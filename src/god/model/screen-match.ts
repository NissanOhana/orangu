/**
 * Reads 1 fresh screen of a Claude Code tab, as `cmux read-screen` gives it after the sanitize and the redaction,
 * and checks it against what the person confirmed. Every rule fails closed: a screen that the rules cannot read
 * the way Claude Code draws it gives a refusal, and the key path sends nothing.
 *
 * The layout that the rules read (Claude Code 2.1.295 on a Unicode terminal):
 * - a question dialog: a chip row `☐ <header>`, the question, then 1 row for each option: `❯ 1. <label>` on the
 *   row with the cursor, `  1. <label>` on the others, each with its description rows under it. Then
 *   `<n>. Type something.` and, below a rule, `<n+1>. Chat about this`. A dialog with more than 1 question, or one
 *   that takes more than 1 selection, shows the arrows and a Submit tab on its chip row, and a multi select writes
 *   `Type something` with no period.
 * - a shell permission dialog: a rule, the title `Bash command`, the description, the command rows, the question
 *   `Do you want to proceed?`, then the numbered options. Only an option labeled exactly `Yes` or `No` counts.
 * - the prompt: the input box, a rule row, `❯` and a space (a no-break space in this build) and the typed text,
 *   then a rule row. The transcript shows the earlier prompts in the same form, so only the last prompt row counts.
 * - between 2 steps of a prompt: the input box, from the last prompt row (a rule row right above it) down to the next
 *   rule row. The rows after the first are the next lines of the text, or a long line that the box wraps.
 * The transcript can quote a dialog. So a match needs exactly 1 dialog, with no prompt row and no numbered row
 * below it. An answer also needs every option row to show the open question of the transcript: the same count,
 * and for each option the same label and the same description on exactly 1 row, so a question that the model asks
 * again with a new description under the same label never matches. Each text compares as it is: only the padding spaces at the end of a row go, with no Unicode
 * normalization and no collapse of spaces, so a lookalike letter, a residue of an escape sequence or another
 * space never matches. A label that can go on in the row under it (a wrap) never matches.
 */
import type { DeliverIntent, DeliverRefusal, QuestionOption } from '../types.js'

/** 1 numbered row of a dialog. */
export type ScreenOption = {
  /** the digit that selects the row */
  digit: number
  /** the row text after `<digit>. `, with the padding spaces at its end removed */
  label: string
  /** the rows under the row that are indented past its digit, each trimmed, joined with 1 space */
  description?: string
  /** how many rows the description takes: more than 1 means it wraps, so it cannot be read whole */
  descriptionRows: number
  /** true when the row holds the cursor ❯ */
  hasCursor: boolean
  /**
   * true when the label cannot go on in the row under it: that row is blank, a rule or a numbered row, or its first
   * word would have fit on the label row. False on a screen with no rule to give the width.
   */
  isWhole: boolean
  /** the index of the row in the screen */
  line: number
}

/** A question dialog: the chip row, the question and the option rows. */
export type QuestionDialog = {
  kind: 'question'
  /** the number of question chips on the chip row */
  chips: number
  /** true when the chip row shows an arrow or the Submit tab */
  hasTabs: boolean
  /** the text after the first chip */
  header: string
  /** the question rows, each trimmed, joined with 1 space: a question that wraps reads as 1 text */
  question: string
  /** the numbered rows before the Type something row */
  options: readonly ScreenOption[]
  /** the last numbered row, when it is the Type something row */
  other?: ScreenOption
  /** true when the Type something row has no period: the question takes more than 1 selection */
  isMultiSelect: boolean
  /** the Chat about this row below the rule */
  chat?: ScreenOption
  firstLine: number
  lastLine: number
}

/** A permission dialog: the rows of its request, its question and its numbered options. */
export type PermissionDialog = {
  kind: 'permission'
  /** the rows between the rule over the dialog and its question, each trimmed, blank rows left out; absent with no rule */
  request?: readonly string[]
  /** the question row, trimmed */
  question: string
  options: readonly ScreenOption[]
  firstLine: number
  lastLine: number
}

export type ScreenDialog = QuestionDialog | PermissionDialog

/** What 1 screen shows. */
export type ScreenView = {
  /** the dialogs, top first: a dialog that the transcript quotes counts too */
  dialogs: readonly ScreenDialog[]
  /** the index of the last prompt row, or -1 */
  promptLine: number
  /** the text of the last prompt row after its mark and its space, with the padding spaces at its end removed */
  promptText: string
  /** true when a rule row is right above and right below the last prompt row: the row is in the input box */
  isPromptFramed: boolean
  /** the index of the last row of a dialog or of the last numbered row, with or without the cursor, or -1 */
  lastMark: number
}

/** A digit to send, or the reason to send nothing. */
export type ScreenMatch = { isMatch: true; digit: number } | { isMatch: false; refusal: DeliverRefusal }

type AnswerIntent = Extract<DeliverIntent, { kind: 'answer' }>
type PermissionIntent = Extract<DeliverIntent, { kind: 'permission' }>

const OPTION_ROW = /^( *)(?:(❯) | {2})([1-9])\. (.*)$/u
const PROMPT_ROW = /^ *❯(?:[ \u00a0](.*))?$/u
const CHIP_ROW = /^ *(?:← +)?[☐☒] +\S/u
const RULE_ROW = /^ *─{3,}/u
const FULL_RULE = /^ *─+$/u
const TYPE_SOMETHING = /^Type something\.?$/
const BASH_TITLE = /^Bash command(?: \([^()]*\))?$/
/** how far up from its question a permission dialog looks for its rule */
const REQUEST_ROWS = 40
/** the columns that a row may lose to the padding of its dialog, when the width rule asks if a word fits */
const WRAP_MARGIN = 6
/** code point ranges of 1 column, as the terminal layout counts them */
const NARROW: readonly (readonly [number, number])[] = [[0x20, 0x7e], [0xa0, 0x2ff], [0x370, 0x482], [0x48a, 0x52f], [0x5d0, 0x5ea], [0x2010, 0x2027], [0x2030, 0x205e], [0x2190, 0x21ff], [0x2500, 0x257f], [0x2610, 0x2612], [0x2714, 0x2714], [0x276f, 0x276f]]
/** code point ranges of 2 columns: the East Asian wide and full-width letters */
const WIDE: readonly (readonly [number, number])[] = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd]]

/** The text with no padding space at its end. A no-break space stays: it is not padding. */
const trimEnd = (text: string): string => text.replace(/ +$/, '')
/** The text with no space at either end. */
const trim = (text: string): string => text.replace(/^ +| +$/g, '')
const isBlank = (row: string | undefined): boolean => row === undefined || row === ''
const indent = (row: string): number => row.length - row.replace(/^ +/, '').length
const inRanges = (code: number, ranges: readonly (readonly [number, number])[]): boolean => ranges.some(([from, to]) => code >= from && code <= to)

/** The columns of a text, or undefined when it holds a character whose width the rules do not know. */
function columns(text: string): number | undefined {
  let total = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (inRanges(code, NARROW)) total += 1
    else if (inRanges(code, WIDE)) total += 2
    else return undefined
  }
  return total
}

/** The numbered row on line i, or undefined. */
function optionRow(rows: readonly string[], i: number): (ScreenOption & { column: number }) | undefined {
  const match = OPTION_ROW.exec(rows[i] ?? '')
  if (!match) return undefined
  return { digit: Number(match[3]), label: match[4] ?? '', descriptionRows: 0, hasCursor: match[2] === '❯', isWhole: false, line: i, column: (match[1] ?? '').length + 2 }
}

/** True when the row under the label row on line i cannot be the rest of its label, on a screen `width` columns wide. */
function isWholeAt(rows: readonly string[], i: number, width: number): boolean {
  const next = rows[i + 1]
  if (next === undefined) return false
  if (next === '' || RULE_ROW.test(next) || optionRow(rows, i + 1)) return true
  const label = columns(rows[i] ?? '')
  const word = columns(trim(next).split(' ')[0] ?? '')
  return width > 0 && label !== undefined && word !== undefined && label + 1 + word <= width - WRAP_MARGIN
}

/** The numbered rows 1, 2, 3 and on from line start, with their description rows. 1 blank row may part 2 rows. */
function readOptions(rows: readonly string[], start: number, width: number): { options: ScreenOption[]; end: number } {
  const options: ScreenOption[] = []
  let column = 0
  let end = start - 1
  for (let i = start; i < rows.length; i++) {
    const row = optionRow(rows, i)
    const last = options[options.length - 1]
    if (row && row.digit === options.length + 1) {
      const { column: rowColumn, ...option } = row
      options.push({ ...option, isWhole: isWholeAt(rows, i, width) })
      column = rowColumn
      end = i
    } else if (!row && last && !isBlank(rows[i]) && indent(rows[i] ?? '') > column && !RULE_ROW.test(rows[i] ?? '')) {
      last.description = [last.description, trim(rows[i] ?? '')].filter(Boolean).join(' ')
      last.descriptionRows += 1
      end = i
    } else if (isBlank(rows[i]) && last && optionRow(rows, i + 1)?.digit === options.length + 1) {
      continue
    } else break
  }
  return { options, end }
}

/** The index of the first row from i that is not blank, skipping at most `most` blank rows; -1 past that. */
function skipBlank(rows: readonly string[], i: number, most: number): number {
  let at = i
  while (at < rows.length && isBlank(rows[at]) && at - i < most) at++
  return isBlank(rows[at]) ? -1 : at
}

/** The question dialog whose chip row is line c, or undefined when the rows after it are not a dialog. */
function questionAt(rows: readonly string[], c: number, width: number): QuestionDialog | undefined {
  const chipRow = rows[c] ?? ''
  const questionRows: string[] = []
  let i = skipBlank(rows, c + 1, 2)
  while (i >= 0 && i < rows.length && !isBlank(rows[i]) && !optionRow(rows, i) && !RULE_ROW.test(rows[i] ?? '')) questionRows.push(trim(rows[i++] ?? ''))
  const first = questionRows.length === 0 ? -1 : skipBlank(rows, i, 2)
  if (first < 0 || optionRow(rows, first)?.digit !== 1) return undefined
  const { options: numbered, end } = readOptions(rows, first, width)
  const last = numbered[numbered.length - 1]
  const other = last && TYPE_SOMETHING.test(last.label) ? last : undefined
  let lastLine = end
  let chat: ScreenOption | undefined
  for (let j = end + 1; j < Math.min(rows.length, end + 4); j++) {
    if (isBlank(rows[j]) || RULE_ROW.test(rows[j] ?? '')) continue
    const row = optionRow(rows, j)
    if (row && row.digit === numbered.length + 1 && row.label === 'Chat about this') {
      const { column: _column, ...option } = row
      chat = option
      lastLine = j
    }
    break
  }
  return {
    kind: 'question',
    chips: (chipRow.match(/[☐☒]/gu) ?? []).length,
    hasTabs: /[←→]/u.test(chipRow) || /✔ *Submit/u.test(chipRow),
    header: /[☐☒] +(.*?)(?= *(?:[☐☒✔→]|$))/u.exec(chipRow)?.[1] ?? '',
    question: questionRows.join(' '),
    options: other ? numbered.slice(0, -1) : numbered,
    ...(other ? { other } : {}),
    isMultiSelect: other !== undefined && !other.label.endsWith('.'),
    ...(chat ? { chat } : {}),
    firstLine: c,
    lastLine,
  }
}

/** The rows between the nearest rule over the question row q and q, or undefined when no rule is near. */
function requestRows(rows: readonly string[], q: number): string[] | undefined {
  for (let i = q - 1; i >= Math.max(0, q - REQUEST_ROWS); i--) {
    const row = rows[i] ?? ''
    if (RULE_ROW.test(row)) return rows.slice(i + 1, q).map(trim).filter((text) => text !== '')
    if (optionRow(rows, i) || PROMPT_ROW.test(row)) return undefined
  }
  return undefined
}

/** The permission dialog whose first numbered row is line i, or undefined. */
function permissionAt(rows: readonly string[], i: number, width: number): PermissionDialog | undefined {
  const q = isBlank(rows[i - 1]) ? i - 2 : i - 1
  const question = trim(rows[q] ?? '')
  if (q < 0 || !question.endsWith('?') || optionRow(rows, q)) return undefined
  const { options, end } = readOptions(rows, i, width)
  if (options.length < 2 || !options.some((option) => option.hasCursor)) return undefined
  const request = requestRows(rows, q)
  return { kind: 'permission', ...(request ? { request } : {}), question, options, firstLine: q, lastLine: end }
}

/** Reads 1 screen text: its dialogs, its last prompt row and the last row that marks a dialog. */
export function readScreen(text: string): ScreenView {
  const rows = text.split('\n').map(trimEnd)
  const width = Math.max(0, ...rows.filter((row) => FULL_RULE.test(row)).map((row) => row.length))
  const dialogs: ScreenDialog[] = []
  let lastMark = -1
  let promptLine = -1
  let promptText = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? ''
    const option = optionRow(rows, i)
    const claimed = dialogs.some((dialog) => i >= dialog.firstLine && i <= dialog.lastLine)
    const dialog = claimed ? undefined : CHIP_ROW.test(row) ? questionAt(rows, i, width) : option?.digit === 1 ? permissionAt(rows, i, width) : undefined
    if (dialog) {
      dialogs.push(dialog)
      lastMark = Math.max(lastMark, dialog.lastLine)
    }
    if (option) lastMark = Math.max(lastMark, i)
    const prompt = option ? undefined : PROMPT_ROW.exec(row)
    if (prompt) {
      promptLine = i
      promptText = prompt[1] ?? ''
    }
  }
  const isPromptFramed = promptLine > 0 && RULE_ROW.test(rows[promptLine - 1] ?? '') && RULE_ROW.test(rows[promptLine + 1] ?? '')
  return { dialogs, promptLine, promptText, isPromptFramed, lastMark }
}

/**
 * The dialog at the bottom of the screen, when it is the only dialog and the last thing on the screen: no prompt
 * row and no numbered row below it.
 */
function soleDialog(view: ScreenView): ScreenDialog | undefined {
  const dialog = view.dialogs[view.dialogs.length - 1]
  if (!dialog || view.dialogs.length !== 1) return undefined
  return view.promptLine > dialog.lastLine || view.lastMark > dialog.lastLine ? undefined : dialog
}

const refuse = (refusal: DeliverRefusal): ScreenMatch => ({ isMatch: false, refusal })

/** True when the option row shows exactly this option: the same label, whole, and the same description on 1 row, or none. */
function showsOption(row: ScreenOption, expected: QuestionOption | undefined): boolean {
  if (!expected || row.label !== expected.label || !row.isWhole) return false
  return expected.description ? row.descriptionRows === 1 && row.description === expected.description : row.descriptionRows === 0
}

/**
 * Checks a question answer: the screen shows 1 question dialog with 1 question and 1 selection, the same header,
 * the same question, the cursor on an option row, the options of the open question (count, labels and
 * descriptions), and the confirmed label, whole, at the confirmed digit.
 */
export function matchAnswer(view: ScreenView, want: Pick<AnswerIntent, 'header' | 'question' | 'option' | 'label'> & { options: readonly QuestionOption[] }): ScreenMatch {
  const dialog = soleDialog(view)
  if (dialog?.kind !== 'question') return refuse('screen-changed')
  if (dialog.chips !== 1 || dialog.hasTabs || dialog.isMultiSelect) return refuse('multi-question')
  if (dialog.header !== want.header || dialog.question !== want.question || !dialog.other) return refuse('screen-changed')
  const cursors = [...dialog.options, dialog.other, ...(dialog.chat ? [dialog.chat] : [])].filter((row) => row.hasCursor)
  if (cursors.length !== 1 || !dialog.options.includes(cursors[0] as ScreenOption)) return refuse('screen-changed')
  if (dialog.options.length !== want.options.length || !dialog.options.every((row, k) => showsOption(row, want.options[k]))) return refuse('screen-changed')
  const option = dialog.options.find((row) => row.digit === want.option)
  if (!option || option.label !== want.label) return refuse('screen-changed')
  return { isMatch: true, digit: option.digit }
}

/** The rows that a shell permission dialog shows for a request: its description rows, then its command rows. */
function requestOf(tool: string, input: string | undefined): string[] | undefined {
  if (tool !== 'Bash' || input === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return undefined
  }
  const { command, description } = (parsed ?? {}) as { command?: unknown; description?: unknown }
  if (typeof command !== 'string') return undefined
  const rowsOf = (text: string): string[] => text.split('\n').map(trim).filter((row) => row !== '')
  const commandRows = rowsOf(command)
  return commandRows.length > 0 ? [...(typeof description === 'string' ? rowsOf(description) : []), ...commandRows] : undefined
}

/** True when the row is the auto mode tip that this build draws under the title. */
const isAutoModeTip = (row: string | undefined): boolean => row === 'Tip: auto mode handles these prompts for you \u2014 choose "switch to auto mode" below'

/**
 * True when the dialog is a shell permission dialog for exactly this request: the title, then (the tip), then the
 * description and command rows and no other row, then the question. So no row of another request, no reason row and
 * no wrapped or cut command row passes.
 */
function showsRequest(dialog: PermissionDialog, expected: readonly string[]): boolean {
  const [title, ...rest] = dialog.request ?? []
  if (dialog.question !== 'Do you want to proceed?' || title === undefined || !BASH_TITLE.test(title)) return false
  const body = isAutoModeTip(rest[0]) ? rest.slice(1) : rest
  return body.length === expected.length && body.every((row, k) => row === expected[k])
}

/**
 * Checks a permission answer: the screen shows 1 shell permission dialog for exactly the confirmed request, with
 * the cursor on 1 row, and exactly 1 option labeled exactly `Yes` (or `No`), whole. Any other tool gives
 * screen-changed: the plan ties only a shell command to the screen.
 */
export function matchPermission(view: ScreenView, want: Pick<PermissionIntent, 'choice' | 'tool' | 'input'>): ScreenMatch {
  const dialog = soleDialog(view)
  const expected = requestOf(want.tool, want.input)
  if (dialog?.kind !== 'permission' || !expected || !showsRequest(dialog, expected)) return refuse('screen-changed')
  if (dialog.options.filter((row) => row.hasCursor).length !== 1) return refuse('screen-changed')
  const label = want.choice === 'yes' ? 'Yes' : 'No'
  const hits = dialog.options.filter((row) => row.label === label)
  if (hits.length !== 1 || !hits[0]) return refuse('label-not-found')
  return hits[0].isWhole ? { isMatch: true, digit: hits[0].digit } : refuse('screen-changed')
}

/**
 * Checks a prompt: no dialog on the screen, and the last prompt row is empty, in the input box (a rule row right
 * above and right below it), with no numbered row below it.
 */
export function matchPrompt(view: ScreenView): DeliverRefusal | undefined {
  if (view.dialogs.length > 0 || view.promptLine < 0 || !view.isPromptFramed || view.lastMark > view.promptLine || view.promptText !== '') return 'screen-changed'
  return undefined
}

/** The text with no white space: the box can wrap a long line at a space and drop that space. */
const squeeze = (text: string): string => text.replace(/\s+/gu, '')

/**
 * The input box: the text of the last prompt row, then each row under it down to the next rule row, with the indent
 * of a next row (2 spaces) removed, and the index of that rule row. Undefined when no rule row is right above the
 * prompt row, or no rule row closes the box.
 */
function inputBox(rows: readonly string[], promptLine: number, promptText: string): { text: string; end: number } | undefined {
  if (promptLine < 1 || !RULE_ROW.test(rows[promptLine - 1] ?? '')) return undefined
  const next: string[] = []
  for (let i = promptLine + 1; i < rows.length; i++) {
    const row = rows[i] ?? ''
    if (RULE_ROW.test(row)) return { text: [promptText, ...next].join('\n'), end: i }
    next.push(row.replace(/^[ \u00a0]{1,2}/u, ''))
  }
  return undefined
}

/**
 * Checks the screen between 2 steps of a prompt: no dialog, no numbered row under the box, and an input box that
 * holds the text typed so far, the same characters in the same order. A numbered row inside the box is a line of the
 * text, so it must match like any other. White space does not count, because the box wraps a long line at a space
 * with no mark: a key that went to a dialog, a lost key, an extra key or ghost text changes the other characters, and
 * the dialog rule covers the rest.
 */
export function matchTyped(text: string, typed: string): DeliverRefusal | undefined {
  const view = readScreen(text)
  if (view.dialogs.length > 0 || view.promptLine < 0) return 'screen-changed'
  const box = inputBox(text.split('\n').map(trimEnd), view.promptLine, view.promptText)
  if (box === undefined || view.lastMark > box.end) return 'screen-changed'
  return squeeze(box.text) === squeeze(typed) ? undefined : 'screen-changed'
}
