/**
 * The cut rule of the god pane: no hidden text. A text that does not fit ends with the count of the characters
 * that it cut, and a list that does not fit says how many items it left out and which key shows them.
 */
import { describe, expect, it } from 'vitest'
import { cellWidth, graphemes } from './cells.js'
import { cutInline, cutMark, fitSegments, moreText, type Part } from './cut.js'
import type { Segment } from './types.js'

/** the count at the end of a cut text */
const countOf = (text: string): number => Number(/…\+(\d+)$/.exec(text)?.[1] ?? Number.NaN)

describe('cutInline: a text in a room of cells', () => {
  it('keeps a text that fits whole, with no mark', () => {
    expect(cutInline('Edit parse.ts', 13)).toBe('Edit parse.ts')
  })

  it('ends a cut text with …+N, where N is the count of the characters it cut', () => {
    const text = 'Which eval set do you want for the next run of the tests?'
    for (const room of [6, 10, 13, 20, 40]) {
      const cut = cutInline(text, room)!
      expect(cut, `room ${room}`).toMatch(/…\+\d+$/)
      expect(cellWidth(cut), `room ${room}`).toBeLessThanOrEqual(room)
      const kept = cut.slice(0, cut.lastIndexOf('…'))
      expect(text.startsWith(kept), `room ${room}`).toBe(true)
      expect(graphemes(kept).length + countOf(cut), `room ${room}: the kept and the cut characters make the whole text`).toBe(graphemes(text).length)
    }
  })

  it('cuts at the last whole word when the room holds one, else at the last character that fits', () => {
    expect(cutInline('Which eval set do you want?', 14)).toBe('Which eval…+17')
    expect(cutInline('abcdefghijklmnop', 8)).toBe('abcd…+12')
  })

  it('never cuts inside a wide character, a combining mark or a joined emoji', () => {
    const text = '日本語のテキストです ééé'
    for (const room of [5, 6, 7, 8, 9]) {
      const cut = cutInline(text, room)!
      expect(cellWidth(cut), `room ${room}`).toBeLessThanOrEqual(room)
      const kept = cut.slice(0, cut.lastIndexOf('…'))
      expect(graphemes(text).slice(0, graphemes(kept).length).join('')).toBe(kept)
    }
    expect(cutInline('\u{1F468}‍\u{1F469}‍\u{1F467}\u{1F468}‍\u{1F469}‍\u{1F467}abc', 6)).toBe('\u{1F468}‍\u{1F469}‍\u{1F467}…+4')
  })

  it('gives undefined when the room cannot hold even the mark: the caller draws the text in another way', () => {
    expect(cutInline('abcdefghijkl', 3)).toBeUndefined()
    expect(cutInline('abcdefghijkl', 4)).toBe('…+12')
  })

  it('writes the mark as the ellipsis and the count', () => {
    expect(cutMark(40)).toBe('…+40')
  })
})

describe('moreText: the line for the items that a view left out', () => {
  it('says the count, the unit and the key that shows them', () => {
    expect(moreText(1, ['session', 'sessions'], '↓')).toBe('+1 session (↓)')
    expect(moreText(12, ['line', 'lines'], 'h')).toBe('+12 lines (h)')
  })
})

describe('fitSegments: styled parts in a room of cells', () => {
  const text = (segments: readonly Segment[]): string => segments.map((segment) => segment.text).join('')
  const chip = (label: string, token: Segment['token']): Part => ({ segment: { text: label, ...(token === undefined ? {} : { token }) }, isWhole: true })
  const plain = (value: string): Part => ({ segment: { text: value } })
  const parts: Part[] = [plain('api-9'), plain('  '), chip('TREE', '--bad'), plain(' '), chip('FILES', '--cat-edit'), plain(' '), plain('Edit parse.ts')]

  it('keeps the parts whole when they fit', () => {
    expect(fitSegments(parts, 31)).toEqual(parts.map((part) => part.segment))
  })

  it('cuts a text part with its count, and counts each hidden character after it, but never a blank part', () => {
    // 4 of the 13 characters show, so 9 are cut; the cut falls at the last whole word
    expect(text(fitSegments(parts, 26))).toBe('api-9  TREE FILES Edit…+9')
  })

  it('keeps a chip whole or leaves it out whole, and puts the mark after a blank, so a whole part never looks cut', () => {
    // FILES (5) and the activity (13) are out: 18
    expect(text(fitSegments(parts, 20))).toBe('api-9  TREE …+18')
    expect(text(fitSegments(parts, 16))).toBe('api-9  TREE …+18')
    // TREE (4) is out too: 22
    expect(text(fitSegments(parts, 15))).toBe('api-9  …+22')
    expect(text(fitSegments(parts, 11))).toBe('api-9  …+22')
  })

  it('keeps the style of each kept part and draws the mark dim, inside the room at each width', () => {
    const fitted = fitSegments(parts, 16)
    expect(fitted[2]).toEqual({ text: 'TREE', token: '--bad' })
    expect(fitted.at(-1)).toEqual({ text: '…+18', dim: true })
    for (let room = 11; room <= 31; room += 1) expect(cellWidth(text(fitSegments(parts, room))), `room ${room}`).toBeLessThanOrEqual(room)
  })
})
