/**
 * The help view: what each heading of the board means, what the same file chip means, and what each key does, as a
 * label column and a text column. It shows in place of the detail, in a window that w and z scroll.
 */
import { describe, expect, it } from 'vitest'
import { HELP_KEYS, HELP_LEVELS } from '../copy.js'
import { LEVEL_ORDER } from '../types.js'
import { LEVEL_PAINT } from '../ui/theme.js'
import { LEVEL_GLYPH, LEVEL_HEADING } from './board.js'
import { cellWidth } from './cells.js'
import { helpLines } from './help.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')

describe('the help view', () => {
  it('says how to close it, then explains each heading in plain words, in the order of the board', () => {
    const lines = helpLines(102).map(text)
    expect(lines[0]).toBe(' What the pane shows. Press h or Esc to close this help.')
    expect(lines.slice(1, 8)).toEqual([
      ' ⚠ NEEDS YOU  The session waits for your answer to a question or a permission prompt.',
      ' ● YOUR TURN  The session finished its turn and waits for your next prompt.',
      ' ✕ STUCK      The session is busy, but it wrote nothing for a long time, or it got an API error.',
      ' ⠋ WORKING    The session works on its task now.',
      ' · IDLE       The session waits for a prompt, and you saw its last turn.',
      ' ○ STALE      The session is idle for a long time. Press Enter on the heading to show its group.',
      ' same file    This session and another session wrote the same file in the last 2 h.',
    ])
    expect(Object.keys(HELP_LEVELS)).toEqual([...LEVEL_ORDER])
    const needs = helpLines(102)[1]!.segments.find((segment) => segment.text.includes(LEVEL_HEADING['needs-you']))
    expect(needs).toEqual({ text: `${LEVEL_GLYPH['needs-you']} ${LEVEL_HEADING['needs-you']}`, ...LEVEL_PAINT['needs-you'], bold: true })
  })

  it('explains each key of the pane: the key row, the keys of the detail and the confirm bar, and the 2 keys that move the keys', () => {
    const lines = helpLines(102).map(text)
    const labels = lines.slice(8).map((line) => line.slice(1, 14).trim())
    expect(labels).toEqual(['↑↓', 'Enter', 'b', 'j', 'n', '1-9', 'p', 'y  c', 'r', 'm', 't', 'w  z', 'x', 's', 'u', 'f', 'g', 'h', 'Esc', 'ctrl+x tab'])
    expect(HELP_KEYS.map(([key]) => key)).toEqual(labels)
    expect(lines).toContain(' r            Write a prompt. The session reads it as your prompt.')
    expect(lines).toContain(' m            Write a peer note. The session reads it as a note from a peer, not as your prompt.')
    expect(lines).toContain(' h            Show this help, or close it.')
    expect(lines).toContain(' p            Go back 1 question in a dialog with 2 or more single-select questions.')
    expect(lines).toContain(' w  z         Show the lines above or below a cut text.')
    expect(lines).toContain(' x            Make a Recap of the session. This key shows only on the Recap tab.')
  })

  it('wraps each text in its column at whole words, and holds every line to the width', () => {
    for (const width of [30, 53, 79]) {
      const lines = helpLines(width).map(text)
      for (const line of lines) expect(cellWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width)
      const stuck = lines.findIndex((line) => line.includes('STUCK'))
      expect(lines[stuck + 1], `${width}`).toMatch(/^ {14}\S/)
    }
    const words = (lines: readonly Line[]): string => lines.map(text).join(' ').replace(/\s+/g, ' ')
    expect(words(helpLines(30))).toBe(words(helpLines(400)))
  })
})
