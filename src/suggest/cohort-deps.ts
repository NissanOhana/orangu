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
import { cohortFactsKey, sidecarTree, type CohortFactsCache } from './cohort-cache.js'
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
 * The sidecar transcripts of a session as the evidence manifest finds them: each `agent-*.jsonl` file of `sidecarTree`
 * (`cohort-cache.ts`), which the cache key reads too. A tree past a limit gives the files found so far, and the full
 * read then decides.
 */
async function sidecarTranscripts(path: string): Promise<string[]> {
  return (await sidecarTree(path)).transcripts.map((entry) => entry.path)
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

/** A skip of a miss, kept for 1 read: the session, the key of its files, the cap of the load and the load. */
interface KeptSkip {
  sessionId: string
  key: string
  maxBytes: number
  load: CohortLoad
}

/**
 * True when a skip over the cap of its load (the evidence cap, or what was left of its side) at `kept.maxBytes` also
 * holds at `maxBytes`: a cap that is not larger, and that is larger than the probe bytes of the skip. With the same
 * files and the same `now`, the trusted loader then reads the same probe bytes (each probe window fits inside the cap)
 * and leaves a smaller cap for the full read. That read refuses again: the declared size check does not use the cap,
 * and the check before each file uses what is left of the cap, in file order. So it gives the same skip and the same
 * bytes.
 */
function overCapHolds(kept: KeptSkip, maxBytes: number): boolean {
  return 'skip' in kept.load && kept.load.skip === 'over-budget' && kept.load.bytesRead < maxBytes && maxBytes <= kept.maxBytes
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
 *
 * The cache holds the facts of settled sessions and 1 kind of skip: a session over the cap of its load. No other skip
 * goes into the cache. So a miss that ends in a skip (a session over the evidence cap, an unreadable one, or one that
 * still settles) is kept in memory for this instance, by path, with its key and its cap. A
 * later load of the same session with the same key and the same cap gets the same skip and the same bytes, and it reads
 * no file and calls no loader: the files, `now` and the cap are the same, so the trusted loader would give the same
 * skip. A changed file moves its key, so it loads again. Without this, each record of 1 read probes, walks and refuses
 * the same session again.
 *
 * A skip over the cap of its load also holds at a smaller cap above its probe bytes (`overCapHolds`). That skip goes
 * into the cache too, under the key of the files, so a later read with no changed file loads no such session. A
 * session over the 64 MiB evidence cap has no facts to keep, so without this each warm read probes and walks it again.
 */
export function createCachedCohortDeps(options: CachedCohortDepsOptions): CachedCohortDeps {
  const base = options.base ?? createCohortDeps({ now: options.now })
  const list = options.listSessions ?? (async (cwd: string) => listSessions({ roots: await claudeRoots(), cwd, maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS }))
  const listings = new Map<string, Promise<SessionRef[]>>()
  const refs = new Map<string, SessionRef>()
  const skips = new Map<string, KeptSkip>()
  const keptSkip = (candidate: CohortCandidate, key: string, maxBytes: number): CohortLoad | undefined => {
    const kept = skips.get(candidate.path)
    if (!kept || kept.sessionId !== candidate.sessionId || kept.key !== key) return undefined
    return kept.maxBytes === maxBytes || overCapHolds(kept, maxBytes) ? { ...kept.load } : undefined
  }
  const keepSkip = (candidate: CohortCandidate, key: string | undefined, maxBytes: number, load: CohortLoad): CohortLoad => {
    if (key === undefined || !('skip' in load)) return load
    // A skip over the cap at a cap that is not smaller stays: it holds for more caps.
    const kept = skips.get(candidate.path)
    const keptOverCap = kept && 'skip' in kept.load && kept.load.skip === 'over-budget'
    if (kept && keptOverCap && kept.sessionId === candidate.sessionId && kept.key === key && kept.maxBytes >= maxBytes) return load
    skips.set(candidate.path, { sessionId: candidate.sessionId, key, maxBytes, load: { ...load } })
    return load
  }
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
      // The cap of a skip over the cap that the cache holds for these files, so a smaller cap never replaces it.
      let storedCap = 0
      if (identity) {
        const now = options.now()
        if (!Number.isFinite(now) || now < identity.changedAt || now - identity.changedAt < MIN_VERIFICATION_QUIET_MS) return settlingSkip(candidate.path, 0, maxBytes)
        const skipped = keptSkip(candidate, identity.key, maxBytes)
        if (skipped) return skipped
        const entry = options.cache ? await options.cache.lookup(identity.key, candidate.sessionId) : undefined
        if (entry && 'overCap' in entry) {
          const kept: KeptSkip = {
            sessionId: candidate.sessionId,
            key: identity.key,
            maxBytes: entry.overCap.maxBytes,
            load: { skip: 'over-budget', bytesRead: entry.overCap.bytesRead },
          }
          storedCap = kept.maxBytes
          if (overCapHolds(kept, maxBytes)) {
            // The same files refuse again at this cap, and the hit spends the probe bytes of the refused load.
            cacheHits++
            skips.set(candidate.path, kept)
            return { ...kept.load }
          }
        }
        const facts = entry && 'facts' in entry ? entry.facts : undefined
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
      if (tail.partial) return keepSkip(candidate, identity?.key, maxBytes, await settlingSkip(candidate.path, tail.bytesRead, maxBytes))
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
      if ('skip' in loaded && loaded.skip === 'over-budget' && cap === maxBytes && storedCap < maxBytes && options.cache && ref && identity) {
        // Store the skip only when the files did not change during the load, as for the facts.
        const after = await cohortFactsKey(ref)
        if (after?.key === identity.key) await options.cache.putOverCap(identity.key, { sessionId: candidate.sessionId, maxBytes, bytesRead: loaded.bytesRead })
      }
      // A skip at a cap that the read budget cut is not the skip of `maxBytes`, so it is not kept.
      return cap === maxBytes ? keepSkip(candidate, identity?.key, maxBytes, loaded) : loaded
    },
    canonicalWorkspace: (identity) => base.canonicalWorkspace(identity),
    stats: () => ({ loaderCalls, missBytes, cacheHits }),
  }
}
