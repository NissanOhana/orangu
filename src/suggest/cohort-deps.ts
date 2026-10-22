/**
 * Default cohort discovery and loading: every supported Claude root, filtered to the workspace's project
 * directories, each session read through its immutable evidence manifest with the 30-minute quiet gate.
 */
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  loadSettledAnalysis,
  MAX_VERIFICATION_DISCOVERED_SESSIONS,
  MIN_VERIFICATION_QUIET_MS,
} from '../adapters/claude-code/discovered-analysis.js'
import { MAX_EVIDENCE_SIDECAR_DEPTH, MAX_EVIDENCE_SIDECAR_ENTRIES } from '../adapters/claude-code/evidence-input.js'
import { tryParseObject } from '../adapters/claude-code/jsonl.js'
import { claudeRoots, listSessions, PEEK_HEAD_BYTES, SESSION_ID_RE, type SessionRef } from '../discover/discover.js'
import { canonicalWorkspace } from './artifacts.js'
import { cohortFactsKey, type CohortFactsCache } from './cohort-cache.js'
import { metricValues, ranOranguLifecycle, type CohortCandidate, type CohortDeps, type CohortLoad } from './cohort.js'

/** The flags of a probe read: no link, and no wait for a writer on a FIFO. */
const READ_PROBE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
/** The most bytes that 1 probe reads from 1 file: the head window of discovery. */
const PROBE_BYTES = PEEK_HEAD_BYTES

/** Read `length` bytes at `position` into `buffer` at `offset`; false when the file got shorter. */
async function readFully(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, offset: number, length: number, position: number): Promise<boolean> {
  let done = 0
  while (done < length) {
    const read = await handle.read(buffer, offset + done, length - done, position + done)
    if (read.bytesRead === 0) return false
    done += read.bytesRead
  }
  return true
}

/**
 * Whether the file ends in a partial line, by the rule of the reader (`src/adapters/claude-code/jsonl.ts`): a last line
 * with no newline that is not a JSON object. It reads the last byte, and when that byte is not a newline, the bytes
 * before it up to 64,000 B in all, and never more than `cap`. An open last line longer than what it read counts as
 * partial. `partial` is absent when the file is not a regular file or cannot be read, so the full read decides.
 * `bytesRead` counts each byte that it read.
 */
export async function readTail(path: string, cap: number): Promise<{ partial?: boolean; bytesRead: number }> {
  const limit = Math.min(PROBE_BYTES, Math.floor(cap))
  if (!(limit >= 1)) return { bytesRead: 0 }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, READ_PROBE_FLAGS)
  } catch {
    return { bytesRead: 0 }
  }
  let bytesRead = 0
  try {
    const st = await handle.stat()
    if (!st.isFile()) return { bytesRead }
    if (st.size === 0) return { partial: false, bytesRead }
    const window = Math.min(st.size, limit)
    const buffer = Buffer.alloc(window)
    if (!(await readFully(handle, buffer, window - 1, 1, st.size - 1))) return { bytesRead }
    bytesRead = 1
    if (buffer[window - 1] === 0x0a) return { partial: false, bytesRead }
    if (window > 1 && !(await readFully(handle, buffer, 0, window - 1, st.size - window))) return { bytesRead }
    bytesRead = window
    const newline = buffer.lastIndexOf(0x0a)
    if (newline === -1 && window < st.size) return { partial: true, bytesRead }
    let line = buffer.subarray(newline + 1).toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return { partial: line.length > 0 && tryParseObject(line) === null, bytesRead }
  } catch {
    return { bytesRead }
  } finally {
    await handle.close()
  }
}

/** True when the transcript ends in a partial line (`readTail` with a cap of 64,000 B), undefined when it cannot tell. */
export async function partialTail(path: string): Promise<boolean | undefined> {
  return (await readTail(path, PROBE_BYTES)).partial
}

/**
 * The sidecar transcripts of a session as the evidence manifest finds them (`src/adapters/claude-code/evidence-input.ts`):
 * each `agent-*.jsonl` file under `<session>/subagents`, down to the depth and entry limits of the manifest. It follows
 * no link. A tree past a limit gives the files found so far, and the full read then decides.
 */
async function sidecarTranscripts(path: string): Promise<string[]> {
  const files: string[] = []
  let entries = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    const st = await lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return
    for (const name of (await readdir(dir)).sort()) {
      if (++entries > MAX_EVIDENCE_SIDECAR_ENTRIES) throw new Error('sidecar limit')
      const child = join(dir, name)
      const cst = await lstat(child)
      if (cst.isSymbolicLink()) continue
      if (cst.isDirectory()) {
        if (depth < MAX_EVIDENCE_SIDECAR_DEPTH) await walk(child, depth + 1)
      } else if (cst.isFile() && name.startsWith('agent-') && name.endsWith('.jsonl')) files.push(child)
    }
  }
  const sessionDir = join(dirname(path), basename(path, '.jsonl'))
  try {
    const st = await lstat(sessionDir)
    if (!st.isSymbolicLink() && st.isDirectory()) await walk(join(sessionDir, 'subagents'), 0)
  } catch {
    // A missing tree has no sidecar. A tree past a limit keeps the files found so far.
  }
  return files
}

/**
 * Whether a session ends in a partial line in its transcript or in 1 of its sidecar transcripts: a tail read of each
 * file, inside `cap` bytes in all. `bytesRead` counts each byte of the probes.
 */
async function sessionTail(path: string, cap: number): Promise<{ partial: boolean; bytesRead: number }> {
  const main = await readTail(path, cap)
  let bytesRead = main.bytesRead
  if (main.partial) return { partial: true, bytesRead }
  for (const file of await sidecarTranscripts(path)) {
    if (cap - bytesRead < 1) break
    const tail = await readTail(file, cap - bytesRead)
    bytesRead += tail.bytesRead
    if (tail.partial) return { partial: true, bytesRead }
  }
  return { partial: false, bytesRead }
}

/** A record time as the parser reads it (`ts` in `src/adapters/claude-code/parse.ts`): ms, seconds, or an ISO string. */
function recordTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : undefined
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : undefined
  }
  return undefined
}

/**
 * The start time of a settling session: the earliest record time in the first 64,000 B of its transcript (and never
 * more than `cap`), which the parser takes as the start time when the head holds the first record. It reads through no
 * link, parses only the complete lines of the head, and gives no time when it finds none. `bytesRead` counts the head.
 */
async function readHead(path: string, cap: number): Promise<{ startedAt?: number; bytesRead: number }> {
  const limit = Math.min(PROBE_BYTES, Math.floor(cap))
  if (!(limit >= 1)) return { bytesRead: 0 }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_NONBLOCK: a FIFO in place of a transcript opens at once, and the regular-file check refuses it.
    handle = await open(path, READ_PROBE_FLAGS)
  } catch {
    return { bytesRead: 0 }
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return { bytesRead: 0 }
    const size = Math.min(st.size, limit)
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const read = await handle.read(buffer, offset, size - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    let earliest: number | undefined
    for (const line of buffer.subarray(0, offset).toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue // a partial line
      }
      const time = record && typeof record === 'object' ? recordTime((record as { timestamp?: unknown }).timestamp) : undefined
      if (time !== undefined && time > 0 && (earliest === undefined || time < earliest)) earliest = time
    }
    return earliest === undefined ? { bytesRead: offset } : { startedAt: earliest, bytesRead: offset }
  } catch {
    return { bytesRead: 0 }
  } finally {
    await handle.close()
  }
}

/** The start time of a settling session from the head of its transcript, or undefined. */
export async function settlingStartedAt(path: string): Promise<number | undefined> {
  return (await readHead(path, PROBE_BYTES)).startedAt
}

/**
 * A settling skip: the bytes read so far, plus the head read for the start time when the caller has none. The head
 * read stays inside what is left of `cap`, so the skip never counts more than the cap of its load.
 */
async function settlingSkip(path: string, bytesRead: number, cap: number, startedAt?: number): Promise<CohortLoad> {
  if (startedAt !== undefined) return { skip: 'still-settling', bytesRead, startedAt }
  const head = await readHead(path, cap - bytesRead)
  const total = bytesRead + head.bytesRead
  return head.startedAt === undefined ? { skip: 'still-settling', bytesRead: total } : { skip: 'still-settling', bytesRead: total, startedAt: head.startedAt }
}

export function createCohortDeps(options: { now?: () => number } = {}): CohortDeps {
  return {
    async listCandidates(cwd) {
      const refs = await listSessions({ roots: await claudeRoots(), cwd, maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS })
      return refs
        .filter((ref) => SESSION_ID_RE.test(ref.sessionId))
        .map((ref) => ({ sessionId: ref.sessionId.toLowerCase(), path: ref.path, mtimeMs: ref.mtimeMs }))
    },
    async loadCandidate(candidate, maxBytes) {
      // A session whose transcript or sidecar transcript ends in a partial line still settles: find it from the ends
      // of its files, and read none of the rest. Every byte of the probes counts, and the full read gets what is left.
      const tail = await sessionTail(candidate.path, maxBytes)
      if (tail.partial) return settlingSkip(candidate.path, tail.bytesRead, maxBytes)
      const left = maxBytes - tail.bytesRead
      if (left < 1) return { skip: 'over-budget', bytesRead: tail.bytesRead }
      const loaded = await loadSettledAnalysis({ path: candidate.path, sessionId: candidate.sessionId }, left, {
        requireQuiet: true,
        ...(options.now ? { now: options.now } : {}),
      })
      if ('skip' in loaded) {
        if (loaded.skip === 'still-settling') return settlingSkip(candidate.path, tail.bytesRead + loaded.bytesRead, maxBytes)
        return { skip: loaded.skip, bytesRead: tail.bytesRead + loaded.bytesRead }
      }
      const { analysis, session } = loaded
      const bytesRead = tail.bytesRead + loaded.bytesRead
      const { cwd, startedAt, endedAt, live } = analysis.session
      if (live !== false) return settlingSkip(candidate.path, bytesRead, maxBytes, typeof startedAt === 'number' ? startedAt : undefined)
      if (
        typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0 ||
        typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt < startedAt ||
        typeof cwd !== 'string' || !isAbsolute(cwd)
      ) return { skip: 'unreadable', bytesRead }
      let canonicalCwd = cwd
      try {
        canonicalCwd = await realpath(cwd)
      } catch {
        // A cwd that no longer exists cannot match the (existing) workspace; it is skipped as another workspace.
      }
      let metrics: ReturnType<typeof metricValues>
      try {
        metrics = metricValues(analysis)
      } catch {
        return { skip: 'unreadable', bytesRead }
      }
      return {
        session: { id: analysis.session.id, path: candidate.path, cwd: canonicalCwd, ranOrangu: ranOranguLifecycle(session), startedAt, endedAt, metrics },
        bytesRead,
      }
    },
    canonicalWorkspace,
  }
}

/** The queue check of 1 item needs a transcript read past the byte budget of its read, so the item is deferred. */
export class CohortReadDeferred extends Error {
  constructor() {
    super('the queue check reached its byte budget')
    this.name = 'CohortReadDeferred'
  }
}

export interface CachedCohortDepsOptions {
  /** the clock of the settle rule, fixed for 1 read */
  now: () => number
  /** the most transcript bytes that this instance reads on a cache miss, over every item of 1 read */
  budgetBytes: number
  /** the cohort facts cache, or null with `--no-cache` */
  cache: CohortFactsCache | null
  /** the loaders of a miss: the trusted loaders of `createCohortDeps` by default */
  base?: CohortDeps
  /** the sessions of a canonical workspace: every Claude root by default */
  listSessions?: (cwd: string) => Promise<SessionRef[]>
}

export interface CachedCohortDeps extends CohortDeps {
  /** `loaderCalls` counts the calls to the loader of a miss, and `missBytes` the bytes that they read */
  stats(): { loaderCalls: number; missBytes: number; cacheHits: number }
}

/**
 * The trusted loaders of `createCohortDeps` behind the cohort facts cache, for the queue only. The record steps keep
 * the trusted loaders, so a cache entry never reaches a stored verdict.
 *
 * Per candidate: a transcript that changed within the quiet time at `now` still settles, and it is not read (its
 * start time comes from the head). Else a valid cache entry gives the facts and the bytes of the trusted read, which
 * the side budget spends as before, so a hit never changes which sessions a side takes. Else the trusted loader reads it inside
 * what is left of `budgetBytes`, and the facts of a settled session go into the cache. A miss past the budget throws
 * `CohortReadDeferred`, so the item is deferred and is never graded on a part of its cohort.
 */
export function createCachedCohortDeps(options: CachedCohortDepsOptions): CachedCohortDeps {
  const base = options.base ?? createCohortDeps({ now: options.now })
  const list = options.listSessions ?? (async (cwd: string) => listSessions({ roots: await claudeRoots(), cwd, maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS }))
  const listings = new Map<string, Promise<SessionRef[]>>()
  const refs = new Map<string, SessionRef>()
  let loaderCalls = 0
  let missBytes = 0
  let cacheHits = 0
  return {
    async listCandidates(cwd: string): Promise<CohortCandidate[]> {
      let listing = listings.get(cwd)
      if (!listing) {
        listing = list(cwd)
        listings.set(cwd, listing)
      }
      const found = (await listing).filter((ref) => SESSION_ID_RE.test(ref.sessionId))
      for (const ref of found) refs.set(ref.path, ref)
      return found.map((ref) => ({ sessionId: ref.sessionId.toLowerCase(), path: ref.path, mtimeMs: ref.mtimeMs }))
    },
    async loadCandidate(candidate, maxBytes) {
      const ref = refs.get(candidate.path)
      const identity = ref ? await cohortFactsKey(ref) : undefined
      if (identity) {
        const now = options.now()
        if (!Number.isFinite(now) || now < identity.changedAt || now - identity.changedAt < MIN_VERIFICATION_QUIET_MS) return settlingSkip(candidate.path, 0, maxBytes)
        const facts = options.cache ? await options.cache.get(identity.key, candidate.sessionId) : undefined
        if (facts) {
          cacheHits++
          // A hit spends the side budget that the trusted read spent, so a warm read takes the same sessions as a cold
          // one. Past the cap of this load the trusted read refuses before it reads, so a hit does the same.
          if (facts.bytesRead > maxBytes) return { skip: 'over-budget', bytesRead: 0 }
          // The key order of a trusted load, so a warm read gives the same bytes as a cold one.
          return {
            session: { id: facts.sessionId, path: candidate.path, cwd: facts.cwd, ranOrangu: facts.ranOrangu, startedAt: facts.startedAt, endedAt: facts.endedAt, metrics: facts.metrics },
            bytesRead: facts.bytesRead,
          }
        }
      }
      // A session that ends in a partial line, in its transcript or in a sidecar, is never cached: find it from the
      // ends of its files, with no call to the loader. The probe bytes of a settling session count. For any other
      // session the trusted loader probes the same ends again and counts them, so a warm read spends what it spends.
      const tail = await sessionTail(candidate.path, maxBytes)
      if (tail.partial) return settlingSkip(candidate.path, tail.bytesRead, maxBytes)
      const remaining = options.budgetBytes - missBytes
      if (!(remaining >= 1)) throw new CohortReadDeferred()
      const cap = Math.min(maxBytes, remaining)
      loaderCalls++
      const loaded = await base.loadCandidate(candidate, cap)
      missBytes += loaded.bytesRead
      // Past the budget of the read, not of the side: the cohort is not complete, so the item waits for a later read.
      if ('skip' in loaded && loaded.skip === 'over-budget' && cap < maxBytes) throw new CohortReadDeferred()
      if ('session' in loaded && options.cache && ref && identity) {
        // Store the facts only when the transcript did not change during the read.
        const after = await cohortFactsKey(ref)
        if (after?.key === identity.key) {
          const { id, cwd, startedAt, endedAt, ranOrangu, metrics } = loaded.session
          await options.cache.put(identity.key, { sessionId: id.toLowerCase(), cwd, startedAt, endedAt, ranOrangu, bytesRead: loaded.bytesRead, metrics })
        }
      }
      return loaded
    },
    canonicalWorkspace: (identity) => base.canonicalWorkspace(identity),
    stats: () => ({ loaderCalls, missBytes, cacheHits }),
  }
}
