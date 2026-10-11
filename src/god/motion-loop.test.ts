/**
 * The motion loop of the god pane: 1 timer of the engine clock that moves the spinner and the pulse while a draw of
 * the pane asks for it, and stops when no draw asks for it (no row works or waits, the motion option is off, or no
 * surface draws the pane) and when the pane closes.
 */
import { describe, expect, it } from 'vitest'
import { MOTION_LEASE_TICKS, createMotionLoop, type MotionPorts } from './motion-loop.js'
import { PULSE_MS, SPINNER_MS } from './view/motion.js'

/** A loop over fake ports: each timer is recorded, and a tick fires each live timer once. */
function loopOf() {
  const timers: Array<{ ms: number; fn: () => void; isCancelled: boolean }> = []
  let redraws = 0
  const ports: MotionPorts = {
    every: (ms, fn) => {
      const timer = { ms, fn, isCancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.isCancelled = true) }
    },
    redraw: () => {
      redraws += 1
    },
  }
  const loop = createMotionLoop(ports)
  const tick = (): void => {
    for (const timer of timers.filter((one) => !one.isCancelled)) timer.fn()
  }
  const live = (): number[] => timers.filter((timer) => !timer.isCancelled).map((timer) => timer.ms)
  return { loop, timers, tick, live, redraws: () => redraws }
}

describe('the motion loop', () => {
  it('starts no timer for a draw that asks for no motion', () => {
    const { loop, timers } = loopOf()
    loop.want(undefined)
    loop.want(undefined)
    expect(timers).toEqual([])
    expect(loop.elapsed()).toBe(0)
  })

  it('starts 1 timer at the period that a draw asks for, and no second one for the next draw', () => {
    const { loop, live } = loopOf()
    loop.want(SPINNER_MS)
    loop.want(SPINNER_MS)
    expect(live()).toEqual([SPINNER_MS])
  })

  it('adds the period to the elapsed motion time on each tick, and asks the pane to draw again', () => {
    const { loop, tick, redraws } = loopOf()
    loop.want(SPINNER_MS)
    tick()
    loop.want(SPINNER_MS)
    tick()
    expect(loop.elapsed()).toBe(2 * SPINNER_MS)
    expect(redraws()).toBe(2)
  })

  it(`stops after ${MOTION_LEASE_TICKS} ticks with no draw that asks for motion (the pane hid, or no row works or waits), and keeps the frame`, () => {
    const { loop, tick, live } = loopOf()
    loop.want(SPINNER_MS)
    tick()
    loop.want(undefined)
    for (let step = 0; step < MOTION_LEASE_TICKS; step += 1) tick()
    expect(live()).toEqual([SPINNER_MS])
    tick()
    expect(live()).toEqual([])
    const kept = loop.elapsed()
    tick()
    expect(loop.elapsed()).toBe(kept)
    loop.want(PULSE_MS)
    expect(live()).toEqual([PULSE_MS])
  })

  it('keeps the 1 timer of a visible pane whose draw comes late: an idle tick between 2 draws does not add up to the lease', () => {
    const { loop, timers, tick, live } = loopOf()
    loop.want(SPINNER_MS)
    tick()
    for (let step = 0; step <= MOTION_LEASE_TICKS; step += 1) {
      // the draw of the tick before comes after the next tick: 1 idle tick, then the draw, then the tick that reads it
      tick()
      expect(live()).toEqual([SPINNER_MS])
      loop.want(SPINNER_MS)
      tick()
    }
    expect(timers).toHaveLength(1)
    expect(loop.elapsed()).toBe((2 * MOTION_LEASE_TICKS + 3) * SPINNER_MS)
  })

  it('moves the frame once for a period that the engine dispatched before it cancelled the timer of the old period', () => {
    const { loop, timers, tick, live, redraws } = loopOf()
    loop.want(SPINNER_MS)
    tick()
    loop.want(PULSE_MS)
    tick()
    expect(live()).toEqual([PULSE_MS])
    const moved = { elapsed: loop.elapsed(), redraws: redraws() }
    // the fake engine fires the cancelled timer of SPINNER_MS once more, as a period already in the queue does
    timers.find((timer) => timer.isCancelled)!.fn()
    expect({ elapsed: loop.elapsed(), redraws: redraws() }).toEqual(moved)
    expect(live()).toEqual([PULSE_MS])
  })

  it('moves to the period that the draws ask for since the last tick, the shortest one first', () => {
    const { loop, tick, live } = loopOf()
    loop.want(SPINNER_MS)
    tick()
    loop.want(PULSE_MS)
    loop.want(SPINNER_MS)
    tick()
    expect(live()).toEqual([SPINNER_MS])
    loop.want(PULSE_MS)
    tick()
    expect(live()).toEqual([PULSE_MS])
    loop.want(SPINNER_MS)
    expect(live()).toEqual([PULSE_MS])
    tick()
    expect(live()).toEqual([SPINNER_MS])
  })

  it('stops at once when the pane closes, and starts again on the next draw that asks for motion', () => {
    const { loop, live, tick, redraws } = loopOf()
    loop.want(SPINNER_MS)
    loop.stop()
    expect(live()).toEqual([])
    tick()
    expect(redraws()).toBe(0)
    loop.want(SPINNER_MS)
    expect(live()).toEqual([SPINNER_MS])
  })
})
