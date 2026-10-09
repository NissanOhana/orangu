/**
 * The alert policy of orangu god, from rules only. It compares the last board snapshot with the new one and gives
 * the alerts that go out. It has no effect of its own: the engine shell plays the tones, sends the notifications
 * and rings the cmux tabs.
 * - An alert starts when a session goes into needs-you or stuck. It is 1 tone, 1 notification and 1 ring on the
 *   cmux tab of the session.
 * - A done tone starts when a session goes into your-turn: its turn ended after the person last saw it. It is a
 *   tone only, with no notification and no ring, because only needs-you and stuck start an alert.
 * - The last stored snapshot gives the levels before. The collector stores a snapshot only when it changed, so on
 *   a quiet board that snapshot can be old. The gap rule reads the time of the last refresh instead: with no last
 *   snapshot, a last snapshot from before the first refresh, no time of the last refresh, or a last refresh more
 *   than 5 min ago (a wake after sleep), nothing goes out. So the pane does not ring for each session when it starts
 *   or opens again.
 * - A session that shows for the first time after such a base counts as a change when it shows in needs-you or
 *   stuck: it can need the person from its first refresh (a trust dialog does). It gets no done tone.
 * - Each session gets 1 alert in 5 min or less: a second alert needs more than 5 min since the first. A done tone
 *   needs more than 5 min since the last alert and the last done tone of that session. So a done tone never holds
 *   back an alert, and it never adds a sound next to one.
 * - A muted session gets nothing.
 * - Sound off, or a pane that this session does not show, stops the tone and keeps the notification. A done tone
 *   then has nothing to send, so it is not in the decision.
 * - 1 decision plays 1 tone at most, because the engine plays 2 clips at the same time, not 1 after the other. The
 *   tone goes to the first alert in this order: needs-you, stuck, done, then the board order.
 * The clock comes in as `now`. The state holds only the times of the last 5 min, so it stays small.
 */
import type { AlertKind, BoardSnapshot, Level, StoreState } from '../types.js'

/** Each session gets 1 alert in this time or less. */
export const ALERT_WINDOW_MS = 5 * 60_000

/** The times that hold back the next alert of each session. The engine state keeps it from 1 decision to the next. */
export type AlertState = {
  /** session id to the time of its last alert (needs-you or stuck) in the last 5 min */
  alertAt: Readonly<Record<string, number>>
  /** session id to the time of its last done tone in the last 5 min */
  doneAt: Readonly<Record<string, number>>
}

/** The state before the first alert. */
export const NO_ALERTS: AlertState = { alertAt: {}, doneAt: {} }

/** 1 alert of 1 session. */
export type Alert = {
  sessionId: string
  kind: AlertKind
  /** true when the engine plays the tone of the kind */
  playsTone: boolean
  /** true when the engine sends 1 notification and rings the cmux tab of the session: needs-you and stuck only */
  notifies: boolean
}

/** What 1 decision reads. */
export type AlertInput = {
  /** the last stored snapshot before this one, absent before the first: it gives the levels before */
  last?: BoardSnapshot
  /** the time of the refresh before this one, whatever it changed: a gap of more than 5 min since it gives no alert */
  lastRefreshAt?: number
  next: BoardSnapshot
  state: AlertState
  /** sound false turns every tone off; a muted session gets nothing */
  store: Pick<StoreState, 'sound' | 'muted'>
  /** true when this Claude Code session shows the god pane: only that session plays tones */
  isPaneOpen: boolean
  now: number
}

/** The alerts of 1 decision, and the state for the next one. */
export type AlertDecision = {
  /** the order of the tone: needs-you, then stuck, then done, each in board order */
  alerts: readonly Alert[]
  /** the times of this decision added, and each time older than 5 min or later than now removed */
  state: AlertState
}

/** The alert kind of a change into each level, or none. */
const KIND_OF_LEVEL: Readonly<Partial<Record<Level, AlertKind>>> = { 'needs-you': 'needs-you', stuck: 'stuck', 'your-turn': 'done' }

/** The order in which the alerts of 1 decision get the tone. */
const TONE_ORDER: readonly AlertKind[] = ['needs-you', 'stuck', 'done']

/** True when the time holds back an alert now: a number at most 5 min ago, and not later than now. */
const holdsBack = (time: unknown, now: number): boolean =>
  typeof time === 'number' && Number.isFinite(time) && time <= now && now - time <= ALERT_WINDOW_MS

/**
 * The times that still hold back an alert now, plus the given new entries, as a new record. Object.entries reads
 * own keys only, and Object.fromEntries makes own keys only, so a session id such as `__proto__` stays a plain key.
 */
function recentTimes(times: Readonly<Record<string, number>>, now: number, added: readonly string[] = []): Record<string, number> {
  const kept = Object.entries(times).filter(([, time]) => holdsBack(time, now))
  return Object.fromEntries([...kept, ...added.map((sessionId): [string, number] => [sessionId, now])])
}

/**
 * True when the last snapshot is a base to compare with: made after the first refresh, with a refresh before this
 * one at most 5 min ago. The age of the snapshot itself does not count, because a quiet board stores none.
 */
const isBase = (last: BoardSnapshot | undefined, lastRefreshAt: number | undefined, now: number): last is BoardSnapshot =>
  last !== undefined && last.firstRefreshDone && lastRefreshAt !== undefined && now - lastRefreshAt <= ALERT_WINDOW_MS

/**
 * The sessions that changed into a level with an alert kind, in board order, with that kind. A session that the
 * last snapshot does not hold changes only into needs-you or stuck.
 */
function changes(last: BoardSnapshot, next: BoardSnapshot): { sessionId: string; kind: AlertKind }[] {
  const before = new Map(last.sessions.map((session) => [session.sessionId, session.level]))
  return next.sessions.flatMap(({ sessionId, level }) => {
    const levelBefore = before.get(sessionId)
    const kind = KIND_OF_LEVEL[level]
    if (kind === undefined || levelBefore === level || (levelBefore === undefined && kind === 'done')) return []
    return [{ sessionId, kind }]
  })
}

/** The alerts that go out for a new snapshot, and the state for the next decision. */
export function decideAlerts(input: AlertInput): AlertDecision {
  const { last, next, store, now } = input
  const alertAt = recentTimes(input.state.alertAt, now)
  const doneAt = recentTimes(input.state.doneAt, now)
  if (!isBase(last, input.lastRefreshAt, now)) return { alerts: [], state: { alertAt, doneAt } }

  const muted = new Set(store.muted)
  const isHeldBack = (sessionId: string, kind: AlertKind): boolean =>
    Object.hasOwn(alertAt, sessionId) || (kind === 'done' && Object.hasOwn(doneAt, sessionId))
  const due = changes(last, next)
    .filter(({ sessionId, kind }) => !muted.has(sessionId) && !isHeldBack(sessionId, kind))
    .sort((a, b) => TONE_ORDER.indexOf(a.kind) - TONE_ORDER.indexOf(b.kind))

  let hasTone = store.sound && input.isPaneOpen
  const alerts = due.flatMap(({ sessionId, kind }): Alert[] => {
    const playsTone = hasTone
    const notifies = kind !== 'done'
    if (!playsTone && !notifies) return []
    if (playsTone) hasTone = false
    return [{ sessionId, kind, playsTone, notifies }]
  })

  const idsOf = (isDone: boolean): string[] => alerts.filter((alert) => (alert.kind === 'done') === isDone).map((alert) => alert.sessionId)
  return { alerts, state: { alertAt: recentTimes(alertAt, now, idsOf(false)), doneAt: recentTimes(doneAt, now, idsOf(true)) } }
}
