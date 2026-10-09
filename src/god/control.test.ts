/**
 * The pure rules of the pane controls: the /god arguments, the settings, the stored choices, what a command and a
 * key change in them, the selection that a move of the focus ring gives, the next session that needs you, and the
 * status line.
 */
import { describe, expect, it } from 'vitest'
import { NOW, boardSnapshot, byRepoSnapshot, snapshotOf } from '../../test/fixtures/god/snapshots.js'
import { idle, waiting } from '../../test/fixtures/god/sessions.js'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STORE,
  nextNeedsYou,
  parseGodArgs,
  selectionOf,
  settingsOf,
  statusText,
  commandAnswer,
  commandChoice,
  openGroupsAfterPress,
  storeOf,
  toggledGroup,
  toggledMode,
} from './control.js'
import type { StoreState } from './types.js'
import { STALE_GROUP_KEY } from './view/board.js'

describe('the /god arguments', () => {
  it('reads the 4 forms, the repo names in order with no repeat, and anything else as unknown', () => {
    expect(parseGodArgs('')).toEqual({ kind: 'open' })
    expect(parseGodArgs('   ')).toEqual({ kind: 'open' })
    expect(parseGodArgs('all')).toEqual({ kind: 'all' })
    expect(parseGodArgs(' repos  repo-a repo-b repo-a ')).toEqual({ kind: 'repos', names: ['repo-a', 'repo-b'] })
    expect(parseGodArgs('repos')).toEqual({ kind: 'show-repos' })
    expect(parseGodArgs('stats')).toEqual({ kind: 'unknown' })
    expect(parseGodArgs('all repo-a')).toEqual({ kind: 'unknown' })
    expect(parseGodArgs('ALL')).toEqual({ kind: 'unknown' })
  })
})

describe('the settings', () => {
  it('takes each userConfig value that is valid, and the default for the rest', () => {
    expect(DEFAULT_SETTINGS).toEqual({ stuckAfterMin: 10, staleAfterH: 24, motion: 'on' })
    expect(settingsOf({})).toEqual(DEFAULT_SETTINGS)
    expect(settingsOf({ stuckAfterMin: 3, staleAfterH: 48, motion: 'off' })).toEqual({ stuckAfterMin: 3, staleAfterH: 48, motion: 'off' })
    expect(settingsOf({ stuckAfterMin: 0, staleAfterH: -1, motion: 'fast' })).toEqual(DEFAULT_SETTINGS)
    expect(settingsOf({ stuckAfterMin: '5', staleAfterH: Number.NaN, motion: true })).toEqual(DEFAULT_SETTINGS)
  })
})

describe('the stored choices', () => {
  it('reads each stored value that has the right shape, and the default for the rest', () => {
    expect(storeOf({})).toEqual(DEFAULT_STORE)
    expect(DEFAULT_STORE).toEqual({ mode: 'all', repos: [], groupBy: 'level', seenAt: {}, muted: [], sound: true })
    const stored = storeOf({ mode: 'repos', repos: ['repo-a', 7, 'repo-b'], groupBy: 'repo', seenAt: { a: 1, b: 'x', c: Number.POSITIVE_INFINITY }, muted: ['s-1'], sound: false })
    expect(stored).toEqual({ mode: 'repos', repos: ['repo-a', 'repo-b'], groupBy: 'repo', seenAt: { a: 1 }, muted: ['s-1'], sound: false })
    expect(storeOf({ mode: 'some', repos: 'repo-a', groupBy: 3, seenAt: [1], muted: {}, sound: 'yes' })).toEqual(DEFAULT_STORE)
  })

  it('keeps no seenAt entry under a key that an object has from its prototype', () => {
    const seenAt = JSON.parse('{"__proto__": 5, "s-1": 9}') as unknown
    expect(storeOf({ seenAt }).seenAt).toEqual({ 's-1': 9 })
    expect(Object.getPrototypeOf(storeOf({ seenAt }).seenAt)).toBe(Object.prototype)
  })

  it('/god all shows every session and clears the repo set, /god repos sets the set, the other forms choose nothing', () => {
    expect(commandChoice({ kind: 'all' })).toEqual({ mode: 'all', repos: [] })
    expect(commandChoice({ kind: 'repos', names: ['repo-b'] })).toEqual({ mode: 'repos', repos: ['repo-b'] })
    for (const kind of ['open', 'show-repos', 'unknown'] as const) expect(commandChoice({ kind })).toBeUndefined()
  })

  it('f switches between all and repos and keeps the set, g switches between level and repo', () => {
    const withRepos: StoreState = { ...DEFAULT_STORE, repos: ['repo-a'] }
    expect(toggledMode(withRepos)).toEqual({ mode: 'repos' })
    expect(toggledMode({ ...DEFAULT_STORE, mode: 'repos' })).toEqual({ mode: 'all' })
    expect(toggledGroup(DEFAULT_STORE)).toEqual({ groupBy: 'repo' })
    expect(toggledGroup({ ...DEFAULT_STORE, groupBy: 'repo' })).toEqual({ groupBy: 'level' })
  })
})

describe('what /god answers', () => {
  it('names what the form did, and says when the engine keeps the pane off the screen', () => {
    expect(commandAnswer({ kind: 'open' }, { isPlaced: true, repos: [] })).toBe('The god pane is open.')
    expect(commandAnswer({ kind: 'open' }, { isPlaced: false, repos: [] })).toBe('The god pane waits for more room. Make the terminal wider.')
    expect(commandAnswer({ kind: 'all' }, { isPlaced: true, repos: [] })).toBe('The god pane shows every live session.')
    expect(commandAnswer({ kind: 'repos', names: ['repo-a', 'repo-b'] }, { isPlaced: true, repos: ['repo-a', 'repo-b'] })).toBe('The god pane shows the sessions of these repos: repo-a, repo-b.')
    expect(commandAnswer({ kind: 'show-repos' }, { isPlaced: true, repos: ['repo-a'] })).toBe('The repos mode shows these repos: repo-a.')
    expect(commandAnswer({ kind: 'show-repos' }, { isPlaced: true, repos: [] })).toBe('No repo is selected. Run /god repos <name> to select one.')
    expect(commandAnswer({ kind: 'unknown' }, { isPlaced: true, repos: [] })).toMatch(/^Run \/god to open the pane\. Run \/god all /)
  })
})

describe('the selection', () => {
  it('follows the ring onto a session row or a closed group heading, and not onto a key or a row that is gone', () => {
    const snapshot = boardSnapshot()
    expect(selectionOf('s-wait', snapshot)).toBe('s-wait')
    expect(selectionOf(STALE_GROUP_KEY, snapshot)).toBe(STALE_GROUP_KEY)
    expect(selectionOf('key:n', snapshot)).toBeUndefined()
    expect(selectionOf('s-gone', snapshot)).toBeUndefined()
    expect(selectionOf(undefined, snapshot)).toBeUndefined()
    expect(selectionOf('s-wait', undefined)).toBeUndefined()
    expect(selectionOf('group:working', snapshot)).toBeUndefined()
  })

  it('a press on the heading of a group that starts closed opens it, and a second press closes it; a session row changes nothing', () => {
    const snapshot = boardSnapshot()
    expect(openGroupsAfterPress([], STALE_GROUP_KEY, snapshot)).toEqual(['stale'])
    expect(openGroupsAfterPress(['stale'], STALE_GROUP_KEY, snapshot)).toEqual([])
    const open: readonly string[] = ['stale']
    expect(openGroupsAfterPress(open, 's-wait', snapshot)).toBe(open)
    expect(openGroupsAfterPress(open, 'group:working', snapshot)).toBe(open)
    expect(openGroupsAfterPress(open, STALE_GROUP_KEY, undefined)).toBe(open)
  })

  it('n selects the next session that needs you in board order after the selected row, and goes round', () => {
    const snapshot = snapshotOf([waiting('s-w1', { name: 'w1', statusSince: NOW - 3000 }), waiting('s-w2', { name: 'w2', statusSince: NOW - 2000 }), idle('s-i', { name: 'i' })])
    expect(nextNeedsYou(snapshot, undefined)).toBe('s-w1')
    expect(nextNeedsYou(snapshot, 's-w1')).toBe('s-w2')
    expect(nextNeedsYou(snapshot, 's-w2')).toBe('s-w1')
    expect(nextNeedsYou(snapshot, 's-i')).toBe('s-w1')
    expect(nextNeedsYou(snapshotOf([idle('s-i', { name: 'i' })]), undefined)).toBeUndefined()
    expect(nextNeedsYou(undefined, undefined)).toBeUndefined()
  })

  it('n walks only the rows that the mode keeps, in the order of the groups', () => {
    const snapshot = byRepoSnapshot()
    const shown = snapshot.groups.flatMap((group) => group.sessionIds)
    const needing = shown.filter((id) => snapshot.sessions.find((session) => session.sessionId === id)?.level === 'needs-you')
    expect(needing.length).toBeGreaterThan(0)
    expect(nextNeedsYou(snapshot, undefined)).toBe(needing[0])
  })
})

describe('the status line', () => {
  it('counts the sessions that need you while the pane is closed, and shows nothing while it is open or none needs you', () => {
    const snapshot = boardSnapshot()
    const count = snapshot.sessions.filter((session) => session.level === 'needs-you').length
    expect(count).toBe(1)
    expect(statusText(snapshot, false)).toBe('god: 1 needs you')
    expect(statusText(snapshotOf([waiting('a', { name: 'a' }), waiting('b', { name: 'b' })]), false)).toBe('god: 2 need you')
    expect(statusText(snapshot, true)).toBeUndefined()
    expect(statusText(snapshotOf([idle('s-i', { name: 'i' })]), false)).toBeUndefined()
    expect(statusText(undefined, false)).toBeUndefined()
  })
})
