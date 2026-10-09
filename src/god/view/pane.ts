/**
 * The whole god pane from 1 board snapshot, top to bottom: the header, a rule, the body, a rule, the key row.
 * - At WIDE_FROM_COLUMNS or more, the body is the board column (BOARD_COLUMNS cells) left of the detail, and each
 *   rule meets the column rule at the board width. Below, the board takes the whole body.
 * - A board state (reading, no session, no session in the selected repos) shows its message under the header in
 *   place of the board and the key row.
 * - The pane takes no more rows than `bodyRows`: the board shows only the lines that fit, around the selected row.
 * - When the pane cannot draw (a body under BOARD_COLUMNS, or too few rows for a window over the board), it shows
 *   1 message with the reason and nothing else.
 * No line is wider than `bodyColumns`, and no line of the board column is wider than the board.
 */
import { DIM } from '../ui/theme.js'
import type { BoardSnapshot } from '../types.js'
import { BOARD_COLUMNS, MIN_WINDOW_ROWS, boardLines } from './board.js'
import { headerLines } from './header.js'
import { keyRow } from './keys.js'
import { CANNOT_DRAW, STATE_TEXT, boardStateOf, messageLines, type CannotDraw } from './states.js'
import type { Line, PaneLayout, PaneView } from './types.js'

/** From this body width, the board and the detail show side by side. */
export const WIDE_FROM_COLUMNS = 90

/** What the pane reads. The engine shell passes the pane props and the clock. */
export type PaneInput = {
  /** absent before the first snapshot */
  snapshot?: BoardSnapshot
  /** `e.props.bodyColumns` of the Pane */
  bodyColumns: number
  /** `e.props.scroll.bodyRows` of the Pane */
  bodyRows: number
  now: number
  /** the key of the selected row (`ui.focus`): a session id or a group key */
  selectedKey?: string
  /** the keys of the groups that the person opened */
  openGroups: readonly string[]
  /** true while the prompt holds the keys (`e.props.isFocused` is false) */
  promptHoldsKeys: boolean
}

/** Where the board goes at a body width. */
export function layoutOf(bodyColumns: number): PaneLayout {
  return bodyColumns >= WIDE_FROM_COLUMNS
    ? { kind: 'wide', boardColumns: BOARD_COLUMNS, detailColumns: bodyColumns - BOARD_COLUMNS - 1 }
    : { kind: 'narrow', boardColumns: bodyColumns }
}

/** A rule across the body. In the wide layout, it meets the column rule with `joint` at the board width. */
function ruleLine(width: number, layout?: PaneLayout, joint = '┬'): Line {
  const text = layout?.kind === 'wide' ? `${'─'.repeat(layout.boardColumns)}${joint}${'─'.repeat(layout.detailColumns)}` : '─'.repeat(width)
  return { segments: [{ text, ...DIM }] }
}

/** The pane that shows only why it cannot draw. */
export function cannotDrawView(reason: CannotDraw, bodyColumns: number): PaneView {
  return { kind: 'cannot-draw', lines: messageLines(CANNOT_DRAW[reason], bodyColumns) }
}

/** The option count of the open question of the selected session, when the digits can answer it. */
function answerCountOf(snapshot: BoardSnapshot, selectedKey: string | undefined): number | undefined {
  const questions = snapshot.sessions.find((session) => session.sessionId === selectedKey)?.transcript?.openQuestion?.questions
  const only = questions?.length === 1 ? questions[0] : undefined
  return only === undefined || only.multiSelect ? undefined : only.options.length
}

/** The pane of 1 snapshot. */
export function paneView(input: PaneInput): PaneView {
  const { snapshot, bodyColumns, bodyRows, now } = input
  if (bodyColumns < BOARD_COLUMNS) return cannotDrawView('too-narrow', bodyColumns)
  const header = headerLines({ ...(snapshot === undefined ? {} : { snapshot }), width: bodyColumns, now })
  const state = boardStateOf(snapshot)
  if (state !== undefined || snapshot === undefined) {
    const body = messageLines(STATE_TEXT[state ?? 'reading'], bodyColumns)
    if (header.length + 1 + body.length > bodyRows) return cannotDrawView('too-short', bodyColumns)
    return { kind: 'message', header, topRule: ruleLine(bodyColumns), body }
  }
  const layout = layoutOf(bodyColumns)
  const keys = keyRow({
    width: bodyColumns,
    isCmuxMissing: snapshot.sources.cmux.status === 'missing',
    promptHoldsKeys: input.promptHoldsKeys,
    answerCount: answerCountOf(snapshot, input.selectedKey),
  })
  const room = bodyRows - header.length - 2 - keys.lines.length
  const board = { snapshot, width: layout.boardColumns, now, openGroups: input.openGroups, selectedKey: input.selectedKey }
  if (room < MIN_WINDOW_ROWS && boardLines({ ...board, rows: Number.POSITIVE_INFINITY }).length > Math.max(0, room)) return cannotDrawView('too-short', bodyColumns)
  return {
    kind: 'board',
    layout,
    header,
    topRule: ruleLine(bodyColumns, layout, '┬'),
    body: boardLines({ ...board, rows: room }),
    bottomRule: ruleLine(bodyColumns, layout, '┴'),
    keys: keys.lines,
    hints: keys.hints,
  }
}

/** Every line of a pane view, top to bottom. */
export function paneLines(view: PaneView): Line[] {
  if (view.kind === 'cannot-draw') return [...view.lines]
  if (view.kind === 'message') return [...view.header, view.topRule, ...view.body]
  return [...view.header, view.topRule, ...view.body, view.bottomRule, ...view.keys]
}
