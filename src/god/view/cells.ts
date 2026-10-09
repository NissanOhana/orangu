/**
 * The width of a text in terminal cells, and padding and wrapping by that width.
 *
 * The rule is the one of displayWidth in src/cli/tty.ts, which the god code cannot import (that file imports Node):
 * the text splits into graphemes (Intl.Segmenter, which the mod environment has), and each grapheme takes
 * - 1 cell when it is printable ASCII,
 * - 0 cells when it starts with a combining mark, a format character, a control character or a default-ignorable
 *   code point (a joiner, a variation selector),
 * - 2 cells when it is an emoji in emoji presentation, holds the emoji selector U+FE0F, or starts in a wide or
 *   full-width East Asian range,
 * - 1 cell else (an ambiguous character such as `●` or `─` takes 1, as in a terminal with no CJK locale).
 * src/god/view/cells.test.ts holds the 2 rules equal. Text from outside is sanitized before it comes here, so no
 * escape sequence needs stripping.
 */
import type { Line, Segment } from './types.js'

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/u
const EMOJI = /\p{Emoji_Presentation}|️/u
/** East Asian Width W and F as ranges: ECMAScript has no property for them */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const isWide = (codePoint: number): boolean => WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)

/** The graphemes of a text: the characters that a reader sees, a combining mark and a joined emoji each in 1. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

function graphemeWidth(grapheme: string): number {
  const codePoint = grapheme.codePointAt(0) ?? 0
  if (codePoint >= 0x20 && codePoint <= 0x7e) return 1
  if (ZERO_WIDTH.test(grapheme)) return 0
  return EMOJI.test(grapheme) || isWide(codePoint) ? 2 : 1
}

/** The terminal cells that a text takes. */
export function cellWidth(text: string): number {
  let width = 0
  for (const grapheme of graphemes(text)) width += graphemeWidth(grapheme)
  return width
}

/** The text, then spaces up to `width` cells. It never cuts: cut first. */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cellWidth(text)))
}

/** Spaces up to `width` cells, then the text. It never cuts: cut first. */
export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - cellWidth(text))) + text
}

/** A word wider than `width` cells, in pieces of `width` cells or less, broken between graphemes. */
function breakWord(word: string, width: number): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const grapheme of graphemes(word)) {
    if (piece !== '' && cellWidth(piece) + graphemeWidth(grapheme) > width) {
      pieces.push(piece)
      piece = ''
    }
    piece += grapheme
  }
  return piece === '' ? pieces : [...pieces, piece]
}

/**
 * The words of a text in lines of `width` cells or less. A line breaks only between words, and a word wider than
 * the line is the one exception: it breaks between graphemes. So every word shows, and nothing is cut.
 */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    const pieces = cellWidth(word) > width ? breakWord(word, width) : [word]
    for (const piece of pieces) {
      if (line !== '' && cellWidth(line) + 1 + cellWidth(piece) <= width) {
        line += ` ${piece}`
        continue
      }
      if (line !== '') lines.push(line)
      line = piece
    }
  }
  return line === '' ? lines : [...lines, line]
}

/**
 * Items (each a run of segments, such as `j jump`) in lines of `width` cells or less: 1 space before the first item
 * of a line, 2 spaces between items. An item moves whole to the next line when it does not fit, so no item is cut.
 * The caller cuts an item that is wider than a line on its own.
 */
export function flowItems(items: readonly (readonly Segment[])[], width: number): Line[] {
  const lines: Segment[][] = []
  let used = 0
  for (const item of items) {
    const itemWidth = item.reduce((sum, segment) => sum + cellWidth(segment.text), 0)
    const line = lines.at(-1)
    if (line !== undefined && used + 2 + itemWidth <= width) {
      line.push({ text: '  ' }, ...item)
      used += 2 + itemWidth
      continue
    }
    lines.push([{ text: ' ' }, ...item])
    used = 1 + itemWidth
  }
  return lines.map((segments) => ({ segments }))
}
