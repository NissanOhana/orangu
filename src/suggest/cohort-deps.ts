/**
 * Default cohort discovery and loading: every supported Claude root, filtered to the workspace's project
 * directories, each session read through its immutable evidence manifest with the 30-minute quiet gate.
 */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  loadSettledAnalysis,
  MAX_VERIFICATION_DISCOVERED_SESSIONS,
  MIN_VERIFICATION_QUIET_MS,
} from '../adapters/claude-code/discovered-analysis.js'
import { tryParseObject } from '../adapters/claude-code/jsonl.js'
import { claudeRoots, listSessions, PEEK_HEAD_BYTES, SESSION_ID_RE, type SessionRef } from '../discover/discover.js'
import { canonicalWorkspace } from './artifacts.js'
import { cohortFactsKey, type CohortFactsCache } from './cohort-cache.js'
import { metricValues, ranOranguLifecycle, type CohortCandidate, type CohortDeps, type CohortLoad } from './cohort.js'

/** The flags of a probe read: no link, and no wait for a writer on a FIFO. */
const READ_PROBE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/**
 * True when the transcript ends in a partial line, by the rule of the reader (`src/adapters/claude-code/jsonl.ts`): a
 * last line with no newline that is not a JSON object. It reads the last byte, and at most the last 64,000 B when that
 * byte is not a newline. An open last line longer than that counts as partial. Undefined when the file is not a
 * regular file or cannot be read, so the full read decides.
 */
export async function partialTail(path: string): Promise<boolean | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, READ_PROBE_FLAGS)
  } catch {
    return undefined
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return undefined
    if (st.size === 0) return false
    const last = Buffer.alloc(1)
    if ((await handle.read(last, 0, 1, st.size - 1)).bytesRead !== 1) return undefined
    if (last[0] === 0x0a) return false
    const window = Math.min(st.size, PEEK_HEAD_BYTES)
    const buffer = Buffer.alloc(window)
    let offset = 0
    while (offset < window) {
      const read = await handle.read(buffer, offset, window - offset, st.size - window + offset)
      if (read.bytesRead === 0) return undefined // the file got shorter: the full read decides
      offset += read.bytesRead
    }
    const newline = buffer.lastIndexOf(0x0a)
    if (newline === -1 && window < st.size) return true
    let line = buffer.subarray(newline + 1).toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return line.length > 0 && tryParseObject(line) === null
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
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
 * The start time of a settling session: the earliest record time in the first 64,000 B of its transcript, which the
 * parser takes as the start time when the head holds the first record. It reads through no link, parses only the
 * complete lines of the head, and gives undefined when it finds no time.
 */
export async function settlingStartedAt(path: string): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_NONBLOCK: a FIFO in place of a transcript opens at once, and the regular-file check refuses it.
    handle = await open(path, READ_PROBE_FLAGS)
  } catch {
    return undefined
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return undefined
    const size = Math.min(st.size, PEEK_HEAD_BYTES)
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
    return earliest
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

/** A settling skip, with the start time from the head of the transcript when it can be read. */
async function settlingSkip(path: string, bytesRead: number, startedAt?: number): Promise<CohortLoad> {
  const start = startedAt ?? (await settlingStartedAt(path))
  return start === undefined ? { skip: 'still-settling', bytesRead } : { skip: 'still-settling', bytesRead, startedAt: start }
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
      // A transcript that ends in a partial line still settles: find it from the end, and read none of the rest.
      if (await partialTail(candidate.path)) return settlingSkip(candidate.path, 0)
      const loaded = await loadSettledAnalysis({ path: candidate.path, sessionId: candidate.sessionId }, maxBytes, {
        requireQuiet: true,
        ...(options.now ? { now: options.now } : {}),
      })
      if ('skip' in loaded) return loaded.skip === 'still-settling' ? settlingSkip(candidate.path, loaded.bytesRead) : loaded
      const { analysis, session, bytesRead } = loaded
      const { cwd, startedAt, endedAt, live } = analysis.session
      if (live !== false) return settlingSkip(candidate.path, bytesRead, typeof startedAt === 'number' ? startedAt : undefined)
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
        if (!Number.isFinite(now) || now < identity.changedAt || now - identity.changedAt < MIN_VERIFICATION_QUIET_MS) return settlingSkip(candidate.path, 0)
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
      // A transcript that ends in a partial line is never cached: find it from the end, with no call to the loader.
      if (await partialTail(candidate.path)) return settlingSkip(candidate.path, 0)
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
