/**
 * The key row of the god pane: the keys of the board, the `ctrl+x tab` line while the prompt holds the keys, and
 * the line that says why jump, answer and reply are off when cmux is not on the machine.
 */
import { describe, expect, it } from 'vitest'
import { cellWidth } from './cells.js'
import { KEY_ROW_NO_CMUX, keyRow } from './keys.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const BASE = { width: 110, isCmuxMissing: false, promptHoldsKeys: false }

describe('the key row', () => {
  it('shows the keys of the board in 1 row', () => {
    const row = keyRow(BASE)
    expect(row.lines.map(text)).toEqual([' ↑↓ select  j jump  n next  1-9 answer  r reply  m message  t tab  s sound'])
    expect(row.hints.filter((hint) => hint.hotkey !== undefined).map((hint) => hint.hotkey)).toEqual(['j', 'n', 'r', 'm', 't', 's'])
    expect(row.hints.every((hint) => !hint.isOff)).toBe(true)
  })

  it('names the digits of the open question of the selected session', () => {
    expect(keyRow({ ...BASE, answerCount: 3 }).lines.map(text).join('')).toMatch(/ {2}1-3 answer {2}/)
    expect(keyRow({ ...BASE, answerCount: 1 }).lines.map(text).join('')).toMatch(/ {2}1 answer {2}/)
  })

  it('ends with the ctrl+x tab line while the prompt holds the keys', () => {
    expect(keyRow({ ...BASE, promptHoldsKeys: true }).lines.map(text).join('')).toMatch(/ {2}ctrl\+x tab: keys to the pane$/)
  })

  it('draws j, the digits and r dim with no cmux, and says why in a line of its own', () => {
    const row = keyRow({ ...BASE, isCmuxMissing: true })
    expect(row.hints.filter((hint) => hint.isOff).map((hint) => hint.keys)).toEqual(['j', '1-9', 'r'])
    expect(row.lines.map(text)).toEqual([' ↑↓ select  j jump  n next  1-9 answer  r reply  m message  t tab  s sound', ` ${KEY_ROW_NO_CMUX}`])
    const jump = row.lines[0]!.segments.filter((segment) => segment.text.includes('j'))
    expect(jump.length).toBeGreaterThan(0)
    for (const segment of jump) expect(segment.dim, segment.text).toBe(true)
    expect(KEY_ROW_NO_CMUX).toBe('Jump, answer and reply are off: cmux is not on this machine.')
  })

  it('moves whole keys to the next line when they do not fit', () => {
    for (const width of [30, 60, 89]) {
      const lines = keyRow({ ...BASE, width, isCmuxMissing: true, promptHoldsKeys: true }).lines.map(text)
      for (const line of lines) expect(cellWidth(line), `${width} columns: ${line}`).toBeLessThanOrEqual(width)
      expect(lines.join(' '), `${width} columns`).toMatch(/1-9 answer/)
      expect(lines.join(' '), `${width} columns`).toMatch(/ctrl\+x tab: keys to the pane/)
    }
  })
})
