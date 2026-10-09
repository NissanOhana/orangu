/**
 * The live session list of orangu god: `claude agents --json`, the registry files `<home>/.claude/sessions/<pid>.json`,
 * and the liveness rule that merges them into 1 live session per session id.
 *
 * Each read returns plain data or a source failure and never throws, so the collector can keep the last good facts
 * of a source that failed. The registry read lists the folder and reads only the `<pid>.json` files whose size or
 * mtime changed since the last read. It reads no other file of that folder: the folder also holds `.key` files.
 *
 * The liveness rule. A session is live when its PID is in the last agents list, or when its registry file is newer
 * than that list: a clean exit deletes the file, but a crash leaves it, and the next list drops it. When the agents
 * list fails, a PID counts only when `ps` in UTC shows the start time that the file writes as procStart, because
 * macOS can give the PID of a dead session to a new process.
 */
import type { Host, RunOptions, RunResult } from '../host.js'
import type { AgentRow, LiveSession, RegistryRow, SessionStatus, SourceState } from '../types.js'

/** Why a read gave no data: off (the read failed) or missing (the command is not on the machine). */
export type SourceFailure = { ok: false; status: Extract<SourceState['status'], 'off' | 'missing'>; reason: string }

/** What 1 read of a source gives: its data, or a failure with a short reason that holds no session text. */
export type SourceResult<T> = { ok: true; value: T } | SourceFailure

/**
 * Cleans 1 outside text (a session name, a waiting reason, a cmux title) before it enters a fact: the collector
 * passes the sanitizer and then the redaction. A path that a later command takes (a cwd) is not cleaned.
 */
export type CleanText = (text: string) => string

/** The failure of a read, as the collector shows it. */
export function off(reason: string): SourceFailure {
  return { ok: false, status: 'off', reason }
}

/** The reason for a command that did not run: it did not start, or it ran for too long. */
export function notRunReason(command: string): string {
  return `The ${command} command did not run.`
}

/** The reason for a command that stopped with an exit code that the read does not accept. */
export function exitReason(command: string, exitCode: number): string {
  return `The ${command} command stopped with exit code ${exitCode}.`
}

/** The reason for an output that the read cannot use. */
export function formReason(command: string): string {
  return `The ${command} output has a form that the mod cannot read.`
}

const REGISTRY_UNREAD = 'The mod cannot read the registry folder.'
const AGENTS_UNREAD = 'The mod cannot read the claude agents list.'

const STATUSES: readonly SessionStatus[] = ['busy', 'idle', 'waiting']
/** A session id is 1 path segment: it names the transcript file, so it can hold no slash and no dot. */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*$/
/** A registry file name: the PID and `.json`, nothing more. */
const REGISTRY_FILE = /^[1-9][0-9]*\.json$/

/** 1 parsed JSON object. */
export type JsonObject = { readonly [key: string]: unknown }
export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const isStatus = (value: unknown): value is SessionStatus => STATUSES.includes(value as SessionStatus)
const timeOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** The value of a JSON text, or nothing when it does not parse. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Runs 1 command and gives its result at any exit code, or nothing when it did not start or ran too long. */
export async function tryRun(host: Host, argv: readonly string[], options?: RunOptions): Promise<RunResult | undefined> {
  try {
    return await host.run(argv, options)
  } catch {
    return undefined
  }
}

/** The length of the session id start that names a session with no name. */
const SHORT_ID_LENGTH = 8

/**
 * The name of a session: the cleaned name, or the first 8 characters of the session id when the name is absent,
 * empty or blank. A row always has a name, because the overlap flag on another row shows it.
 */
function sessionName(name: unknown, sessionId: string, clean: CleanText): string {
  const cleaned = clean(textOf(name) ?? '')
  return cleaned.trim() === '' ? sessionId.slice(0, SHORT_ID_LENGTH) : cleaned
}

/** 1 agents row from 1 parsed value, or nothing when the PID, the session id, the cwd or the status is wrong. */
function agentRow(value: unknown, clean: CleanText): AgentRow | undefined {
  if (!isObject(value)) return undefined
  const { pid, sessionId, cwd, status } = value
  if (!isPid(pid) || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined
  if (typeof cwd !== 'string' || cwd === '' || !isStatus(status)) return undefined
  const row: AgentRow = { pid, sessionId, cwd, name: sessionName(value.name, sessionId, clean), kind: textOf(value.kind) ?? '', status }
  const waitingFor = textOf(value.waitingFor)
  if (status === 'waiting' && waitingFor !== undefined) row.waitingFor = clean(waitingFor)
  const startedAt = timeOf(value.startedAt)
  if (startedAt !== undefined) row.startedAt = startedAt
  return row
}

/** The rows of `claude agents --json`, or nothing when the output is not a JSON list. A bad row counts and gives no row. */
export function parseAgents(stdout: string, clean: CleanText): { rows: AgentRow[]; parseErrors: number } | undefined {
  const list = parseJson(stdout)
  if (!Array.isArray(list)) return undefined
  const rows: AgentRow[] = []
  let parseErrors = 0
  for (const value of list) {
    const row = agentRow(value, clean)
    if (row) rows.push(row)
    else parseErrors += 1
  }
  return { rows, parseErrors }
}

/** The last good agents list, and the clock before the command ran: a registry file newer than that is live. */
export type AgentsList = { rows: readonly AgentRow[]; listedAt: number; parseErrors: number }

/** Runs `claude agents --json` once. */
export async function readAgents(host: Host, clean: CleanText): Promise<SourceResult<AgentsList>> {
  try {
    const listedAt = await host.now()
    const result = await tryRun(host, ['claude', 'agents', '--json'])
    if (!result) return off(notRunReason('claude agents'))
    if (result.exitCode !== 0) return off(exitReason('claude agents', result.exitCode))
    const parsed = parseAgents(result.stdout, clean)
    if (!parsed) return off(formReason('claude agents'))
    return { ok: true, value: { rows: parsed.rows, listedAt, parseErrors: parsed.parseErrors } }
  } catch {
    return off(AGENTS_UNREAD)
  }
}

/** The registry folder under the home folder. */
export function registryFolder(home: string): string {
  return `${home}/.claude/sessions`
}

/** 1 registry file as the last read saw it: its size and mtime from the listing, and its row. */
export type RegistryEntry = { size: number; mtimeMs: number; row: RegistryRow }

/** The registry files of the last read by file name. The collector keeps it between reads. */
export type RegistryCache = { readonly [fileName: string]: RegistryEntry }

/** 1 read of the registry folder. */
export type RegistryRead = {
  /** 1 row per file that parsed, by PID */
  rows: readonly RegistryRow[]
  /** the cache for the next read */
  cache: RegistryCache
  /** the files that did not parse, or that name another PID: each is read again on the next read */
  parseErrors: number
  /** the files that this read read, for the refresh stats */
  filesRead: number
}

/** 1 registry row from the text of the file `<pid>.json`, or nothing when it does not parse or names another PID. */
function registryRow(fileName: string, body: string, fileMtimeMs: number, clean: CleanText): RegistryRow | undefined {
  const value = parseJson(body)
  const row = agentRow(value, clean)
  if (!row || !isObject(value) || fileName !== `${row.pid}.json`) return undefined
  const out: RegistryRow = { ...row, fileMtimeMs }
  const statusUpdatedAt = timeOf(value.statusUpdatedAt)
  if (statusUpdatedAt !== undefined) out.statusUpdatedAt = statusUpdatedAt
  const procStart = textOf(value.procStart)
  if (procStart !== undefined) out.procStart = procStart
  const version = textOf(value.version)
  if (version !== undefined) out.version = version
  return out
}

/** Lists the registry folder and reads each `<pid>.json` file that is new or whose size or mtime changed. */
export async function readRegistry(host: Host, home: string, cache: RegistryCache, clean: CleanText): Promise<SourceResult<RegistryRead>> {
  const folder = registryFolder(home)
  try {
    const entries = await host.list(folder)
    const next: Record<string, RegistryEntry> = {}
    let parseErrors = 0
    let filesRead = 0
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.isLink || !REGISTRY_FILE.test(entry.name)) continue
      const known = cache[entry.name]
      if (known && known.size === entry.size && known.mtimeMs === entry.mtimeMs) {
        next[entry.name] = known
        continue
      }
      let body: string
      try {
        body = await host.read(`${folder}/${entry.name}`)
      } catch {
        continue // the session ended between the list and the read
      }
      filesRead += 1
      const row = registryRow(entry.name, body, entry.mtimeMs, clean)
      if (row) next[entry.name] = { size: entry.size, mtimeMs: entry.mtimeMs, row }
      else parseErrors += 1
    }
    const rows = Object.values(next)
      .map((entry) => entry.row)
      .sort((a, b) => a.pid - b.pid)
    return { ok: true, value: { rows, cache: next, parseErrors, filesRead } }
  } catch {
    return off(REGISTRY_UNREAD)
  }
}

/** The start time of 1 process as `ps -o lstart=` writes it in UTC, trimmed. */
export type ProcStart = { pid: number; lstart: string }

/** What the liveness rule reads. */
export type LivenessInput = {
  /** the last agents list; absent when the last agents read failed or has not run */
  agents?: AgentsList
  /** the rows of the last registry read */
  registry: readonly RegistryRow[]
  /** the start times from `ps` in UTC: the rule reads them only when the agents list is absent */
  procStarts?: readonly ProcStart[]
}

/** The live fields of a registry row: its status time becomes statusSince, and the file-only fields go. */
function fromRegistry(file: RegistryRow): LiveSession {
  const { fileMtimeMs: _mtime, procStart: _procStart, statusUpdatedAt, ...row } = file
  return statusUpdatedAt === undefined ? row : { ...row, statusSince: statusUpdatedAt }
}

/**
 * 1 PID that both sources have. The agents list gives the PID, the session id, the cwd, the name and the kind. The
 * registry file gives the status, the waiting reason, the status time and the version, because the 2 s registry
 * read sees a new wait before the next agents list.
 */
function merged(agent: AgentRow, file: RegistryRow | undefined): LiveSession {
  if (!file) return { ...agent }
  const { waitingFor: _waitingFor, ...identity } = agent
  const { status, waitingFor, statusSince, version } = fromRegistry(file)
  const startedAt = agent.startedAt ?? file.startedAt
  const live: LiveSession = { ...identity, status }
  if (waitingFor !== undefined) live.waitingFor = waitingFor
  if (startedAt !== undefined) live.startedAt = startedAt
  if (statusSince !== undefined) live.statusSince = statusSince
  if (version !== undefined) live.version = version
  return live
}

/** 1 row per session id: when 2 live PIDs share an id, the process that started last stays. */
function bySessionId(candidates: readonly LiveSession[]): LiveSession[] {
  const kept = new Map<string, LiveSession>()
  for (const candidate of candidates) {
    const known = kept.get(candidate.sessionId)
    if (!known || (candidate.startedAt ?? -Infinity) > (known.startedAt ?? -Infinity)) kept.set(candidate.sessionId, candidate)
  }
  return [...kept.values()].sort((a, b) => a.pid - b.pid)
}

/** The live sessions, 1 per session id, by PID. */
export function liveSessions(input: LivenessInput): LiveSession[] {
  const files = new Map(input.registry.map((row) => [row.pid, row]))
  if (input.agents) {
    const { rows, listedAt } = input.agents
    const listed = new Set(rows.map((row) => row.pid))
    const newer = input.registry.filter((row) => !listed.has(row.pid) && row.fileMtimeMs > listedAt)
    return bySessionId([...rows.map((row) => merged(row, files.get(row.pid))), ...newer.map(fromRegistry)])
  }
  const starts = new Map((input.procStarts ?? []).map((start) => [start.pid, start.lstart]))
  const proven = input.registry.filter((row) => row.procStart !== undefined && starts.get(row.pid) === row.procStart)
  return bySessionId(proven.map(fromRegistry))
}
