/**
 * The board snapshot: the board of buildBoard from the facts of the last refresh, the stored choices and the
 * settings, with the last snapshot as `previous` and the first-sight entries for the store; the 10 s mark of old
 * facts; and the check that keeps an unchanged snapshot from a second write, which time drift alone never passes.
 * The sessions come from the synthetic fixtures of test/fixtures/god.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, PANE_START, SECOND, SETTINGS, STORE, busy, facts, idle, session, waiting } from '../../test/fixtures/god/sessions.js'
import { buildBoard } from './model/board.js'
import { FACTS_OLD_AFTER_MS, hasOldFacts, isSnapshotChanged, makeSnapshot, type SnapshotInput } from './snapshot.js'
import type { BoardSnapshot, Facts, SourceName, SourceState } from './types.js'

const SELF = 'god-self'
const BASE = { store: STORE, settings: SETTINGS, selfId: SELF, paneStartedAt: PANE_START }

const snap = (over: Partial<SnapshotInput> & Pick<SnapshotInput, 'now'>): BoardSnapshot => makeSnapshot({ ...BASE, ...over }).snapshot
const ids = (snapshot: BoardSnapshot): string[] => snapshot.sessions.map((row) => row.sessionId)

/** The same facts after a later refresh: only the times moved. */
function later(base: Facts, at: number): Facts {
  const sources = Object.fromEntries(Object.entries(base.sources).map(([name, state]) => [name, { ...state, lastOkAt: at }])) as Record<SourceName, SourceState>
  return { sessions: base.sessions, sources, stats: { at, computeMs: base.stats.computeMs + 7, waitMs: base.stats.waitMs + 90, sessions: base.stats.sessions } }
}

describe('makeSnapshot: the board from the facts, the store and the settings', () => {
  it('is the board of buildBoard, with the end of the refresh as the facts time', () => {
    const given = facts([busy('a'), waiting('b'), session(SELF, 'busy')])
    const snapshot = snap({ facts: given, now: NOW })
    expect(snapshot).toStrictEqual(buildBoard({ ...BASE, facts: given, now: NOW, firstRefreshDone: true, factsAt: given.stats.at }))
    expect(ids(snapshot)).toEqual(['b', 'a'])
    expect(snapshot.factsAt).toBe(NOW - SECOND)
    expect(snapshot.firstRefreshDone).toBe(true)
  })

  it('passes the last snapshot as previous: a level that its facts give no time for keeps its time', () => {
    const quiet = session('quiet', 'busy')
    const first = snap({ facts: facts([quiet]), now: NOW })
    expect(first.sessions[0]).toMatchObject({ level: 'working', levelSince: NOW })
    const next = snap({ facts: facts([quiet]), now: NOW + 2 * SECOND, previous: first })
    expect(next.sessions[0]?.levelSince).toBe(NOW)
    const withoutPrevious = snap({ facts: facts([quiet]), now: NOW + 2 * SECOND })
    expect(withoutPrevious.sessions[0]?.levelSince).toBe(NOW + 2 * SECOND)
  })

  it('gives the first-sight entries of the board sessions that the store does not hold, and never the god session', () => {
    const store = { ...STORE, seenAt: { a: NOW - MINUTE } }
    const { snapshot, firstSight } = makeSnapshot({ ...BASE, store, facts: facts([busy('a'), idle('b'), session(SELF, 'busy')]), now: NOW })
    expect(firstSight).toEqual({ b: PANE_START })
    expect(snapshot.sessions.find((row) => row.sessionId === 'b')?.seenAt).toBe(PANE_START)
  })

  it('before the first refresh ends, the board has no session, each source is unread and it is not done', () => {
    const { snapshot, firstSight } = makeSnapshot({ ...BASE, now: NOW })
    expect(snapshot).toMatchObject({ at: NOW, selfId: SELF, firstRefreshDone: false, sessions: [], groups: [] })
    expect(Object.values(snapshot.sources)).toEqual([{ status: 'unread' }, { status: 'unread' }, { status: 'unread' }, { status: 'unread' }])
    expect(snapshot.factsAt).toBeUndefined()
    expect(hasOldFacts(snapshot)).toBe(false)
    expect(firstSight).toEqual({})
  })
})

describe('hasOldFacts: a 10 s gap marks the facts old', () => {
  it('the facts are old only when the snapshot is more than 10 s after the refresh that gave them', () => {
    const given = facts([busy('a')])
    expect(FACTS_OLD_AFTER_MS).toBe(10_000)
    expect(hasOldFacts(snap({ facts: given, now: given.stats.at + 10_000 }))).toBe(false)
    expect(hasOldFacts(snap({ facts: given, now: given.stats.at + 10_001 }))).toBe(true)
  })
})

describe('isSnapshotChanged: an unchanged snapshot is not written again', () => {
  const rows = [busy('a'), waiting('b'), idle('c')]
  const first = snap({ facts: facts(rows), now: NOW })

  it('the first snapshot is a change', () => {
    expect(isSnapshotChanged(undefined, first)).toBe(true)
  })

  it('time drift alone is no change: the snapshot time, the facts time, the refresh stats and the source times', () => {
    const next = snap({ facts: later(facts(rows), NOW + SECOND), now: NOW + 2 * SECOND, previous: first })
    expect(next).not.toStrictEqual(first)
    expect(isSnapshotChanged(first, next)).toBe(false)
  })

  it('a change in a row, a source state, a stored choice or the old mark is a change', () => {
    const changedRow = snap({ facts: facts([busy('a'), waiting('b', { waitingFor: 'permission prompt' }), rows[2]!]), now: NOW, previous: first })
    expect(isSnapshotChanged(first, changedRow)).toBe(true)

    const cmuxOff = facts(rows)
    const offSources = { ...cmuxOff.sources, cmux: { status: 'off', reason: 'The cmux tree command did not run.', lastOkAt: NOW - SECOND } } satisfies Facts['sources']
    expect(isSnapshotChanged(first, snap({ facts: { ...cmuxOff, sources: offSources }, now: NOW, previous: first }))).toBe(true)

    expect(isSnapshotChanged(first, snap({ facts: facts(rows), now: NOW, previous: first, store: { ...STORE, groupBy: 'repo' } }))).toBe(true)

    const old = snap({ facts: facts(rows), now: NOW - SECOND + 10_001, previous: first })
    expect(hasOldFacts(old)).toBe(true)
    expect(isSnapshotChanged(first, old)).toBe(true)
  })

  it('a level that time alone changes is a change: a busy session that went silent for the stuck limit', () => {
    const silent = busy('s', { statusSince: NOW - 20 * MINUTE, lastWriteAt: NOW - 9 * MINUTE })
    const working = snap({ facts: facts([silent]), now: NOW })
    const stuck = snap({ facts: facts([silent]), now: NOW + 2 * MINUTE, previous: working })
    expect([working.sessions[0]?.level, stuck.sessions[0]?.level]).toEqual(['working', 'stuck'])
    expect(isSnapshotChanged(working, stuck)).toBe(true)
  })

  it('the key order of the same facts is no change', () => {
    const reordered = Object.fromEntries(Object.entries(rows[0]!).reverse()) as typeof rows[0]
    const next = snap({ facts: facts([reordered, rows[1]!, rows[2]!]), now: NOW, previous: first })
    expect(isSnapshotChanged(first, next)).toBe(false)
  })
})
