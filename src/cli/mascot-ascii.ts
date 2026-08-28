/**
 * The terminal brand lockup: a calm orangutan face, a block-letter `orangu` wordmark, the tagline.
 *
 * CLI-only on purpose. The art used to live in the report client, where the file bundle inlined it
 * into every saved HTML report for nothing (no browser draws ASCII), so a bigger wordmark would have
 * cost report bytes. Here it costs none.
 *
 * Pure ASCII, every code point in 0x20-0x7E: `orangu --help` prints the art without consulting
 * `caps.unicode`, so a box-drawing character would be mojibake on a TERM=linux console.
 *
 * Three tiers, because the lockup has to survive an 80-, a 60- and a 40-column terminal:
 * WIDE face + wordmark, STACKED wordmark only, MINI face only. `mascotArt` picks; `mascotLines`
 * composes, centres and paints. Both `--help` and the dashboard go through `mascotLines`, so the two
 * can never disagree about tier, indent or colour.
 */
import { layoutWidth } from './summary.js'
import { displayWidth, paint, truncate, type Caps, type Style } from './tty.js'

/** the house indent every CLI frame starts from */
const INDENT = '  '
/** columns between the face and the wordmark in the WIDE tier */
const GUTTER = '   '
const FACE_WIDTH = 23

const FACE = [
  `  .-"""""""""""""""-.`,
  ` /      .-"""-.      \\`,
  `|      /       \\      |`,
  `|     |  o   o  |     |`,
  `|    /    . .    \\    |`,
  `|   |   \\_____/   |   |`,
  ` \\   '-.........-'   /`,
  `  '-...............-'`,
]

const WORD = [
  ` ####  ## ##  ####  ## ##   ##### ##  ##`,
  `##  ## ###       ## ### ## ##  ## ##  ##`,
  `##  ## ##     ##### ##  ## ##  ## ##  ##`,
  `##  ## ##    ##  ## ##  ##  ##### ##  ##`,
  ` ####  ##     ##### ##  ##     ##  #####`,
  `                            ####`,
]

const TAG = 'see what your agent did'

/** One painted run inside an art row: a row mixes the face and the wordmark, so rows are segments. */
export interface MascotSegment {
  text: string
  style: Style | Style[]
}

export type MascotRow = MascotSegment[]

const FACE_STYLE: Style = 'accent'
/** the "big write": accent plus SGR 1 makes the logotype the loudest thing on the frame */
const WORD_STYLE: Style[] = ['accent', 'bold']
const TAG_STYLE: Style = 'dim'

/** Face left, wordmark right, offset down one row: the logotype straddles the eye band and the
 * tagline lands on the chin row. */
const WIDE: MascotRow[] = FACE.map((line, i) => {
  if (i === 0) return [{ text: line, style: FACE_STYLE }]
  const right: MascotSegment = i <= WORD.length ? { text: WORD[i - 1]!, style: WORD_STYLE } : { text: TAG, style: TAG_STYLE }
  return [{ text: line.padEnd(FACE_WIDTH) + GUTTER, style: FACE_STYLE }, right]
})

/** The face costs 23 of 40 columns and 8 terminal rows; the wordmark is the identity, so it stays. */
const STACKED: MascotRow[] = [...WORD.map((line) => [{ text: line, style: WORD_STYLE }]), [{ text: TAG, style: TAG_STYLE }]]

/** Face and tagline are both exactly 23 columns, so they align with no padding. */
const MINI: MascotRow[] = [...FACE.map((line) => [{ text: line, style: FACE_STYLE }]), [{ text: TAG, style: TAG_STYLE }]]

function plainRow(row: MascotRow): string {
  return row.map((segment) => segment.text).join('')
}

function artWidth(rows: MascotRow[]): number {
  return Math.max(...rows.map((row) => displayWidth(plainRow(row))))
}

/** The tiers in preference order with their measured widths; MINI is the floor. */
const TIERS = [WIDE, STACKED, MINI].map((rows) => ({ rows, width: artWidth(rows) }))

export const MASCOT_WIDE: readonly string[] = WIDE.map(plainRow)
export const MASCOT_STACKED: readonly string[] = STACKED.map(plainRow)
export const MASCOT_MINI: readonly string[] = MINI.map(plainRow)

/**
 * The first tier whose art plus the house indent fits `width` (a layout width, not raw columns).
 * Derived, so no caller carries a magic column number.
 */
export function mascotArt(width: number): MascotRow[] {
  return (TIERS.find((tier) => tier.width + INDENT.length <= width) ?? TIERS[TIERS.length - 1]!).rows
}

/**
 * The composed art for a stream: centred inside its layout and painted per segment. At
 * `caps.color === 0` paint returns the text untouched, so NO_COLOR prints the same ASCII.
 */
export function mascotLines(caps: Caps): string[] {
  const width = layoutWidth(caps)
  const rows = mascotArt(width)
  const widest = artWidth(rows)
  const indent = ' '.repeat(Math.max(INDENT.length, Math.floor((width - widest) / 2)))
  const budget = width - indent.length
  return rows.map((row) => {
    const text = plainRow(row)
    // the tier rule keeps every row inside the budget at 40 columns and up; below the caps floor
    // (a caller passing its own narrow width) a cut beats an overflowing frame
    if (displayWidth(text) > budget) return indent + paint(caps, FACE_STYLE, truncate(text, budget, caps))
    return indent + row.map((segment) => paint(caps, segment.style, segment.text)).join('')
  })
}
