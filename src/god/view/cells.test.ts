/**
 * The width of a text in terminal cells. The god pane cannot import src/cli/tty.ts (it imports Node), so it has its
 * own copy of the same rule. This test holds the 2 equal on every kind of character the pane can get.
 */
import { describe, expect, it } from 'vitest'
import { displayWidth } from '../../cli/tty.js'
import { cellWidth, graphemes, padEnd, padStart, wrapWords } from './cells.js'

const SAMPLES = [
  'api-7',
  '',
  ' ',
  '⚠ ● ✕ ⠋ · ○ ▌ ▸ ▾ │ ─ ┬ ┴ ◉ ↑↓ …',
  '日本語のテキスト',
  'été',
  'a‍b',
  '\u{1F600} smile',
  '\u{1F468}‍\u{1F469}‍\u{1F467} family',
  '❤️ heart',
  'ｆｕｌｌ ｗｉｄｔｈ',
  '한국어',
  'tab\tand\nnewline',
]

describe('cellWidth: the cells a text takes in a terminal', () => {
  it('counts ASCII as 1, a combining mark or a joiner as 0, wide East Asian text and emoji as 2', () => {
    expect(cellWidth('api-7')).toBe(5)
    expect(cellWidth('é')).toBe(1)
    expect(cellWidth('日本')).toBe(4)
    expect(cellWidth('\u{1F600}')).toBe(2)
    expect(cellWidth('\u{1F468}‍\u{1F469}‍\u{1F467}')).toBe(2)
    expect(cellWidth('❤️')).toBe(2)
  })

  it('counts each glyph of the pane as 1 cell', () => {
    for (const glyph of ['⚠', '●', '✕', '⠋', '·', '○', '▌', '▸', '▾', '│', '─', '┬', '┴', '◉', '…', '↑', '↓']) expect(cellWidth(glyph), glyph).toBe(1)
  })

  it('gives the same width as displayWidth of the CLI on every sample', () => {
    for (const sample of SAMPLES) expect(cellWidth(sample), JSON.stringify(sample)).toBe(displayWidth(sample))
  })
})

describe('graphemes: the characters a reader sees', () => {
  it('keeps a combining mark and a joined emoji in 1 character', () => {
    expect(graphemes('ét')).toEqual(['é', 't'])
    expect(graphemes('a\u{1F468}‍\u{1F469}‍\u{1F467}b')).toHaveLength(3)
  })
})

describe('padding and wrapping by cells', () => {
  it('pads to a width in cells and never cuts', () => {
    expect(padEnd('日本', 6)).toBe('日本  ')
    expect(padStart('3m', 4)).toBe('  3m')
    expect(padEnd('too long', 3)).toBe('too long')
  })

  it('wraps at whole words, and breaks only a word wider than the line', () => {
    expect(wrapWords('No other Claude Code session runs now.', 20)).toEqual(['No other Claude Code', 'session runs now.'])
    expect(wrapWords('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    for (const line of wrapWords('日本語のテキスト and more words', 7)) expect(cellWidth(line)).toBeLessThanOrEqual(7)
    expect(wrapWords('日本語のテキスト and more words', 7).join(' ').replace(/ /g, '')).toBe('日本語のテキストandmorewords')
  })
})
