/**
 * The body of the wide pane (90 columns or more): the board column, the column rule `│` and the detail column, side
 * by side. Each column has as many lines as the tallest one, so the rule runs from the top rule to the bottom rule,
 * and a short column ends with blank lines. The detail column holds Buttons, so the engine shell draws it from the
 * detail view and adds the blank lines that this module gives.
 */
import { DIM } from '../ui/theme.js'
import type { Line } from './types.js'

/** The 3 columns of the wide body: the board, the rule, and the blank lines under the detail. */
export type WideColumns = { board: Line[]; rule: Line[]; detailPad: Line[] }

/** A line with 1 space: a blank line that a terminal still draws 1 row high. */
const BLANK: Line = { segments: [{ text: ' ' }] }

const blanks = (count: number): Line[] => Array.from({ length: Math.max(0, count) }, () => BLANK)

/** The board, the column rule and the blank lines under the detail, each column as tall as the taller of the 2. */
export function wideColumns(board: readonly Line[], detailHeight: number): WideColumns {
  const height = Math.max(board.length, detailHeight)
  return {
    board: [...board, ...blanks(height - board.length)],
    rule: Array.from({ length: height }, (): Line => ({ segments: [{ text: '│', ...DIM }] })),
    detailPad: blanks(height - detailHeight),
  }
}
