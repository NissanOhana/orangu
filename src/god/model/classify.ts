/**
 * The attention level of 1 session, from rules only. The first rule that holds gives the level:
 * - needs-you: the status is waiting;
 * - your-turn: the status is idle, and the last turn ended after seenAt;
 * - stuck: the status is busy, and the transcript ends with an API error or retry, or has no write for the stuck
 *   limit (a session with no transcript file proves no silence, so it stays working);
 * - working: the status is busy;
 * - stale: the status is idle for the stale limit or more;
 * - idle: the status is idle.
 * So a turn that the person did not see stays your-turn after the stale limit.
 *
 * seenAt is the stored time of the person's last look, else the start time of the pane: on the first start, only a
 * turn that ends after the start is your-turn. levelSince is the start of the fact that puts the session at its
 * level (the wait, the turn end, the error or the last write, the busy status, the idle status), so it holds from 1
 * refresh to the next. When the facts give no such time, the level keeps its time from the last snapshot, else the
 * time starts now. The clock comes in as `now`, and the limits come from Settings.
 */
import type { Level, SessionFacts, Settings } from '../types.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** The level of 1 session and the time since it is at that level. */
export type Classified = {
  level: Level
  levelSince: number
}

/** What the level of 1 session reads. */
export type ClassifyInput = {
  session: SessionFacts
  /** the last time the person opened or jumped to the session: seenAtOf */
  seenAt: number
  settings: Settings
  now: number
  /** the level of the session in the last snapshot, for a level whose facts give no time */
  previous?: Classified
}

// ---------- seenAt ----------

/** The stored seenAt of 1 session, or undefined. Only an own key with a number counts, so `constructor` is no entry. */
function storedSeenAt(sessionId: string, seenAt: Readonly<Record<string, number>>): number | undefined {
  const stored: unknown = Object.hasOwn(seenAt, sessionId) ? seenAt[sessionId] : undefined
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : undefined
}

/** The seenAt of 1 session: the stored time, else the start time of the pane (the first-sight rule). */
export function seenAtOf(sessionId: string, seenAt: Readonly<Record<string, number>>, paneStartedAt: number): number {
  return storedSeenAt(sessionId, seenAt) ?? paneStartedAt
}

/**
 * The entries to add to the stored seenAt: the start time of the pane for each session that the store does not
 * hold yet. The engine writes them, so a session keeps its first-sight time when the pane starts again.
 */
export function firstSightEntries(sessionIds: readonly string[], seenAt: Readonly<Record<string, number>>, paneStartedAt: number): Record<string, number> {
  return Object.fromEntries(sessionIds.filter((id) => storedSeenAt(id, seenAt) === undefined).map((id) => [id, paneStartedAt]))
}

// ---------- level ----------

/** The attention level of 1 session and the time since it is at that level. */
export function classify({ session, seenAt, settings, now, previous }: ClassifyInput): Classified {
  const transcript = session.transcript
  const at = (level: Level, ...facts: readonly (number | undefined)[]): Classified => {
    const since = facts.find((time) => time !== undefined)
    return { level, levelSince: since ?? (previous?.level === level ? previous.levelSince : now) }
  }

  if (session.status === 'waiting') {
    const openCall = transcript?.activity?.isOpen === true ? transcript.activity.at : undefined
    return at('needs-you', session.statusSince, transcript?.openQuestion?.askedAt, openCall)
  }

  if (session.status === 'busy') {
    if (transcript?.errorTail !== undefined) return at('stuck', transcript.errorTail.at, session.lastWriteAt)
    const lastWrite = session.lastWriteAt
    if (lastWrite !== undefined && now - lastWrite >= settings.stuckAfterMin * MINUTE_MS) return at('stuck', lastWrite)
    return at('working', session.statusSince)
  }

  const turnEnded = transcript?.lastTurnEndedAt
  if (turnEnded !== undefined && turnEnded > seenAt) return at('your-turn', turnEnded)
  const idleSince = session.statusSince ?? turnEnded ?? session.lastWriteAt
  if (idleSince !== undefined && now - idleSince >= settings.staleAfterH * HOUR_MS) return at('stale', idleSince)
  return at('idle', idleSince)
}
