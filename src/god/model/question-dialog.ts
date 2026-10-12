/**
 * Reads 1 fresh screen of a dialog with 2 or more single-select questions, for 1 step of an answers intent, and checks
 * it against what the person confirmed. The plan sends 1 digit for each question and then `1` on the review screen, and
 * each step checks the screen again. Every rule fails closed: any other screen gives a refusal, and no key goes out.
 *
 * The layout that the rules read (Claude Code 2.1.296, live spike of 2026-10-12):
 * - each question: the chip row `←  ☒ Colour  ☐ Size  ✔ Submit  →`, with 1 chip for each question in dialog order,
 *   `☒` for a question with an answer and `☐` for the others, then the Submit tab. Under it the shown question, as the
 *   dialog of 1 question draws it (src/god/model/screen-match.ts): the question rows, each option with its description
 *   rows and the cursor on 1 of them, `Type something.`, a rule and `Chat about this`. A digit answers the shown question,
 *   and the dialog shows the next one.
 * - after the last question, the review screen: the same chip row with each chip `☒`, `Review your answers`, then for
 *   each question a row `● <question>` and a row `→ <label>`, then `Ready to submit your answers?`, then
 *   `❯ 1. Submit answers` and `2. Cancel`. `1` submits.
 * Blank rows between the parts do not count (at most 2 in a row). A question or a label that wraps reads as 1 text, each
 * row trimmed and joined with 1 space. Each other text compares as it is. The screen must hold exactly 1 chip row and
 * exactly 1 dialog, with no prompt row and no numbered row below it, so a dialog that the transcript quotes never
 * matches.
 */
import type { DeliverIntent, DeliverRefusal, Question } from '../types.js'
import { readScreen, showsOption, soleDialog, type ScreenMatch, type ScreenOption, type ScreenView } from './screen-match.js'

type AnswersIntent = Extract<DeliverIntent, { kind: 'answers' }>

/** What a step checks: the questions of the open question in the fresh transcript read, and the confirmed answers. */
export type StepWant = { questions: readonly Question[]; answers: AnswersIntent['answers'] }

/** The most options of a question that the pane answers: its Type something row must take 1 digit too. */
const MOST_OPTIONS = 8
/** The chip row: an arrow, the chips, the Submit tab and an arrow. */
const TABS_ROW = /^ *← +(.*?) +✔ Submit +→$/u
/** 1 chip of the chip row: its mark, the spaces after it, and its header. */
const CHIP = /^([☐☒]) +(\S.*)$/u
/** The rows of the review screen that are not a question or a label. */
const REVIEW_TITLE = 'Review your answers'
const REVIEW_READY = 'Ready to submit your answers?'
const SUBMIT_ROWS = [/^❯? *1\. Submit answers$/u, /^❯? *2\. Cancel$/u]
/** The most blank rows in a row between 2 parts of the dialog. */
const MOST_BLANKS = 2

const refuse = (refusal: DeliverRefusal): ScreenMatch => ({ isMatch: false, refusal })
const CHANGED = refuse('screen-changed')
const trimEnd = (text: string): string => text.replace(/ +$/, '')
const trim = (text: string): string => text.replace(/^ +| +$/g, '')

/** True when the pane answers the questions in steps: 2 or more, each single-select with 1 to 8 options. */
export function isSteppable(questions: readonly Question[]): boolean {
  return questions.length >= 2 && questions.every((question) => !question.multiSelect && question.options.length >= 1 && question.options.length <= MOST_OPTIONS)
}

/** The chips of a chip row, each with its mark and header, or undefined when the row is not a chip row of tabs. */
function chipsOf(row: string): { isAnswered: boolean; header: string }[] | undefined {
  const middle = TABS_ROW.exec(row)?.[1]
  if (middle === undefined) return undefined
  const chips = middle.split(/ +(?=[☐☒])/u).map((part) => CHIP.exec(part))
  return chips.every((chip) => chip !== null) ? chips.map((chip) => ({ isAnswered: chip[1] === '☒', header: chip[2] ?? '' })) : undefined
}

/** True when the row holds a chip of each confirmed question in order: the first `answered` with `☒`, the rest with `☐`. */
function showsChips(row: string | undefined, want: StepWant, answered: number): boolean {
  const chips = chipsOf(row ?? '')
  return chips !== undefined && chips.length === want.questions.length && chips.every((chip, k) => chip.header === want.questions[k]?.header && chip.isAnswered === k < answered)
}

/** The checks of a screen view at any step: exactly 1 chip row, and what the confirmed answers say of the open question. */
function isWanted(rows: readonly string[], want: StepWant): boolean {
  if (!isSteppable(want.questions) || want.answers.length !== want.questions.length) return false
  const sameAnswers = want.answers.every((answer, k) => {
    const question = want.questions[k]
    return question !== undefined && answer.header === question.header && answer.question === question.text && question.options[answer.option - 1]?.label === answer.label
  })
  return sameAnswers && rows.filter((row) => TABS_ROW.test(row)).length === 1
}

/** The step of question k: the dialog shows question k whole, under the chip row with the k questions before it answered. */
function matchQuestion(view: ScreenView, rows: readonly string[], want: StepWant, k: number): ScreenMatch {
  const dialog = soleDialog(view)
  const question = want.questions[k]
  const answer = want.answers[k]
  if (dialog?.kind !== 'question' || question === undefined || answer === undefined || dialog.isMultiSelect || dialog.other === undefined) return CHANGED
  if (!showsChips(rows[dialog.firstLine], want, k) || dialog.question !== question.text) return CHANGED
  const cursors = [...dialog.options, dialog.other, ...(dialog.chat ? [dialog.chat] : [])].filter((row) => row.hasCursor)
  if (cursors.length !== 1 || !dialog.options.includes(cursors[0] as ScreenOption)) return CHANGED
  if (dialog.options.length !== question.options.length || !dialog.options.every((row, at) => showsOption(row, question.options[at]))) return CHANGED
  const option = dialog.options.find((row) => row.digit === answer.option)
  return option !== undefined && option.label === answer.label ? { isMatch: true, digit: option.digit } : CHANGED
}

/** The rows from line `from` with the blank rows left out, each trimmed, with its line; undefined past MOST_BLANKS blank rows in a row. */
function partsFrom(rows: readonly string[], from: number): { text: string; line: number }[] | undefined {
  const parts: { text: string; line: number }[] = []
  let blanks = 0
  for (let line = from; line < rows.length; line++) {
    const text = trim(rows[line] ?? '')
    blanks = text === '' ? blanks + 1 : 0
    if (blanks > MOST_BLANKS) return parts.length === 0 ? undefined : parts
    if (text !== '') parts.push({ text, line })
  }
  return parts
}

/**
 * The step of the review screen: under the chip row with every chip answered, the title, then for each confirmed
 * question its `●` row (and the rows of its wrap) and its `→` row (and the rows of its wrap) with the confirmed label,
 * the ready row, and the 2 options Submit answers and Cancel with 1 cursor. No other row comes between them, and the
 * dialog that the screen reader finds lies inside them.
 */
function matchReview(view: ScreenView, rows: readonly string[], want: StepWant): ScreenMatch {
  const chipLine = rows.findIndex((row) => TABS_ROW.test(row))
  const parts = partsFrom(rows, chipLine + 1)
  if (chipLine < 0 || parts === undefined || !showsChips(rows[chipLine], want, want.questions.length) || parts[0]?.text !== REVIEW_TITLE) return CHANGED
  let at = 1
  /** The text of the rows from `at` until a row that starts a new part: 1 row, then the rows of its wrap. */
  const takeText = (mark: string): string | undefined => {
    const first = parts[at]?.text
    if (first === undefined || !first.startsWith(`${mark} `)) return undefined
    const texts = [first.slice(mark.length + 1)]
    for (at += 1; at < parts.length && !/^(?:●|→) /u.test(parts[at]?.text ?? '') && parts[at]?.text !== REVIEW_READY; at++) texts.push(parts[at]?.text ?? '')
    return texts.join(' ')
  }
  for (const answer of want.answers) {
    if (takeText('●') !== answer.question || takeText('→') !== answer.label) return CHANGED
  }
  const [ready, submit, cancel] = parts.slice(at, at + 3)
  if (ready?.text !== REVIEW_READY || submit === undefined || cancel === undefined || !SUBMIT_ROWS[0]!.test(submit.text) || !SUBMIT_ROWS[1]!.test(cancel.text)) return CHANGED
  if ([submit, cancel].filter((row) => row.text.startsWith('❯')).length !== 1) return CHANGED
  const isInside = view.dialogs.length <= 1 && view.dialogs.every((dialog) => dialog.firstLine >= chipLine && dialog.lastLine <= cancel.line)
  if (!isInside || view.promptLine > chipLine || view.lastMark > cancel.line) return CHANGED
  return { isMatch: true, digit: 1 }
}

/**
 * Checks the fresh screen of step `step` of an answers intent: step k from 0 shows question k, and the step after the
 * last question shows the review screen. Gives the digit of the confirmed option, or 1 on the review screen.
 */
export function matchAnswersStep(text: string, want: StepWant, step: number): ScreenMatch {
  const rows = text.split('\n').map(trimEnd)
  if (!Number.isInteger(step) || step < 0 || step > want.questions.length || !isWanted(rows, want)) return CHANGED
  const view = readScreen(text)
  return step < want.questions.length ? matchQuestion(view, rows, want, step) : matchReview(view, rows, want)
}
