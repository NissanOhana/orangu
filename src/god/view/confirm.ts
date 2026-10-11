/**
 * The confirm bar and the outcome lines of the key path. Nothing goes out until the person presses y in the bar,
 * so the bar names the session and what goes to it, in the accent color, then the y and c keys:
 * - an answer: the option digit and label, then the header chip and the question;
 * - a permission: Yes or No and the tool, then its whole input, with the spaces of the input as written;
 * - a prompt or a peer message: the whole text.
 * The keys show in the form that the engine paints a hotkey Button (`y: send  c: cancel`), each 1 segment that the
 * shell draws as its Button. The bar of a prompt also names the command mode when the first character that is not
 * white space, on any line, is `/` (`   \n/clear` is a command), because the session reads it as a key. A prompt that
 * the text check of the key guard refuses (src/god/act/deliver-plan.ts textRefusal: an empty text, a control or hidden
 * character, a backslash escape, a shell command, the help or an exit) shows the line of that refusal in its place,
 * before y, and the bar offers c only, because y can send nothing. A peer message that is empty or holds a control or
 * hidden character (peerRefusal) does the same. While y runs, the bar shows that the pane sends in place of y and c.
 * The target and the question stay fixed. A long prompt or tool input scrolls with w and z in the row limit of the
 * bar (src/god/view/window.ts), with a count line for each side that the window leaves out, so the person can read
 * all of it before y. When the limit leaves fewer than 3 rows, the bar takes its fixed lines and 3 more: a text
 * that the person approves never hides. Each refusal code has 1 line: an old read in the warn color, every other
 * refusal in the bad color, and the not-delivered line in the warn color. No line is wider than `width`.
 */
import { peerRefusal, textRefusal } from '../act/deliver-plan.js'
import { CONTROL_CHAR, NOT_A_PROMPT, TASK_RUNNING } from '../copy.js'
import type { DeliverIntent, DeliverOutcome, DeliverRefusal } from '../types.js'
import { ACCENT } from '../ui/theme.js'
import { pressSegment } from './keys.js'
import type { KeyHint, Line, Segment } from './types.js'
import { MIN_WINDOW, windowOf, type ScrollWindow } from './window.js'
import { appendItem, flat, keptLines, textLines, wrapSegments } from './wrap.js'

/** The keys of the bar: y sends, c cancels. */
export const CONFIRM_HINTS: readonly KeyHint[] = [
  { keys: 'y', label: 'send', hotkey: 'y', isOff: false },
  { keys: 'c', label: 'cancel', hotkey: 'c', isOff: false },
]

/** The line of a dialog that the digits cannot answer: the detail shows it, and so does the multi-question refusal. */
export const MULTI_DIALOG = 'This dialog has more than 1 question or more than 1 choice. Press j to answer it in its tab.'

/** The same line when cmux is not on the machine, so j is off. */
export const MULTI_DIALOG_NO_CMUX = 'This dialog has more than 1 question or more than 1 choice. Answer it in its tab.'

/**
 * Why the key path sent nothing: 1 line for each refusal code. 2 codes have 2 meanings each in the key guard
 * (src/god/act/deliver-plan.ts), and their lines name both: screen-changed is a changed screen or a session state
 * that does not take the key, and stale-screen is an old screen read or session facts that lag the read.
 */
export const REFUSAL_TEXT: Readonly<Record<DeliverRefusal, string>> = {
  'no-cmux': 'cmux is not on this machine, so the pane sent nothing.',
  'no-tab': 'The session has no cmux tab, so the pane sent nothing.',
  'stale-screen': 'The screen or the session facts are too old, so the pane sent nothing. Press y again.',
  'screen-changed': 'The screen or the session changed, so the pane sent nothing.',
  'label-not-found': 'The screen shows no option with the exact label Yes or No, so the pane sent nothing.',
  'multi-question': MULTI_DIALOG,
  empty: 'The text is empty, so the pane sent nothing.',
  'control-char': CONTROL_CHAR,
  'backslash-escape': 'A line ends with a backslash, or holds \\n, \\r or \\t in any case, so the pane sent nothing.',
  'task-running': TASK_RUNNING,
  'not-a-prompt': NOT_A_PROMPT,
}

/**
 * The line of the mode that the target opens for a prompt whose first character is 1 of these. A prompt that the text
 * check refuses, such as a `!` (shell) or `?` (help) prompt or /exit, gets the line of its refusal in place of a mode
 * line, because the pane does not type it.
 */
export const PROMPT_MODE_TEXT: Readonly<Record<string, string>> = {
  '/': 'The first line starts with /, so the session runs it as a command.',
}

/** The keys went out, but the next refresh did not see the answer or the prompt. */
export const NOT_DELIVERED = 'Not delivered. Check the Screen tab.'

/** The engine did not deliver a peer message. */
export const PEER_NOT_DELIVERED = 'The peer message did not arrive.'

/** A cmux command of the plan failed, so the steps after it did not run. */
export const SEND_FAILED = 'A cmux command failed, so the keys after it did not go out. Check the Screen tab.'

/**
 * Why a delivery failed, by the reason that the executor gives (src/god/act/deliver.ts): a read before the keys, a
 * cmux command of the plan, a change that the check between 2 steps of a prompt saw, or c. Any other reason shows the
 * line of a cmux command that failed.
 */
export const FAILURE_TEXT: Readonly<Record<string, string>> = {
  'facts-unread': 'The pane could not read the session again, so it sent nothing.',
  'screen-unread': 'cmux did not read the screen, so the pane sent nothing.',
  'step-failed': SEND_FAILED,
  stopped: 'The screen or the session changed while the pane typed, so it sent no more keys. Check the Screen tab.',
  cancelled: 'You pressed c, so the pane sent no more keys.',
}

/** What the bar shows in place of its keys while y runs. */
export const SENDING = 'The pane sends it now.'

/** What the bar reads. */
export type ConfirmInput = {
  intent: DeliverIntent
  /** the pane width in cells */
  width: number
  /** the most rows of the bar */
  rows: number
  /** the first line of the scrolled text to show: 0, or what scrollBy gave. The shell sets 0 for a new intent */
  scroll: number
  /** true while y runs: the bar shows that the pane sends, in place of y and c */
  isSending?: boolean
}

/** The bar, its keys, and the window over its scrolled text. */
export type ConfirmView = { lines: Line[]; hints: readonly KeyHint[]; window: ScrollWindow }

/** The question of the bar: what goes to which session. */
function askText(intent: DeliverIntent): string {
  const name = flat(intent.target.name)
  if (intent.kind === 'answer') return `Send "${intent.option} ${flat(intent.label)}" to ${name}?`
  if (intent.kind === 'permission') return `Send "${intent.choice === 'yes' ? 'Yes' : 'No'}" to the ${flat(intent.tool)} request of ${name}?`
  return intent.kind === 'prompt' ? `Send this prompt to ${name}?` : `Send this peer message to ${name}?`
}

/** The keys of a bar that cannot send (a prompt or a peer message that the text check refuses, or a draft): c only. */
export const CANCEL_HINTS: readonly KeyHint[] = CONFIRM_HINTS.filter((hint) => hint.keys === 'c')

/** The lines that stay fixed (the target and the question), and the text that scrolls under them. */
function partsOf(intent: DeliverIntent, width: number, isSending: boolean, refusal: DeliverRefusal | undefined): { fixed: Line[]; text: Line[] } {
  const hints = refusal === undefined ? CONFIRM_HINTS : CANCEL_HINTS
  const keys: Segment[] = isSending ? [{ text: SENDING, dim: true }] : hints.flatMap((hint, index) => [...(index === 0 ? [] : [{ text: '  ' }]), pressSegment(hint.hotkey ?? hint.keys, hint.label)])
  const ask = appendItem(wrapSegments([{ text: askText(intent), ...ACCENT, bold: true }], width), keys, width)
  if (intent.kind === 'answer') return { fixed: [...ask, ...wrapSegments([{ text: `☐ ${flat(intent.header)}`, bold: true }, { text: `  ${flat(intent.question)}` }], width, 1, 3)], text: [] }
  if (intent.kind === 'permission') {
    if (intent.input === undefined) return { fixed: [...ask, ...wrapSegments([{ text: 'Input', bold: true }, { text: '  none' }], width)], text: [] }
    return { fixed: [...ask, ...wrapSegments([{ text: 'Input', bold: true }], width)], text: keptLines(intent.input, width, 3) }
  }
  const note = refusal !== undefined ? REFUSAL_TEXT[refusal] : intent.kind === 'prompt' ? PROMPT_MODE_TEXT[intent.text.trimStart().charAt(0)] : undefined
  return { fixed: [...ask, ...(note === undefined ? [] : wrapSegments([{ text: note, token: '--warn' }], width))], text: textLines(intent.text, width, 3) }
}

/** The confirm bar of 1 intent. */
export function confirmView(input: ConfirmInput): ConfirmView {
  const { intent } = input
  const refusal = intent.kind === 'prompt' ? textRefusal(intent.text) : intent.kind === 'peer' ? peerRefusal(intent.text) : undefined
  const { fixed, text } = partsOf(input.intent, input.width, input.isSending === true, refusal)
  const { lines, window } = windowOf(text, Math.max(MIN_WINDOW, input.rows - fixed.length), input.scroll)
  return { lines: [...fixed, ...lines], hints: refusal === undefined ? CONFIRM_HINTS : CANCEL_HINTS, window }
}

/** What became of an intent after y, as the lines that the pane shows. */
export function outcomeLines(outcome: DeliverOutcome, width: number): Line[] {
  const name = flat(outcome.intent.target.name)
  switch (outcome.status) {
    case 'refused':
      return wrapSegments([{ text: REFUSAL_TEXT[outcome.refusal], token: outcome.refusal === 'stale-screen' ? '--warn' : '--bad' }], width)
    case 'not-delivered':
      return wrapSegments([{ text: outcome.intent.kind === 'peer' ? PEER_NOT_DELIVERED : NOT_DELIVERED, token: '--warn' }], width)
    case 'failed':
      return wrapSegments([{ text: (Object.hasOwn(FAILURE_TEXT, outcome.reason) ? FAILURE_TEXT[outcome.reason] : undefined) ?? SEND_FAILED, token: outcome.reason === 'cancelled' ? '--warn' : '--bad' }], width)
    case 'sent':
      return wrapSegments([{ text: `Sent to ${name}. The next refresh checks it.` }], width)
    case 'delivered':
      return wrapSegments([{ text: `Delivered to ${name}.`, token: '--good' }], width)
  }
}
