/**
 * The alert policy: which alerts go out when a new board snapshot comes. An alert starts on a change into
 * needs-you or stuck, a done tone on a change into your-turn, each session gets 1 alert in 5 min, a muted session
 * gets nothing, sound off and a pane that this session does not show stop the tone and keep the notification, and
 * 1 decision plays 1 tone at most.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, SECOND, facts, session } from '../../../test/fixtures/god/sessions.js'
import type { BoardSnapshot, GodSession, Level, SessionStatus } from '../types.js'
import { ALERT_WINDOW_MS, NO_ALERTS, decideAlerts, type Alert, type AlertDecision, type AlertInput, type AlertState } from './alert-policy.js'

const STATUS_OF: Readonly<Record<Level, SessionStatus>> = {
  'needs-you': 'waiting',
  'your-turn': 'idle',
  stuck: 'busy',
  working: 'busy',
  idle: 'idle',
  stale: 'idle',
}

/** 1 board row at the given level */
function row(sessionId: string, level: Level): GodSession {
  return { ...session(sessionId, STATUS_OF[level]), seenAt: NOW - 30 * MINUTE, level, levelSince: NOW - MINUTE, summary: '', flags: [], muted: false }
}

/** a board snapshot made at `at`, with 1 row per entry in the given order (the board order) */
function snapshot(at: number, levels: Readonly<Record<string, Level>>, over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  const sessions = Object.entries(levels).map(([id, level]) => row(id, level))
  const base = facts(sessions)
  return { at, selfId: 'god-self', firstRefreshDone: true, sessions, groups: [], mode: 'all', repos: [], groupBy: 'level', sources: base.sources, stats: base.stats, ...over }
}

/** 1 decision with sound on, nothing muted, the pane open, and the time of the new snapshot */
function decide(last: BoardSnapshot | undefined, next: BoardSnapshot, over: Partial<AlertInput> = {}): AlertDecision {
  return decideAlerts({ ...(last === undefined ? {} : { last }), next, state: NO_ALERTS, store: { sound: true, muted: [] }, isPaneOpen: true, now: next.at, ...over })
}

/**
 * Runs the policy over the snapshots in order, each decision with the state of the one before, and gives the
 * alerts of each step after the first.
 */
function walk(snapshots: readonly BoardSnapshot[], over: Partial<AlertInput> = {}): Alert[][] {
  let state: AlertState = NO_ALERTS
  const steps: Alert[][] = []
  for (let index = 1; index < snapshots.length; index += 1) {
    const decision = decide(snapshots[index - 1], snapshots[index] as BoardSnapshot, { ...over, state })
    steps.push([...decision.alerts])
    state = decision.state
  }
  return steps
}

const T0 = NOW
const TICK = 2 * SECOND

const needsYou = (sessionId: string): Alert => ({ sessionId, kind: 'needs-you', playsTone: true, notifies: true })

describe('an alert starts on a change into needs-you or stuck, and a done tone on a change into your-turn', () => {
  it('gives 1 alert with its tone and its notification for a change into needs-you', () => {
    expect(decide(snapshot(T0, { a: 'working' }), snapshot(T0 + TICK, { a: 'needs-you' })).alerts).toEqual([needsYou('a')])
  })

  it('gives 1 alert with its tone and its notification for a change into stuck', () => {
    expect(decide(snapshot(T0, { a: 'working' }), snapshot(T0 + TICK, { a: 'stuck' })).alerts).toEqual([{ sessionId: 'a', kind: 'stuck', playsTone: true, notifies: true }])
  })

  it('gives a done tone with no notification for a change into your-turn', () => {
    expect(decide(snapshot(T0, { a: 'working' }), snapshot(T0 + TICK, { a: 'your-turn' })).alerts).toEqual([{ sessionId: 'a', kind: 'done', playsTone: true, notifies: false }])
  })

  it('gives none when the level stays, and none for a change into working, idle or stale', () => {
    const last = snapshot(T0, { wait: 'needs-you', stuck: 'stuck', turn: 'your-turn', work: 'needs-you', rest: 'your-turn', old: 'idle' })
    const next = snapshot(T0 + TICK, { wait: 'needs-you', stuck: 'stuck', turn: 'your-turn', work: 'working', rest: 'idle', old: 'stale' })
    expect(decide(last, next).alerts).toEqual([])
  })

  it('gives none for the first snapshot, after a snapshot made before the first refresh, and for a session that shows for the first time', () => {
    const next = snapshot(T0 + TICK, { a: 'needs-you', b: 'stuck' })
    expect(decide(undefined, next).alerts).toEqual([])
    expect(decide(snapshot(T0, { a: 'working', b: 'working' }, { firstRefreshDone: false }), next).alerts).toEqual([])
    expect(decide(snapshot(T0, {}), next).alerts).toEqual([])
    // the control: the same new snapshot after a last snapshot that holds both sessions alerts for both
    expect(decide(snapshot(T0, { a: 'working', b: 'working' }), next).alerts.map((alert) => alert.kind)).toEqual(['needs-you', 'stuck'])
  })

  it('gives none when the last snapshot is more than 5 min old, so a pane that opens again does not ring for each change it missed', () => {
    const next = snapshot(T0 + ALERT_WINDOW_MS + SECOND, { a: 'needs-you' })
    expect(decide(snapshot(T0, { a: 'working' }), next).alerts).toEqual([])
    expect(decide(snapshot(T0 + SECOND, { a: 'working' }), next).alerts).toEqual([needsYou('a')])
  })
})

describe('each session gets 1 alert in 5 min or less', () => {
  it('gives 1 alert for 2 changes into needs-you within 5 min', () => {
    const steps = walk([
      snapshot(T0, { a: 'working' }),
      snapshot(T0 + TICK, { a: 'needs-you' }),
      snapshot(T0 + TICK + MINUTE, { a: 'working' }),
      snapshot(T0 + TICK + 2 * MINUTE, { a: 'needs-you' }),
    ])
    expect(steps).toEqual([[needsYou('a')], [], []])
  })

  it('gives a second alert for a change at 5 min and 1 s, and none for a change at 5 min exactly', () => {
    const first = T0 + TICK
    const run = (secondAt: number): Alert[][] =>
      walk([snapshot(T0, { a: 'working' }), snapshot(first, { a: 'needs-you' }), snapshot(secondAt - TICK, { a: 'working' }), snapshot(secondAt, { a: 'needs-you' })])
    expect(run(first + ALERT_WINDOW_MS + SECOND)).toEqual([[needsYou('a')], [], [needsYou('a')]])
    expect(run(first + ALERT_WINDOW_MS)).toEqual([[needsYou('a')], [], []])
    expect(ALERT_WINDOW_MS).toBe(5 * MINUTE)
  })

  it('counts needs-you and stuck together: a change into stuck 1 min after a needs-you alert gives none', () => {
    const steps = walk([snapshot(T0, { a: 'working' }), snapshot(T0 + TICK, { a: 'needs-you' }), snapshot(T0 + TICK + MINUTE, { a: 'stuck' })])
    expect(steps).toEqual([[needsYou('a')], []])
  })

  it('counts each session alone: a second session alerts in the same 5 min', () => {
    const steps = walk([snapshot(T0, { a: 'working', b: 'working' }), snapshot(T0 + TICK, { a: 'needs-you', b: 'working' }), snapshot(T0 + TICK + MINUTE, { a: 'needs-you', b: 'needs-you' })])
    expect(steps).toEqual([[needsYou('a')], [needsYou('b')]])
  })

  it('never holds back an alert for a done tone, and gives no done tone within 5 min of an alert or a done tone', () => {
    const done = (sessionId: string): Alert => ({ sessionId, kind: 'done', playsTone: true, notifies: false })
    // a done tone, then a needs-you alert 1 min later: the alert goes out
    expect(walk([snapshot(T0, { a: 'working' }), snapshot(T0 + TICK, { a: 'your-turn' }), snapshot(T0 + TICK + MINUTE, { a: 'needs-you' })])).toEqual([[done('a')], [needsYou('a')]])
    // a needs-you alert, then a done 1 min later: no done tone
    expect(walk([snapshot(T0, { a: 'working' }), snapshot(T0 + TICK, { a: 'needs-you' }), snapshot(T0 + TICK + MINUTE, { a: 'your-turn' })])).toEqual([[needsYou('a')], []])
    // 2 done changes within 5 min give 1 done tone, and a third after 5 min and 1 s gives a second
    const later = T0 + TICK + ALERT_WINDOW_MS + SECOND
    expect(
      walk([
        snapshot(T0, { a: 'working' }),
        snapshot(T0 + TICK, { a: 'your-turn' }),
        snapshot(T0 + TICK + MINUTE, { a: 'working' }),
        snapshot(T0 + TICK + 2 * MINUTE, { a: 'your-turn' }),
        snapshot(later - TICK, { a: 'working' }),
        snapshot(later, { a: 'your-turn' }),
      ]),
    ).toEqual([[done('a')], [], [], [], [done('a')]])
  })
})

describe('the sound switch, the mute and the open pane', () => {
  const last = snapshot(T0, { a: 'working', b: 'working', c: 'working' })
  const next = snapshot(T0 + TICK, { a: 'needs-you', b: 'stuck', c: 'your-turn' })

  it('gives a muted session no alert and no done tone, and records nothing for it', () => {
    const decision = decide(last, next, { store: { sound: true, muted: ['a', 'b', 'c'] } })
    expect(decision.alerts).toEqual([])
    expect(decision.state).toEqual(NO_ALERTS)
    expect(decide(last, next, { store: { sound: true, muted: ['a'] } }).alerts.map((alert) => alert.sessionId)).toEqual(['b'])
  })

  it('gives the notification and no tone when the sound is off, and then no done tone at all', () => {
    expect(decide(last, next, { store: { sound: false, muted: [] } }).alerts).toEqual([
      { sessionId: 'a', kind: 'needs-you', playsTone: false, notifies: true },
      { sessionId: 'b', kind: 'stuck', playsTone: false, notifies: true },
    ])
  })

  it('gives the notification and no tone when this session does not show the pane', () => {
    expect(decide(last, next, { isPaneOpen: false }).alerts).toEqual([
      { sessionId: 'a', kind: 'needs-you', playsTone: false, notifies: true },
      { sessionId: 'b', kind: 'stuck', playsTone: false, notifies: true },
    ])
  })

  it('reads the mute from the store, not from the row', () => {
    const mutedRow = { ...snapshot(T0 + TICK, { a: 'needs-you' }), sessions: [{ ...row('a', 'needs-you'), muted: true }] }
    expect(decide(snapshot(T0, { a: 'working' }), mutedRow).alerts).toEqual([needsYou('a')])
  })
})

describe('1 decision plays 1 tone at most', () => {
  it('gives 2 sessions that go into needs-you at once 2 alerts and 1 tone, on the first in board order', () => {
    const alerts = decide(snapshot(T0, { a: 'working', b: 'working' }), snapshot(T0 + TICK, { b: 'needs-you', a: 'needs-you' })).alerts
    expect(alerts).toEqual([needsYou('b'), { sessionId: 'a', kind: 'needs-you', playsTone: false, notifies: true }])
  })

  it('gives the tone to needs-you, then stuck, then done, whatever the board order, and drops a done that has no tone', () => {
    const last = snapshot(T0, { turn: 'working', stuck: 'working', wait: 'working' })
    expect(decide(last, snapshot(T0 + TICK, { turn: 'your-turn', stuck: 'stuck' })).alerts).toEqual([{ sessionId: 'stuck', kind: 'stuck', playsTone: true, notifies: true }])
    expect(decide(last, snapshot(T0 + TICK, { turn: 'your-turn', stuck: 'stuck', wait: 'needs-you' })).alerts).toEqual([
      needsYou('wait'),
      { sessionId: 'stuck', kind: 'stuck', playsTone: false, notifies: true },
    ])
  })

  it('records the done tone that it dropped as no done tone, so the session can still ring later', () => {
    const last = snapshot(T0, { turn: 'working', wait: 'working' })
    const decision = decide(last, snapshot(T0 + TICK, { turn: 'your-turn', wait: 'needs-you' }))
    expect(decision.state).toEqual({ alertAt: { wait: T0 + TICK }, doneAt: {} })
  })
})

describe('the alert state', () => {
  it('records the time of each alert and each done tone, keyed by session id', () => {
    const decision = decide(snapshot(T0, { a: 'working', b: 'working' }), snapshot(T0 + TICK, { a: 'needs-you', b: 'your-turn' }), { store: { sound: true, muted: [] } })
    expect(decision.state).toEqual({ alertAt: { a: T0 + TICK }, doneAt: {} })
    const solo = decide(snapshot(T0, { b: 'working' }), snapshot(T0 + TICK, { b: 'your-turn' }))
    expect(solo.state).toEqual({ alertAt: {}, doneAt: { b: T0 + TICK } })
  })

  it('drops each time older than 5 min, each time after now (a clock that went back) and each value that is not a time, and keeps the rest', () => {
    const now = T0 + 10 * MINUTE
    const notATime = { text: 'x', empty: null, digits: String(now - MINUTE) } as unknown as Record<string, number>
    const state: AlertState = { alertAt: { old: now - ALERT_WINDOW_MS - 1, edge: now - ALERT_WINDOW_MS, ahead: now + MINUTE, ...notATime }, doneAt: { old: now - 6 * MINUTE, fresh: now - MINUTE } }
    const decision = decide(snapshot(now - TICK, {}), snapshot(now, {}), { state, now })
    expect(decision.state).toEqual({ alertAt: { edge: now - ALERT_WINDOW_MS }, doneAt: { fresh: now - MINUTE } })
    // a time after now holds back nothing
    const ahead = decide(snapshot(now - TICK, { ahead: 'working' }), snapshot(now, { ahead: 'needs-you' }), { state, now })
    expect(ahead.alerts).toEqual([needsYou('ahead')])
  })

  it('reads only own keys of the state, so a session named constructor alerts', () => {
    const id = 'constructor'
    const last = { ...snapshot(T0, {}), sessions: [row(id, 'working')] }
    const next = { ...snapshot(T0 + TICK, {}), sessions: [row(id, 'needs-you')] }
    expect(decide(last, next).alerts).toEqual([needsYou(id)])
  })

  it('keeps a session named __proto__ as a plain key of the state, and holds back its second alert', () => {
    const id = '__proto__'
    const last = { ...snapshot(T0, {}), sessions: [row(id, 'working')] }
    const next = { ...snapshot(T0 + TICK, {}), sessions: [row(id, 'needs-you')] }
    const first = decide(last, next)
    expect(first.alerts).toEqual([needsYou(id)])
    expect(Object.getPrototypeOf(first.state.alertAt)).toBe(Object.prototype)
    expect(Object.hasOwn(first.state.alertAt, id)).toBe(true)
    const again = decide({ ...last, at: T0 + MINUTE }, { ...next, at: T0 + MINUTE + TICK }, { state: first.state })
    expect(again.alerts).toEqual([])
  })

  it('does not change the state, the store or the snapshots that it got, and gives plain JSON data', () => {
    const state: AlertState = Object.freeze({ alertAt: Object.freeze({ z: T0 }), doneAt: Object.freeze({}) })
    const last = snapshot(T0, { a: 'working' })
    const next = snapshot(T0 + TICK, { a: 'needs-you' })
    const before = JSON.stringify([state, last, next])
    const decision = decide(last, next, { state, store: Object.freeze({ sound: true, muted: Object.freeze([]) as readonly string[] }) })
    expect(JSON.stringify([state, last, next])).toBe(before)
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision)
    expect(decision.state).toEqual({ alertAt: { z: T0, a: T0 + TICK }, doneAt: {} })
  })

  it('holds the alert state and the decision to plain JSON at compile time', () => {
    type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined }
    const plainData = <T extends Json>(name: string): string => name
    expect([plainData<AlertState>('AlertState'), plainData<AlertDecision>('AlertDecision')]).toHaveLength(2)
  })
})
