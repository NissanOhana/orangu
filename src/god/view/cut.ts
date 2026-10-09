/**
 * The cut rule of the god pane: no hidden text. Each text that the pane cuts ends with the count of what it cut,
 * and each list that it shortens says how many items it left out and which key shows them:
 * - a text in a row cell ends with `…+N`, where N is the count of the characters (graphemes) that it cut. The row
 *   is the key to the rest: the person selects it, and the detail shows the text whole;
 * - a list ends with a line such as `+3 sessions (↓)`: the count, the unit and the key.
 * A cut falls at the last whole word that fits, else at the last character that fits (the rule of truncate in
 * src/cli/tty.ts), and never inside a grapheme.
 */
import { cellWidth, graphemes } from './cells.js'
import type { Segment } from './types.js'

/** The mark at the end of a cut text: the ellipsis, then the count of the characters that the cut hid. */
export function cutMark(count: number): string {
  return `…+${count}`
}

/** A list line: `+N <unit> (<key>)`. The unit is the singular and the plural word. */
export function moreText(count: number, unit: readonly [string, string], key: string): string {
  return `+${count} ${count === 1 ? unit[0] : unit[1]} (${key})`
}

/**
 * How many graphemes of `chars` to keep in `room` cells, when a mark for the hidden ones (plus `hiddenAfter` more)
 * follows them: the most that fit, moved back to the end of the last whole word when the cut falls inside a word.
 * Undefined when not even the mark fits.
 */
function keptCount(chars: readonly string[], room: number, hiddenAfter: number): number | undefined {
  let width = 0
  let kept = 0
  let best: number | undefined
  for (;;) {
    if (width + cellWidth(cutMark(chars.length - kept + hiddenAfter)) <= room) best = kept
    if (kept === chars.length) break
    width += cellWidth(chars[kept]!)
    kept += 1
    if (width > room) break
  }
  if (best === undefined || best === 0 || best === chars.length) return best
  if (/\s/.test(chars[best]!)) return best
  let space = best - 1
  while (space > 0 && !/\s/.test(chars[space]!)) space -= 1
  return space > 0 ? space : best
}

/** The kept graphemes as text, with no white space at the end. */
const keptText = (chars: readonly string[], count: number): string => chars.slice(0, count).join('').trimEnd()

/**
 * The text whole when it fits `room` cells, else its start and the cut mark, in `room` cells or less. Undefined when
 * the room cannot hold even the mark: the caller then draws the text in another way, never cut in silence.
 */
export function cutInline(text: string, room: number): string | undefined {
  if (cellWidth(text) <= room) return text
  const chars = graphemes(text)
  const count = keptCount(chars, room, 0)
  if (count === undefined) return undefined
  const kept = keptText(chars, count)
  return kept + cutMark(chars.length - graphemes(kept).length)
}

/** 1 styled part of a row: `isWhole` marks a chip, which shows whole or not at all. */
export type Part = { segment: Segment; isWhole?: boolean }

const isBlank = (part: Part): boolean => part.segment.text.trim() === ''
/** the characters that a part counts when the cut hides it: a blank part counts none */
const countable = (part: Part): number => (isBlank(part) ? 0 : graphemes(part.segment.text).length)

/**
 * The parts in `room` cells: whole while they fit. Else the parts are cut once, with the mark (dim) at the cut:
 * - inside a text part, at its last whole word, when some of it fits;
 * - else between 2 parts, after a blank part, so a whole part never looks cut.
 * The count of the mark is every character that the cut hides: the rest of the cut part and each part after it,
 * but no blank part.
 */
export function fitSegments(parts: readonly Part[], room: number): Segment[] {
  const widths = parts.map((part) => cellWidth(part.segment.text))
  if (widths.reduce((sum, width) => sum + width, 0) <= room) return parts.map((part) => part.segment)
  const before = (index: number): number => widths.slice(0, index).reduce((sum, width) => sum + width, 0)
  const hiddenFrom = (index: number): number => parts.slice(index).reduce((sum, part) => sum + countable(part), 0)
  const mark = (count: number): Segment => ({ text: cutMark(count), dim: true })

  let first = 0
  while (first < parts.length && before(first + 1) <= room) first += 1
  for (let index = first; index >= 0; index -= 1) {
    const part = parts[index]!
    const used = before(index)
    if (!part.isWhole && !isBlank(part)) {
      const chars = graphemes(part.segment.text)
      const count = keptCount(chars, room - used, hiddenFrom(index + 1))
      if (count !== undefined && count > 0 && count < chars.length) {
        const kept = keptText(chars, count)
        const hidden = chars.length - graphemes(kept).length + hiddenFrom(index + 1)
        return [...parts.slice(0, index).map((whole) => whole.segment), { ...part.segment, text: kept }, mark(hidden)]
      }
    }
    const afterBlank = index === 0 || isBlank(parts[index - 1]!)
    if (afterBlank && used + cellWidth(cutMark(hiddenFrom(index))) <= room) return [...parts.slice(0, index).map((whole) => whole.segment), mark(hiddenFrom(index))]
  }
  return [mark(hiddenFrom(0))]
}
