// The engine shell of the key path: what a digit, the Yes or No of a Bash request, r, m, a line of the draft, y, c,
// w and z of the bar, and each refresh of the board do, with no rule of its own. The rules are in
// src/god/deliver-control.ts (the bar and the draft) and src/god/act/deliver.ts (the executor). Every function that
// takes `$` is a function declaration at the top of the file, as the engine asks.
// - A digit, Yes or No, r and m only open the confirm bar or the draft in the engine state. Nothing goes out until y.
//   While a draft is open, a digit and Yes or No keep the draft.
// - y takes the intent that the bar of its drawing shows, and delivers it only while the engine state still holds
//   that intent: a peer message through the engine, any other intent through the executor over the host port, with
//   the row of its target and the state of cmux from the last board snapshot. 1 y runs at a time: a y while one runs
//   does nothing, so a key never goes out twice. While it runs, the state is marked as sending, so the bar draws no
//   y and no c.
// - c while the keys go out (from a drawing made before y) sets the cancel mark, which the executor reads before each
//   step, so the steps that did not go out never go out.
// - A refusal or a failure with a fresh screen selects its session and opens its Screen tab.
// - The text field of a draft takes the focus ring when it opens and after each line, so the person types on.
// - After each tick of the board, the check of the last send reads the newest facts.
import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { deliver, deliverPeer, type DeliverResult } from './act/deliver.js'
import {
  afterDelivery,
  afterDraftLine,
  afterRefresh,
  answerIntent,
  cancelled,
  draftFor,
  isSendingOf,
  notSending,
  opensScreen,
  permissionIntent,
  screenDetail,
  scrolled,
  sendPressed,
  withDraft,
  withPicked,
} from './deliver-control.js'
import { engineClock, engineEffects, engineHost } from './engine.js'
import { textCleaner } from './sanitize.js'
import { BOARD, DELIVER, DETAIL, JUMP, SELECTED } from './state.js'
import type { BoardSnapshot, DeliverIntent, Facts } from './types.js'
import { draftKey, type Draft } from './view/bar.js'

/** The id of the pane. */
export const PANE = 'god'

/** The key path of 1 load of the module: true while a y runs, and the cancel mark of a c while it runs. */
export type DeliverRuntime = { isDelivering: boolean; isCancelled: boolean }

async function selection($: EngineInterface): Promise<{ snapshot: BoardSnapshot | undefined; selectedKey: string | undefined }> {
  return { snapshot: (await read($, BOARD)) ?? undefined, selectedKey: (await read($, SELECTED)) || undefined }
}

async function openBar($: EngineInterface, intent: DeliverIntent | undefined): Promise<void> {
  if (intent !== undefined) await update($, DELIVER, (state) => withPicked(state, intent))
}

/** A digit on an option of the open question of the selected session: the confirm bar of that answer. */
export async function openAnswer($: EngineInterface, digit: number): Promise<void> {
  const { snapshot, selectedKey } = await selection($)
  await openBar($, answerIntent(snapshot, selectedKey, digit))
}

/** The Yes or the No of the Bash request of the selected session: the confirm bar of that choice. */
export async function openPermission($: EngineInterface, choice: 'yes' | 'no'): Promise<void> {
  const { snapshot, selectedKey } = await selection($)
  await openBar($, permissionIntent(snapshot, selectedKey, choice))
}

/** Moves the focus ring onto the text field of the draft, once the pane draws it. */
async function focusDraft($: EngineInterface, draft: Draft): Promise<void> {
  await $.ui.focus({ requestId: PANE, key: draftKey(draft) })
}

/** r or m: the draft of a prompt or a peer message for the selected session. */
export async function openDraft($: EngineInterface, kind: Draft['kind']): Promise<void> {
  const { snapshot, selectedKey } = await selection($)
  const draft = draftFor(snapshot, selectedKey, kind)
  if (draft === undefined) return
  await update($, DELIVER, (state) => withDraft(state, draft))
  await focusDraft($, draft)
}

/** Enter in the text field of the draft: 1 more line, or the confirm bar of the whole text on an empty line. */
export async function addDraftLine($: EngineInterface, value: string): Promise<void> {
  const next = await update($, DELIVER, (state) => afterDraftLine(state, value))
  if (next.draft !== undefined) await focusDraft($, next.draft)
}

/** c: the bar and the draft close. While a y runs, the steps that did not go out stop. */
export async function cancelBar($: EngineInterface, runtime: DeliverRuntime): Promise<void> {
  if (runtime.isDelivering) runtime.isCancelled = true
  await update($, DELIVER, cancelled)
}

/** w or z of the bar: the scroll that the view gave for the key. */
export async function scrollBar($: EngineInterface, scroll: number): Promise<void> {
  await update($, DELIVER, (state) => scrolled(state, scroll))
}

/** The delivery of 1 intent: a peer message through the engine, keys through the executor. */
async function deliverIntent($: EngineInterface, intent: DeliverIntent, runtime: DeliverRuntime): Promise<DeliverResult> {
  if (intent.kind === 'peer') return { outcome: await deliverPeer(engineEffects($).peer, intent, () => $.clock.now()) }
  const snapshot = (await read($, BOARD)) ?? undefined
  const session = snapshot?.sessions.find((candidate) => candidate.sessionId === intent.target.sessionId)
  const home = (await $.env.get('HOME')) ?? ''
  const ports = { host: engineHost($), home, clean: textCleaner(home), clock: engineClock, isCancelled: () => runtime.isCancelled }
  return deliver(ports, { intent, ...(session === undefined ? {} : { session }), cmux: snapshot?.sources.cmux.status ?? 'unread' })
}

/** Selects the session of an outcome and opens its Screen tab, from its top. */
async function showScreen($: EngineInterface, sessionId: string): Promise<void> {
  await update($, SELECTED, () => sessionId)
  await update($, DETAIL, screenDetail)
  await update($, JUMP, () => null)
}

/** y of a drawing that shows `shown`: that intent goes out, once, while the state still holds it. */
export async function sendConfirmed($: EngineInterface, runtime: DeliverRuntime, shown: DeliverIntent | undefined): Promise<void> {
  if (runtime.isDelivering || shown === undefined) return
  runtime.isDelivering = true
  runtime.isCancelled = false
  try {
    const marked = await update($, DELIVER, (state) => sendPressed(state, shown))
    if (!isSendingOf(marked, shown)) return
    const result = await deliverIntent($, shown, runtime).catch(async (error: unknown) => {
      await update($, DELIVER, notSending)
      throw error
    })
    await update($, DELIVER, (state) => afterDelivery(state, shown, result))
    if (opensScreen(result.outcome)) await showScreen($, shown.target.sessionId)
  } finally {
    runtime.isDelivering = false
  }
}

/** After a tick of the board: the check of the last send reads the newest facts. */
export async function checkSent($: EngineInterface, facts: Facts | undefined): Promise<void> {
  const state = await read($, DELIVER)
  if (state.check === undefined || afterRefresh(state, facts) === state) return
  await update($, DELIVER, (now) => afterRefresh(now, facts))
}
