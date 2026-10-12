/**
 * The pure rules of the detail controls, so the engine shell (src/god/register.tsx) holds none. Each rule takes the
 * detail state (src/god/view/detail-pane.ts) and gives the next one:
 * - t opens the next tab, and Recap goes back to Now. A press on a tab opens that tab. A new tab starts at its top;
 * - w and z take the scroll that the view gave for the key (PaneDetail scrollTo), so the shell does no sums;
 * - a new selected row starts the tab content at its top. The same row keeps the scroll;
 * - in the narrow layout, a press on a session row (Enter, or a click) opens the detail in place of the board,
 *   from the top of its tab. A press on a heading opens or closes its group, and opens no detail. In the wide
 *   layout the detail shows beside the board at all times, so a press opens nothing;
 * - b goes back to the board, and keeps the tab;
 * - h opens the help in place of the detail from its top, and h again closes it. Esc (the prompt takes the keys), b,
 *   t and a press on a tab close it too. The detail shows again from the top of its tab.
 */
import type { BoardSnapshot, DetailTab } from './types.js'
import { nextTab } from './view/detail.js'
import type { DetailState } from './view/detail-pane.js'
import type { PaneLayout } from './view/types.js'

/** The state with no help field: the detail shows. */
function withoutHelp(state: DetailState): DetailState {
  const { isHelp: _help, ...detail } = state
  return detail
}

/** t: the next tab, from its top, and no help. */
export const detailAfterNextTab = (state: DetailState): DetailState => ({ ...withoutHelp(state), tab: nextTab(state.tab), scroll: 0 })

/** A press on a tab: that tab, from its top when it is not the open tab or the help shows, and no help. */
export const detailAfterTab = (state: DetailState, tab: DetailTab): DetailState =>
  tab === state.tab && state.isHelp !== true ? state : { ...withoutHelp(state), tab, scroll: 0 }

/** h: the help from its top, or the detail again from the top of its tab. */
export const detailAfterHelp = (state: DetailState): DetailState => (state.isHelp === true ? { ...withoutHelp(state), scroll: 0 } : { ...state, scroll: 0, isHelp: true })

/** Esc gave the keys to the prompt: no help, and the detail from the top of its tab. */
export const detailWithoutHelp = (state: DetailState): DetailState => (state.isHelp === true ? { ...withoutHelp(state), scroll: 0 } : state)

/** w or z: the scroll that the view gave for the key. */
export const detailAfterScroll = (state: DetailState, scroll: number): DetailState => ({ ...state, scroll })

/** A selection: the tab content from its top when the selected row changed from `before` to `after`. */
export const detailAfterSelect = (state: DetailState, before: string, after: string): DetailState => (before === after ? state : { ...state, scroll: 0 })

/** A press on the row `key`: in the narrow layout a session row of the board opens the detail. */
export function detailAfterRowPress(state: DetailState, key: string, snapshot: BoardSnapshot | undefined, layout: PaneLayout): DetailState {
  const isSession = snapshot?.sessions.some((session) => session.sessionId === key) === true
  return layout.kind === 'narrow' && isSession ? { ...state, isOpen: true, scroll: 0 } : state
}

/** b: back to the board, and no help. */
export const detailAfterBack = (state: DetailState): DetailState => ({ ...withoutHelp(state), isOpen: false, ...(state.isHelp === true ? { scroll: 0 } : {}) })
