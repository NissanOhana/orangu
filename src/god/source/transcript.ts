/**
 * The transcript reader of orangu god. It keeps 1 cursor for each session transcript and reads only what the
 * file added since the last tick, through the host port. It gives the parsed records and the new cursor. It
 * does not reduce the records to facts, and it does not sanitize or redact them: the record reducer does that.
 *
 * The rules of a read:
 * - The path is <home>/.claude/projects/<projectSlug(cwd)>/<sessionId>.jsonl. When no file is there, the reader
 *   looks for <sessionId>.jsonl in each project folder, once. It keeps the first path that gave a file.
 * - The first read takes the last 512 KiB: `tail -c +<start+1>`, with the start from the size that the stat gave,
 *   so the reader knows the byte where the read starts. When that part holds no title record, the reader takes
 *   the bytes before it, at most 64 KiB, once (`head -c`).
 * - Each later read takes the bytes after the offset. A line is whole only when its newline came: a partial last
 *   line waits for the next read.
 * - A smaller file or a new inode reads again from the end. The engine stat gives no inode, so 1 `stat -f '%i %N'`
 *   on each tick gives the inodes of all the transcripts whose size or mtime changed.
 * - An offset counts UTF-8 bytes, never string length.
 * - A host command gives at most 4 MiB of standard output. A read that stops at that limit takes only its whole
 *   lines, and the next tick reads on. A line longer than the limit counts once as a parse error, and the reader
 *   goes past it.
 * - A line that does not parse as a JSON object counts as a parse error and never stops the read. An empty line
 *   counts nothing.
 */
import { projectSlug } from '../../discover/slug.js'
import type { DirEntry, FileStat, Host } from '../host.js'

/** The first read takes this many bytes from the end of the file. */
export const TAIL_BYTES = 524_288
/** When the first read holds no title record, the reader takes at most this many bytes from the start, once. */
export const HEAD_BYTES = 65_536
/** A host command gives at most this many bytes of standard output. */
export const STDOUT_CAP_BYTES = 4_194_304

/** 1 parsed line of a transcript: a JSON object as the file writes it, not sanitized and not redacted. */
export type TranscriptRecord = Record<string, unknown>

/**
 * Where the next read starts:
 * - line: just after a newline, or at the start of the file, so the first line of the read is whole;
 * - cut: possibly inside a line. The first line of the read is whole only when it parses. Else it is the rest of
 *   a cut line, and the reader drops it and counts nothing.
 */
export type ReadEdge = 'line' | 'cut'

/** What the reader knows of a file after a read. Plain JSON data. */
export type ReadPosition = {
  /** the byte just after the last line that the reader took: the next read starts here */
  offset: number
  edge: ReadEdge
  /** the size and mtime that the stat gave before the read: a change in either starts the next read */
  size: number
  mtimeMs: number
  /** the inode at the read, when `stat -f` gave one */
  inode?: string
  /** true when the read stopped at the 4 MiB limit: the next tick reads on, with no change in the file */
  hasMore: boolean
}

/** The state of the reader of 1 transcript, kept between ticks. Plain JSON data. */
export type TranscriptCursor = {
  sessionId: string
  /** the transcript file, kept once a stat or the search found it */
  path?: string
  /** true once the search by file name ran, with a result or not */
  isSearched: boolean
  /** absent until the first read of the file, and again after the file went missing */
  position?: ReadPosition
}

/** 1 session to read: its id, its working directory and the cursor of the last tick (absent at first sight). */
export type TranscriptTarget = { sessionId: string; cwd: string; cursor?: TranscriptCursor }

/** Why a read gave nothing: a command that exited with an error, or a host call that rejected. */
export type ReadFailure = 'exit-code' | 'rejected'

/**
 * What 1 tick gave for 1 transcript. Each arm has the cursor for the next tick.
 * - missing: no file. The row shows only the registry facts.
 * - unchanged: the file did not change, and no command ran.
 * - read: the records of the whole lines after the offset, in file order. isFresh is true when the read started
 *   again from the end (the first read, a smaller file, a new inode): the reducer drops what it made from the
 *   earlier records. headRecords are the first records of the file, for the title order only: the bytes between
 *   them and the records were not read, so a tool use in them has no result to pair with. parseErrors counts the
 *   lines of this read only.
 * - failed: a command failed. The cursor stays as it was, so the next tick tries again.
 */
export type TranscriptRead =
  | { status: 'missing'; cursor: TranscriptCursor }
  | { status: 'unchanged'; cursor: TranscriptCursor; mtimeMs: number }
  | {
      status: 'read'
      cursor: TranscriptCursor
      mtimeMs: number
      isFresh: boolean
      records: readonly TranscriptRecord[]
      headRecords: readonly TranscriptRecord[]
      parseErrors: number
    }
  | { status: 'failed'; cursor: TranscriptCursor; mtimeMs: number; failure: ReadFailure }

const TITLE_TYPES: ReadonlySet<unknown> = new Set(['custom-title', 'ai-title'])
const REPLACEMENT = '�'
const encoder = new TextEncoder()

const projectsDir = (home: string): string => `${home}/.claude/projects`

/** The path of a transcript: the project folder of the cwd, then the session id. */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${projectsDir(home)}/${projectSlug(cwd)}/${sessionId}.jsonl`
}

/** The record of 1 line: a JSON object, or null for any other line. */
function parseRecord(line: string): TranscriptRecord | null {
  if (!line.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as TranscriptRecord) : null
  } catch {
    return null
  }
}

/**
 * The UTF-8 bytes of the text of a read. A read from a cut edge can start inside a character, with at most 3 lone
 * continuation bytes. The engine decodes each of them as U+FFFD, which encodes to 3 bytes, so each U+FFFD among
 * the first 3 characters counts 1 byte. A decoder that drops such a byte, or a real U+FFFD there, makes the count
 * short, never long: the next read then starts in the line before, and its cut edge drops that rest.
 */
function byteLength(text: string, edge: ReadEdge): number {
  let lead = 0
  if (edge === 'cut') while (lead < 3 && text[lead] === REPLACEMENT) lead += 1
  return lead + encoder.encode(lead ? text.slice(lead) : text).length
}

/** What the text of 1 read gave: the records of its whole lines, the lines that did not parse, the bytes taken and the next edge. */
export type LineRead = { records: TranscriptRecord[]; parseErrors: number; bytes: number; edge: ReadEdge }

/** Parses the whole lines of the text of 1 read that started at `edge`. The part after the last newline waits. */
export function parseLines(text: string, edge: ReadEdge, isTruncated: boolean): LineRead {
  const end = text.lastIndexOf('\n') + 1
  if (end === 0) {
    // 4 MiB with no newline is a line too long to read: go past its bytes, and count it once
    if (isTruncated) return { records: [], parseErrors: edge === 'line' ? 1 : 0, bytes: STDOUT_CAP_BYTES, edge: 'cut' }
    return { records: [], parseErrors: 0, bytes: 0, edge }
  }
  const records: TranscriptRecord[] = []
  let parseErrors = 0
  let next: ReadEdge = 'line'
  text
    .slice(0, end - 1)
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const record = parseRecord(line)
      if (index === 0 && edge === 'cut' && !record) next = 'cut'
      else if (record) records.push(record)
      else if (line.length > 0) parseErrors += 1
    })
  return { records, parseErrors, bytes: byteLength(text.slice(0, end), edge), edge: next }
}

const isTitle = (record: TranscriptRecord): boolean => TITLE_TYPES.has(record['type'])

const isChanged = (position: ReadPosition | undefined, stat: FileStat): boolean =>
  !position || position.size !== stat.size || position.mtimeMs !== stat.mtimeMs

/** The stat of a regular file. A missing path, a folder and a link give none. */
async function fileStat(host: Host, path: string): Promise<FileStat | undefined> {
  const stat = await host.stat(path).catch(() => undefined)
  return stat && stat.kind === 'file' && !stat.isLink ? stat : undefined
}

function withoutPosition(cursor: TranscriptCursor): TranscriptCursor {
  return { sessionId: cursor.sessionId, isSearched: cursor.isSearched, ...(cursor.path !== undefined ? { path: cursor.path } : {}) }
}

type Located = { cursor: TranscriptCursor; path?: string; stat?: FileStat }

/** Finds `<sessionId>.jsonl` in the project folders, in name order: 1 list for each tick, then 1 stat for each folder. */
async function search(host: Host, home: string, sessionId: string, projects: () => Promise<readonly DirEntry[]>): Promise<(FileStat & { path: string }) | undefined> {
  const paths = (await projects())
    .filter((entry) => entry.kind === 'dir' && !entry.isLink)
    .map((entry) => entry.name)
    .sort()
    .map((name) => `${projectsDir(home)}/${name}/${sessionId}.jsonl`)
  const stats = await Promise.all(paths.map((path) => fileStat(host, path)))
  const index = stats.findIndex((stat) => stat !== undefined)
  const stat = stats[index]
  const path = paths[index]
  return stat && path !== undefined ? { ...stat, path } : undefined
}

async function locate(host: Host, home: string, target: TranscriptTarget, projects: () => Promise<readonly DirEntry[]>): Promise<Located> {
  const cursor = target.cursor ?? { sessionId: target.sessionId, isSearched: false }
  const path = cursor.path ?? transcriptPath(home, target.cwd, target.sessionId)
  const stat = await fileStat(host, path)
  if (stat) return { cursor: { ...cursor, path }, path, stat }
  if (cursor.path !== undefined || cursor.isSearched) return { cursor: withoutPosition(cursor) }
  const searched = { ...withoutPosition(cursor), isSearched: true }
  const found = await search(host, home, target.sessionId, projects)
  if (!found) return { cursor: searched }
  const { path: foundPath, ...foundStat } = found
  return { cursor: { ...searched, path: foundPath }, path: foundPath, stat: foundStat }
}

/** The inode of each path, from 1 `stat -f '%i %N'` over all of them. A path that the command did not name has none. */
async function readInodes(host: Host, paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const inodes = new Map<string, string>()
  if (paths.length === 0) return inodes
  const result = await host.run(['stat', '-f', '%i %N', ...new Set(paths)]).catch(() => undefined)
  for (const row of result?.stdout.split('\n') ?? []) {
    const match = /^(\d+) (.+)$/.exec(row)
    if (match?.[1] !== undefined && match[2] !== undefined) inodes.set(match[2], match[1])
  }
  return inodes
}

const NO_LINES: LineRead = { records: [], parseErrors: 0, bytes: 0, edge: 'line' }

/** The whole lines of the bytes before the tail, at most 64 KiB: undefined when `head` exits with an error. */
async function readHead(host: Host, path: string, tailStart: number): Promise<LineRead | undefined> {
  const head = await host.run(['head', '-c', String(Math.min(HEAD_BYTES, tailStart)), path])
  return head.exitCode === 0 ? parseLines(head.stdout, 'line', false) : undefined
}

async function readOne(host: Host, located: Located, inodes: ReadonlyMap<string, string>): Promise<TranscriptRead> {
  const { cursor, path, stat } = located
  if (path === undefined || stat === undefined) return { status: 'missing', cursor }
  const before = cursor.position
  const inode = inodes.get(path) ?? before?.inode
  const isNewInode = before?.inode !== undefined && inodes.has(path) && inodes.get(path) !== before.inode
  // the position that this read goes on from: none when the read starts again from the end
  const resume = before && stat.size >= before.size && stat.size >= before.offset && !isNewInode ? before : undefined
  if (resume && !isChanged(resume, stat) && !resume.hasMore) return { status: 'unchanged', cursor, mtimeMs: stat.mtimeMs }
  const start = resume ? resume.offset : Math.max(0, stat.size - TAIL_BYTES)
  const edge: ReadEdge = resume ? resume.edge : start === 0 ? 'line' : 'cut'
  const failed = (failure: ReadFailure): TranscriptRead => ({ status: 'failed', cursor, mtimeMs: stat.mtimeMs, failure })
  try {
    const tail = await host.run(['tail', '-c', `+${start + 1}`, path])
    if (tail.exitCode !== 0) return failed('exit-code')
    const lines = parseLines(tail.stdout, edge, tail.isStdoutTruncated)
    const head = !resume && start > 0 && !lines.records.some(isTitle) ? await readHead(host, path, start) : NO_LINES
    if (!head) return failed('exit-code')
    const position: ReadPosition = {
      offset: start + lines.bytes,
      edge: lines.edge,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(inode !== undefined ? { inode } : {}),
      hasMore: tail.isStdoutTruncated,
    }
    return {
      status: 'read',
      cursor: { ...cursor, position },
      mtimeMs: stat.mtimeMs,
      isFresh: !resume,
      records: lines.records,
      headRecords: head.records,
      parseErrors: lines.parseErrors + head.parseErrors,
    }
  } catch {
    return failed('rejected')
  }
}

/**
 * Reads the transcripts of 1 tick: a stat of each file (and the search for a missing one), 1 inode command for
 * the files that changed, then 1 read for each file that changed or has more to read. One failure stays with its
 * own transcript. The reads come back in the order of the targets.
 */
export async function readTranscripts(host: Host, home: string, targets: readonly TranscriptTarget[]): Promise<TranscriptRead[]> {
  let listing: Promise<readonly DirEntry[]> | undefined
  const projects = (): Promise<readonly DirEntry[]> => (listing ??= host.list(projectsDir(home)).catch(() => []))
  const located = await Promise.all(targets.map((target) => locate(host, home, target, projects)))
  const changed = located.flatMap(({ cursor, path, stat }) => (path !== undefined && stat !== undefined && isChanged(cursor.position, stat) ? [path] : []))
  const inodes = await readInodes(host, changed)
  return Promise.all(located.map((item) => readOne(host, item, inodes)))
}

// ---------- subagent files ----------

/** The fields of `agent-<id>.meta.json` that the board reads. rawDescription is as the file writes it: the collector sanitizes and redacts it. */
export type SubagentMeta = { toolUseId?: string; agentType?: string; rawDescription?: string }

/** 1 subagent transcript `<sessionId>/subagents/agent-<id>.jsonl`, with the fields of its meta file once they parsed. */
export type SubagentEntry = { agentId: string; size: number; mtimeMs: number; meta?: SubagentMeta }

const AGENT_FILE = /^agent-(.+)\.jsonl$/

async function readMeta(host: Host, path: string): Promise<SubagentMeta | undefined> {
  try {
    const value: unknown = JSON.parse(await host.read(path))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const text = (key: string): string | undefined => {
      const field = (value as Record<string, unknown>)[key]
      return typeof field === 'string' ? field : undefined
    }
    const [toolUseId, agentType, rawDescription] = [text('toolUseId'), text('agentType'), text('description')]
    return {
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(agentType !== undefined ? { agentType } : {}),
      ...(rawDescription !== undefined ? { rawDescription } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Lists the subagent files of a transcript with 1 folder list. A meta file is read once: `known` (the last list)
 * gives the meta fields that parsed before, and a meta file that did not parse is read again on the next list. A
 * link and any other name are skipped. A missing folder gives none. The entries come in agent id order.
 */
export async function listSubagents(host: Host, transcript: string, known: readonly SubagentEntry[] = []): Promise<SubagentEntry[]> {
  const dir = `${transcript.replace(/\.jsonl$/, '')}/subagents`
  const entries = await host.list(dir).catch((): readonly DirEntry[] => [])
  const files = entries.filter((entry) => entry.kind === 'file' && !entry.isLink)
  const names = new Set(files.map((entry) => entry.name))
  const knownMeta = new Map(known.flatMap((entry) => (entry.meta ? [[entry.agentId, entry.meta] as const] : [])))
  const agents = files
    .flatMap((entry) => {
      const agentId = AGENT_FILE.exec(entry.name)?.[1]
      return agentId === undefined ? [] : [{ agentId, entry }]
    })
    .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))
  return Promise.all(
    agents.map(async ({ agentId, entry }) => {
      const metaName = `agent-${agentId}.meta.json`
      const meta = knownMeta.get(agentId) ?? (names.has(metaName) ? await readMeta(host, `${dir}/${metaName}`) : undefined)
      return { agentId, size: entry.size, mtimeMs: entry.mtimeMs, ...(meta ? { meta } : {}) }
    }),
  )
}
