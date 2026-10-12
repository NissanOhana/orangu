/**
 * The detail that the pane shows beside the board (90 columns or more) or in place of it (below 90, once the
 * person opens it): the detail of the selected session (src/god/view/detail.ts), or 1 line that asks for a
 * selection when no session of the board is selected.
 * - The selected session is the selected row of the board when it is a session that a group of the board holds. A
 *   heading, no selection, a session that left the board, or a session that the repos mode hides selects none.
 * - The Screen tab shows the screen state of the selected session (src/god/screen-loop.ts): its last good read, and
 *   whether the newest read failed. A state of another session shows nothing of it. While the last cmux read failed,
 *   the tab says that the session has no tab, because the tab map can be old.
 * - The Recap tab shows the last Recap that the engine state holds (src/god/act/recap.ts) when it is of the selected
 *   session, and the x key that makes one while no Recap runs.
 * - The last outcome of the key path goes to the detail, so the Screen tab of its session shows the line of a refusal,
 *   a failure or a miss above the screen, and the fresh screen of a refusal.
 * - For each side that the window over the tab content cuts, the view gives the scroll that its key goes to: w the
 *   page above, z the page below (scrollBy in src/god/view/window.ts). The engine shell keeps only the number.
 * - While the help is open (h), the help view (src/god/view/help.ts) takes the place of the detail, with or with no
 *   selected session, in a window that w and z scroll the same way.
 */
import type { ScreenState } from '../source/screen.js'
import type { BoardSnapshot, DeliverOutcome, DetailTab, RecapState } from '../types.js'
import type { Picks } from './bar.js'
import { isOnBoard } from './board.js'
import { detailLines, detailView, scrollBy, SCROLL_KEYS, type DetailView } from './detail.js'
import { helpLines } from './help.js'
import { CANNOT_DRAW, messageLines } from './states.js'
import type { Line } from './types.js'
import { MIN_WINDOW, windowOf, type ScrollWindow } from './window.js'

/** What the person chose for the detail: the open tab, the first line of its content, and the narrow detail. */
export type DetailState = {
  tab: DetailTab
  /** the first line of the tab content to show: 0, or what a key of scrollTo gave */
  scroll: number
  /** true when the narrow pane shows the detail in place of the board */
  isOpen: boolean
  /** true while the help (h) shows in place of the detail; absent, false */
  isHelp?: boolean
}

/** The detail of a first start: Now from its top, and the board in the narrow pane. */
export const DEFAULT_DETAIL: DetailState = { tab: 'now', scroll: 0, isOpen: false }

/** The line of the detail when no session of the board is selected. */
export const NO_DETAIL = 'Select a session on the board to show its detail.'

/**
 * The detail of the pane:
 * - session: the detail of the selected session, and the scroll that each key of a cut side goes to;
 * - none: the line that asks for a selection;
 * - help: the window over the help view, and the scroll that each key of a cut side goes to.
 */
export type PaneDetail =
  | { kind: 'session'; sessionId: string; view: DetailView; scrollTo: Readonly<Partial<Record<string, number>>> }
  | { kind: 'none'; lines: Line[] }
  | { kind: 'help'; lines: Line[]; scrollTo: Readonly<Partial<Record<string, number>>> }

/** What the detail of the pane reads. The engine shell passes the selection, the room, the clock and the state. */
export type PaneDetailInput = {
  snapshot: BoardSnapshot
  /** the key of the selected row of the board */
  selectedKey?: string
  /** the detail width in cells */
  width: number
  /** the most lines that the detail may take */
  rows: number
  now: number
  state: DetailState
  /** the screen state of the Screen tab: the session that it read, its last good read, and whether the newest failed */
  screen?: ScreenState
  /** the last outcome of the key path */
  outcome?: DeliverOutcome
  /** the last Recap, of any session */
  recap?: RecapState
  /** true while a draft of r or m is open: the digits of the Now tab have no hotkey */
  isDraftOpen?: boolean
  /** the picks so far in a dialog with 2 or more questions */
  picks?: Picks
}

/** The scroll that each key goes to: w while lines hide above the window, z while lines hide below it. */
function scrollTargets(view: DetailView): Partial<Record<string, number>> {
  return view.kind === 'detail' ? windowTargets(view.window) : {}
}

function windowTargets(window: ScrollWindow): Partial<Record<string, number>> {
  return {
    ...(window.first > 0 ? { [SCROLL_KEYS.up]: scrollBy(window, 'up') } : {}),
    ...(window.first + window.shown < window.total ? { [SCROLL_KEYS.down]: scrollBy(window, 'down') } : {}),
  }
}

/** The detail of the selected session, or the line that asks for a selection. */
export function paneDetail(input: PaneDetailInput): PaneDetail {
  const { snapshot, width } = input
  if (input.state.isHelp === true) {
    const help = helpLines(width)
    if (help.length > input.rows && input.rows < MIN_WINDOW) return { kind: 'none', lines: messageLines(CANNOT_DRAW['too-short'], width) }
    const { lines, window } = windowOf(help, input.rows, input.state.scroll)
    return { kind: 'help', lines, scrollTo: windowTargets(window) }
  }
  const session = isOnBoard(snapshot, input.selectedKey) ? snapshot.sessions.find((candidate) => candidate.sessionId === input.selectedKey) : undefined
  if (session === undefined) return { kind: 'none', lines: messageLines(NO_DETAIL, width) }
  const screen = input.screen?.sessionId === session.sessionId ? input.screen : undefined
  const view = detailView({
    session,
    sessions: snapshot.sessions,
    width,
    rows: input.rows,
    now: input.now,
    tab: input.state.tab,
    scroll: input.state.scroll,
    isCmuxMissing: snapshot.sources.cmux.status === 'missing',
    ...(snapshot.sources.cmux.status === 'off' || snapshot.sources.cmux.status === 'unread' ? { isTabMapOld: true } : {}),
    ...(screen?.read === undefined ? {} : { screen: screen.read }),
    ...(screen?.isFailed === true ? { isScreenFailed: true } : {}),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.recap === undefined ? {} : { recap: input.recap }),
    ...(input.isDraftOpen === true ? { isDraftOpen: true } : {}),
    ...(input.picks === undefined ? {} : { picks: input.picks }),
  })
  return { kind: 'session', sessionId: session.sessionId, view, scrollTo: scrollTargets(view) }
}

/** Every line of the detail of the pane, top to bottom. */
export function paneDetailLines(detail: PaneDetail): Line[] {
  return detail.kind === 'session' ? detailLines(detail.view) : [...detail.lines]
}
