/**
 * The help view of the god pane (h), as lines of the detail width: the line that says how to close it, then what
 * each heading of the board means (its glyph and heading in the level color), what the same file chip means (in its
 * color), and what each key does. Each entry is a label column and a text column. The text wraps in its column at
 * whole words, and nothing is cut. The pane shows it in place of the detail (src/god/view/pane.ts).
 */
import { HELP_KEYS, HELP_LEVELS, HELP_SAME_FILE, HELP_TITLE } from '../copy.js'
import { LEVEL_ORDER } from '../types.js'
import { FLAG_PAINT, LEVEL_PAINT } from '../ui/theme.js'
import { FLAG_CHIP, LEVEL_GLYPH, LEVEL_HEADING } from './board.js'
import { cellWidth, wrapWords } from './cells.js'
import type { Line, Segment } from './types.js'
import { wrapSegments } from './wrap.js'

/** The cells between the label column and the text column. */
const GAP = 2

/** 1 entry of the help: the label in its style, and the text. */
type Entry = { label: Segment; text: string }

const ENTRIES: readonly Entry[] = [
  ...LEVEL_ORDER.map((level) => ({ label: { text: `${LEVEL_GLYPH[level]} ${LEVEL_HEADING[level]}`, ...LEVEL_PAINT[level], bold: true }, text: HELP_LEVELS[level] })),
  { label: { text: FLAG_CHIP['same-files'], ...FLAG_PAINT['same-files'] }, text: HELP_SAME_FILE },
  ...HELP_KEYS.map(([keys, text]) => ({ label: { text: keys, bold: true }, text })),
]

/** The lines of the help view at `width` cells. */
export function helpLines(width: number): Line[] {
  const column = Math.max(...ENTRIES.map((entry) => cellWidth(entry.label.text))) + GAP
  const room = Math.max(1, width - 1 - column)
  const entryLines = ENTRIES.flatMap((entry) =>
    wrapWords(entry.text, room).map(
      (text, index): Line => ({
        segments: index === 0 ? [{ text: ' ' }, entry.label, { text: `${' '.repeat(column - cellWidth(entry.label.text))}${text}` }] : [{ text: `${' '.repeat(1 + column)}${text}` }],
      }),
    ),
  )
  return [...wrapSegments([{ text: HELP_TITLE }], width), ...entryLines]
}
