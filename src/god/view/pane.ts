/**
 * The whole god pane from 1 board snapshot, top to bottom: the header, a rule, the body, a rule, the key row.
 * - At WIDE_FROM_COLUMNS or more, the body is the board column (BOARD_COLUMNS cells) left of the detail of the
 *   selected session (src/god/view/detail-pane.ts), and each rule meets the column rule at the board width. The
 *   detail takes no more rows than the board has. Below, the board takes the whole body, and once the person opens
 *   the detail, the detail takes it in place of the board, and the key row starts with b, which goes back.
 * - A board state (reading, no session, no session in the selected repos) shows its message under the header in
 *   place of the board. The 2 states of the repos mode (no repo selected, no session of the selected repos) keep a
 *   rule and the key row under their message, because f leaves them, and a key works only while its Button is drawn.
 * - The pane takes no more rows than `bodyRows`: the board shows only the lines that fit, around the selected row.
 * - The jump note of the selected session (why its last j did not jump) shows under the key row. The note of another
 *   session shows nothing.
 * - The bar of the key path (src/god/view/bar.ts) sits under the bottom rule and above the key row, in the board and
 *   in the narrow detail, and its rows come from the board: it takes at most half of the rows under the header. While
 *   the bar shows a count line, w and z scroll the bar, so the detail draws its own count lines with no key.
 * - The digits of the key row name the options of the open question of the selected session, or the Yes and No of
 *   its Bash request, while the Now tab of the detail draws their Buttons. Where no digit Button shows (the narrow
 *   board, another tab, a draft, nothing to answer) the row shows `1-9` dim.
 * - When the bar leaves too few rows for a window over the board or the detail, a note of the last outcome gives way
 *   (it has no key), and a bar that holds an intent or a draft takes the place of the board: the header, a rule, the
 *   bar and the key row, so y and c stay.
 * - When the pane cannot draw (a body under BOARD_COLUMNS, or too few rows for a window over the board), it shows
 *   1 message with the reason and nothing else.
 * No line is wider than `bodyColumns`, and no line of the board column is wider than the board.
 */
import type { JumpNote } from '../act/jump.js'
import type { ScreenState } from '../source/screen.js'
import { DIM } from '../ui/theme.js'
import type { BoardSnapshot } from '../types.js'
import { BOARD_COLUMNS, MIN_WINDOW_ROWS, boardLines, boardWindow } from './board.js'
import { barView, type BarView, type DeliverState } from './bar.js'
import { DEFAULT_DETAIL, paneDetail, paneDetailLines, type DetailState, type PaneDetail } from './detail-pane.js'
import { ANSWERED_TOOL, PERMISSION_ANSWERS } from './detail-tabs.js'
import { headerLines } from './header.js'
import { JUMP_NOTE, keyRow } from './keys.js'
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

/** The count of the choices that the digits answer for the selected session: its open question, or its Bash request. */
function answerCountOf(snapshot: BoardSnapshot, selectedKey: string | undefined): number | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.sessionId === selectedKey)
  const questions = session?.transcript?.openQuestion?.questions
  const activity = session?.transcript?.activity
  if ((questions === undefined || questions.length === 0) && session?.waitingFor === 'permission prompt' && activity?.isOpen === true && activity.tool === ANSWERED_TOOL) return PERMISSION_ANSWERS.length
  const only = questions?.length === 1 ? questions[0] : undefined
  return only === undefined || only.multiSelect ? undefined : only.options.length
}

/** The rows of the bar, its text field included. */
const barHeight = (bar: BarView | undefined): number => (bar === undefined ? 0 : bar.lines.length + (bar.field === undefined ? 0 : 1))

/** True when the bar is only the note of the last outcome: no intent, no draft and no key. */
const isNote = (bar: BarView): boolean => bar.intent === undefined && bar.field === undefined

/** The detail with no scroll keys: the bar shows a count line, so w and z scroll the bar. */
function withoutScroll(detail: PaneDetail, bar: BarView | undefined): PaneDetail {
  return detail.kind === 'session' && bar !== undefined && Object.keys(bar.scrollTo).length > 0 ? { ...detail, scrollTo: {} } : detail
}

/** The pane of 1 snapshot. */
export function paneView(input: PaneInput): PaneView {
  const { snapshot, bodyColumns, bodyRows, now } = input
  if (bodyColumns < BOARD_COLUMNS) return cannotDrawView('too-narrow', bodyColumns)
  const header = headerLines({ ...(snapshot === undefined ? {} : { snapshot }), width: bodyColumns, now })
  const state = boardStateOf(snapshot)
  const note = input.jumpNote ?? undefined
  const notice = note !== undefined && note.sessionId === input.selectedKey ? { notice: JUMP_NOTE[note.reason] } : {}
  const isDraftOpen = input.deliver?.draft !== undefined
  const keysOf = (board: BoardSnapshot, isDetail = false, showsDigits = false) => {
    const answerCount = showsDigits ? answerCountOf(board, input.selectedKey) : undefined
    return keyRow({
      width: bodyColumns,
      isCmuxMissing: board.sources.cmux.status === 'missing',
      promptHoldsKeys: input.promptHoldsKeys,
      ...(answerCount === undefined ? {} : { answerCount }),
      isAnswerOff: answerCount === undefined,
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
  const detailState = input.detail ?? DEFAULT_DETAIL
  const isDetail = layout.kind === 'narrow' && detailState.isOpen
  const showsDigits = (layout.kind === 'wide' || isDetail) && detailState.tab === 'now' && !isDraftOpen
  const keys = keysOf(snapshot, isDetail, showsDigits)
  const selection = input.selectedKey === undefined ? {} : { selectedKey: input.selectedKey }
  const under = bodyRows - header.length - 2 - keys.lines.length
  const barOf = (rows: number): BarView | undefined =>
    input.deliver === undefined ? undefined : barView({ deliver: input.deliver, width: bodyColumns, rows, ...selection, isScreenOpen: detailState.tab === 'screen' })
  const board = { snapshot, width: layout.boardColumns, now, openGroups: input.openGroups, selectedKey: input.selectedKey }
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
  const draft = isDraftOpen ? { isDraftOpen } : {}
  const detailOf = (width: number) => withoutScroll(paneDetail({ snapshot, ...selection, width, rows: room, now, state: detailState, ...screen, ...outcome, ...draft }), bar)
  if (isDetail) return { kind: 'detail', header, topRule: ruleLine(bodyColumns), detail: detailOf(bodyColumns), bottomRule: ruleLine(bodyColumns), ...withBar, keys: keys.lines, hints: keys.hints }
  const { lines: body, more } = boardWindow({ ...board, rows: room })
  return {
    kind: 'board',
    layout,
    header,
    topRule: ruleLine(bodyColumns, layout, '┬'),
    body,
    more,
    ...(layout.kind === 'wide' ? { detail: detailOf(layout.detailColumns) } : {}),
    bottomRule: ruleLine(bodyColumns, layout, '┴'),
    ...withBar,
    keys: keys.lines,
    hints: keys.hints,
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
