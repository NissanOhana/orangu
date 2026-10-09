/**
 * The confirm bar and the outcome lines of the key path. Nothing goes out until the person presses y in the bar,
 * so the bar names the session and what goes to it, in the accent color, then the y and c keys:
 * - an answer: the option digit and label, then the header chip and the question;
 * - a permission: Yes or No, the tool, then its whole input (never cut: the person approves what it shows);
 * - a prompt or a peer message: the first line, then the count of the other lines and the key that opens the text
 *   again (r for a prompt, m for a peer message).
 * Each text wraps whole. Each refusal code has 1 line in the bad color, and the not-delivered line is in the warn
 * color. The engine shell puts the bar 1 row above the key row. No line is wider than `width`.
 */
import type { DeliverIntent, DeliverOutcome, DeliverRefusal } from '../types.js'
import { ACCENT, DIM } from '../ui/theme.js'
import { moreText } from './cut.js'
import type { KeyHint, Line, Segment } from './types.js'
import { LINE_BREAK, appendItem, flat, textLines, wrapSegments } from './wrap.js'

/** The keys of the bar: y sends, c cancels. */
export const CONFIRM_HINTS: readonly KeyHint[] = [
  { keys: 'y', label: 'send', hotkey: 'y', isOff: false },
  { keys: 'c', label: 'cancel', hotkey: 'c', isOff: false },
]

/** Why the key path sent nothing: 1 line for each refusal code. */
export const REFUSAL_TEXT: Readonly<Record<DeliverRefusal, string>> = {
  'no-cmux': 'cmux is not on this machine, so nothing was sent.',
  'no-tab': 'The session has no cmux tab, so nothing was sent.',
  'stale-screen': 'The screen read is older than 1 s, so nothing was sent.',
  'screen-changed': 'The screen changed, so nothing was sent.',
  'label-not-found': 'The screen shows no option with the exact label Yes or No, so nothing was sent.',
  'multi-question': 'The dialog has more than 1 question, so nothing was sent. Press j to answer it in its tab.',
  empty: 'The text is empty, so nothing was sent.',
  'control-char': 'The text has a control character, so nothing was sent.',
  'backslash-escape': 'The text has a backslash escape that cmux types as a key, so nothing was sent.',
}

/** The keys went out, but the next refresh did not see the answer or the prompt. */
export const NOT_DELIVERED = 'Not delivered. Check the Screen tab.'

/** The engine did not deliver a peer message. */
export const PEER_NOT_DELIVERED = 'The peer message did not arrive.'

/** A cmux command of the plan failed, so the steps after it did not run. */
export const SEND_FAILED = 'A cmux command failed, so the keys after it did not go out. Check the Screen tab.'

/** The key that opens the text of a prompt or a peer message again: it shows the lines that the bar counts. */
const TEXT_KEY = { prompt: 'r', peer: 'm' } as const

const LINE_UNIT = ['line', 'lines'] as const

/** The bar and its keys. */
export type ConfirmView = { lines: Line[]; hints: readonly KeyHint[] }

/** The question of the bar: what goes to which session. */
function askText(intent: DeliverIntent): string {
  const name = flat(intent.target.name)
  if (intent.kind === 'answer') return `Send "${intent.option} ${flat(intent.label)}" to ${name}?`
  if (intent.kind === 'permission') return `Send "${intent.choice === 'yes' ? 'Yes' : 'No'}" to the ${flat(intent.tool)} request of ${name}?`
  return intent.kind === 'prompt' ? `Send this prompt to ${name}?` : `Send this peer message to ${name}?`
}

/** The first line of a text that is not blank, and the count of the other lines. */
function firstLine(text: string): { first: string; more: number } {
  const lines = text.split(LINE_BREAK)
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  const first = lines.find((line) => line.trim() !== '') ?? ''
  return { first: flat(first), more: Math.max(0, lines.length - 1) }
}

/** What the bar shows under its question. */
function bodyOf(intent: DeliverIntent, width: number): Line[] {
  if (intent.kind === 'answer') return wrapSegments([{ text: `☐ ${flat(intent.header)}`, bold: true }, { text: `  ${flat(intent.question)}` }], width, 1, 3)
  if (intent.kind === 'permission') {
    if (intent.input === undefined) return wrapSegments([{ text: 'Input', bold: true }, { text: '  none' }], width)
    return [...wrapSegments([{ text: 'Input', bold: true }], width), ...textLines(intent.input, width, 3)]
  }
  const { first, more } = firstLine(intent.text)
  const lines = wrapSegments([{ text: first }], width)
  return more === 0 ? lines : appendItem(lines, [{ text: moreText(more, LINE_UNIT, TEXT_KEY[intent.kind]), ...DIM }], width)
}

/** The confirm bar of 1 intent. */
export function confirmView(intent: DeliverIntent, width: number): ConfirmView {
  const keys: Segment[] = CONFIRM_HINTS.flatMap((hint, index) => [...(index === 0 ? [] : [{ text: '  ' }]), { text: hint.keys, bold: true }, { text: ` ${hint.label}` }])
  const ask = appendItem(wrapSegments([{ text: askText(intent), ...ACCENT, bold: true }], width), keys, width)
  return { lines: [...ask, ...bodyOf(intent, width)], hints: CONFIRM_HINTS }
}

/** What became of an intent after y, as the lines that the pane shows. */
export function outcomeLines(outcome: DeliverOutcome, width: number): Line[] {
  const name = flat(outcome.intent.target.name)
  switch (outcome.status) {
    case 'refused':
      return wrapSegments([{ text: REFUSAL_TEXT[outcome.refusal], token: '--bad' }], width)
    case 'not-delivered':
      return wrapSegments([{ text: outcome.intent.kind === 'peer' ? PEER_NOT_DELIVERED : NOT_DELIVERED, token: '--warn' }], width)
    case 'failed':
      return wrapSegments([{ text: SEND_FAILED, token: '--bad' }], width)
    case 'sent':
      return wrapSegments([{ text: `Sent to ${name}. The next refresh checks it.` }], width)
    case 'delivered':
      return wrapSegments([{ text: `Delivered to ${name}.`, token: '--good' }], width)
  }
}
