/**
 * The board snapshot of orangu god: 1 BoardSnapshot from the facts of the last refresh, the stored choices and the
 * settings, and the check that tells the engine whether to write it.
 *
 * - makeSnapshot makes the board through buildBoard. The last snapshot that the engine wrote goes in as `previous`,
 *   so a level that its facts give no time for keeps its time from 1 snapshot to the next. Before the first refresh
 *   ends, the board has no session, each source is unread, and firstRefreshDone is false.
 * - firstSight holds the seenAt entries that the engine writes to the store: the pane start time for each board
 *   session that the store does not hold yet. So a session keeps its first-sight time when the pane starts again.
 * - factsAt is the end of the refresh that gave the facts. The facts are old when the snapshot is more than
 *   FACTS_OLD_AFTER_MS after it. A tick that comes while a refresh runs gets the last facts again, so a refresh that
 *   hangs shows as old facts.
 * - isSnapshotChanged ignores time drift: the snapshot time, the facts time, the refresh times and the time of the
 *   last good read of each source. Any other change is a change: a row (its level, its summary, a fact), a group,
 *   the state or the reason of a source, a stored choice, the session count and the old mark. The key order of an
 *   object is no change.
 */
import { buildBoard } from './model/board.js'
import { firstSightEntries } from './model/classify.js'
import type { BoardSnapshot, Facts, Settings, SourceState, StoreState } from './types.js'

/** The facts are old when the snapshot is more than this many milliseconds after the refresh that gave them. */
export const FACTS_OLD_AFTER_MS = 10_000

const UNREAD: SourceState = { status: 'unread' }

/** The facts before the first refresh ends: no session, and no source read. */
const NO_FACTS: Facts = {
  sessions: [],
  sources: { agents: UNREAD, registry: UNREAD, cmux: UNREAD, git: UNREAD },
  stats: { at: 0, computeMs: 0, waitMs: 0, sessions: 0 },
}

/** What 1 snapshot reads. */
export type SnapshotInput = {
  /** the facts of the last refresh that ended; absent before the first refresh ends */
  facts?: Facts
  store: StoreState
  settings: Settings
  /** the session id of the god session: the board leaves it out */
  selfId: string
  /** when the god pane started: the seenAt of a session that the store does not hold */
  paneStartedAt: number
  now: number
  /** the last snapshot that the engine wrote */
  previous?: BoardSnapshot
}

/** 1 snapshot, and the seenAt entries that the engine adds to the store with it. */
export type SnapshotResult = {
  snapshot: BoardSnapshot
  /** session id to the pane start time, for each board session that the store does not hold */
  firstSight: Record<string, number>
}

/** The board snapshot of the facts, the store and the settings, and its first-sight entries. */
export function makeSnapshot(input: SnapshotInput): SnapshotResult {
  const { facts, store, settings, selfId, paneStartedAt, now, previous } = input
  const snapshot = buildBoard({
    facts: facts ?? NO_FACTS,
    store,
    settings,
    selfId,
    paneStartedAt,
    now,
    firstRefreshDone: facts !== undefined,
    ...(facts === undefined ? {} : { factsAt: facts.stats.at }),
    ...(previous === undefined ? {} : { previous }),
  })
  const ids = snapshot.sessions.map((session) => session.sessionId)
  return { snapshot, firstSight: firstSightEntries(ids, store.seenAt, paneStartedAt) }
}

/** True when the snapshot is more than FACTS_OLD_AFTER_MS after the refresh that gave its facts. */
export function hasOldFacts(snapshot: BoardSnapshot): boolean {
  return snapshot.factsAt !== undefined && snapshot.at - snapshot.factsAt > FACTS_OLD_AFTER_MS
}

/** The parts of a snapshot that time drift does not move, and the old mark. */
function lasting(snapshot: BoardSnapshot): unknown {
  const { at: _at, factsAt: _factsAt, stats, sources, ...rest } = snapshot
  const states = Object.fromEntries(Object.entries(sources).map(([name, { lastOkAt: _lastOkAt, ...state }]) => [name, state]))
  return { ...rest, sources: states, sessionCount: stats.sessions, isOld: hasOldFacts(snapshot) }
}

/** True when 2 JSON values hold the same data, whatever the key order of their objects. */
function isSameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => isSameData(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keys = Object.keys(a)
  const other = b as Record<string, unknown>
  return keys.length === Object.keys(other).length && keys.every((key) => Object.hasOwn(other, key) && isSameData((a as Record<string, unknown>)[key], other[key]))
}

/** True when the engine must write the next snapshot: the first one, or one that differs by more than time drift. */
export function isSnapshotChanged(last: BoardSnapshot | undefined, next: BoardSnapshot): boolean {
  return last === undefined || !isSameData(lasting(last), lasting(next))
}
