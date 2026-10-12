/**
 * Synthetic screens of a dialog with 2 or more single-select questions, in the layout that Claude Code 2.1.296 drew in
 * the live spike of 2026-10-12: the chip row `←  ☐ Colour  ☐ Size  ✔ Submit  →`, the shown question with its options,
 * `Type something.` and `Chat about this`, and after the last question the review screen. The texts are synthetic.
 */
import type { Question } from '../../../src/god/types.js'

/** The rule over the dialog and over the Chat row, as wide as an 80-column tab. */
export const RULE = '─'.repeat(80)

/** The 2 questions of the base dialog, as the transcript gives them. */
export const COLOUR_SIZE: readonly Question[] = [
  {
    header: 'Colour',
    text: 'Which test colour?',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'Use red as the test colour.' },
      { label: 'Green', description: 'Use green as the test colour.' },
      { label: 'Blue', description: 'Use blue as the test colour.' },
    ],
  },
  { header: 'Size', text: 'Which test size?', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
]

/** The answers that the person picked on the base dialog: 2 Green, then 1 Small. */
export const GREEN_SMALL = [
  { header: 'Colour', question: 'Which test colour?', option: 2, label: 'Green' },
  { header: 'Size', question: 'Which test size?', option: 1, label: 'Small' },
]

/** The transcript line of an open AskUserQuestion call with these questions, written at `ms`. */
export const askLine = (id: string, questions: readonly Question[], ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ms).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: questions.map((question) => ({ question: question.text, header: question.header, multiSelect: question.multiSelect, options: question.options })) } }],
    },
  })

/** The chip row: 1 chip for each header, `☒` for the first `answered`, `☐` for the rest. */
export const tabsRow = (headers: readonly string[], answered: number): string =>
  `←  ${headers.map((header, index) => `${index < answered ? '☒' : '☐'} ${header}`).join('  ')}  ✔ Submit  →`

/** The rows above a dialog: the prompt of the turn, a blank row and the rule over the dialog. */
const ABOVE = ['❯ Pick the test colour and size.', '', RULE]
/** The last row of the dialog. */
export const FOOTER = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'

/** The screen that shows question `step` (from 0), with the cursor on option `cursor`. `gap` puts that many blank rows between the parts. */
export function questionScreen(questions: readonly Question[], step: number, options: { cursor?: number; gap?: number } = {}): string {
  const question = questions[step]!
  const blank = Array.from({ length: options.gap ?? 0 }, () => '')
  const cursor = options.cursor ?? 1
  const rows = question.options.flatMap((option, index) => [`${index + 1 === cursor ? '❯' : ' '} ${index + 1}. ${option.label}`, ...(option.description === undefined ? [] : [`     ${option.description}`])])
  const count = question.options.length
  return [...ABOVE, tabsRow(questions.map((one) => one.header), step), ...blank, question.text, ...blank, ...rows, `  ${count + 1}. Type something.`, RULE, `  ${count + 2}. Chat about this`, '', FOOTER].join('\n')
}

/** The review screen after the last question: each question with the label that the person picked, then Submit and Cancel. */
export function reviewScreen(questions: readonly Question[], labels: readonly string[], options: { gap?: number } = {}): string {
  const blank = Array.from({ length: options.gap ?? 0 }, () => '')
  const items = questions.flatMap((question, index) => [` ● ${question.text}`, `   → ${labels[index] ?? ''}`, ...blank])
  const headers = questions.map((one) => one.header)
  return [...ABOVE, tabsRow(headers, headers.length), 'Review your answers', ...blank, ...items, 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel', '', FOOTER].join('\n')
}

/** The screen with 1 row changed: the first row that equals `from` becomes `to` (or goes, when `to` is undefined). */
export function changeRow(text: string, from: string, to: string | undefined): string {
  const rows = text.split('\n')
  const at = rows.indexOf(from)
  if (at < 0) throw new Error(`the screen has no row ${JSON.stringify(from)}`)
  return [...rows.slice(0, at), ...(to === undefined ? [] : [to]), ...rows.slice(at + 1)].join('\n')
}
