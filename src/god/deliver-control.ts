/**
 * The pure rules of the key path controls, so the engine shell (src/god/deliver-keys.tsx) holds none. Each rule takes
 * the delivery state (src/god/view/bar.ts) and gives the next one. No rule sends a key: a rule only opens or closes
 * the confirm bar, keeps the draft, or takes the outcome of a delivery and the check of the next refreshes.
 * - A digit opens the bar for the option with that digit of the open question of the selected session, only when the
 *   question is the only one of its dialog and takes 1 choice, and only with cmux on the machine.
 * - The Yes or the No of a request opens the bar only for an open Bash request of a session that waits on a
 *   permission prompt: the screen check ties only a shell command to its dialog. Any other tool gets j only.
 * - While a draft is open, a digit and the Yes or No keep the draft and open no bar, so a digit typed for the draft
 *   never arms y.
 * - r opens a prompt draft for the selected session, only with cmux. m opens a peer message draft, with or without
 *   cmux, because the engine sends it. A new bar or draft closes the one before it and the note of the last outcome.
 * - y sends only the intent that the bar of its drawing shows, while the state still holds that intent and no y runs.
 *   While the keys go out the state is marked as sending, so the bar draws no y and no c; the outcome ends the mark.
 * - Each line of a draft adds its text, split at its line breaks (a paste can hold them). An empty line ends the
 *   draft: with 1 or more lines it opens the bar with the whole text, else it closes the draft.
 * - c closes the bar of its own drawing (as y sends the intent of its own drawing), and stops the keys only of a
 *   delivery of that same intent, so the c of a bar that a digit opened while the keys go out stops nothing.
 * - c closes the bar and the draft. A delivery closes the bar of its intent, but after stale-screen, when the bar
 *   still asks about that intent, the bar stays with its scroll, so y reads the facts and the screen again. A bar or a
 *   draft that the person opened while the keys went out stays.
 * - A refusal or a failure that holds a fresh screen opens the Screen tab of its session from its top.
 * - After each refresh, the check of a send turns the sent outcome into delivered or not delivered. A later outcome
 *   took the place of the sent one: the check goes, and the outcome stays.
 */
import { checkDelivery } from './act/deliver-check.js'
import type { DeliverResult } from './act/deliver.js'
import type { KeyIntent } from './act/deliver-plan.js'
import type { BoardSnapshot, DeliverIntent, DeliverOutcome, DeliverTarget, Facts, GodSession } from './types.js'
import type { DeliverState, Draft } from './view/bar.js'
import type { DetailState } from './view/detail-pane.js'
import { ANSWERED_TOOL } from './view/detail-tabs.js'
import { LINE_BREAK } from './view/wrap.js'

/** The selected session of the board, when cmux allows the keys (or `needsCmux` is false). */
function selectedSession(snapshot: BoardSnapshot | undefined, selectedKey: string | undefined, needsCmux = true): GodSession | undefined {
  if (snapshot === undefined || (needsCmux && snapshot.sources.cmux.status === 'missing')) return undefined
  return snapshot.sessions.find((session) => session.sessionId === selectedKey)
}

const targetOf = (session: GodSession): DeliverTarget => ({ sessionId: session.sessionId, name: session.name })

/** The answer of a digit for the open question of the selected session. */
export function answerIntent(snapshot: BoardSnapshot | undefined, selectedKey: string | undefined, digit: number): KeyIntent | undefined {
  const session = selectedSession(snapshot, selectedKey)
  const open = session?.transcript?.openQuestion
  const [question, ...more] = open?.questions ?? []
  if (session === undefined || open === undefined || question === undefined || more.length > 0 || question.multiSelect) return undefined
  const option = Number.isInteger(digit) && digit >= 1 && digit <= 9 ? question.options[digit - 1] : undefined
  if (option === undefined) return undefined
  return { kind: 'answer', target: targetOf(session), toolUseId: open.toolUseId, header: question.header, question: question.text, option: digit, label: option.label }
}

/** The Yes or the No for the open Bash request of the selected session. */
export function permissionIntent(snapshot: BoardSnapshot | undefined, selectedKey: string | undefined, choice: 'yes' | 'no'): KeyIntent | undefined {
  const session = selectedSession(snapshot, selectedKey)
  const activity = session?.transcript?.activity
  if (session === undefined || session.status !== 'waiting' || session.waitingFor !== 'permission prompt' || activity?.isOpen !== true || activity.tool !== ANSWERED_TOOL) return undefined
  return { kind: 'permission', target: targetOf(session), choice, tool: activity.tool, ...(activity.input === undefined ? {} : { input: activity.input }) }
}

/** The draft of r (a prompt, needs cmux) or m (a peer message) for the selected session. */
export function draftFor(snapshot: BoardSnapshot | undefined, selectedKey: string | undefined, kind: Draft['kind']): Draft | undefined {
  const session = selectedSession(snapshot, selectedKey, kind === 'prompt')
  return session === undefined ? undefined : { kind, target: targetOf(session), lines: [] }
}

const sameIntent = (a: DeliverIntent | undefined, b: DeliverIntent): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b)

/** The check of the state, when it has one: a new bar or draft keeps it. */
const checkOf = (state: DeliverState): Pick<DeliverState, 'check'> => (state.check === undefined ? {} : { check: state.check })

/** The bar of a new intent, from its top. */
export const withIntent = (state: DeliverState, intent: DeliverIntent): DeliverState => ({ scroll: 0, intent, ...checkOf(state) })

/** A digit or the Yes or No: the bar of its intent, or the same state while a draft is open. */
export const withPicked = (state: DeliverState, intent: DeliverIntent): DeliverState => (state.draft === undefined ? withIntent(state, intent) : state)

/** A new draft, in place of the bar. */
export const withDraft = (state: DeliverState, draft: Draft): DeliverState => ({ scroll: 0, draft, ...checkOf(state) })

/** 1 line of the draft: its text, or an empty line that ends the draft. */
export function afterDraftLine(state: DeliverState, value: string): DeliverState {
  const draft = state.draft
  if (draft === undefined) return state
  if (value.trim() !== '') return { ...state, draft: { ...draft, lines: [...draft.lines, ...value.split(new RegExp(LINE_BREAK.source))] } }
  const { draft: _draft, ...rest } = state
  if (draft.lines.length === 0) return rest
  return withIntent(rest, { kind: draft.kind, target: draft.target, text: draft.lines.join('\n') })
}

/** c: no bar and no draft. The outcome and the check stay. */
export function cancelled(state: DeliverState): DeliverState {
  const { intent: _intent, draft: _draft, ...rest } = state
  return { ...rest, scroll: 0 }
}

/**
 * c of a drawing that shows `shown` (the intent of its confirm bar, or undefined for a draft): no bar and no draft
 * while the state still shows that bar, else the same state, so a c never closes a bar that opened after its drawing.
 */
export function cancelPressed(state: DeliverState, shown: DeliverIntent | undefined): DeliverState {
  const isShown = shown === undefined ? state.intent === undefined : sameIntent(state.intent, shown)
  return isShown ? cancelled(state) : state
}

/** True when c of a bar that shows `shown` stops the keys of the delivery of `delivering`: only the bar of that intent does. */
export const stopsDelivery = (delivering: DeliverIntent | undefined, shown: DeliverIntent | undefined): boolean => delivering !== undefined && shown !== undefined && sameIntent(delivering, shown)

/** w or z of the bar: the scroll that the view gave for the key. */
export const scrolled = (state: DeliverState, scroll: number): DeliverState => ({ ...state, scroll })

/** True when y of a drawing that shows `shown` may send it: the state still holds that intent, and no y runs. */
export const isSendable = (state: DeliverState, shown: DeliverIntent | undefined): shown is DeliverIntent => shown !== undefined && state.isSending !== true && sameIntent(state.intent, shown)

/** The state while the keys of its intent go out: the bar draws no y and no c. */
export const sending = (state: DeliverState): DeliverState => ({ ...state, isSending: true })

/** The state with no sending mark. */
export function notSending(state: DeliverState): DeliverState {
  const { isSending: _isSending, ...rest } = state
  return rest
}

/** y of a drawing that shows `shown`: the state marked as sending when isSendable takes it, else the same state. */
export const sendPressed = (state: DeliverState, shown: DeliverIntent | undefined): DeliverState => (isSendable(state, shown) ? sending(state) : state)

/** True when the state is marked as sending `intent`: the y that marked it sends that intent. */
export const isSendingOf = (state: DeliverState, intent: DeliverIntent): boolean => state.isSending === true && sameIntent(state.intent, intent)

/** The state after the delivery of `intent` gave `result`. The sending mark ends. */
export function afterDelivery(state: DeliverState, intent: DeliverIntent, result: DeliverResult): DeliverState {
  const { outcome, check } = result
  const isStale = outcome.status === 'refused' && outcome.refusal === 'stale-screen'
  const isOwnBar = sameIntent(state.intent, intent)
  const keeps = state.intent !== undefined && (!isOwnBar || isStale)
  return {
    scroll: keeps ? state.scroll : 0,
    ...(keeps ? { intent: state.intent } : {}),
    ...(state.draft === undefined ? {} : { draft: state.draft }),
    outcome,
    ...(check !== undefined ? { check } : checkOf(state)),
  }
}

/** True when the outcome holds a fresh screen of a refusal or a failure: the Screen tab of its session opens. */
export const opensScreen = (outcome: DeliverOutcome): boolean => (outcome.status === 'refused' || outcome.status === 'failed') && outcome.screen !== undefined

/** The detail that shows the Screen tab from its top, in place of the board in the narrow pane too. */
export const screenDetail = (state: DetailState): DetailState => ({ ...state, tab: 'screen', scroll: 0, isOpen: true })

/** The state after a refresh of the board: the check of the last send, when there is one. */
export function afterRefresh(state: DeliverState, facts: Facts | undefined): DeliverState {
  const check = state.check
  if (check === undefined) return state
  const result = checkDelivery(check, facts)
  if (result.status === 'waiting') return result.check === check ? state : { ...state, check: result.check }
  const { check: _check, ...rest } = state
  const sent = state.outcome?.status === 'sent' ? state.outcome : undefined
  if (sent === undefined) return rest
  return { ...rest, outcome: { status: result.status, intent: sent.intent, at: facts?.stats.at ?? sent.at } }
}
