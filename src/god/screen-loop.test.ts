/**
 * The screen loop of the Screen tab: it reads the screen of the selected session every 1 s while the tab is open
 * and a surface draws it, and it stops when the tab closes, the pane closes, or no surface draws it (the pane hid).
 * - screenWanted: the tab that the shared state asks for, the same on every surface;
 * - the loop: a draw that shows the tab starts it or renews it; a timer tick with no draw since 2 ticks stops it.
 */
import { describe, expect, it } from 'vitest'
import { detailSnapshot } from '../../test/fixtures/god/detail.js'
import { degradedSnapshot } from '../../test/fixtures/god/snapshots.js'
import { DEFAULT_DETAIL } from './view/detail-pane.js'
import { paneView } from './view/pane.js'
import { NOW } from '../../test/fixtures/god/sessions.js'
import { SCREEN_LEASE_TICKS, SCREEN_MS, createScreenLoop, isScreenShown, screenWanted, type ScreenPorts } from './screen-loop.js'
import type { ScreenState, ScreenTarget } from './source/screen.js'
import type { ScreenRead } from './types.js'

const WAIT: ScreenTarget = { sessionId: 's-wait', workspaceRef: 'workspace:7', surfaceRef: 'surface:12' }
const WORK: ScreenTarget = { sessionId: 's-work', workspaceRef: 'workspace:7', surfaceRef: 'surface:12' }

/** A loop over fake ports: each read answers from `answers` (a text, or undefined for a failed read). */
function loopOf(answers: Array<string | undefined> = []) {
  const reads: ScreenTarget[] = []
  const writes: ScreenState[] = []
  const timers: Array<{ ms: number; fn: () => void; isCancelled: boolean }> = []
  let time = 1000
  const pending: Array<() => void> = []
  const ports: ScreenPorts = {
    read: (target) => {
      reads.push(target)
      const text = answers.length > 0 ? answers.shift() : 'screen'
      return new Promise<ScreenRead | undefined>((resolve) => pending.push(() => resolve(text === undefined ? undefined : { ...target, text, readAt: time })))
    },
    write: async (state) => {
      writes.push(state)
    },
    every: (ms, fn) => {
      const timer = { ms, fn, isCancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.isCancelled = true) }
    },
  }
  const loop = createScreenLoop(ports)
  /** answers every read in flight, and lets the writes settle */
  const settle = async (): Promise<void> => {
    while (pending.length > 0) pending.shift()!()
    for (let step = 0; step < 5; step += 1) await Promise.resolve()
  }
  /** fires each live timer once, as 1 period of the engine clock does */
  const tick = async (): Promise<void> => {
    time += SCREEN_MS
    for (const timer of timers.filter((one) => !one.isCancelled)) timer.fn()
    await settle()
  }
  const live = (): number => timers.filter((timer) => !timer.isCancelled).length
  return { loop, reads, writes, timers, settle, tick, live }
}

describe('screenWanted', () => {
  it('asks for the mapped tab of the selected session while the Screen tab is open', () => {
    expect(screenWanted(detailSnapshot(), 's-wait', 'screen')).toEqual(WAIT)
  })

  it('asks for nothing in another tab, with no selection, for a session with no tab, with no cmux, or with no board', () => {
    expect(screenWanted(detailSnapshot(), 's-wait', 'now')).toBeUndefined()
    expect(screenWanted(detailSnapshot(), undefined, 'screen')).toBeUndefined()
    expect(screenWanted(detailSnapshot(), 's-idle', 'screen')).toBeUndefined()
    const noCmux = { ...degradedSnapshot({ cmux: { status: 'missing' } }), sessions: detailSnapshot().sessions }
    expect(screenWanted(noCmux, 's-wait', 'screen')).toBeUndefined()
    expect(screenWanted(undefined, 's-wait', 'screen')).toBeUndefined()
  })
})

describe('isScreenShown', () => {
  const view = (bodyColumns: number, isOpen: boolean, bodyRows = 40) =>
    paneView({ snapshot: detailSnapshot(), bodyColumns, bodyRows, now: NOW, selectedKey: 's-wait', openGroups: [], promptHoldsKeys: false, detail: { ...DEFAULT_DETAIL, tab: 'screen', isOpen } })

  it('is true for the wide pane and for the narrow pane that shows the detail, and false for the narrow board', () => {
    expect(isScreenShown(view(110, false), WAIT)).toBe(true)
    expect(isScreenShown(view(80, true), WAIT)).toBe(true)
    expect(isScreenShown(view(80, false), WAIT)).toBe(false)
  })

  it('is false for another session, no target, and a pane that cannot draw', () => {
    expect(isScreenShown(view(110, false), WORK)).toBe(false)
    expect(isScreenShown(view(110, false), undefined)).toBe(false)
    expect(isScreenShown(view(20, true), WAIT)).toBe(false)
    expect(isScreenShown(view(110, false, 3), WAIT)).toBe(false)
  })
})

describe('the screen loop', () => {
  it('reads at once when a draw shows the tab, then once each SCREEN_MS while the draws go on, and writes each read', async () => {
    const { loop, reads, writes, timers, settle, tick } = loopOf(['one', 'two', 'three'])
    loop.want(WAIT, true)
    await settle()
    expect(timers.map((timer) => timer.ms)).toEqual([SCREEN_MS])
    for (let step = 0; step < 2; step += 1) {
      await tick()
      loop.want(WAIT, true)
    }
    expect(reads).toEqual([WAIT, WAIT, WAIT])
    expect(writes.map((state) => state.read?.text)).toEqual(['one', 'two', 'three'])
    expect(writes.every((state) => state.sessionId === 's-wait' && !state.isFailed)).toBe(true)
  })

  it('stops at once when the shared state asks for no screen: another tab, another session with no tab, no cmux', async () => {
    const { loop, reads, settle, tick, live } = loopOf()
    loop.want(WAIT, true)
    await settle()
    loop.want(undefined, false)
    expect(live()).toBe(0)
    await tick()
    await tick()
    expect(reads).toHaveLength(1)
  })

  it('stops when the pane closes', async () => {
    const { loop, reads, settle, tick, live } = loopOf()
    loop.want(WAIT, true)
    await settle()
    loop.stop()
    expect(live()).toBe(0)
    await tick()
    expect(reads).toHaveLength(1)
  })

  it(`stops after ${SCREEN_LEASE_TICKS} ticks with no draw that shows the tab: the pane hid, so no surface draws it`, async () => {
    const { loop, reads, settle, tick, live } = loopOf()
    loop.want(WAIT, true)
    await settle()
    for (let step = 0; step < SCREEN_LEASE_TICKS + 3; step += 1) await tick()
    expect(reads).toHaveLength(1 + SCREEN_LEASE_TICKS)
    expect(live()).toBe(0)
    // the pane shows again: its next draw starts the reads again
    loop.want(WAIT, true)
    await settle()
    await tick()
    expect(reads).toHaveLength(1 + SCREEN_LEASE_TICKS + 2)
  })

  it('does not start, renew or stop on a surface that does not draw the tab (a narrow board), while another surface does', async () => {
    const { loop, reads, settle, tick, live } = loopOf()
    loop.want(WAIT, false)
    await settle()
    expect(reads).toEqual([])
    expect(live()).toBe(0)
    loop.want(WAIT, true)
    await settle()
    for (let step = 0; step < SCREEN_LEASE_TICKS + 2; step += 1) {
      loop.want(WAIT, false)
      await tick()
    }
    expect(live()).toBe(0)
    expect(reads).toHaveLength(1 + SCREEN_LEASE_TICKS)
  })

  it('reads the new tab at once when the selection moves to another session, and drops a read of the old one', async () => {
    const { loop, reads, writes, settle, timers } = loopOf(['old', 'new'])
    loop.want(WAIT, true)
    loop.want(WORK, true)
    await settle()
    await settle()
    expect(timers.filter((timer) => !timer.isCancelled)).toHaveLength(1)
    expect(reads.map((target) => target.sessionId)).toEqual(['s-wait', 's-work'])
    expect(writes.map((state) => state.sessionId)).toEqual(['s-work'])
  })

  it('starts no second read while 1 runs', async () => {
    const { loop, reads, timers } = loopOf()
    loop.want(WAIT, true)
    for (const timer of timers) timer.fn()
    for (const timer of timers) timer.fn()
    expect(reads).toHaveLength(1)
  })

  it('marks a failed read and keeps the last good read of the same session under it', async () => {
    const { loop, writes, settle, tick } = loopOf(['good', undefined])
    loop.want(WAIT, true)
    await settle()
    await tick()
    expect(writes.at(-1)).toEqual({ sessionId: 's-wait', read: { ...WAIT, text: 'good', readAt: 1000 }, isFailed: true })
  })
})
