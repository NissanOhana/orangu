/**
 * The bar of the key path: the lines under the bottom rule of the pane and above the key row. Nothing goes out from
 * the bar until the person presses y. It shows 1 of 3 things:
 * - the confirm bar of the intent (src/god/view/confirm.ts). After an old read (stale-screen) the intent and the bar
 *   stay, with the line of that refusal above them, so y reads the facts and the screen again. While the keys go
 *   out, the bar has no y and no c;
 * - the draft of r or m: its target, its line count and c, then 1 text field. The field of the engine holds 1 line,
 *   so each Enter adds the line that it holds, and Enter on an empty field ends the draft and opens the confirm bar
 *   with the whole text. Each line gets a new field key, so the field is empty for the next line. The confirm bar
 *   shows every line of the text before y;
 * - the note of the last outcome, while its session is selected. A refusal, a failure or a miss shows no note while
 *   the Screen tab of that session is open, because the Screen tab shows the same line above the screen.
 * The bar gives the scroll that each count key of the confirm bar goes to (w the page above, z the page below), as
 * the detail does. No line is wider than `width`.
 */
import type { DeliverCheck } from '../act/deliver-check.js'
import type { DeliverIntent, DeliverOutcome, DeliverTarget } from '../types.js'
import { ACCENT } from '../ui/theme.js'
import { CANCEL_HINTS, confirmView, outcomeLines } from './confirm.js'
import { pressSegment } from './keys.js'
import type { KeyHint, Line } from './types.js'
import { SCROLL_KEYS, scrollBy, type ScrollWindow } from './window.js'
import { appendItem, flat, wrapSegments } from './wrap.js'

/** The text of r (a prompt that the pane types into the tab) or m (a peer message), 1 line for each Enter. */
export type Draft = { kind: 'prompt' | 'peer'; target: DeliverTarget; lines: readonly string[] }

/**
 * What the key path holds, in the engine state:
 * - intent: what the open confirm bar asks about; absent while the bar is closed;
 * - scroll: the first line of the scrolled text of the bar;
 * - draft: the draft of r or m, while it is open;
 * - outcome: what became of the last intent after y;
 * - check: what the refreshes after a send look for (src/god/act/deliver-check.ts);
 * - isSending: true while the keys of the intent go out, so the bar draws no y and no c.
 */
export type DeliverState = { intent?: DeliverIntent; scroll: number; draft?: Draft; outcome?: DeliverOutcome; check?: DeliverCheck; isSending?: boolean }

/** The key path before any key: no bar, no draft, no outcome. */
export const NO_DELIVERY: DeliverState = { scroll: 0 }

/** The key of the text field of a draft: new for each line, so the field is empty for the next one. */
export const draftKey = (draft: Draft): string => `draft:${draft.lines.length}`

/** The text before the field, in the field when it is empty, and what Enter does. */
export const DRAFT_LABEL = 'Line'
export const DRAFT_PLACEHOLDER = 'Type 1 line and press Enter. Press Enter on an empty line to end.'
export const DRAFT_SUBMIT = 'add line'

/** The first line of a draft: what it is, for which session, and how many lines it has. */
export function draftText(draft: Draft): string {
  const count = draft.lines.length
  return `Write the ${draft.kind === 'prompt' ? 'prompt' : 'peer message'} for ${flat(draft.target.name)}. It has ${count} ${count === 1 ? 'line' : 'lines'}.`
}

/** The text field of a draft, as the shell draws it. */
export type DraftField = { key: string; label: string; placeholder: string; submitLabel: string }

/**
 * The bar: its lines, the text field of a draft, the scroll that each count key goes to, whether it is open (a
 * confirm bar or a draft, which own c, and y in the confirm bar), the keys that its Buttons press, and the intent that
 * the confirm bar shows, which its y sends. The keys hold y only in a confirm bar that can send: a refused prompt or
 * peer message and a draft hold c only, so the shell binds no y there. While the keys go out the bar is not open and
 * holds no key, and w and z still scroll it.
 */
export type BarView = { lines: Line[]; field?: DraftField; scrollTo: Readonly<Partial<Record<string, number>>>; isOpen: boolean; hints: readonly KeyHint[]; intent?: DeliverIntent }

/** What the bar reads. */
export type BarInput = {
  deliver: DeliverState
  /** the pane width in cells */
  width: number
  /** the most rows of the confirm bar */
  rows: number
  /** the key of the selected row of the board */
  selectedKey?: string
  /** true while the detail shows the Screen tab of the selected session */
  isScreenOpen: boolean
}

/** The scroll that each key goes to: w while lines hide above the window, z while lines hide below it. */
function scrollTargets(window: ScrollWindow): Partial<Record<string, number>> {
  return {
    ...(window.first > 0 ? { [SCROLL_KEYS.up]: scrollBy(window, 'up') } : {}),
    ...(window.first + window.shown < window.total ? { [SCROLL_KEYS.down]: scrollBy(window, 'down') } : {}),
  }
}

/** True when the Screen tab shows the line of the outcome above the screen: a refusal, a failure or a miss. */
const isScreenLine = (outcome: DeliverOutcome): boolean => outcome.status === 'refused' || outcome.status === 'failed' || outcome.status === 'not-delivered'

/** The bar of the key path, or undefined when it has no line. */
export function barView(input: BarInput): BarView | undefined {
  const { deliver, width } = input
  const { intent, draft, outcome } = deliver
  if (intent !== undefined) {
    const isStale = outcome?.status === 'refused' && outcome.refusal === 'stale-screen' && JSON.stringify(outcome.intent) === JSON.stringify(intent)
    const stale = isStale ? outcomeLines(outcome, width) : []
    const isSending = deliver.isSending === true
    const bar = confirmView({ intent, width, rows: input.rows - stale.length, scroll: deliver.scroll, isSending })
    return { lines: [...stale, ...bar.lines], scrollTo: scrollTargets(bar.window), isOpen: !isSending, hints: isSending ? [] : bar.hints, intent }
  }
  if (draft !== undefined) {
    const head = appendItem(wrapSegments([{ text: draftText(draft), ...ACCENT, bold: true }], width), [pressSegment('c', 'cancel')], width)
    return { lines: head, field: { key: draftKey(draft), label: DRAFT_LABEL, placeholder: DRAFT_PLACEHOLDER, submitLabel: DRAFT_SUBMIT }, scrollTo: {}, isOpen: true, hints: CANCEL_HINTS }
  }
  if (outcome === undefined || outcome.intent.target.sessionId !== input.selectedKey) return undefined
  if (input.isScreenOpen && isScreenLine(outcome)) return undefined
  return { lines: outcomeLines(outcome, width), scrollTo: {}, isOpen: false, hints: [] }
}
