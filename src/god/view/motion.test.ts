/**
 * The motion of the god pane: the spinner frame of a WORKING row, the pulse of a NEEDS YOU row, the timer period that
 * a drawn view needs (none when motion is off, or when no drawn row works or waits), and the sparkline: the sessions
 * that worked in each minute of the last 30 min, its glyphs and its Raster cells.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, SECOND, busy, idle, waiting } from '../../../test/fixtures/god/sessions.js'
import { NOW, boardSnapshot, emptySnapshot, readingSnapshot, snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import type { BoardSnapshot } from '../types.js'
import { headerLines } from './header.js'
import { NO_SPARK, PULSE_MS, SPARK_LABEL, SPARK_MINUTES, SPINNER_FRAMES, SPINNER_MS, TERMINAL_COLOR, motionFrame, motionPeriod, paneMotion, rasterCells, sparkAfter, sparkCounts, sparkGlyphs, spinnerGlyph, type SparkState } from './motion.js'
import { paneView, type PaneInput } from './pane.js'
import type { Line, PaneView } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const pane = (snapshot: BoardSnapshot, over: Partial<PaneInput> = {}): PaneView =>
  paneView({ snapshot, bodyColumns: 110, bodyRows: 40, now: NOW, openGroups: [], promptHoldsKeys: false, ...over })
const rowOf = (view: PaneView, sessionId: string): Line => {
  const line = view.kind === 'board' ? view.body.find((candidate) => candidate.key === sessionId) : undefined
  if (line === undefined) throw new Error(`no row for ${sessionId}`)
  return line
}
/** the decoded Raster cells: each [code point, foreground, background] */
const decode = (cells: string): number[][] => {
  const bytes = Uint8Array.from(atob(cells), (char) => char.charCodeAt(0))
  const words = new DataView(bytes.buffer)
  return Array.from({ length: bytes.length / 12 }, (_, cell) => [0, 4, 8].map((at) => words.getUint32(cell * 12 + at, true)))
}

describe('the spinner and the pulse', () => {
  it('walks the 10 braille frames at 8 frames each second, and pulses each 500 ms (1 cycle each second)', () => {
    expect(SPINNER_FRAMES.join('')).toBe('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏')
    expect(SPINNER_MS).toBe(125)
    expect(PULSE_MS).toBe(500)
    expect([0, 125, 250, 1125, 1250].map((ms) => spinnerGlyph(motionFrame(ms)))).toEqual(['⠋', '⠙', '⠹', '⠏', '⠋'])
    expect([0, 499, 500, 999, 1000].map((ms) => motionFrame(ms).isPulseOn)).toEqual([false, false, true, true, false])
  })

  it('draws the WORKING rows with the spinner frame, and the static frame when the pane has no motion', () => {
    const moving = pane(boardSnapshot(), { motion: { frame: motionFrame(375) } })
    expect(text(rowOf(moving, 's-work'))).toMatch(/^ ⠸ api-9 /)
    expect(text(rowOf(moving, 's-new'))).toMatch(/^ ⠸ docs-1 /)
    expect(text(rowOf(pane(boardSnapshot()), 's-work'))).toMatch(/^ ⠋ api-9 /)
    expect(text(rowOf(pane(boardSnapshot(), { motion: { frame: motionFrame(0) } }), 's-work'))).toMatch(/^ ⠋ api-9 /)
  })

  it('switches the bold and the color of the glyph and the name of a NEEDS YOU row with the pulse, and leaves the other rows', () => {
    const glyphAndName = (view: PaneView) => rowOf(view, 's-wait').segments.slice(1, 4)
    expect(glyphAndName(pane(boardSnapshot(), { motion: { frame: motionFrame(500) } }))).toEqual([{ text: '⚠', token: '--bad', bold: true }, { text: ' ' }, { text: 'api-7', token: '--bad', bold: true }])
    const quiet = [{ text: '⚠', token: '--bad' }, { text: ' ' }, { text: 'api-7' }]
    expect(glyphAndName(pane(boardSnapshot(), { motion: { frame: motionFrame(1000) } }))).toEqual(quiet)
    expect(glyphAndName(pane(boardSnapshot()))).toEqual(quiet)
    expect(rowOf(pane(boardSnapshot(), { motion: { frame: motionFrame(500) } }), 's-turn').segments).toEqual(rowOf(pane(boardSnapshot()), 's-turn').segments)
  })
})

describe('the timer period that a drawn view needs', () => {
  const working = snapshotOf([busy('s-a', { name: 'work-a' }), idle('s-b', { name: 'idle-b', statusSince: NOW - 3 * MINUTE })])
  const asking = snapshotOf([idle('s-b', { name: 'idle-b' }), waiting('s-c', { name: 'ask-c' })])

  it('asks for the spinner period while a drawn row works, and the pulse period while only a drawn row waits', () => {
    expect(motionPeriod(pane(boardSnapshot()), boardSnapshot(), 'on')).toBe(SPINNER_MS)
    expect(motionPeriod(pane(working), working, 'on')).toBe(SPINNER_MS)
    expect(motionPeriod(pane(asking), asking, 'on')).toBe(PULSE_MS)
  })

  it('asks for no timer when the motion option is off, whatever the rows', () => {
    expect(motionPeriod(pane(boardSnapshot()), boardSnapshot(), 'off')).toBeUndefined()
    expect(motionPeriod(pane(asking), asking, 'off')).toBeUndefined()
  })

  it('asks for no timer when no drawn row works or waits: idle rows, a message, the narrow detail, a cut window', () => {
    const quiet = snapshotOf([idle('s-b', { name: 'idle-b' }), idle('s-d', { name: 'idle-d', statusSince: NOW - 3 * MINUTE })])
    expect(motionPeriod(pane(quiet), quiet, 'on')).toBeUndefined()
    expect(motionPeriod(pane(emptySnapshot()), emptySnapshot(), 'on')).toBeUndefined()
    expect(motionPeriod(pane(readingSnapshot()), readingSnapshot(), 'on')).toBeUndefined()
    const detail = pane(boardSnapshot(), { bodyColumns: 80, selectedKey: 's-work', detail: { tab: 'now', scroll: 0, isOpen: true } })
    expect(detail.kind).toBe('detail')
    expect(motionPeriod(detail, boardSnapshot(), 'on')).toBeUndefined()
    // 5 rows of 80 columns: the window keeps the stale group in view, and the moving rows are cut away
    const window = pane(boardSnapshot(), { bodyColumns: 80, bodyRows: 9, selectedKey: 'group:stale' })
    expect(window.kind === 'board' && window.body.some((line) => line.key === 's-work' || line.key === 's-wait')).toBe(false)
    expect(motionPeriod(window, boardSnapshot(), 'on')).toBeUndefined()
  })
})

describe('the sparkline', () => {
  const at = (minute: number, second = 0): number => NOW + minute * MINUTE + second * SECOND
  const workingIds = (...ids: string[]): BoardSnapshot => snapshotOf(ids.map((id) => busy(id, { name: id })))

  it('counts each session that worked in a minute once, and keeps only the last 30 minutes', () => {
    let spark: SparkState = NO_SPARK
    spark = sparkAfter(spark, workingIds('s-a'), at(0, 5))
    spark = sparkAfter(spark, workingIds('s-a', 's-b'), at(0, 40))
    spark = sparkAfter(spark, workingIds('s-b'), at(2, 1))
    spark = sparkAfter(spark, snapshotOf([idle('s-c')]), at(3, 1))
    const counts = sparkCounts(spark, at(3, 30))
    expect(counts).toHaveLength(SPARK_MINUTES)
    expect(counts.slice(-4)).toEqual([2, 0, 1, 0])
    expect(counts.slice(0, -4).every((count) => count === 0)).toBe(true)
    const later = sparkAfter(spark, workingIds('s-d'), at(31, 0))
    expect(later.minutes.map((minute) => minute.ids)).toEqual([['s-b'], ['s-d']])
    expect(sparkCounts(later, at(31, 0)).slice(-30, -28)).toEqual([1, 0])
  })

  it('gives the same state back when a tick adds nothing, so the engine state is not written', () => {
    const spark = sparkAfter(NO_SPARK, workingIds('s-a'), at(0, 5))
    expect(sparkAfter(spark, workingIds('s-a'), at(0, 30))).toBe(spark)
    expect(sparkAfter(NO_SPARK, snapshotOf([idle('s-c')]), at(0, 5))).toBe(NO_SPARK)
  })

  it('draws a count as 1 of 8 block heights of the busiest minute, and a minute with no work as a space', () => {
    expect(sparkGlyphs([0, 1, 2, 4, 8])).toBe(' ▁▂▄█')
    expect(sparkGlyphs([0, 0, 0])).toBe('   ')
    expect(sparkGlyphs([3, 1])).toBe('█▃')
  })

  it('packs each glyph as 1 Raster cell: the code point, the foreground and the terminal background', () => {
    const color = Number.parseInt('7fa8d8', 16)
    expect(decode(rasterCells(' ▁█', color))).toEqual([
      [0x20, color, TERMINAL_COLOR],
      [0x2581, color, TERMINAL_COLOR],
      [0x2588, color, TERMINAL_COLOR],
    ])
  })

  it('sits in the header after the mode, as 1 item of the 30 minute glyphs and the label, and only when the line holds it whole', () => {
    const counts = [...Array<number>(SPARK_MINUTES - 2).fill(0), 1, 2]
    const header = headerLines({ snapshot: boardSnapshot(), width: 110, now: NOW, spark: counts })
    const segments = header.flatMap((line) => line.segments)
    const glyphs = segments.find((segment) => segment.raster === true)
    expect(glyphs).toEqual({ text: sparkGlyphs(counts), token: '--cat-read', raster: true })
    expect(segments[segments.indexOf(glyphs!) + 1]).toEqual({ text: ` ${SPARK_LABEL}`, dim: true })
    expect(header.map(text).join('\n')).toMatch(/ all {2}[ ▁-█]{30} 30m/)
    expect(headerLines({ snapshot: boardSnapshot(), width: 34, now: NOW, spark: counts }).flatMap((line) => line.segments).some((segment) => segment.raster === true)).toBe(false)
    expect(headerLines({ snapshot: boardSnapshot(), width: 110, now: NOW }).flatMap((line) => line.segments).some((segment) => segment.raster === true)).toBe(false)
  })
})

describe('the motion of 1 draw', () => {
  const spark = sparkAfter(NO_SPARK, snapshotOf([busy('s-a')]), NOW)

  it('gives the frame of the elapsed motion time, and the sparkline only on a surface that has a Raster', () => {
    expect(paneMotion({ motion: 'on', elapsedMs: 250, spark, hasRaster: true, now: NOW })).toEqual({ frame: motionFrame(250), spark: sparkCounts(spark, NOW) })
    expect(paneMotion({ motion: 'on', elapsedMs: 250, spark, hasRaster: false, now: NOW })).toEqual({ frame: motionFrame(250) })
  })

  it('gives no frame and no sparkline when the motion option is off', () => {
    expect(paneMotion({ motion: 'off', elapsedMs: 250, spark, hasRaster: true, now: NOW })).toEqual({})
  })
})
