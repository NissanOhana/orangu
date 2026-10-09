/**
 * The view model of the god pane: what the engine shell draws, as plain data. A view builder under src/god/view
 * turns a board snapshot into lines. The shell (src/god/ui/*.tsx) turns each line into 1 `Text` row, each segment
 * into 1 nested `Text`, and each line with a key into 1 plain `Button`. So every rule about what the pane shows
 * (the order, the glyphs, the widths, the cuts, the copy) lives in pure code, and the shell holds none.
 *
 * Width is in terminal cells (src/god/view/cells.ts). No line of a view is wider than the width that its builder
 * got. A text that does not fit is cut with the count of what it cut (src/god/view/cut.ts), never in silence.
 */
import type { GodTokenName } from '../generated/tokens.js'

/** 1 run of text with 1 style. The shell resolves the token to a color of the session theme (src/god/ui/theme.ts). */
export type Segment = {
  text: string
  /** the tokens.css color of the text; absent, the terminal's own text color */
  token?: GodTokenName
  bold?: boolean
  /** drawn dim, as the `dimColor` of `Text` */
  dim?: boolean
}

/** 1 row of the pane. */
export type Line = {
  segments: readonly Segment[]
  /**
   * Set on a row that the person can select: the shell draws it as a plain Button with this key, so the arrows
   * walk the rows and `ui.focus` names the selected row. A session row has the session id. A group heading that
   * opens and closes has groupKey(<group key>) (src/god/view/board.ts).
   */
  key?: string
}

/** 1 key of the key row: what to press, what it does, and the Button hotkey that presses it. */
export type KeyHint = {
  /** the key as the row shows it, for example `j`, `↑↓` or `1-3` */
  keys: string
  label: string
  /** the 1 letter that a hotkey Button takes; absent for a key that the engine handles (the arrows) or the detail handles (the digits) */
  hotkey?: string
  /** true when the key does nothing now: the row draws it dim */
  isOff: boolean
}

/**
 * Where the board goes in the pane body:
 * - wide: the board on the left, then a rule, then the detail;
 * - narrow: the board alone. Enter on a row opens the detail in its place.
 */
export type PaneLayout =
  | { kind: 'wide'; boardColumns: number; detailColumns: number }
  | { kind: 'narrow'; boardColumns: number }

/**
 * The whole pane, top to bottom:
 * - board: the header, a rule, the body, a rule, the key row. In the wide layout the body is the board column
 *   only, and the rules join the column rule (`┬`, `┴`) at the board width;
 * - message: the header, a rule and 1 message across the body, in place of the board (no session yet, or none);
 * - cannot-draw: 1 message with the reason, and nothing else.
 */
export type PaneView =
  | {
      kind: 'board'
      layout: PaneLayout
      header: readonly Line[]
      topRule: Line
      body: readonly Line[]
      bottomRule: Line
      keys: readonly Line[]
      hints: readonly KeyHint[]
    }
  | { kind: 'message'; header: readonly Line[]; topRule: Line; body: readonly Line[] }
  | { kind: 'cannot-draw'; lines: readonly Line[] }
