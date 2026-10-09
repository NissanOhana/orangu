/**
 * Text in lines of a width, for the detail and the confirm bar of the god pane. The detail shows each text whole,
 * so nothing here cuts:
 * - wrapSegments: styled text that fits keeps its spaces; else it breaks at whole words (each run of white space
 *   becomes 1 space), and a word wider than a line breaks between graphemes;
 * - textLines: a text of 1 or more lines (a reply, a prompt, a tool input), each line wrapped, with 1 blank line
 *   kept between paragraphs;
 * - keptLines and screenLines: a tool input or a terminal screen, each row with its spaces as written, broken
 *   between graphemes at the width.
 * A tab becomes 2 spaces and each line break ends a line, so no line that a view gives holds a character that
 * the terminal draws wider than cellWidth says.
 */
import { cellWidth, graphemes } from './cells.js'
import type { Line, Segment } from './types.js'

/** A line break: what ends a line of outside text. */
export const LINE_BREAK = /\r\n|[\n\r\u2028\u2029\u0085\v\f]/

/** Outside text on 1 line: each run of white space becomes 1 space. */
export const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The style of a segment: all but its text. */
type Style = Omit<Segment, 'text'>

const styleOf = ({ text: _text, ...style }: Segment): Style => style
const sameStyle = (a: Style, b: Style): boolean => a.token === b.token && a.bold === b.bold && a.dim === b.dim

/** The segments with no empty text, each run of 1 style joined into 1 segment. */
function merged(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    if (segment.text === '') continue
    const last = out.at(-1)
    if (last !== undefined && sameStyle(styleOf(last), styleOf(segment))) out[out.length - 1] = { ...last, text: last.text + segment.text }
    else out.push({ ...segment })
  }
  return out
}

/** The longest start of a text that fits `room` cells, at least 1 grapheme, and the rest. */
function splitAt(text: string, room: number): [string, string] {
  const chars = graphemes(text)
  let head = chars[0] ?? ''
  let index = 1
  while (index < chars.length && cellWidth(head + chars[index]!) <= room) head += chars[index++]!
  return [head, chars.slice(index).join('')]
}

/**
 * Styled text in lines of `width` cells or less: the first line after `indent` spaces, each next line after `hang`
 * spaces. The space between 2 words of 1 style takes that style.
 */
export function wrapSegments(segments: readonly Segment[], width: number, indent = 1, hang = indent): Line[] {
  const clean = segments.map((segment) => ({ ...segment, text: segment.text.replace(/\t/g, '  ').replace(new RegExp(LINE_BREAK.source, 'g'), ' ') }))
  if (indent + clean.reduce((sum, segment) => sum + cellWidth(segment.text), 0) <= width) return [{ segments: merged([{ text: ' '.repeat(indent) }, ...clean]) }]
  const words = clean.flatMap((segment) => segment.text.split(/\s+/).filter((word) => word !== '').map((word) => ({ ...segment, text: word })))
  const lines: Segment[][] = []
  let line: Segment[] = []
  let used = 0
  const room = (): number => width - (lines.length === 0 ? indent : hang)
  const flush = (): void => {
    lines.push(line)
    line = []
    used = 0
  }
  for (const word of words) {
    let rest = word.text
    while (rest !== '') {
      const gap = line.length > 0 ? 1 : 0
      if (used + gap + cellWidth(rest) <= room()) {
        const last = line.at(-1)
        if (last !== undefined) line.push({ ...(sameStyle(styleOf(last), styleOf(word)) ? styleOf(word) : {}), text: ' ' })
        line.push({ ...word, text: rest })
        used += gap + cellWidth(rest)
        rest = ''
      } else if (line.length > 0) {
        flush()
      } else {
        const [head, tail] = splitAt(rest, room())
        line.push({ ...word, text: head })
        rest = tail
        flush()
      }
    }
  }
  if (line.length > 0) lines.push(line)
  return lines.map((parts, index) => ({ segments: merged([{ text: ' '.repeat(index === 0 ? indent : hang) }, ...parts]) }))
}

/** A text of 1 or more lines, each wrapped after `indent` spaces. Blank lines between paragraphs become 1. */
export function textLines(text: string, width: number, indent: number, style: Style = {}): Line[] {
  const out: Line[] = []
  for (const source of text.split(LINE_BREAK)) {
    if (source.trim() === '') {
      if (out.length > 0 && out.at(-1)!.segments.length > 0) out.push({ segments: [] })
      continue
    }
    out.push(...wrapSegments([{ ...style, text: source.trimEnd() }], width, indent))
  }
  while (out.at(-1)?.segments.length === 0) out.pop()
  return out
}

/**
 * A text with its spaces as written (a tool input, a terminal screen): each row after `indent` spaces, broken
 * between graphemes at the width, with no blank row at the end. A screen also drops the spaces at the end of each
 * row (`isTrimmed`), which only pad it.
 */
export function keptLines(text: string, width: number, indent: number, isTrimmed = false): Line[] {
  const rows = text.replace(/\t/g, '  ').split(LINE_BREAK).map((row) => (isTrimmed ? row.trimEnd() : row))
  while (rows.length > 0 && rows.at(-1)!.trim() === '') rows.pop()
  const pad = ' '.repeat(indent)
  return rows.flatMap((row): Line[] => {
    if (row === '') return [{ segments: [] }]
    const pieces: string[] = []
    let rest = row
    while (rest !== '') {
      const [head, tail] = splitAt(rest, width - indent)
      pieces.push(head)
      rest = tail
    }
    return pieces.map((piece) => ({ segments: [{ text: pad + piece }] }))
  })
}

/** A terminal screen: each row after 1 space, its spaces kept, broken between graphemes at the width. */
export const screenLines = (text: string, width: number): Line[] => keptLines(text, width, 1, true)

/** 1 more item after the last line, 2 spaces after it, or on a line of its own when it does not fit. */
export function appendItem(lines: readonly Line[], item: readonly Segment[], width: number): Line[] {
  const last = lines.at(-1)
  const used = last === undefined ? 0 : last.segments.reduce((sum, segment) => sum + cellWidth(segment.text), 0)
  const itemWidth = item.reduce((sum, segment) => sum + cellWidth(segment.text), 0)
  if (last !== undefined && used + 2 + itemWidth <= width) return [...lines.slice(0, -1), { segments: [...last.segments, { text: '  ' }, ...item] }]
  return [...lines, ...wrapSegments(item, width)]
}
