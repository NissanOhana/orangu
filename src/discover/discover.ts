/**
 * Session discovery for Claude Code.
 *
 * Layout (macOS/Linux; Windows uses %USERPROFILE%\.claude):
 *   <configDir>/projects/<project-slug>/<session-id>.jsonl          main transcript
 *   <configDir>/projects/<project-slug>/<session-id>/subagents/*.jsonl  subagent transcripts (+ .meta.json)
 *   <configDir>/projects/<project-slug>/<session-id>/tool-results/     oversized tool results
 *   <configDir>/projects/<project-slug>/<session-id>/workflows/        workflow runs
 *
 * configDir = $CLAUDE_CONFIG_DIR || ~/.claude
 */
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MAX_EVIDENCE_SIDECAR_ENTRIES } from '../adapters/claude-code/evidence-input.js'

export interface DiscoverOptions {
  /** override of the Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude) */
  configDir?: string
  /** search across multiple config roots (from claudeRoots); overrides configDir when set */
  roots?: string[]
  /** restrict to the project that owns this cwd */
  cwd?: string
  /** cumulative session cap; verification supplies a stricter value */
  maxSessions?: number
  /** cumulative directory-entry cap (primarily injectable for deterministic tests) */
  maxEntries?: number
}

export interface ProjectInfo {
  slug: string
  path: string
  sessionCount: number
  lastModified: number
  /** best-effort original cwd, recovered from a transcript record when available */
  cwd?: string
}

export interface SessionRef {
  sessionId: string
  path: string
  projectSlug: string
  projectPath: string
  sizeBytes: number
  mtimeMs: number
  hasSidecarDir: boolean
  subagentFiles: string[]
}

export function defaultConfigDir(): string {
  const env = process.env['CLAUDE_CONFIG_DIR']
  if (env && env.trim()) return env
  return join(homedir(), '.claude')
}

/**
 * All Claude config roots to scan, in order:
 * ORANGU_CLAUDE_ROOTS (comma-separated), then CLAUDE_CONFIG_DIR, then ~/.claude, then ~/.config/claude,
 * then Cowork/Desktop local session roots under Library/Application Support/Claude/local-agent-mode-sessions.
 * Each root is a dir that contains a projects subtree. De-duplicated, unreadable roots skipped.
 */
export async function claudeRoots(
  explicit?: string,
  homeDir = homedir(),
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const entryBudget = discoveryEntryBudget()
  const roots: string[] = []
  const add = (p?: string) => {
    if (p && p.trim() && !roots.includes(p)) roots.push(p)
  }
  if (explicit) explicit.split(',').forEach((r) => add(r.trim()))
  ;(env['ORANGU_CLAUDE_ROOTS'] ?? '').split(',').forEach((r) => add(r.trim()))
  ;(env['CLAUDE_CONFIG_DIR'] ?? '').split(',').forEach((r) => add(r.trim()))
  add(join(homeDir, '.claude'))
  add(join(homeDir, '.config', 'claude'))
  // Cowork / Claude Desktop local mode (macOS). Each session nests a full .claude tree.
  const coworkBase = join(homeDir, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  const canonicalCoworkBase = await canonicalNonSymlinkDirectoryChain(homeDir, [
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
  ])
  if (canonicalCoworkBase) {
    for (const a of await safeReaddir(canonicalCoworkBase, entryBudget)) {
      const ad = join(coworkBase, a)
      if (!(await canonicalNonSymlinkDirectory(ad))) continue
      for (const b of await safeReaddir(ad, entryBudget)) {
        const bd = join(ad, b)
        if (!(await canonicalNonSymlinkDirectory(bd))) continue
        for (const c of await safeReaddir(bd, entryBudget)) {
          if (c.startsWith('local_') && !c.endsWith('.json')) {
            const cc = join(bd, c, '.claude')
            if (!(await canonicalNonSymlinkDirectory(join(bd, c)))) continue
            if (!(await canonicalNonSymlinkDirectory(cc))) continue
            const projects = await canonicalNonSymlinkDirectory(join(cc, 'projects'))
            if (projects && isWithin(canonicalCoworkBase, projects)) add(cc)
          }
        }
      }
    }
  }
  // keep only roots that have a projects subtree, de-duplicated by real (symlink-resolved) path
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of roots) {
    if (!existsSync(join(r, 'projects'))) continue
    let real = r
    try {
      real = await realpath(r)
    } catch {
      /* use as-is */
    }
    if (seen.has(real)) continue
    seen.add(real)
    out.push(r)
  }
  return out
}

/** Claude Code encodes the cwd as a directory name: every '/' '\\' '.' ':' (and other non [A-Za-z0-9-]) becomes '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_DISCOVERY_DIRECTORY_ENTRIES = 25_000
export const MAX_DISCOVERED_SESSIONS = 25_000

interface DiscoveryEntryBudget {
  remaining: number
  limit: number
}

class DiscoveryLimitError extends Error {}

function discoveryEntryBudget(limit = MAX_DISCOVERY_DIRECTORY_ENTRIES): DiscoveryEntryBudget {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_DIRECTORY_ENTRIES) {
    throw new Error(`discovery entry cap must be an integer from 1-${MAX_DISCOVERY_DIRECTORY_ENTRIES}`)
  }
  return { remaining: limit, limit }
}

/** @internal Bounded materialization primitive shared by every discovery walk. */
export async function readBoundedDiscoveryDirectory(
  p: string,
  maxEntries = MAX_DISCOVERY_DIRECTORY_ENTRIES,
  budget?: DiscoveryEntryBudget,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_DISCOVERY_DIRECTORY_ENTRIES) {
    throw new Error(`discovery directory cap must be an integer from 1-${MAX_DISCOVERY_DIRECTORY_ENTRIES}`)
  }
  let dir: Awaited<ReturnType<typeof opendir>>
  try {
    dir = await opendir(p)
  } catch {
    return []
  }
  const names: string[] = []
  for await (const entry of dir) {
    if (budget) {
      if (budget.remaining <= 0) throw new DiscoveryLimitError(`session discovery exceeds ${budget.limit} cumulative directory entries`)
      budget.remaining--
    }
    names.push(entry.name)
    if (names.length > maxEntries) {
      throw new DiscoveryLimitError(`session discovery directory exceeds ${maxEntries} entries: ${p}`)
    }
  }
  return names
}

const safeReaddir = (path: string, budget?: DiscoveryEntryBudget) =>
  readBoundedDiscoveryDirectory(path, MAX_DISCOVERY_DIRECTORY_ENTRIES, budget)

function sessionLimit(opts: DiscoverOptions): number {
  const value = opts.maxSessions ?? MAX_DISCOVERED_SESSIONS
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DISCOVERED_SESSIONS) {
    throw new Error(`session discovery cap must be an integer from 0-${MAX_DISCOVERED_SESSIONS}`)
  }
  return value
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function canonicalNonSymlinkDirectory(path: string): Promise<string | undefined> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isDirectory()) return undefined
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function canonicalNonSymlinkDirectoryChain(root: string, segments: string[]): Promise<string | undefined> {
  let current = resolve(root)
  if (!(await canonicalNonSymlinkDirectory(current))) return undefined
  for (const segment of segments) {
    current = join(current, segment)
    if (!(await canonicalNonSymlinkDirectory(current))) return undefined
  }
  return realpath(current)
}

async function canonicalProjectsRoot(configDir: string): Promise<string | undefined> {
  try {
    const root = await realpath(join(configDir, 'projects'))
    const st = await lstat(root)
    return st.isDirectory() ? root : undefined
  } catch {
    return undefined
  }
}

export async function listProjects(opts: DiscoverOptions = {}): Promise<ProjectInfo[]> {
  const entryBudget = discoveryEntryBudget(opts.maxEntries)
  const configDir = opts.configDir ?? defaultConfigDir()
  const root = await canonicalProjectsRoot(configDir)
  if (!root) return []
  const names = await safeReaddir(root, entryBudget)
  const out: ProjectInfo[] = []
  for (const name of names) {
    const p = join(root, name)
    let st
    try {
      st = await lstat(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    const files = (await safeReaddir(p, entryBudget)).filter((f) => f.endsWith('.jsonl'))
    let last = 0
    for (const f of files) {
      try {
        const s = await lstat(join(p, f))
        if (s.isSymbolicLink() || !s.isFile()) continue
        if (s.mtimeMs > last) last = s.mtimeMs
      } catch {
        /* ignore */
      }
    }
    out.push({ slug: name, path: p, sessionCount: files.length, lastModified: last })
  }
  out.sort((a, b) => b.lastModified - a.lastModified)
  return out
}

async function sessionRefFor(
  projectPath: string,
  file: string,
  projectsRoot?: string,
  entryBudget?: DiscoveryEntryBudget,
): Promise<SessionRef | null> {
  try {
    const projectStat = await lstat(projectPath)
    if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return null
  } catch {
    return null
  }
  const path = join(projectPath, file)
  let st
  try {
    st = await lstat(path)
  } catch {
    return null
  }
  if (st.isSymbolicLink() || !st.isFile()) return null
  if (projectsRoot) {
    let canonicalPath: string
    try {
      canonicalPath = await realpath(path)
    } catch {
      return null
    }
    if (!isWithin(projectsRoot, canonicalPath)) return null
  }
  const sessionId = basename(file, '.jsonl')
  const sidecar = join(projectPath, sessionId)
  let hasSidecarDir = false
  let subagentFiles: string[] = []
  try {
    const sessionDirStat = await lstat(sidecar)
    const subagentRoot = join(sidecar, 'subagents')
    const subagentRootStat = await lstat(subagentRoot)
    hasSidecarDir = !sessionDirStat.isSymbolicLink() && sessionDirStat.isDirectory() && !subagentRootStat.isSymbolicLink() && subagentRootStat.isDirectory()
    if (hasSidecarDir) {
      const subs = await safeReaddir(subagentRoot, entryBudget)
      if (subs.length <= MAX_EVIDENCE_SIDECAR_ENTRIES) {
        for (const name of subs.sort()) {
          if (!name.endsWith('.jsonl')) continue
          const candidate = join(subagentRoot, name)
          const candidateStat = await lstat(candidate)
          if (!candidateStat.isSymbolicLink() && candidateStat.isFile()) subagentFiles.push(candidate)
        }
      }
    }
  } catch (error) {
    if (error instanceof DiscoveryLimitError) throw error
    // Missing or malformed sidecar trees are never trusted discovery hints. The
    // bounded parser preflight owns the authoritative error when selected.
  }
  return {
    sessionId,
    path,
    projectSlug: basename(projectPath),
    projectPath,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    hasSidecarDir,
    subagentFiles,
  }
}

/** Resolve which project directories match a cwd: exact slug first, else any whose transcripts declare that cwd. */
async function projectDirsForCwd(root: string, cwd: string, entryBudget: DiscoveryEntryBudget): Promise<string[]> {
  const exact = join(root, projectSlug(cwd))
  if (existsSync(exact)) return [exact]
  // fallback: peek at the first record of one transcript per project
  const out: string[] = []
  for (const name of await safeReaddir(root, entryBudget)) {
    const p = join(root, name)
    try {
      const st = await lstat(p)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
    } catch {
      continue
    }
    const files = (await safeReaddir(p, entryBudget)).filter((f) => f.endsWith('.jsonl'))
    const f = files[0]
    if (!f) continue
    const c = await peekCwd(join(p, f))
    if (c === cwd) out.push(p)
  }
  return out
}

/** Read the first few KB of a transcript and return its `cwd` field if present. */
export async function peekCwd(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return undefined
    const size = Math.min(st.size, 64_000)
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const read = await handle.read(buffer, offset, size - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const head = buffer.subarray(0, offset).toString('utf8')
    for (const line of head.split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const r = JSON.parse(line) as { cwd?: unknown }
        if (typeof r.cwd === 'string') return r.cwd
      } catch {
        /* partial line */
      }
    }
  } finally {
    await handle.close()
  }
  return undefined
}

export async function listSessions(opts: DiscoverOptions = {}): Promise<SessionRef[]> {
  const limit = sessionLimit(opts)
  return listSessionsWithBudget(opts, { remaining: limit, limit }, discoveryEntryBudget(opts.maxEntries))
}

interface DiscoveryBudget {
  remaining: number
  limit: number
}

async function listSessionsWithBudget(
  opts: DiscoverOptions,
  budget: DiscoveryBudget,
  entryBudget: DiscoveryEntryBudget,
): Promise<SessionRef[]> {
  if (opts.roots && opts.roots.length) {
    const all: SessionRef[] = []
    const seen = new Set<string>()
    for (const r of opts.roots) {
      for (const ref of await listSessionsWithBudget({ configDir: r, cwd: opts.cwd }, budget, entryBudget)) {
        if (seen.has(ref.path)) continue
        seen.add(ref.path)
        all.push(ref)
      }
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return all
  }
  const configDir = opts.configDir ?? defaultConfigDir()
  const root = await canonicalProjectsRoot(configDir)
  if (!root) return []
  const dirs = opts.cwd
    ? await projectDirsForCwd(root, resolve(opts.cwd), entryBudget)
    : (await safeReaddir(root, entryBudget)).map((n) => join(root, n))
  const out: SessionRef[] = []
  for (const d of dirs) {
    let st
    try {
      st = await lstat(d)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    for (const f of await safeReaddir(d, entryBudget)) {
      if (!f.endsWith('.jsonl')) continue
      if (budget.remaining <= 0) throw new Error(`session discovery exceeds ${budget.limit} sessions`)
      budget.remaining--
      const ref = await sessionRefFor(d, f, root, entryBudget)
      if (ref) out.push(ref)
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

export interface ResolveResult extends SessionRef {}

/**
 * Resolve a user-supplied session reference: an absolute/relative path to a .jsonl, a full session id,
 * or a unique id prefix. Returns null when nothing (or more than one thing) matches.
 */
export async function resolveSession(ref: string, opts: DiscoverOptions = {}): Promise<ResolveResult | null> {
  const r = ref.trim()
  // path?
  if (r.endsWith('.jsonl') || r.includes('/') || r.includes('\\')) {
    const abs = isAbsolute(r) ? r : resolve(process.cwd(), r)
    if (existsSync(abs)) {
      const projectPath = dirname(abs)
      const made = await sessionRefFor(projectPath, basename(abs))
      if (made) return made
      // Preserve a precise secure-boundary error for an explicitly selected
      // transcript symlink; listSessions itself never returns this hint.
      try {
        const st = await lstat(abs)
        if (st.isSymbolicLink()) {
          return {
            sessionId: basename(abs, '.jsonl'),
            path: abs,
            projectSlug: basename(projectPath),
            projectPath,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
            hasSidecarDir: false,
            subagentFiles: [],
          }
        }
      } catch {
        return null
      }
    }
    return null
  }
  const all = await listSessions({ configDir: opts.configDir, roots: opts.roots })
  const exact = all.find((s) => s.sessionId.toLowerCase() === r.toLowerCase())
  if (exact) return exact
  const matches = all.filter((s) => s.sessionId.toLowerCase().startsWith(r.toLowerCase()))
  if (matches.length === 1) return matches[0] as SessionRef
  return null
}

export async function candidatesForPrefix(prefix: string, opts: DiscoverOptions = {}): Promise<SessionRef[]> {
  const all = await listSessions({ configDir: opts.configDir, roots: opts.roots })
  return all.filter((s) => s.sessionId.toLowerCase().startsWith(prefix.toLowerCase()))
}

export async function findLatestSession(opts: DiscoverOptions = {}): Promise<SessionRef | null> {
  const sessions = await listSessions(opts)
  return sessions[0] ?? null
}
