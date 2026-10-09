/**
 * The board: 1 row per live session but the god session, in the level order with the longest time in the level
 * first, grouped by level or by repo, with the repos mode as a filter on the groups only.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, NOW, PANE_START, SETTINGS, STORE, busy, facts, idle, repo, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import type { BoardSnapshot, SessionFacts, StoreState } from '../types.js'
import { buildBoard, type BoardInput } from './board.js'

const SELF = 'god-self'

const board = (sessions: readonly SessionFacts[], over: Partial<BoardInput> = {}): BoardSnapshot =>
  buildBoard({ facts: facts(sessions), store: STORE, settings: SETTINGS, selfId: SELF, paneStartedAt: PANE_START, now: NOW, firstRefreshDone: true, ...over })

const ids = (snapshot: BoardSnapshot): string[] => snapshot.sessions.map((session) => session.sessionId)

/** 1 session for each level, and a second working session that is busy for longer */
function everyLevel(): SessionFacts[] {
  return [
    idle('stale-1', { statusSince: NOW - 30 * HOUR, transcript: transcript({ lastTurnEndedAt: NOW - 30 * HOUR, lastReply: 'Old work.' }) }),
    idle('idle-1'),
    busy('work-1', { statusSince: NOW - 5 * MINUTE }),
    busy('stuck-1', { lastWriteAt: NOW - 15 * MINUTE }),
    idle('turn-1', { statusSince: NOW - 3 * MINUTE, transcript: transcript({ lastTurnEndedAt: NOW - 3 * MINUTE, lastReply: 'Done. Look at it.' }) }),
    waiting('wait-1'),
    busy('work-2', { statusSince: NOW - 40 * MINUTE }),
  ]
}

describe('board order', () => {
  it('sorts by level, then the longest time in the level first', () => {
    expect(ids(board(everyLevel()))).toEqual(['wait-1', 'turn-1', 'stuck-1', 'work-2', 'work-1', 'idle-1', 'stale-1'])
  })

  it('gives each row its level, the time since its level, its summary, its flags and its seenAt', () => {
    const turn = board(everyLevel()).sessions.find((session) => session.sessionId === 'turn-1')
    expect(turn).toMatchObject({ level: 'your-turn', levelSince: NOW - 3 * MINUTE, summary: 'Done.', flags: [], seenAt: PANE_START, muted: false })
  })

  it('sorts 2 stuck rows by the time each entered the level, not by the time of its fact', () => {
    const failed = busy('stuck-error', { transcript: transcript({ errorTail: { kind: 'api-error', text: 'Overloaded.', at: NOW - 5 * MINUTE } }) })
    const silent = busy('stuck-silent', { lastWriteAt: NOW - 12 * MINUTE })
    const snapshot = board([silent, failed])
    expect(snapshot.sessions.map((session) => [session.sessionId, session.level, session.levelSince])).toEqual([
      ['stuck-error', 'stuck', NOW - 5 * MINUTE],
      ['stuck-silent', 'stuck', NOW - 2 * MINUTE],
    ])
  })

  it('orders 2 rows with the same level and time by name, then by id', () => {
    const twin = (id: string, name: string) => busy(id, { name, statusSince: NOW - 5 * MINUTE })
    expect(ids(board([twin('s2', 'beta'), twin('s3', 'alpha'), twin('s1', 'alpha')]))).toEqual(['s1', 's3', 's2'])
  })
})

describe('1 row per session id, and no row for the god session', () => {
  it('keeps 1 row for 2 sessions with the same id: the one whose status changed last', () => {
    const old = busy('dup', { pid: 7001, statusSince: NOW - HOUR })
    const fresh = waiting('dup', { pid: 7002, statusSince: NOW - MINUTE })
    const snapshot = board([old, fresh])
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({ sessionId: 'dup', pid: 7002, level: 'needs-you' })
    expect(snapshot.groups.flatMap((group) => group.sessionIds)).toEqual(['dup'])
  })

  it('leaves out the god session from the rows, the groups and the flags', () => {
    const tree = repo('api')
    const self = busy(SELF, { repo: tree, transcript: transcript({ branch: 'main' }) })
    const other = busy('other', { repo: tree, transcript: transcript({ branch: 'main' }) })
    const snapshot = board([self, other])
    expect(ids(snapshot)).toEqual(['other'])
    expect(snapshot.selfId).toBe(SELF)
    expect(snapshot.groups.flatMap((group) => group.sessionIds)).toEqual(['other'])
    expect(snapshot.sessions[0]?.flags).toEqual([])
  })
})

describe('groups by level', () => {
  it('gives 1 group for each level that has rows, in the level order', () => {
    const groups = board(everyLevel()).groups
    expect(groups.map((group) => [group.key, group.level, group.sessionIds])).toEqual([
      ['needs-you', 'needs-you', ['wait-1']],
      ['your-turn', 'your-turn', ['turn-1']],
      ['stuck', 'stuck', ['stuck-1']],
      ['working', 'working', ['work-2', 'work-1']],
      ['idle', 'idle', ['idle-1']],
      ['stale', 'stale', ['stale-1']],
    ])
    expect(board([idle('only')]).groups.map((group) => group.key)).toEqual(['idle'])
  })

  it('starts the STALE group closed with its count, and every other group open', () => {
    const stale = (id: string) => idle(id, { statusSince: NOW - 30 * HOUR })
    const groups = board([stale('s1'), stale('s2'), stale('s3'), busy('w1')]).groups
    expect(groups.map((group) => [group.key, group.startsClosed, group.sessionIds.length])).toEqual([
      ['working', false, 1],
      ['stale', true, 3],
    ])
  })
})

describe('the repos mode', () => {
  const api = busy('api-main', { repo: repo('api') })
  const apiTree = busy('api-tree', { repo: repo('api', '/work/api-wt') })
  const web = busy('web-main', { repo: repo('web') })
  const plain = busy('no-repo')
  const repos = (names: readonly string[]): StoreState => ({ ...STORE, mode: 'repos', repos: names })

  it('keeps in the groups only the sessions of the selected repos, a worktree with its repo', () => {
    const snapshot = board([api, apiTree, web, plain], { store: repos(['api']) })
    expect(snapshot.groups.flatMap((group) => group.sessionIds).sort()).toEqual(['api-main', 'api-tree'])
  })

  it('keeps every live session in the rows, so the live count and the tools see them all', () => {
    expect(ids(board([api, apiTree, web, plain], { store: repos(['api']) })).sort()).toEqual(['api-main', 'api-tree', 'no-repo', 'web-main'])
  })

  it('keeps no session when the set is empty, and every session in the all mode', () => {
    expect(board([api, web], { store: repos([]) }).groups).toEqual([])
    expect(board([api, web], { store: { ...STORE, repos: ['api'] } }).groups.flatMap((group) => group.sessionIds).sort()).toEqual(['api-main', 'web-main'])
  })
})

describe('groups by repo', () => {
  it('gives 1 group for each git common dir in board order, and 1 group with no repo', () => {
    const sessions = [
      busy('web-main', { repo: repo('web'), statusSince: NOW - 2 * MINUTE }),
      busy('api-tree', { repo: repo('api', '/work/api-wt'), statusSince: NOW - 3 * MINUTE }),
      waiting('api-main', { repo: repo('api') }),
      busy('no-repo', { statusSince: NOW - MINUTE }),
    ]
    const groups = board(sessions, { store: { ...STORE, groupBy: 'repo' } }).groups
    expect(groups.map((group) => [group.key, group.repo?.name, group.sessionIds, group.startsClosed])).toEqual([
      ['/work/api/.git', 'api', ['api-main', 'api-tree'], false],
      ['/work/web/.git', 'web', ['web-main'], false],
      ['', undefined, ['no-repo'], false],
    ])
    for (const group of groups) expect(Object.keys(group)).not.toContain('level')
  })

  it('names a repo group by its main worktree', () => {
    const groups = board([busy('tree', { repo: repo('api', '/work/api-wt'), statusSince: NOW - HOUR }), busy('main', { repo: repo('api') })], {
      store: { ...STORE, groupBy: 'repo' },
    }).groups
    expect(groups[0]?.repo).toEqual(repo('api'))
  })
})

describe('the snapshot', () => {
  it('carries the time, the stored choices, the sources, the stats and the refresh state', () => {
    const store: StoreState = { ...STORE, mode: 'repos', repos: ['api'], groupBy: 'repo', muted: ['b1'] }
    const snapshot = board([busy('b1', { repo: repo('api') })], { store, factsAt: NOW - 2000, firstRefreshDone: false })
    expect(snapshot).toMatchObject({ at: NOW, selfId: SELF, firstRefreshDone: false, mode: 'repos', repos: ['api'], groupBy: 'repo', factsAt: NOW - 2000 })
    expect(snapshot.sources).toEqual(facts([]).sources)
    expect(snapshot.stats).toEqual(facts([busy('b1')]).stats)
    expect(snapshot.sessions[0]?.muted).toBe(true)
  })

  it('takes seenAt from the store, else the pane start', () => {
    const snapshot = board([busy('seen'), busy('new')], { store: { ...STORE, seenAt: { seen: NOW - HOUR } } })
    expect(Object.fromEntries(snapshot.sessions.map((session) => [session.sessionId, session.seenAt]))).toEqual({ seen: NOW - HOUR, new: PANE_START })
  })

  it('keeps the levelSince of the last snapshot when the facts give no time and the level holds', () => {
    const { statusSince: _status, ...bare } = busy('b1')
    const first = board([bare], { now: NOW - MINUTE })
    expect(first.sessions[0]?.levelSince).toBe(NOW - MINUTE)
    expect(board([bare], { previous: first }).sessions[0]?.levelSince).toBe(NOW - MINUTE)
  })

  it('is plain JSON data: a JSON round trip gives the same snapshot', () => {
    const snapshot = board(everyLevel(), { store: { ...STORE, groupBy: 'repo' } })
    expect(JSON.parse(JSON.stringify(snapshot))).toStrictEqual(snapshot)
    expect(Object.keys(board([busy('b1')]))).not.toContain('factsAt')
  })

  it('gives the same snapshot for the same input', () => {
    const sessions = everyLevel()
    expect(board(sessions)).toEqual(board([...sessions].reverse()))
  })
})
