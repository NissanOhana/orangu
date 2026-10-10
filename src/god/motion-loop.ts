/**
 * The motion loop of the god pane: 1 timer of the engine clock that moves the spinner and the pulse, as pure code
 * over ports, so the engine shell (src/god/motion-keys.tsx) only connects the ports to `$`.
 *
 * - Each draw of the pane calls want with the timer period that it needs (motionPeriod, src/god/view/motion.ts), or
 *   with none. A period starts the timer at once when none runs. A draw that needs no period starts nothing.
 * - Each tick adds its period to the elapsed motion time (the frame of the next draw) and asks the pane to draw
 *   again. Then it moves the timer to the shortest period that the draws asked for since the tick before.
 * - A tick after more than MOTION_LEASE_TICKS ticks with no draw that asked for a period stops the timer: no drawn
 *   row works or waits, the motion option is off, or no surface draws the pane (it hid). The elapsed time stays, so
 *   the frame goes on from there when the motion starts again.
 * - stop ends the timer at once: the engine shell calls it when the pane closes.
 */

/** The timer stops after this many ticks with no draw that asks for a period. */
export const MOTION_LEASE_TICKS = 2

/** What the loop asks of the engine. */
export type MotionPorts = {
  /** a timer of the engine clock that calls fn every ms until it is cancelled */
  every: (ms: number, fn: () => void) => { cancel: () => void }
  /** asks the pane to draw again */
  redraw: () => void
}

export type MotionLoop = {
  /** 1 draw of the pane: the period that it needs, or undefined for none */
  want: (period: number | undefined) => void
  /** the elapsed motion time in milliseconds */
  elapsed: () => number
  /** ends the timer at once: the pane closed */
  stop: () => void
}

export function createMotionLoop(ports: MotionPorts): MotionLoop {
  let timer: { period: number; cancel: () => void } | undefined
  let asked: number | undefined
  let idleTicks = 0
  let elapsed = 0

  function stop(): void {
    timer?.cancel()
    timer = undefined
    asked = undefined
  }

  function start(period: number): void {
    const own = { period, cancel: () => handle.cancel() }
    // a period that the engine dispatched before the cancel does not count for the timer after it
    const handle = ports.every(period, () => {
      if (timer === own) tick()
    })
    timer = own
    idleTicks = 0
  }

  function tick(): void {
    if (timer === undefined) return
    elapsed += timer.period
    ports.redraw()
    const next = asked
    asked = undefined
    if (next === undefined) {
      idleTicks += 1
      if (idleTicks > MOTION_LEASE_TICKS) stop()
      return
    }
    idleTicks = 0
    if (next === timer.period) return
    timer.cancel()
    start(next)
  }

  return {
    want: (period) => {
      if (period === undefined) return
      asked = asked === undefined ? period : Math.min(asked, period)
      if (timer === undefined) start(period)
    },
    elapsed: () => elapsed,
    stop,
  }
}
