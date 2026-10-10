/**
 * The motion of the god pane, as pure code:
 * - the braille spinner of a WORKING row walks SPINNER_FRAMES at 8 frames each second, and the NEEDS YOU row switches
 *   its pulse each PULSE_MS (1 cycle each second). The frame comes from the elapsed motion time of the motion loop
 *   (src/god/motion-loop.ts), not from the clock, so a pane with no motion keeps its frame;
 * - a drawn view needs the spinner period while it draws a WORKING row, else the pulse period while it draws a NEEDS
 *   YOU row, else no timer: the motion option is off, or the view draws no such row (a message, the narrow detail,
 *   a window that cuts the moving rows away);
 * - the sparkline: each tick of the board adds its working sessions to the minute of the tick, each session once,
 *   and the state keeps only the last SPARK_MINUTES minutes. The header draws the count of each minute as 1 of 8
 *   block heights of the busiest minute, and a minute with no work as a space, as 1 Raster where the surface has one;
 * - the motion option off gives no frame and no sparkline, so the pane draws the static frame.
 */
import { base64 } from '../act/tones.js'
import type { BoardSnapshot, Settings } from '../types.js'
import type { PaneView } from './types.js'

/** The frames of the spinner of a WORKING row. The first is the static frame. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** The spinner moves 1 frame this often: 8 frames each second. */
export const SPINNER_MS = 125

/** The pulse of a NEEDS YOU row switches this often: 1 cycle each second. */
export const PULSE_MS = 500

/** The sparkline shows this many minutes, 1 cell each. */
export const SPARK_MINUTES = 30

/** The label after the sparkline. */
export const SPARK_LABEL = '30m'

/** The key of the Raster of the sparkline. */
export const SPARK_KEY = 'spark'

/** The Raster color of the terminal's own color: bit 24 alone. */
export const TERMINAL_COLOR = 0x01000000

const MINUTE_MS = 60_000
const BLOCKS = [...'▁▂▃▄▅▆▇█']

/** The frame of 1 draw: the spinner frame and whether the pulse is on. */
export type MotionFrame = { spinner: number; isPulseOn: boolean }

/** The motion of 1 draw of the pane. No frame: the static frame. No spark: no sparkline. */
export type PaneMotion = { frame?: MotionFrame; spark?: readonly number[] }

/** The working sessions of 1 minute (the minute count since the epoch), each once. */
export type SparkMinute = { minute: number; ids: readonly string[] }

/** The sparkline data in the engine state: the minutes of the last SPARK_MINUTES that had work, oldest first. */
export type SparkState = { minutes: readonly SparkMinute[] }

export const NO_SPARK: SparkState = { minutes: [] }

/** The frame after `elapsedMs` of motion. */
export function motionFrame(elapsedMs: number): MotionFrame {
  return { spinner: Math.floor(elapsedMs / SPINNER_MS) % SPINNER_FRAMES.length, isPulseOn: Math.floor(elapsedMs / PULSE_MS) % 2 === 1 }
}

/** The spinner glyph of a frame. */
export function spinnerGlyph(frame: MotionFrame): string {
  return SPINNER_FRAMES[frame.spinner] ?? SPINNER_FRAMES[0]
}

/** The timer period that a drawn view needs, or undefined for none. */
export function motionPeriod(view: PaneView, snapshot: BoardSnapshot | undefined, motion: Settings['motion']): number | undefined {
  if (motion === 'off' || view.kind !== 'board' || snapshot === undefined) return undefined
  const drawn = new Set(view.body.flatMap((line) => (line.key === undefined ? [] : [line.key])))
  const levels = snapshot.sessions.filter((session) => drawn.has(session.sessionId)).map((session) => session.level)
  if (levels.includes('working')) return SPINNER_MS
  return levels.includes('needs-you') ? PULSE_MS : undefined
}

/** The sparkline after 1 tick at `now`. A tick that adds no session and drops no minute gives the same state back. */
export function sparkAfter(spark: SparkState, snapshot: BoardSnapshot, now: number): SparkState {
  const minute = Math.floor(now / MINUTE_MS)
  const kept = spark.minutes.filter((entry) => entry.minute > minute - SPARK_MINUTES && entry.minute <= minute)
  const current = kept.find((entry) => entry.minute === minute)
  const added = snapshot.sessions.filter((session) => session.level === 'working' && !(current?.ids.includes(session.sessionId) ?? false)).map((session) => session.sessionId)
  if (added.length === 0) return kept.length === spark.minutes.length ? spark : { minutes: kept }
  return { minutes: [...kept.filter((entry) => entry !== current), { minute, ids: [...(current?.ids ?? []), ...added] }] }
}

/** The count of working sessions in each of the last SPARK_MINUTES minutes up to `now`, oldest first. */
export function sparkCounts(spark: SparkState, now: number): number[] {
  const first = Math.floor(now / MINUTE_MS) - SPARK_MINUTES + 1
  return Array.from({ length: SPARK_MINUTES }, (_, index) => spark.minutes.find((entry) => entry.minute === first + index)?.ids.length ?? 0)
}

/** 1 glyph for each count: 1 of 8 block heights of the highest count, and a space for 0. */
export function sparkGlyphs(counts: readonly number[]): string {
  const top = Math.max(0, ...counts)
  return counts.map((count) => (count > 0 && top > 0 ? BLOCKS[Math.ceil((count / top) * BLOCKS.length) - 1] : ' ')).join('')
}

/** The Raster cells of 1 row of glyphs: each cell its code point, `color` and the terminal's own background. */
export function rasterCells(glyphs: string, color: number): string {
  const chars = [...glyphs]
  const words = new DataView(new ArrayBuffer(chars.length * 12))
  chars.forEach((char, cell) => {
    words.setUint32(cell * 12, char.codePointAt(0) ?? 0, true)
    words.setUint32(cell * 12 + 4, color, true)
    words.setUint32(cell * 12 + 8, TERMINAL_COLOR, true)
  })
  return base64(new Uint8Array(words.buffer))
}

/** What the motion of 1 draw reads. */
export type MotionInput = {
  motion: Settings['motion']
  /** the elapsed motion time of the motion loop */
  elapsedMs: number
  spark: SparkState
  /** true when the surface draws a Raster (the terminal) */
  hasRaster: boolean
  now: number
}

/** The motion of 1 draw: the frame, and the sparkline only on a surface with a Raster. None when the option is off. */
export function paneMotion(input: MotionInput): PaneMotion {
  if (input.motion === 'off') return {}
  const frame = motionFrame(input.elapsedMs)
  return input.hasRaster ? { frame, spark: sparkCounts(input.spark, input.now) } : { frame }
}
