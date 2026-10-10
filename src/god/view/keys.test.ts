/**
 * The key row of the god pane: the keys of the board, the `ctrl+x tab` line while the prompt holds the keys, and
 * the line that says why jump, answer and reply are off when cmux is not on the machine.
 */
import { describe, expect, it } from 'vitest'
import { cellWidth } from './cells.js'
import { JUMP_NOTE, KEY_ROW_NO_CMUX, keyRow } from './keys.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const BASE = { width: 110, isCmuxMissing: false, promptHoldsKeys: false, mode: 'all' } as const
const ROW = ' ↑↓ select  j: jump  n: next  1-9 answer  r: reply  m: message  t: tab  s: sound  u: mute  f: repos  g: group'

describe('the key row', () => {
  it('shows the keys of the board in 1 row', () => {
    const row = keyRow(BASE)
    expect(row.lines.map(text)).toEqual([ROW])
    expect(row.hints.filter((hint) => hint.hotkey !== undefined).map((hint) => hint.hotkey)).toEqual(['j', 'n', 'r', 'm', 't', 's', 'u', 'f', 'g'])
    expect(row.hints.every((hint) => !hint.isOff)).toBe(true)
  })

  it('names the digits of the open question of the selected session', () => {
    expect(keyRow({ ...BASE, answerCount: 3 }).lines.map(text).join('')).toMatch(/ {2}1-3 answer {2}/)
    expect(keyRow({ ...BASE, answerCount: 1 }).lines.map(text).join('')).toMatch(/ {2}1 answer {2}/)
  })

  it('ends with the ctrl+x tab line while the prompt holds the keys', () => {
    const lines = keyRow({ ...BASE, promptHoldsKeys: true }).lines.map(text)
    expect(lines.at(-1)).toMatch(/ ctrl\+x tab: keys to the pane$/)
  })

  it('says in a line of its own, in the warn color, why the last j did not jump', () => {
    expect(JUMP_NOTE).toEqual({
      'no-tab': 'This session has no cmux tab, so j cannot jump to it.',
      failed: 'The jump failed: cmux did not show the tab of this session. Press j to try again.',
    })
    for (const notice of Object.values(JUMP_NOTE)) {
      const row = keyRow({ ...BASE, notice })
      expect(row.lines.map(text)).toEqual([ROW, ` ${notice}`])
      expect(row.lines[1]!.segments.find((segment) => segment.text.trim() !== '')?.token).toBe('--warn')
    }
    const narrow = keyRow({ ...BASE, width: 40, notice: JUMP_NOTE.failed })
    for (const line of narrow.lines) expect(cellWidth(text(line)), text(line)).toBeLessThanOrEqual(40)
    expect(narrow.lines.map(text).join(' ').replace(/\s+/g, ' ')).toContain(JUMP_NOTE.failed)
  })

  it('draws j, the digits and r dim with no cmux, and says why in a line of its own', () => {
    const row = keyRow({ ...BASE, isCmuxMissing: true })
    expect(row.hints.filter((hint) => hint.isOff).map((hint) => hint.keys)).toEqual(['j', '1-9', 'r'])
    expect(row.lines.map(text)).toEqual([ROW, ` ${KEY_ROW_NO_CMUX}`])
    const jump = row.lines[0]!.segments.filter((segment) => segment.text.includes('j'))
    expect(jump.length).toBeGreaterThan(0)
    for (const segment of jump) expect(segment.dim, segment.text).toBe(true)
    expect(KEY_ROW_NO_CMUX).toBe('Jump, answer and reply are off: cmux is not on this machine.')
  })

  it('gives each key with a hotkey 1 segment that a Button presses, in the form the engine paints: the key, a colon, the label', () => {
    const segments = keyRow(BASE).lines.flatMap((line) => line.segments)
    const pressed = segments.filter((segment) => segment.press !== undefined)
    expect(pressed.map((segment) => segment.press)).toEqual([
      { hotkey: 'j', label: 'jump' },
      { hotkey: 'n', label: 'next' },
      { hotkey: 'r', label: 'reply' },
      { hotkey: 'm', label: 'message' },
      { hotkey: 't', label: 'tab' },
      { hotkey: 's', label: 'sound' },
      { hotkey: 'u', label: 'mute' },
      { hotkey: 'f', label: 'repos' },
      { hotkey: 'g', label: 'group' },
    ])
    for (const segment of pressed) expect(segment.text).toBe(`${segment.press!.hotkey}: ${segment.press!.label}`)
    expect(segments.filter((segment) => segment.text.includes('select') || segment.text.includes('answer')).every((segment) => segment.press === undefined)).toBe(true)
  })

  it('starts with b: back in place of the arrows while the narrow pane shows the detail', () => {
    const row = keyRow({ ...BASE, isDetail: true })
    expect(row.lines.map(text)).toEqual([' b: back  j: jump  n: next  1-9 answer  r: reply  m: message  t: tab  s: sound  u: mute  f: repos  g: group'])
    expect(row.hints[0]).toEqual({ keys: 'b', label: 'back', hotkey: 'b', isOff: false })
    expect(row.hints.some((hint) => hint.keys === '↑↓')).toBe(false)
    expect(keyRow(BASE).hints.some((hint) => hint.hotkey === 'b')).toBe(false)
  })

  it('names the mode that f shows next: the repos from all, all from the repos', () => {
    const label = (mode: 'all' | 'repos'): string | undefined =>
      keyRow({ ...BASE, mode })
        .lines.flatMap((line) => line.segments)
        .find((segment) => segment.press?.hotkey === 'f')?.press?.label
    expect(label('all')).toBe('repos')
    expect(label('repos')).toBe('all')
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
