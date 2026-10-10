// The engine shell of the motion of the god pane: the ports of the motion loop over `$`, the sparkline in the engine
// state, and the motion of 1 draw, with no rule of their own. The rules are in src/god/motion-loop.ts and
// src/god/view/motion.ts. Every function that takes `$` is a function declaration at the top of the file, as the
// engine asks.
// - The motion loop is 1 timer of the engine clock. Each tick asks the pane to draw again, and each draw tells the
//   loop the period that it needs, so the timer stops when no surface draws the pane.
// - Each tick of the board adds its working sessions to the sparkline. A tick that adds nothing writes nothing.
// - Only the terminal gets the sparkline: the element table of the desktop has no Raster.
import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { RefreshTurn } from './board-loop.js'
import { engineClock } from './engine.js'
import { createMotionLoop, type MotionLoop } from './motion-loop.js'
import { SPARK } from './state.js'
import type { Settings } from './types.js'
import { paneMotion, sparkAfter, type PaneMotion } from './view/motion.js'

export type { MotionLoop } from './motion-loop.js'

/** The motion loop over the engine clock and the redraw of the pane. */
export function motionLoopOf($: EngineInterface): MotionLoop {
  return createMotionLoop({
    every: (ms, fn) => $.clock.every(ms, fn),
    redraw: () => $.ui.invalidate('ui.render'),
  })
}

/** Adds the working sessions of 1 tick of the board to the sparkline in the engine state. */
export async function recordSpark($: EngineInterface, turn: RefreshTurn): Promise<void> {
  const spark = await read($, SPARK)
  if (sparkAfter(spark, turn.next, turn.now) === spark) return
  await update($, SPARK, (current) => sparkAfter(current, turn.next, turn.now))
}

/** The motion of 1 draw: the frame of the elapsed motion time, and the sparkline on a surface with a Raster. */
export async function drawnMotion($: EngineInterface, elapsedMs: number, motion: Settings['motion'], hasRaster: boolean): Promise<PaneMotion> {
  return paneMotion({ motion, elapsedMs, spark: await read($, SPARK), hasRaster, now: engineClock() })
}
