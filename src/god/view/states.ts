/**
 * The states of the board pane that show a message in place of the board, and the reasons that the pane cannot
 * draw. Each message is 1 sentence or 2, wrapped at whole words to the pane width, never cut.
 */
import type { BoardSnapshot } from '../types.js'
import { BOARD_COLUMNS } from './board.js'
import { wrapWords } from './cells.js'
import type { Line } from './types.js'

/**
 * A board state with a message in place of the board:
 * - reading: the first refresh did not end yet;
 * - no-sessions: no live session but the god session;
 * - no-repo-match: the repos mode keeps none of the live sessions.
 */
export type BoardState = 'reading' | 'no-sessions' | 'no-repo-match'

/** The message of each board state. */
export const STATE_TEXT: Readonly<Record<BoardState, string>> = {
  reading: 'Reading sessions.',
  'no-sessions': 'No other Claude Code session runs now.',
  'no-repo-match': 'No session of the selected repos runs now. Press f to show every session.',
}

/**
 * Why the pane cannot draw:
 * - too-narrow: the body is narrower than the narrowest board;
 * - too-short: the board does not fit, and the body has too few rows for a window over it;
 * - failed: the engine shell could not draw the pane.
 */
export type CannotDraw = 'too-narrow' | 'too-short' | 'failed'

/** The line of each reason. */
export const CANNOT_DRAW: Readonly<Record<CannotDraw, string>> = {
  'too-narrow': `The pane is too narrow. Make it ${BOARD_COLUMNS} columns or wider.`,
  'too-short': 'The pane is too short. Make it taller.',
  failed: 'The pane cannot draw the board. Run /god to open it again.',
}

/** The board state of a snapshot, or undefined when the pane draws the board. */
export function boardStateOf(snapshot: BoardSnapshot | undefined): BoardState | undefined {
  if (snapshot === undefined || !snapshot.firstRefreshDone) return 'reading'
  if (snapshot.sessions.length === 0) return 'no-sessions'
  if (snapshot.groups.length === 0) return 'no-repo-match'
  return undefined
}

/** A message in lines of `width` cells or less, each after 1 space. */
export function messageLines(text: string, width: number): Line[] {
  return wrapWords(text, Math.max(1, width - 1)).map((line) => ({ segments: [{ text: ` ${line}` }] }))
}
