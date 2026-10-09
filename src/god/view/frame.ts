/**
 * The body of the wide pane (90 columns or more): the board column, the column rule `│` and the detail column, side
 * by side. Each column has as many lines as the tallest one, so the rule runs from the top rule to the bottom rule,
 * and a short column ends with blank lines. Until the detail view lands, the detail column shows 1 short line.
 */
import { DIM } from '../ui/theme.js'
import { messageLines } from './states.js'
import type { Line } from './types.js'

/** The line of the detail column in a build that has no detail view yet. */
export const DETAIL_PLACEHOLDER = 'The detail of the selected session is not in this build.'

/** The 3 columns of the wide body. */
export type WideColumns = { board: Line[]; rule: Line[]; detail: Line[] }

/** A line with 1 space: a blank line that a terminal still draws 1 row high. */
const BLANK: Line = { segments: [{ text: ' ' }] }

const padded = (lines: readonly Line[], height: number): Line[] => [...lines, ...Array.from({ length: height - lines.length }, () => BLANK)]

/** The board, the column rule and the detail, each as tall as the tallest of the board and the detail. */
export function wideColumns(board: readonly Line[], detail: readonly Line[]): WideColumns {
  const height = Math.max(board.length, detail.length)
  return {
    board: padded(board, height),
    rule: Array.from({ length: height }, (): Line => ({ segments: [{ text: '│', ...DIM }] })),
    detail: padded(detail, height),
  }
}

/** The detail column of this build: the placeholder line, wrapped at whole words to the column width. */
export function detailPlaceholder(width: number): Line[] {
  return messageLines(DETAIL_PLACEHOLDER, width)
}
