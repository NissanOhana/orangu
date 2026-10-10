/**
 * The pure rules of the detail controls, so the engine shell (src/god/register.tsx) holds none. Each rule takes the
 * detail state (src/god/view/detail-pane.ts) and gives the next one:
 * - t opens the next tab, and Recap goes back to Now. A press on a tab opens that tab. A new tab starts at its top;
 * - w and z take the scroll that the view gave for the key (PaneDetail scrollTo), so the shell does no sums;
 * - a new selected row starts the tab content at its top. The same row keeps the scroll;
 * - in the narrow layout, a press on a session row (Enter, or a click) opens the detail in place of the board,
 *   from the top of its tab. A press on a heading opens or closes its group, and opens no detail. In the wide
 *   layout the detail shows beside the board at all times, so a press opens nothing;
 * - b goes back to the board, and keeps the tab.
 */
import type { BoardSnapshot, DetailTab } from './types.js'
import { nextTab } from './view/detail.js'
import type { DetailState } from './view/detail-pane.js'
import type { PaneLayout } from './view/types.js'

/** t: the next tab, from its top. */
export const detailAfterNextTab = (state: DetailState): DetailState => ({ ...state, tab: nextTab(state.tab), scroll: 0 })

/** A press on a tab: that tab, from its top when it is not the open tab. */
export const detailAfterTab = (state: DetailState, tab: DetailTab): DetailState => (tab === state.tab ? state : { ...state, tab, scroll: 0 })

/** w or z: the scroll that the view gave for the key. */
export const detailAfterScroll = (state: DetailState, scroll: number): DetailState => ({ ...state, scroll })

/** A selection: the tab content from its top when the selected row changed from `before` to `after`. */
export const detailAfterSelect = (state: DetailState, before: string, after: string): DetailState => (before === after ? state : { ...state, scroll: 0 })

/** A press on the row `key`: in the narrow layout a session row of the board opens the detail. */
export function detailAfterRowPress(state: DetailState, key: string, snapshot: BoardSnapshot | undefined, layout: PaneLayout): DetailState {
  const isSession = snapshot?.sessions.some((session) => session.sessionId === key) === true
  return layout.kind === 'narrow' && isSession ? { ...state, isOpen: true, scroll: 0 } : state
}

/** b: back to the board. */
export const detailAfterBack = (state: DetailState): DetailState => ({ ...state, isOpen: false })
