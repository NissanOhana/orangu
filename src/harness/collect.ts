/**
 * The harness inventory collector: what the user's Claude Code configuration DECLARES.
 *
 * Deterministic and offline. Pure `node:fs/promises` + `node:path`: no network, no clock, no model.
 *
 * **It never throws.** A harness in drift is the normal case, not an error: every failure becomes an
 * `unreadable[]` row with a reason, and collection continues. The one rule that shapes the noise:
 *   - a path the CALLER named (`cwd`, each `roots[]` entry) that is missing is recorded `enoent`;
 *   - an OPTIONAL path that is simply absent (no `CLAUDE.md`, no `skills/`, no `.mcp.json`) is silent,
 *     because a row per absent probe would swamp the array on every normal machine;
 *   - any other failure (`eacces`, `bad-json`, `too-large`, `other`) is always recorded.
 * `~/.claude.json` is the documented exception: a miss is silent here and surfaces as a `notes[]` entry
 * on the report, with `usageCounters` left `undefined`.
 *
 * **The collection boundary is narrower than redaction.** `--no-redact` does not widen it:
 *   - env is read with `Object.keys`: NAMES ONLY, never a value (see `settingsEnv`);
 *   - a hook command is reduced to `basename(argv0)` before it enters the report (`argv0Basename` in names.ts, the
 *     same rule the crosswalk joins on),
 *     and the arguments, which is where secrets live, are dropped rather than masked;
 *   - `~/.claude.json` is read through an explicit four-key allowlist (`CLAUDE_JSON_KEYS`), with each
 *     `projects[*]` entry that is read (the cwd's, or every entry under a global scan) reading exactly three
 *     more (`CLAUDE_JSON_PROJECT_KEYS`). The account block, history, caches and the ~75 other top-level keys
 *     of that file are never touched;
 *   - managed (organization) policy is read from the platform's system directory (`managedDirs`), through the
 *     same settings parser and the same boundary as a user settings file.
 * Every string that survives into the report goes through `../redact/redact.js`: `redactValue` for paths
 * (secret patterns + the home prefix rewritten to `~`) and `scrubStr` for names. There is no second,
 * hand-rolled scrubber here.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { redactValue, scrubStr } from '../redact/redact.js'
import { contentWords } from '../analyze/instructions.js'
import { projectSlug } from '../discover/discover.js'
import { argv0Basename } from './names.js'
import type {
  HarnessAgentEntry,
  HarnessConfigScope,
  HarnessHookConfig,
  HarnessInventory,
  HarnessMcpScope,
  HarnessMcpServerEntry,
  HarnessMemoryFile,
  HarnessMemoryIndexFile,
  HarnessOrigin,
  HarnessPluginEntry,
  HarnessSettingsFile,
  HarnessSkillEntry,
  HarnessUnreadableEntry,
  HarnessUnreadableReason,
  HarnessUsageCounters,
} from './types.js'

export interface CollectOptions {
  /** the repo whose `.claude/` is the "repo" side; also the key into `~/.claude.json` → `projects` */
  cwd: string
  /** Claude config roots (from `claudeRoots()`), the "global" side */
  roots: string[]
  /** the home dir: `~/.claude.json` is probed here, and this prefix is rewritten to `~` in every path */
  home: string
  /** any single file bigger than this is skipped as `too-large` and never read (default 1 MB) */
  maxFileBytes?: number
  /** managed (organization) policy dirs from `managedSettingsDirs()`: managed-settings.json, managed-settings.d/, managed-mcp.json */
  managedDirs?: string[]
  /** read the MCP declarations of EVERY project entry in `~/.claude.json`, the declared side a global session scan needs; default: only cwd's */
  allProjects?: boolean
  /** auto-memory indexes the scanned sessions loaded (absolute paths), measured beside the ones in scope */
  memoryIndexPaths?: string[]
  /**
   * When given, the content words of every instruction file and memory note in scope are added here. The words
   * never enter the inventory: the enforcement section uses them to say a complaint word is already in a note.
   */
  instructionWords?: Set<string>
}

/** Claude Code loads the first 200 lines or the first 25,000 bytes of MEMORY.md, whichever comes first (docs: memory) */
export const MEMORY_INDEX_LINE_LIMIT = 200
export const MEMORY_INDEX_BYTE_LIMIT = 25_000

/**
 * Where Claude Code cuts an auto-memory index at load: the whole lines that fit in both limits stay, the rest
 * goes. Its own warning counts the same way ("3 of 117 lines were cut off, starting at line 115").
 */
export function memoryIndexCut(text: string): { lines: number; linesPastLimit: number; firstLinePastLimit?: number } {
  const lines = text === '' ? [] : text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let bytes = 0
  for (let i = 0; i < lines.length; i++) {
    const next = bytes + Buffer.byteLength(lines[i]!, 'utf8')
    if (i >= MEMORY_INDEX_LINE_LIMIT || next > MEMORY_INDEX_BYTE_LIMIT) return { lines: lines.length, linesPastLimit: lines.length - i, firstLinePastLimit: i + 1 }
    bytes = next + 1
  }
  return { lines: lines.length, linesPastLimit: 0 }
}

const DEFAULT_MAX_FILE_BYTES = 1_000_000
/** how deep an `agents/**` or `commands/**` walk goes before it stops */
const MAX_WALK_DEPTH = 6

/** the ONLY keys read from `~/.claude.json`. Everything else in that file is never touched. */
const CLAUDE_JSON_KEYS = ['mcpServers', 'projects', 'skillUsage', 'pluginUsage'] as const
/** the ONLY keys read from `~/.claude.json` → `projects[*]` */
const CLAUDE_JSON_PROJECT_KEYS = ['mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'] as const

// ---------------------------------------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------------------------------------

interface Ctx {
  /** the instruction-word sink (CollectOptions.instructionWords) */
  words?: Set<string>
  home: string
  maxFileBytes: number
  unreadable: HarnessUnreadableEntry[]
  seen: Set<string>
  filesRead: number
  bytesRead: number
}

function reasonOf(e: unknown): HarnessUnreadableReason {
  const code = (e as { code?: string } | null | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'enoent'
  if (code === 'EACCES' || code === 'EPERM') return 'eacces'
  return 'other'
}

/**
 * paths: secret patterns masked AND the home prefix rewritten to `~`.
 * An empty `home` is passed as "absent" so `redactValue` falls back to `$HOME` rather than disabling the
 * rewrite entirely (`homeRegExp('')` returns null): a caller must not be able to opt out of relativization
 * by passing a blank string.
 */
function cleanPath(ctx: Ctx, p: string): string {
  return redactValue(p, ctx.home ? { home: ctx.home } : {})
}
/** names, keys and short identifiers: secret patterns masked */
function cleanName(s: string): string {
  return scrubStr(s)
}

function mark(ctx: Ctx, path: string, reason: HarnessUnreadableReason): void {
  const p = cleanPath(ctx, path)
  const key = `${p}::${reason}`
  if (ctx.seen.has(key)) return
  ctx.seen.add(key)
  ctx.unreadable.push({ path: p, reason })
}

/** reads a file, or records why it could not. `null` means "not in the report"; never throws. */
async function readText(ctx: Ctx, path: string): Promise<string | null> {
  let size: number
  try {
    const st = await stat(path)
    if (!st.isFile()) return null
    size = st.size
  } catch (e) {
    const r = reasonOf(e)
    if (r !== 'enoent') mark(ctx, path, r)
    return null
  }
  if (size > ctx.maxFileBytes) {
    mark(ctx, path, 'too-large')
    return null
  }
  try {
    const text = await readFile(path, 'utf8')
    ctx.filesRead++
    ctx.bytesRead += size
    return text
  } catch (e) {
    mark(ctx, path, reasonOf(e))
    return null
  }
}

async function readJson(ctx: Ctx, path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(ctx, path)
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      mark(ctx, path, 'bad-json')
      return null
    }
    return v as Record<string, unknown>
  } catch {
    mark(ctx, path, 'bad-json')
    return null
  }
}

/** lists a directory. An absent OPTIONAL directory is silence; `required` makes the miss a row. */
async function listDir(ctx: Ctx, path: string, required = false): Promise<Array<{ name: string; dir: boolean }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch (e) {
    const r = reasonOf(e)
    if (r !== 'enoent' || required) mark(ctx, path, r)
    return []
  }
}

/** every `*.md` under `dir`, depth-bounded, sorted, hidden dirs skipped */
async function walkMarkdown(ctx: Ctx, dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return []
  const out: string[] = []
  for (const e of await listDir(ctx, dir)) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.dir) out.push(...(await walkMarkdown(ctx, p, depth + 1)))
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

const approxTokens = (bytes: number): number => Math.ceil(bytes / 4)

function lineCount(text: string): number {
  if (text === '') return 0
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

function headingCount(text: string): number {
  let n = 0
  for (const l of text.split('\n')) if (/^#{1,6}\s/.test(l)) n++
  return n
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm: Record<string, string> = {}
  for (const raw of (m[1] ?? '').split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue // nested / continuation lines are not top-level fields
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    if (val.length > 1 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) val = val.slice(1, -1)
    fm[key] = val
  }
  return { fm, body: text.slice(m[0].length) }
}

/** `Read, Bash(orangu:*)` / `[a, b]` → `['Read', 'Bash(orangu:*)']`; commas inside brackets are not separators */
function splitList(value: string | undefined): string[] | null {
  if (value === undefined) return null
  let s = value.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth <= 0) {
      const t = cur.trim()
      if (t) out.push(t)
      cur = ''
      continue
    }
    cur += ch
  }
  const t = cur.trim()
  if (t) out.push(t)
  return out.map((x) => x.replace(/^['"]|['"]$/g, ''))
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const byKey = <T>(pick: (x: T) => string) => (a: T, b: T) => {
  const x = pick(a)
  const y = pick(b)
  return x < y ? -1 : x > y ? 1 : 0
}

// ---------------------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------------------

/** env: `Object.keys` ONLY. A value is never read, never copied, never masked; it simply never arrives. */
function settingsEnv(raw: Record<string, unknown>): { count: number; names: string[] } {
  const env = asRecord(raw['env'])
  if (!env) return { count: 0, names: [] }
  const names = Object.keys(env).map(cleanName).sort()
  return { count: names.length, names }
}

function settingsHooks(raw: Record<string, unknown>): HarnessHookConfig[] {
  return hookConfigsFrom(asRecord(raw['hooks']))
}

/** `{ <Event>: [{ matcher?, hooks: [{ command }] }] }`, the shape settings files and plugin `hooks.json` share */
function hookConfigsFrom(hooks: Record<string, unknown> | null): HarnessHookConfig[] {
  if (!hooks) return []
  const out: HarnessHookConfig[] = []
  for (const event of Object.keys(hooks).sort()) {
    const matchers = asArray(hooks[event])
    const names = new Set<string>()
    let commands = 0
    for (const m of matchers) {
      for (const h of asArray(asRecord(m)?.['hooks'])) {
        const cmd = asString(asRecord(h)?.['command'])
        if (cmd === undefined) continue
        commands++
        const b = argv0Basename(cmd)
        if (b) names.add(cleanName(b))
      }
    }
    out.push({ event: cleanName(event), matchers: matchers.length, commands, commandBasenames: [...names].sort() })
  }
  return out
}

function enabledPluginKeys(raw: Record<string, unknown>): string[] {
  const v = raw['enabledPlugins']
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map(cleanName).sort()
  const rec = asRecord(v)
  if (!rec) return []
  return Object.keys(rec)
    .filter((k) => rec[k] !== false)
    .map(cleanName)
    .sort()
}

function parseSettings(ctx: Ctx, scope: HarnessConfigScope, file: string, raw: Record<string, unknown>): HarnessSettingsFile {
  const perms = asRecord(raw['permissions'])
  return {
    scope,
    file: cleanPath(ctx, file),
    keys: Object.keys(raw).map(cleanName).sort(),
    ...(asString(raw['model']) ? { model: cleanName(asString(raw['model'])!) } : {}),
    ...(asString(raw['effortLevel']) ? { effortLevel: cleanName(asString(raw['effortLevel'])!) } : {}),
    permissions: {
      allow: asArray(perms?.['allow']).length,
      deny: asArray(perms?.['deny']).length,
      ask: asArray(perms?.['ask']).length,
      ...(asString(perms?.['defaultMode']) ? { defaultMode: cleanName(asString(perms!['defaultMode'])!) } : {}),
    },
    hooks: settingsHooks(raw),
    env: settingsEnv(raw),
    statusLine: raw['statusLine'] != null,
    // both cleanup windows, kept raw: `src/harness/retention.ts` decides which values are usable, so a
    // value this collector cannot vouch for is still visible in the inventory rather than silently dropped
    ...(typeof raw['cleanupPeriodDays'] === 'number' ? { cleanupPeriodDays: raw['cleanupPeriodDays'] } : {}),
    ...(typeof raw['desktopSessionCleanupPeriodDays'] === 'number' ? { desktopSessionCleanupPeriodDays: raw['desktopSessionCleanupPeriodDays'] } : {}),
    ...(typeof raw['allowManagedHooksOnly'] === 'boolean' ? { allowManagedHooksOnly: raw['allowManagedHooksOnly'] } : {}),
    enabledPlugins: enabledPluginKeys(raw),
  }
}

// ---------------------------------------------------------------------------------------------------------
// skills / agents / memory
// ---------------------------------------------------------------------------------------------------------

async function readSkillDir(ctx: Ctx, dir: string, origin: HarnessOrigin, plugin?: string): Promise<HarnessSkillEntry[]> {
  const out: HarnessSkillEntry[] = []
  for (const e of await listDir(ctx, dir)) {
    if (!e.dir || e.name.startsWith('.')) continue
    const file = join(dir, e.name, 'SKILL.md')
    const text = await readText(ctx, file)
    if (text === null) continue
    const { fm, body } = parseFrontmatter(text)
    const bytes = Buffer.byteLength(text, 'utf8')
    out.push({
      name: cleanName(fm['name'] ?? e.name),
      origin,
      ...(plugin ? { plugin: cleanName(plugin) } : {}),
      file: cleanPath(ctx, file),
      bytes,
      approxTokens: approxTokens(bytes),
      descriptionChars: (fm['description'] ?? '').length,
      allowedTools: splitList(fm['allowed-tools'] ?? fm['allowedTools'])?.map(cleanName) ?? null,
      bodyLines: lineCount(body),
      hasReferences: await isDir(join(dir, e.name, 'references')),
    })
  }
  return out
}

async function readAgentDir(ctx: Ctx, dir: string, origin: HarnessOrigin, plugin?: string): Promise<HarnessAgentEntry[]> {
  const out: HarnessAgentEntry[] = []
  for (const file of await walkMarkdown(ctx, dir)) {
    const text = await readText(ctx, file)
    if (text === null) continue
    const { fm } = parseFrontmatter(text)
    const bytes = Buffer.byteLength(text, 'utf8')
    out.push({
      name: cleanName(fm['name'] ?? basename(file, '.md')),
      origin,
      ...(plugin ? { plugin: cleanName(plugin) } : {}),
      file: cleanPath(ctx, file),
      bytes,
      approxTokens: approxTokens(bytes),
      descriptionChars: (fm['description'] ?? '').length,
      ...(fm['model'] ? { model: cleanName(fm['model']) } : {}),
      ...(fm['effort'] ? { effort: cleanName(fm['effort']) } : {}),
      tools: splitList(fm['tools'])?.map(cleanName) ?? null,
      disallowedTools: splitList(fm['disallowedTools'] ?? fm['disallowed-tools'])?.map(cleanName) ?? null,
    })
  }
  return out
}

async function readMemory(ctx: Ctx, file: string, scope: 'repo' | 'global'): Promise<HarnessMemoryFile | null> {
  const text = await readText(ctx, file)
  if (text === null) return null
  if (ctx.words) for (const w of contentWords(text, { cap: Infinity })) ctx.words.add(w)
  const bytes = Buffer.byteLength(text, 'utf8')
  return { scope, file: cleanPath(ctx, file), bytes, approxTokens: approxTokens(bytes), lines: lineCount(text), headings: headingCount(text) }
}

// ---------------------------------------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------------------------------------

function mcpFromRecord(rec: Record<string, unknown> | null, scope: HarnessMcpScope, enabled = true): HarnessMcpServerEntry[] {
  if (!rec) return []
  const out: HarnessMcpServerEntry[] = []
  for (const name of Object.keys(rec).sort()) {
    const srv = asRecord(rec[name])
    const command = asString(srv?.['command'])
    const transport = asString(srv?.['type']) ?? (asString(srv?.['url']) ? 'http' : command ? 'stdio' : 'unknown')
    out.push({
      name: cleanName(name),
      scope,
      transport: cleanName(transport),
      ...(command ? { commandBasename: cleanName(argv0Basename(command)) } : {}),
      enabled,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------------------------------------

interface PluginWalk {
  skills: HarnessSkillEntry[]
  agents: HarnessAgentEntry[]
  mcpServers: HarnessMcpServerEntry[]
  commands: number
  hooks: number
  hookConfigs: HarnessHookConfig[]
}

/**
 * Walk an installed plugin's own tree for its components. This is what keeps `undeclared` from
 * over-firing: a plugin-provided skill IS declared, just not in a settings file.
 */
async function walkPlugin(ctx: Ctx, installPath: string, key: string): Promise<PluginWalk> {
  const skills = await readSkillDir(ctx, join(installPath, 'skills'), 'plugin', key)
  const agents = await readAgentDir(ctx, join(installPath, 'agents'), 'plugin', key)
  const commands = (await walkMarkdown(ctx, join(installPath, 'commands'))).length
  // a plugin's hooks.json either wraps the events in `hooks` or is the event map itself; a `hooks` key that
  // is not an object is a malformed file and declares nothing, never an event named `hooks`
  const hooksJson = await readJson(ctx, join(installPath, 'hooks', 'hooks.json'))
  const hookConfigs = hookConfigsFrom(hooksJson && 'hooks' in hooksJson ? asRecord(hooksJson['hooks']) : hooksJson)
  const hooks = hookConfigs.reduce((n, h) => n + h.commands, 0)
  const mcpJson = await readJson(ctx, join(installPath, '.mcp.json'))
  const mcpServers = mcpFromRecord(asRecord(mcpJson?.['mcpServers']), 'plugin')
  return { skills, agents, mcpServers, commands, hooks, hookConfigs }
}

// ---------------------------------------------------------------------------------------------------------
// the collector
// ---------------------------------------------------------------------------------------------------------

export async function collectInventory(opts: CollectOptions): Promise<HarnessInventory> {
  if (typeof opts.cwd !== 'string' || typeof opts.home !== 'string' || !Array.isArray(opts.roots)) {
    throw new TypeError('collectInventory: cwd and home must be strings and roots an array')
  }
  const ctx: Ctx = {
    ...(opts.instructionWords ? { words: opts.instructionWords } : {}),
    home: opts.home,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    unreadable: [],
    seen: new Set(),
    filesRead: 0,
    bytesRead: 0,
  }

  const claudeMd: HarnessMemoryFile[] = []
  const settings: HarnessSettingsFile[] = []
  const skills: HarnessSkillEntry[] = []
  const agents: HarnessAgentEntry[] = []
  const plugins: HarnessPluginEntry[] = []
  const mcpServers: HarnessMcpServerEntry[] = []

  // ---- repo side ----
  if (await isDir(opts.cwd)) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const m = await readMemory(ctx, join(opts.cwd, name), 'repo')
      if (m) claudeMd.push(m)
    }
    const dotClaude = join(opts.cwd, '.claude')
    const m = await readMemory(ctx, join(dotClaude, 'CLAUDE.md'), 'repo')
    if (m) claudeMd.push(m)
    for (const [file, scope] of [
      [join(dotClaude, 'settings.json'), 'repo'],
      [join(dotClaude, 'settings.local.json'), 'repo-local'],
    ] as Array<[string, HarnessConfigScope]>) {
      const raw = await readJson(ctx, file)
      if (raw) settings.push(parseSettings(ctx, scope, file, raw))
    }
    skills.push(...(await readSkillDir(ctx, join(dotClaude, 'skills'), 'repo')))
    agents.push(...(await readAgentDir(ctx, join(dotClaude, 'agents'), 'repo')))
    const mcpJson = await readJson(ctx, join(opts.cwd, '.mcp.json'))
    mcpServers.push(...mcpFromRecord(asRecord(mcpJson?.['mcpServers']), 'repo-file'))
  } else {
    mark(ctx, opts.cwd, 'enoent')
  }

  // ---- managed side: organization policy, the scope every other one is read under ----
  for (const dir of opts.managedDirs ?? []) {
    if (!(await isDir(dir))) continue // most machines carry no policy; absence is not a miss
    const main = join(dir, 'managed-settings.json')
    const rawMain = await readJson(ctx, main)
    if (rawMain) settings.push(parseSettings(ctx, 'managed', main, rawMain))
    const dropIns = join(dir, 'managed-settings.d')
    if (await isDir(dropIns)) {
      let names: string[] = []
      try {
        names = (await readdir(dropIns)).filter((n) => n.endsWith('.json')).sort()
      } catch (e) {
        mark(ctx, dropIns, reasonOf(e))
      }
      for (const name of names) {
        const file = join(dropIns, name)
        const raw = await readJson(ctx, file)
        if (raw) settings.push(parseSettings(ctx, 'managed', file, raw))
      }
    }
    const mcp = await readJson(ctx, join(dir, 'managed-mcp.json'))
    mcpServers.push(...mcpFromRecord(asRecord(mcp?.['mcpServers']), 'managed'))
  }

  // ---- global side ----
  const liveRoots: string[] = []
  for (const root of opts.roots) {
    if (!(await isDir(root))) {
      // a root the caller named is an input, so its absence is reported rather than swallowed
      try {
        await stat(root)
        mark(ctx, root, 'other')
      } catch (e) {
        mark(ctx, root, reasonOf(e))
      }
      continue
    }
    liveRoots.push(root)
    const m = await readMemory(ctx, join(root, 'CLAUDE.md'), 'global')
    if (m) claudeMd.push(m)
    for (const [file, scope] of [
      [join(root, 'settings.json'), 'global'],
      [join(root, 'settings.local.json'), 'global-local'],
    ] as Array<[string, HarnessConfigScope]>) {
      const raw = await readJson(ctx, file)
      if (raw) settings.push(parseSettings(ctx, scope, file, raw))
    }
    skills.push(...(await readSkillDir(ctx, join(root, 'skills'), 'global')))
    agents.push(...(await readAgentDir(ctx, join(root, 'agents'), 'global')))
  }

  // ---- plugins (after settings, because `enabled` comes from enabledPlugins) ----
  const enabled = new Set<string>(settings.flatMap((s) => s.enabledPlugins))
  for (const root of liveRoots) {
    const installed = await readJson(ctx, join(root, 'plugins', 'installed_plugins.json'))
    const byName = asRecord(installed?.['plugins'])
    if (!byName) continue
    for (const key of Object.keys(byName).sort()) {
      const entry = asArray(byName[key]).map(asRecord).find((e) => e && asString(e['installPath']))
      if (!entry) continue
      const installPath = asString(entry['installPath'])!
      const at = key.lastIndexOf('@')
      const walk = await walkPlugin(ctx, installPath, key)
      skills.push(...walk.skills)
      agents.push(...walk.agents)
      mcpServers.push(...walk.mcpServers)
      plugins.push({
        key: cleanName(key),
        name: cleanName(at > 0 ? key.slice(0, at) : key),
        marketplace: cleanName(at > 0 ? key.slice(at + 1) : ''),
        scope: cleanName(asString(entry['scope']) ?? 'unknown'),
        ...(asString(entry['version']) ? { version: cleanName(asString(entry['version'])!) } : {}),
        enabled: enabled.has(key),
        skills: walk.skills.length,
        agents: walk.agents.length,
        commands: walk.commands,
        hooks: walk.hooks,
        mcpServers: walk.mcpServers.length,
        ...(walk.hookConfigs.length ? { hookConfigs: walk.hookConfigs } : {}),
      })
    }
  }

  // ---- ~/.claude.json: allowlist read only ----
  let usageCounters: HarnessUsageCounters | undefined
  let projectEntries = 0
  const claudeJsonPath = join(opts.home, '.claude.json')
  const rawClaudeJson = await readJson(ctx, claudeJsonPath)
  if (rawClaudeJson) {
    // the allowlist IS the boundary: nothing outside these four keys is ever dereferenced
    const picked: Record<string, unknown> = {}
    for (const k of CLAUDE_JSON_KEYS) if (k in rawClaudeJson) picked[k] = rawClaudeJson[k]

    mcpServers.push(...mcpFromRecord(asRecord(picked['mcpServers']), 'global'))

    // one entry, the cwd, for a repo scan; every entry for a global one, whose observed side spans every project
    const projects = asRecord(picked['projects']) ?? {}
    const projectKeys = opts.allProjects ? Object.keys(projects).sort() : [opts.cwd]
    for (const key of projectKeys) {
      const project = asRecord(projects[key])
      if (!project) continue
      projectEntries++
      const proj: Record<string, unknown> = {}
      for (const k of CLAUDE_JSON_PROJECT_KEYS) if (k in project) proj[k] = project[k]
      const ownRowsFrom = mcpServers.length
      mcpServers.push(...mcpFromRecord(asRecord(proj['mcpServers']), 'project'))
      // These two lists record ONE project's approval of the servers ITS `.mcp.json` declared, so the normal
      // case is a name already among the rows this entry owns: what it just declared, plus the repo `.mcp.json`
      // rows when the entry is the cwd. Reconcile onto those rows instead of pushing a second one (a duplicate
      // inflates `totals.mcpServers` and lets the inventory claim one server is both enabled and disabled;
      // disabled always wins), and never onto another project's, a plugin's or a managed row: under a global
      // scan a foreign project's decline must not flip a server it never declared.
      const ownsRepoFile = key === opts.cwd
      for (const [list, on] of [
        [asArray(proj['enabledMcpjsonServers']), true],
        [asArray(proj['disabledMcpjsonServers']), false],
      ] as Array<[unknown[], boolean]>) {
        for (const raw of list) {
          const name = asString(raw)
          if (!name) continue
          const clean = cleanName(name)
          const existing = mcpServers.filter((m, i) => m.name === clean && (i >= ownRowsFrom || (ownsRepoFile && m.scope === 'repo-file')))
          if (existing.length) for (const row of existing) row.enabled = row.enabled && on
          else mcpServers.push({ name: clean, scope: ownsRepoFile ? 'repo-file' : 'project', transport: 'unknown', enabled: on })
        }
      }
    }

    const skillUsage = asRecord(picked['skillUsage'])
    const pluginUsage = asRecord(picked['pluginUsage'])
    usageCounters = {
      skills: Object.keys(skillUsage ?? {})
        .sort()
        .map((name) => ({ name: cleanName(name), usageCount: asNumber(asRecord(skillUsage![name])?.['usageCount']), lastUsedAt: asNumber(asRecord(skillUsage![name])?.['lastUsedAt']) })),
      plugins: Object.keys(pluginUsage ?? {})
        .sort()
        .map((key) => ({ key: cleanName(key), usageCount: asNumber(asRecord(pluginUsage![key])?.['usageCount']), lastUsedAt: asNumber(asRecord(pluginUsage![key])?.['lastUsedAt']) })),
    }
  }

  // ---- auto-memory indexes: the cwd's project (or every project under a global scan), plus each one a session loaded ----
  const memoryIndexes: HarnessMemoryIndexFile[] = []
  const indexPaths = new Set<string>(opts.memoryIndexPaths ?? [])
  for (const root of liveRoots) {
    const projects = join(root, 'projects')
    if (opts.allProjects) {
      for (const e of await listDir(ctx, projects)) if (e.dir) indexPaths.add(join(projects, e.name, 'memory', 'MEMORY.md'))
    } else indexPaths.add(join(projects, projectSlug(opts.cwd), 'memory', 'MEMORY.md'))
  }
  for (const file of [...indexPaths].sort()) {
    // most projects keep no memory: an absent index is not a miss
    try {
      if (!(await stat(file)).isFile()) continue
    } catch {
      continue
    }
    const text = await readText(ctx, file)
    if (text === null) continue
    const bytes = Buffer.byteLength(text, 'utf8')
    const cut = memoryIndexCut(text)
    memoryIndexes.push({ file: cleanPath(ctx, file), bytes, approxTokens: approxTokens(bytes), lines: cut.lines, linesPastLimit: cut.linesPastLimit, ...(cut.firstLinePastLimit !== undefined ? { firstLinePastLimit: cut.firstLinePastLimit } : {}) })
    // the topic notes beside the index load on demand; their words still count as "a note exists"
    if (ctx.words) {
      for (const w of contentWords(text, { cap: Infinity })) ctx.words.add(w)
      const dir = join(file, '..')
      for (const e of await listDir(ctx, dir)) {
        if (e.dir || !e.name.endsWith('.md') || e.name === 'MEMORY.md') continue
        const note = await readText(ctx, join(dir, e.name))
        if (note !== null) for (const w of contentWords(note, { cap: Infinity })) ctx.words.add(w)
      }
    }
  }

  // ---- explicit sorts, so the same tree always serializes the same bytes ----
  claudeMd.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  settings.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  agents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  plugins.sort(byKey((p: HarnessPluginEntry) => p.key))
  mcpServers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))
  ctx.unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))

  return {
    claudeMd,
    memoryIndexes,
    settings,
    skills,
    agents,
    plugins,
    mcpServers,
    ...(usageCounters ? { usageCounters } : {}),
    totals: {
      filesRead: ctx.filesRead,
      bytesRead: ctx.bytesRead,
      claudeMdBytes: claudeMd.reduce((n, m) => n + m.bytes, 0),
      claudeMdApproxTokens: claudeMd.reduce((n, m) => n + m.approxTokens, 0),
      skills: skills.length,
      agents: agents.length,
      plugins: plugins.length,
      // distinct NAMES: one server declared by `.mcp.json` and named again by a toggle list is one server
      mcpServers: new Set(mcpServers.map((m) => m.name)).size,
      // settings files plus the hooks of ENABLED plugins: the commands Claude Code will actually run
      hookCommands:
        settings.reduce((n, s) => n + s.hooks.reduce((k, h) => k + h.commands, 0), 0) +
        plugins.reduce((n, p) => n + (p.enabled ? p.hooks : 0), 0),
      projectEntries,
    },
    unreadable: ctx.unreadable,
  }
}
