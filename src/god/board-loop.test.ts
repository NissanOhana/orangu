/**
 * The board loop: what the engine does on each tick of the pane. It refreshes the facts, makes a snapshot on every
 * tick (a dropped one too), adds the first-sight times to the store, writes the snapshot only when it changed, keeps
 * the status line while the pane is closed, and draws the pane again when only a time that it shows moved.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, PANE_START, SECOND, SETTINGS, STORE, busy, facts, idle, waiting } from '../../test/fixtures/god/sessions.js'
import { createBoardLoop, type BoardPorts } from './board-loop.js'
import type { BoardSnapshot, Facts, StoreState } from './types.js'

const SELF = 'god-self'

type Recorded = { snapshots: BoardSnapshot[]; store: Array<[string, unknown]>; statuses: Array<string | undefined>; redraws: number }

/** A loop over fake ports: the clock reads `time.now`, and each refresh answers the next queued facts. */
function loopOf(queue: Array<Facts | Promise<Facts>>, over: { store?: StoreState; isPaneOpen?: boolean; ports?: Partial<BoardPorts> } = {}) {
  const time = { now: NOW }
  const recorded: Recorded = { snapshots: [], store: [], statuses: [], redraws: 0 }
  let last: Facts | Promise<Facts> | undefined
  const ports: BoardPorts = {
    refresh: () => {
      last = queue.length > 0 ? queue.shift()! : last
      return Promise.resolve(last!)
    },
    clock: () => time.now,
    writeSnapshot: async (snapshot) => {
      recorded.snapshots.push(snapshot)
    },
    writeStore: async (key, value) => {
      recorded.store.push([key, value])
    },
    showStatus: (text) => {
      recorded.statuses.push(text)
    },
    redraw: () => {
      recorded.redraws += 1
    },
    ...over.ports,
  }
  const loop = createBoardLoop({ ports, store: over.store ?? STORE, settings: SETTINGS, selfId: SELF, paneStartedAt: PANE_START, isPaneOpen: over.isPaneOpen ?? true })
  return { loop, time, recorded }
}

const atFacts = (sessions: Parameters<typeof facts>[0], at: number): Facts => ({ ...facts(sessions), stats: { ...facts(sessions).stats, at } })

describe('the board loop', () => {
  it('writes the first snapshot, and the first-sight time of each board session to the store', async () => {
    const { loop, recorded } = loopOf([facts([waiting('s-a', { name: 'a' }), idle('s-b', { name: 'b' }), idle(SELF, { name: 'god' })])])
    await loop.tick()
    expect(recorded.snapshots).toHaveLength(1)
    expect(recorded.snapshots[0]!.firstRefreshDone).toBe(true)
    expect(recorded.snapshots[0]!.sessions.map((session) => session.sessionId)).toEqual(['s-a', 's-b'])
    expect(recorded.store).toEqual([['seenAt', { 's-a': PANE_START, 's-b': PANE_START }]])
    expect(loop.store().seenAt).toEqual({ 's-a': PANE_START, 's-b': PANE_START })
  })

  it('writes nothing again when the facts and the clock give the same board', async () => {
    const same = facts([idle('s-b', { name: 'b' })])
    const { loop, recorded } = loopOf([same, same])
    await loop.tick()
    await loop.tick()
    expect(recorded.snapshots).toHaveLength(1)
    expect(recorded.store).toHaveLength(1)
  })

  it('writes the snapshot again when a session changed', async () => {
    const { loop, recorded } = loopOf([facts([busy('s-a', { name: 'a' })]), facts([waiting('s-a', { name: 'a' })])])
    await loop.tick()
    await loop.tick()
    expect(recorded.snapshots.map((snapshot) => snapshot.sessions[0]!.level)).toEqual(['working', 'needs-you'])
  })

  it('makes a snapshot on a dropped tick too, so facts that stopped moving show as old', async () => {
    const only = facts([idle('s-b', { name: 'b' })])
    const { loop, time, recorded } = loopOf([only])
    await loop.tick()
    time.now = only.stats.at + 12 * SECOND
    await loop.tick()
    expect(recorded.snapshots).toHaveLength(2)
    expect(recorded.snapshots[1]!.at - recorded.snapshots[1]!.factsAt!).toBe(12 * SECOND)
  })

  it('passes the last snapshot as previous, so a level with no time fact keeps its time', async () => {
    const noTimes = busy('s-a', { name: 'a', statusSince: undefined, lastWriteAt: undefined, transcript: undefined })
    const { loop, time } = loopOf([facts([noTimes]), facts([noTimes])])
    await loop.tick()
    time.now = NOW + MINUTE
    await loop.tick()
    expect(loop.snapshot()!.sessions[0]!.levelSince).toBe(NOW)
  })

  it('builds from the newest facts when a slow refresh ends after a faster one', async () => {
    let finishSlow: (value: Facts) => void = () => undefined
    const slow = new Promise<Facts>((resolve) => {
      finishSlow = resolve
    })
    const { loop, recorded } = loopOf([slow, atFacts([waiting('s-a', { name: 'a' })], NOW)])
    const first = loop.tick()
    await loop.tick()
    finishSlow(atFacts([busy('s-a', { name: 'a' })], NOW - 5 * SECOND))
    await first
    expect(recorded.snapshots.at(-1)!.factsAt).toBe(NOW)
    expect(recorded.snapshots.at(-1)!.sessions[0]!.level).toBe('needs-you')
  })

  it('shows the count of sessions that need you while the pane is closed, and clears it when the pane opens', async () => {
    const { loop, recorded } = loopOf([facts([waiting('s-a', { name: 'a' }), idle('s-b', { name: 'b' })])], { isPaneOpen: false })
    await loop.tick()
    await loop.tick()
    expect(recorded.statuses).toEqual(['god: 1 needs you'])
    await loop.setPaneOpen(true)
    expect(recorded.statuses).toEqual(['god: 1 needs you', undefined])
    await loop.setPaneOpen(false)
    expect(recorded.statuses).toEqual(['god: 1 needs you', undefined, 'god: 1 needs you'])
  })

  it('keeps a choice in the store and writes a snapshot with it at once', async () => {
    const { loop, recorded } = loopOf([facts([waiting('s-a', { name: 'a' })])])
    await loop.tick()
    await loop.choose({ mode: 'repos', repos: ['repo-a'] })
    expect(recorded.store.slice(1)).toEqual([
      ['mode', 'repos'],
      ['repos', ['repo-a']],
    ])
    expect(recorded.snapshots.at(-1)!.mode).toBe('repos')
    expect(recorded.snapshots.at(-1)!.repos).toEqual(['repo-a'])
    await loop.choose({ groupBy: 'repo' })
    expect(recorded.store.at(-1)).toEqual(['groupBy', 'repo'])
    expect(loop.store()).toMatchObject({ mode: 'repos', repos: ['repo-a'], groupBy: 'repo' })
  })

  it('draws the open pane again when only a time that it shows moved, and not when nothing it shows moved', async () => {
    const steady = atFacts([idle('s-b', { name: 'b' })], NOW)
    const { loop, time, recorded } = loopOf([steady])
    await loop.tick()
    time.now = NOW + 100
    await loop.tick()
    expect(recorded.redraws).toBe(0)
    time.now = NOW + 2 * MINUTE
    await loop.tick()
    expect(recorded.snapshots).toHaveLength(2)
    time.now = NOW + 2 * MINUTE + 61 * SECOND
    await loop.tick()
    expect(recorded.redraws).toBeGreaterThan(0)
  })

  it('goes on after a port fails, and writes the snapshot on the next tick', async () => {
    let fails = 1
    const { loop, recorded } = loopOf([facts([idle('s-b', { name: 'b' })])], {
      ports: {
        writeSnapshot: async (snapshot) => {
          if (fails-- > 0) throw new Error('state write refused')
          recorded.snapshots.push(snapshot)
        },
      },
    })
    await expect(loop.tick()).resolves.toBeUndefined()
    expect(recorded.snapshots).toHaveLength(0)
    await loop.tick()
    expect(recorded.snapshots).toHaveLength(1)
  })

  it('keeps the last facts for /god stats', async () => {
    const one = facts([idle('s-b', { name: 'b' })])
    const { loop } = loopOf([one])
    expect(loop.facts()).toBeUndefined()
    await loop.tick()
    expect(loop.facts()).toBe(one)
  })
})
