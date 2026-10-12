/**
 * The whole god pane from 1 board snapshot, top to bottom: the header, a rule, the body, a rule, the key row.
 * - At WIDE_FROM_COLUMNS or more, the body is the board column (BOARD_SHARE of the body, from BOARD_COLUMNS to
 *   BOARD_MAX_COLUMNS cells) left of the detail of the selected session (src/god/view/detail-pane.ts), and each rule
 *   meets the column rule at the board width. The
 *   detail takes no more rows than the board has. Below, the board takes the whole body, and once the person opens
 *   the detail, the detail takes it in place of the board, and the key row starts with b, which goes back.
 * - A board state (reading, no session, no session in the selected repos) shows its message under the header in
 *   place of the board. The 2 states of the repos mode (no repo selected, no session of the selected repos) keep a
 *   rule and the key row under their message, because f leaves them, and a key works only while its Button is drawn.
 * - The pane takes no more rows than `bodyRows`: the board shows only the lines that fit, around the selected row.
 * - The jump note of the selected session (why its last j did not jump) shows under the key row while the board shows
 *   that session. The note of another session, or of a session that the repos mode hides, shows nothing.
 * - The bar of the key path (src/god/view/bar.ts) sits under the bottom rule and above the key row, in the board and
 *   in the narrow detail, and its rows come from the board: it takes at most half of the rows under the header. While
 *   the bar shows a count line, w and z scroll the bar, so the detail draws its own count lines with no key.
 * - The digits of the key row name the option Buttons that the detail draws: the options of the open question of the
 *   selected session, or the Yes and No of its Bash request, in the window of the Now tab. Where no digit Button
 *   shows (the narrow board, another tab, a draft, nothing to answer, a detail too short for them, the bar in place
 *   of the board) the row shows `1-9` dim. The rows of the key row come from `1-9`, its widest form.
 * - When the bar leaves too few rows for a window over the board or the detail, a note of the last outcome gives way
 *   (it has no key), and a bar that holds an intent or a draft takes the place of the board: the header, a rule, the
 *   bar and the key row, so y and c stay.
 * - When the pane cannot draw (a body under BOARD_COLUMNS, or too few rows for a window over the board), it shows
 *   1 message with the reason and nothing else.
 * - While the help is open (h), it takes the place of the detail: beside the board in the wide layout, and in place
 *   of the board in the narrow layout, where b goes back. It shows only while the pane holds the keys: Esc gives
 *   them to the prompt, and the engine shell then closes the help.
 * - The motion of the draw (src/god/view/motion.ts) gives the board its spinner and pulse frame, and the header its
 *   sparkline. No motion: the static frame and no sparkline.
 * No line is wider than `bodyColumns`, and no line of the board column is wider than the board.
 */
import type { JumpNote } from '../act/jump.js'
import type { ScreenState } from '../source/screen.js'
import { DIM } from '../ui/theme.js'
import type { BoardSnapshot, RecapState } from '../types.js'
import { BOARD_COLUMNS, BOARD_MAX_COLUMNS, BOARD_SHARE, MIN_WINDOW_ROWS, boardLines, boardWindow, isOnBoard } from './board.js'
import { barView, type BarView, type DeliverState } from './bar.js'
import { DEFAULT_DETAIL, paneDetail, paneDetailLines, type DetailState, type PaneDetail } from './detail-pane.js'
import { headerLines } from './header.js'
import { JUMP_NOTE, keyRow } from './keys.js'
import type { PaneMotion } from './motion.js'
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
  /** the open tab of the detail, its scroll, and whether the narrow pane shows the detail; absent, the defaults */
  detail?: DetailState
  /** the note of the last j that did not jump */
  jumpNote?: JumpNote | null
  /** the screen state of the Screen tab */
  screen?: ScreenState | null
  /** the state of the key path: the confirm bar, the draft of r or m, the last outcome */
  deliver?: DeliverState
  /** the last Recap, of any session */
  recap?: RecapState | null
  /** true while s keeps every tone off: the header says so */
  isSoundOff?: boolean
  /** the spinner and pulse frame, and the sparkline; absent, the static frame and no sparkline */
  motion?: PaneMotion
}

/** Where the board goes at a body width. */
export function layoutOf(bodyColumns: number): PaneLayout {
  if (bodyColumns < WIDE_FROM_COLUMNS) return { kind: 'narrow', boardColumns: bodyColumns }
  const boardColumns = Math.min(BOARD_MAX_COLUMNS, Math.max(BOARD_COLUMNS, Math.round(bodyColumns * BOARD_SHARE)))
  return { kind: 'wide', boardColumns, detailColumns: bodyColumns - boardColumns - 1 }
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

/** The digits of the option Buttons that a detail draws: the option lines in its window that a digit presses. */
function drawnDigits(detail: PaneDetail | undefined): number[] {
  if (detail?.kind !== 'session' || detail.view.kind !== 'detail') return []
  return detail.view.options.flatMap((option) => (option.isOff ? [] : [option.digit]))
}

/** The rows of the bar, its text field included. */
const barHeight = (bar: BarView | undefined): number => (bar === undefined ? 0 : bar.lines.length + (bar.field === undefined ? 0 : 1))

/** True when the bar is only the note of the last outcome: no intent, no draft and no key. */
const isNote = (bar: BarView): boolean => bar.intent === undefined && bar.field === undefined

/** The detail with no scroll keys: the bar shows a count line, so w and z scroll the bar. */
function withoutScroll(detail: PaneDetail, bar: BarView | undefined): PaneDetail {
  return detail.kind !== 'none' && bar !== undefined && Object.keys(bar.scrollTo).length > 0 ? { ...detail, scrollTo: {} } : detail
}

/** The pane of 1 snapshot. */
export function paneView(input: PaneInput): PaneView {
  const { snapshot, bodyColumns, bodyRows, now } = input
  if (bodyColumns < BOARD_COLUMNS) return cannotDrawView('too-narrow', bodyColumns)
  const { frame, spark } = input.motion ?? {}
  const keysAt = input.promptHoldsKeys ? 'prompt' : 'pane'
  const header = headerLines({ ...(snapshot === undefined ? {} : { snapshot }), width: bodyColumns, now, keysAt, ...(input.isSoundOff === true ? { isSoundOff: true } : {}), ...(spark === undefined ? {} : { spark }) })
  const state = boardStateOf(snapshot)
  const note = input.jumpNote ?? undefined
  const notice = note !== undefined && note.sessionId === input.selectedKey && snapshot !== undefined && isOnBoard(snapshot, note.sessionId) ? { notice: JUMP_NOTE[note.reason] } : {}
  const isDraftOpen = input.deliver?.draft !== undefined
  const keysOf = (board: BoardSnapshot, isDetail = false, detail?: PaneDetail) => {
    const answerDigits = drawnDigits(detail)
    return keyRow({
      width: bodyColumns,
      isCmuxMissing: board.sources.cmux.status === 'missing',
      answerDigits,
      isAnswerOff: answerDigits.length === 0,
      mode: board.mode,
      isDetail,
      ...notice,
    })
  }
  if (state !== undefined || snapshot === undefined) {
    const body = messageLines(STATE_TEXT[state ?? 'reading'], bodyColumns)
    const keys = (state === 'no-repo-match' || state === 'no-repo-set') && snapshot !== undefined ? keysOf(snapshot).lines : []
    if (header.length + 1 + body.length + (keys.length > 0 ? 1 + keys.length : 0) > bodyRows) return cannotDrawView('too-short', bodyColumns)
    const message = { kind: 'message' as const, header, topRule: ruleLine(bodyColumns), body }
    return keys.length > 0 ? { ...message, bottomRule: ruleLine(bodyColumns), keys } : message
  }
  const layout = layoutOf(bodyColumns)
  const asked = input.detail ?? DEFAULT_DETAIL
  const detailState = asked.isHelp === true && input.promptHoldsKeys ? { ...asked, isHelp: false } : asked
  const isDetail = layout.kind === 'narrow' && (detailState.isOpen || detailState.isHelp === true)
  // the rows of the key row with no digit Button: `1-9` is the widest hint, so the drawn row takes no more rows
  const keys = keysOf(snapshot, isDetail)
  const selection = input.selectedKey === undefined ? {} : { selectedKey: input.selectedKey }
  const under = bodyRows - header.length - 2 - keys.lines.length
  const barOf = (rows: number): BarView | undefined =>
    input.deliver === undefined ? undefined : barView({ deliver: input.deliver, width: bodyColumns, rows, ...selection, isScreenOpen: detailState.tab === 'screen' })
  const board = { snapshot, width: layout.boardColumns, now, openGroups: input.openGroups, selectedKey: input.selectedKey, ...(frame === undefined ? {} : { frame }) }
  const fits = (room: number): boolean => room >= MIN_WINDOW_ROWS || (!isDetail && boardLines({ ...board, rows: Number.POSITIVE_INFINITY }).length <= Math.max(0, room))
  const shared = barOf(Math.floor(under / 2))
  const bar = shared !== undefined && isNote(shared) && !fits(under - barHeight(shared)) ? undefined : shared
  const room = under - barHeight(bar)
  if (!fits(room)) {
    // the bar holds an intent or a draft: it takes the place of the board, so its y and c stay
    const whole = bar === undefined ? undefined : barOf(bodyRows - header.length - 1 - keys.lines.length)
    if (whole === undefined || header.length + 1 + barHeight(whole) + keys.lines.length > bodyRows) return cannotDrawView('too-short', bodyColumns)
    return { kind: 'bar', header, topRule: ruleLine(bodyColumns), bar: whole, keys: keys.lines, hints: keys.hints }
  }
  const withBar = bar === undefined ? {} : { bar }
  const screen = input.screen === undefined || input.screen === null ? {} : { screen: input.screen }
  const outcome = input.deliver?.outcome === undefined ? {} : { outcome: input.deliver.outcome }
  const recap = input.recap === undefined || input.recap === null ? {} : { recap: input.recap }
  const draft = isDraftOpen ? { isDraftOpen } : {}
  const detailOf = (width: number) => withoutScroll(paneDetail({ snapshot, ...selection, width, rows: room, now, state: detailState, ...screen, ...outcome, ...recap, ...draft }), bar)
  if (isDetail) {
    const detail = detailOf(bodyColumns)
    const drawn = keysOf(snapshot, true, detail)
    return { kind: 'detail', header, topRule: ruleLine(bodyColumns), detail, bottomRule: ruleLine(bodyColumns), ...withBar, keys: drawn.lines, hints: drawn.hints }
  }
  const { lines: body, more } = boardWindow({ ...board, rows: room })
  const detail = layout.kind === 'wide' ? detailOf(layout.detailColumns) : undefined
  const drawn = keysOf(snapshot, false, detail)
  return {
    kind: 'board',
    layout,
    header,
    topRule: ruleLine(bodyColumns, layout, '┬'),
    body,
    more,
    ...(detail === undefined ? {} : { detail }),
    bottomRule: ruleLine(bodyColumns, layout, '┴'),
    ...withBar,
    keys: drawn.lines,
    hints: drawn.hints,
  }
}

/**
 * Every line of a pane view, top to bottom. In the wide body, the lines of the board column come before the detail.
 * The text field of a draft is an element, not a line.
 */
export function paneLines(view: PaneView): Line[] {
  if (view.kind === 'cannot-draw') return [...view.lines]
  if (view.kind === 'message') return [...view.header, view.topRule, ...view.body, ...(view.bottomRule === undefined ? [] : [view.bottomRule]), ...(view.keys ?? [])]
  if (view.kind === 'bar') return [...view.header, view.topRule, ...view.bar.lines, ...view.keys]
  const bar = view.bar?.lines ?? []
  if (view.kind === 'detail') return [...view.header, view.topRule, ...paneDetailLines(view.detail), view.bottomRule, ...bar, ...view.keys]
  return [...view.header, view.topRule, ...view.body, ...(view.detail === undefined ? [] : paneDetailLines(view.detail)), view.bottomRule, ...bar, ...view.keys]
}
