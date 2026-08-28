/**
 * The `current` selector: the session the Claude Code process that spawned us is running in, and
 * the set of sessions Claude Code says are running right now. Kept out of discover.ts because it
 * probes the Claude Code runtime (its environment and `<configDir>/sessions/<pid>.json`) rather
 * than the transcript tree.
 *
 * Resolution order (RESEARCH-cli-ux §7), each step guarded:
 *   1. CLAUDE_CODE_SESSION_ID (Bash tool subprocesses since Claude Code 2.1.132): the id itself.
 *      Set but without a transcript -> a precise error, never another session.
 *   2. CLAUDE_PID -> `<configDir>/sessions/<pid>.json` ({ pid, sessionId, ... }, undocumented,
 *      4 KB cap, no symlinks). Malformed -> fall through.
 *   3. CLAUDECODE=1 -> the newest session whose project is CLAUDE_PROJECT_DIR ?? cwd, with a note
 *      that says it was guessed.
 *   4. Otherwise an error naming the alternatives.
 *
 * `current` is resolved to a concrete SessionRef at the CLI boundary and is never persisted.
 */
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultConfigDir, findLatestSession, resolveSession, SESSION_ID_RE, type DiscoverOptions, type SessionRef } from './discover.js'

export type Env = Record<string, string | undefined>

export interface CurrentSession {
  ref: SessionRef
  /** which step found it */
  via: 'env' | 'pid-file' | 'cwd'
  /** a one-line stderr note when the answer was inferred rather than named */
  note?: string
}

/** One `<configDir>/sessions/<pid>.json` record, reduced to the fields orangu reads. */
export interface RunningSession {
  pid: number
  sessionId: string
  cwd?: string
  name?: string
  status?: string
}

export const MAX_SESSION_RECORD_BYTES = 4096
export const MAX_SESSION_RECORDS = 500

const ALTERNATIVES = 'use latest, an id, or orangu pick'

/** Where `sessions/` lives: an explicit config dir, else the roots, else the default; never widened. */
export function sessionsDirs(opts: DiscoverOptions): string[] {
  if (opts.configDir) return [join(opts.configDir, 'sessions')]
  if (opts.roots && opts.roots.length) return opts.roots.map((r) => join(r, 'sessions'))
  return [join(defaultConfigDir(), 'sessions')]
}

/** Read one pid record: a regular file (no symlink), at most 4 KB, JSON with a pid and a session id. */
export async function readSessionRecord(path: string): Promise<RunningSession | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.size > MAX_SESSION_RECORD_BYTES) return undefined
    const buffer = Buffer.allocUnsafe(st.size)
    const { bytesRead } = await handle.read(buffer, 0, st.size, 0)
    const r = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Record<string, unknown>
    if (!r || typeof r !== 'object') return undefined
    const pid = r['pid']
    const sessionId = r['sessionId']
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return undefined
    const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
    const out: RunningSession = { pid: pid as number, sessionId }
    const cwd = str('cwd')
    const name = str('name')
    const status = str('status')
    if (cwd) out.cwd = cwd
    if (name) out.name = name
    if (status) out.status = status
    return out
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

/** Is a process with this pid running? EPERM means it exists but is not ours: alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface RunningDeps {
  isAlive?: (pid: number) => boolean
}

/**
 * Sessions Claude Code records as running: every readable `<configDir>/sessions/*.json` whose pid
 * answers, keyed by session id. Best effort and bounded; any failure degrades to an empty map.
 */
export async function runningSessions(opts: DiscoverOptions, deps: RunningDeps = {}): Promise<Map<string, RunningSession>> {
  const isAlive = deps.isAlive ?? pidAlive
  const out = new Map<string, RunningSession>()
  for (const dir of sessionsDirs(opts)) {
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => /^\d+\.json$/.test(n)).sort().slice(0, MAX_SESSION_RECORDS)
    } catch {
      continue
    }
    for (const name of names) {
      const rec = await readSessionRecord(join(dir, name))
      if (!rec || !isAlive(rec.pid)) continue
      if (!out.has(rec.sessionId)) out.set(rec.sessionId, rec)
    }
  }
  return out
}

export interface CurrentDeps {
  /** the process cwd (injected by tests) */
  cwd?: () => string
}

async function resolveNamed(id: string, opts: DiscoverOptions, via: 'env' | 'pid-file'): Promise<CurrentSession> {
  const ref = await resolveSession(id, opts)
  if (ref) return { ref, via }
  throw new Error(
    `current: session ${id.slice(0, 8)} has no transcript yet (Claude Code writes it asynchronously); try again in a moment, or ${ALTERNATIVES}`,
  )
}

export async function resolveCurrentSession(opts: DiscoverOptions, env: Env = process.env, deps: CurrentDeps = {}): Promise<CurrentSession> {
  const envId = env['CLAUDE_CODE_SESSION_ID']?.trim()
  if (envId) {
    if (!SESSION_ID_RE.test(envId)) throw new Error(`current: CLAUDE_CODE_SESSION_ID is not a session id; ${ALTERNATIVES}`)
    return resolveNamed(envId, opts, 'env')
  }
  const pid = Number(env['CLAUDE_PID'])
  if (Number.isSafeInteger(pid) && pid > 0) {
    for (const dir of sessionsDirs(opts)) {
      const rec = await readSessionRecord(join(dir, `${pid}.json`))
      if (rec) return resolveNamed(rec.sessionId, opts, 'pid-file')
    }
  }
  if (env['CLAUDECODE']) {
    const cwd = env['CLAUDE_PROJECT_DIR']?.trim() || (deps.cwd ?? (() => process.cwd()))()
    const ref = await findLatestSession({ ...opts, cwd })
    if (!ref) throw new Error(`current: no session for ${cwd} yet; ${ALTERNATIVES}`)
    return { ref, via: 'cwd', note: `current: guessed ${ref.sessionId.slice(0, 8)} from cwd (no session id in the environment)` }
  }
  throw new Error(`current: not inside a Claude Code session; ${ALTERNATIVES}`)
}
