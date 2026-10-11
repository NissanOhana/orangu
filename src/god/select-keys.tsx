// The engine shell of the selection keys of the god pane: a move of the selection, n, a press on a row, j, a change
// of the detail and b, with no rule of their own. The rules are in src/god/control.ts, src/god/detail-control.ts
// and src/god/act/jump.ts. Every function that takes `$` is a function declaration at the top of the file, as the
// engine asks.
// - Each new selection starts the detail at its top, and clears the note of the last j.
// - A choice of the board (f, g, a /god form) clears a selected row that the new board does not show, so the detail,
//   the jump note and the keys leave it. The confirm bar keeps its own target.
// - A press on a session row (an open) and a jump mark the session seen through the board loop.
import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { jumpNoteOf, jumpPlan, jumpedSessionOf, runJump } from './act/jump.js'
import type { BoardLoop } from './board-loop.js'
import { nextNeedsYou, openGroupsAfterPress, openedSessionOf, selectionOf } from './control.js'
import { detailAfterBack, detailAfterRowPress, detailAfterSelect } from './detail-control.js'
import { PANE } from './deliver-keys.js'
import { engineClock, engineHost } from './engine.js'
import { BOARD, DETAIL, JUMP, OPEN_GROUPS, SELECTED } from './state.js'
import type { DetailState } from './view/detail-pane.js'
import type { PaneLayout } from './view/types.js'

/** Selects the row `key`. A new selected row starts the detail at the top of its tab. */
export async function select($: EngineInterface, key: string): Promise<void> {
  const before = await read($, SELECTED)
  if (before === key) return
  await update($, SELECTED, () => key)
  await update($, DETAIL, (state) => detailAfterSelect(state, before, key))
  await update($, JUMP, () => null)
}

/** Selects the row `key` and moves the focus ring onto it, so the arrows and Tab go on from there. */
export async function selectAndFocus($: EngineInterface, key: string): Promise<void> {
  await select($, key)
  await $.ui.focus({ requestId: PANE, key })
}

/** After a choice of the board: no selection when the selected row is not a row of the new board. */
export async function dropHiddenSelection($: EngineInterface): Promise<void> {
  const selected = await read($, SELECTED)
  if (selected !== '' && selectionOf(selected, (await read($, BOARD)) ?? undefined) === undefined) await select($, '')
}

/** n: the next session that needs you. */
export async function selectNext($: EngineInterface): Promise<void> {
  const next = nextNeedsYou((await read($, BOARD)) ?? undefined, (await read($, SELECTED)) || undefined)
  if (next !== undefined) await selectAndFocus($, next)
}

/** A press on a row: a heading opens or closes its group, and a session row opens the session and marks it seen. */
export async function pressRow($: EngineInterface, board: BoardLoop | undefined, key: string, layout: PaneLayout): Promise<void> {
  const snapshot = (await read($, BOARD)) ?? undefined
  await update($, OPEN_GROUPS, (groups) => openGroupsAfterPress(groups, key, snapshot))
  await select($, key)
  await update($, DETAIL, (state) => detailAfterRowPress(state, key, snapshot, layout))
  const opened = openedSessionOf(key, snapshot)
  if (opened !== undefined) await board?.seen(opened, engineClock())
}

/** j: the jump to the tab of the selected session, the note of a j that did not jump, and the seen mark of a jump. */
export async function jumpSelected($: EngineInterface, board: BoardLoop | undefined): Promise<void> {
  const outcome = await runJump(engineHost($), jumpPlan((await read($, BOARD)) ?? undefined, (await read($, SELECTED)) || undefined))
  await update($, JUMP, () => jumpNoteOf(outcome))
  const jumped = jumpedSessionOf(outcome)
  if (jumped !== undefined) await board?.seen(jumped, engineClock())
}

export async function changeDetail($: EngineInterface, change: (state: DetailState) => DetailState): Promise<void> {
  await update($, DETAIL, change)
}

/** b: the board again, with the focus ring on the selected row. */
export async function backToBoard($: EngineInterface): Promise<void> {
  await update($, DETAIL, detailAfterBack)
  const selected = await read($, SELECTED)
  if (selected !== '') await $.ui.focus({ requestId: PANE, key: selected })
}
