/**
 * Reads 1 fresh screen of a Claude Code tab, as `cmux read-screen` gives it after the sanitize and the redaction,
 * and checks it against what the person confirmed. Every rule fails closed: a screen that the rules cannot read
 * gives a refusal, and the key path sends nothing.
 *
 * The layout that the rules read (Claude Code 2.1.295 on a Unicode terminal):
 * - a question dialog: a chip row `☐ <header>`, the question, then 1 row for each option: `❯ 1. <label>` on the
 *   row with the cursor, `  1. <label>` on the others, each with its description rows under it. Then
 *   `<n>. Type something.` and, below a rule, `<n+1>. Chat about this`. A dialog with more than 1 question, or one
 *   that takes more than 1 selection, shows the arrows and a Submit tab on its chip row, and a multi select writes
 *   `Type something` with no period.
 * - a permission dialog: a rule, the request (a shell command on its own rows), a question that ends with `?`,
 *   then the numbered options. Only an option whose label is exactly `Yes` or exactly `No` counts.
 * - the prompt: `❯` and a space (a no-break space in this build), then the typed text. The transcript shows the
 *   earlier prompts in the same form, so only the last prompt row counts.
 * The transcript can quote a dialog. So a match needs exactly 1 dialog, with no prompt row and no cursor row below
 * it. A label is compared as it is, with no Unicode normalization, so a lookalike letter never matches.
 */
import type { DeliverIntent, DeliverRefusal } from '../types.js'

/** 1 numbered row of a dialog. */
export type ScreenOption = {
  /** the digit that selects the row */
  digit: number
  /** the row text after `<digit>. `, with the spaces at its end removed */
  label: string
  /** the rows under the row that are indented past its digit, each trimmed, joined with 1 space */
  description?: string
  /** true when the row holds the cursor ❯ */
  hasCursor: boolean
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
  /** the question rows, joined with 1 space */
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

/** 1 row of the request of a permission dialog: its text with the spaces collapsed, and its indent. */
export type RequestRow = {
  text: string
  indent: number
}

/** A permission dialog: the rows of its request, its question and its numbered options. */
export type PermissionDialog = {
  kind: 'permission'
  /** the rows from the rule over the dialog to its question, blank rows left out; absent with no rule */
  request?: readonly RequestRow[]
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
  /** the text of the last prompt row after its mark, trimmed */
  promptText: string
  /** the index of the last row of a dialog or of a numbered row with the cursor, or -1 */
  lastDialogMark: number
}

/** A digit to send, or the reason to send nothing. */
export type ScreenMatch = { isMatch: true; digit: number } | { isMatch: false; refusal: DeliverRefusal }

type AnswerIntent = Extract<DeliverIntent, { kind: 'answer' }>
type PermissionIntent = Extract<DeliverIntent, { kind: 'permission' }>

const OPTION_ROW = /^([ \u00a0]*)(?:(❯)[ \u00a0]|[ \u00a0]{2})([1-9])\.[ \u00a0](.*)$/u
const PROMPT_ROW = /^[ \u00a0]*❯(?:[ \u00a0](.*))?$/u
const CHIP_ROW = /^[ \u00a0]*(?:←[ \u00a0]+)?[☐☒][ \u00a0]+\S/u
const RULE_ROW = /^[ \u00a0]*─{3,}/u
const TYPE_SOMETHING = /^Type something\.?$/
/** how far up from its question a permission dialog looks for its rule */
const REQUEST_ROWS = 40

/** The text with no space, tab or no-break space at its end: the padding of a terminal row. */
const trimEnd = (text: string): string => text.replace(/[ \t\u00a0]+$/, '')
/** The text on 1 row: each run of spaces and newlines becomes 1 space, with none at the ends. */
const collapse = (text: string): string => text.replace(/[ \t\u00a0\n]+/g, ' ').replace(/^ | $/g, '')
const isBlank = (row: string | undefined): boolean => row === undefined || row === ''
const indent = (row: string): number => row.length - row.replace(/^[ \u00a0]+/, '').length

/** The numbered row on line i, or undefined. */
function optionRow(rows: readonly string[], i: number): (ScreenOption & { column: number }) | undefined {
  const match = OPTION_ROW.exec(rows[i] ?? '')
  if (!match) return undefined
  return { digit: Number(match[3]), label: match[4] ?? '', hasCursor: match[2] === '❯', line: i, column: (match[1] ?? '').length + 2 }
}

/** The numbered rows 1, 2, 3 and on from line start, with their description rows. 1 blank row may part 2 rows. */
function readOptions(rows: readonly string[], start: number): { options: ScreenOption[]; end: number } {
  const options: ScreenOption[] = []
  let column = 0
  let end = start - 1
  for (let i = start; i < rows.length; i++) {
    const row = optionRow(rows, i)
    const last = options[options.length - 1]
    if (row && row.digit === options.length + 1) {
      const { column: rowColumn, ...option } = row
      options.push(option)
      column = rowColumn
      end = i
    } else if (!row && last && !isBlank(rows[i]) && indent(rows[i] ?? '') > column && !RULE_ROW.test(rows[i] ?? '')) {
      last.description = [last.description, (rows[i] ?? '').trim()].filter(Boolean).join(' ')
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
function questionAt(rows: readonly string[], c: number): QuestionDialog | undefined {
  const chipRow = rows[c] ?? ''
  const questionRows: string[] = []
  let i = skipBlank(rows, c + 1, 2)
  while (i >= 0 && i < rows.length && !isBlank(rows[i]) && !optionRow(rows, i) && !RULE_ROW.test(rows[i] ?? '')) questionRows.push(rows[i++] ?? '')
  const first = questionRows.length === 0 ? -1 : skipBlank(rows, i, 2)
  if (first < 0 || optionRow(rows, first)?.digit !== 1) return undefined
  const { options: numbered, end } = readOptions(rows, first)
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
  const header = /[☐☒][ \u00a0]+(.*?)(?=[ \u00a0]*(?:[☐☒✔→]|$))/u.exec(chipRow)?.[1] ?? ''
  return {
    kind: 'question',
    chips: (chipRow.match(/[☐☒]/gu) ?? []).length,
    hasTabs: /[←→]/u.test(chipRow) || /✔[ \u00a0]*Submit/u.test(chipRow),
    header: header.trim(),
    question: collapse(questionRows.join(' ')),
    options: other ? numbered.slice(0, -1) : numbered,
    ...(other ? { other } : {}),
    isMultiSelect: other !== undefined && !other.label.endsWith('.'),
    ...(chat ? { chat } : {}),
    firstLine: c,
    lastLine,
  }
}

/** The rows from the nearest rule over the question row q to q, or undefined when no rule is near. */
function requestRows(rows: readonly string[], q: number): RequestRow[] | undefined {
  for (let i = q - 1; i >= Math.max(0, q - REQUEST_ROWS); i--) {
    const row = rows[i] ?? ''
    if (RULE_ROW.test(row)) return rows.slice(i + 1, q + 1).filter((text) => !isBlank(text)).map((text) => ({ text: collapse(text), indent: indent(text) }))
    if (optionRow(rows, i) || PROMPT_ROW.test(row)) return undefined
  }
  return undefined
}

/** The permission dialog whose first numbered row is line i, or undefined. */
function permissionAt(rows: readonly string[], i: number): PermissionDialog | undefined {
  const q = isBlank(rows[i - 1]) ? i - 2 : i - 1
  const questionRow = trimEnd(rows[q] ?? '')
  if (q < 0 || !questionRow.endsWith('?') || optionRow(rows, q)) return undefined
  const { options, end } = readOptions(rows, i)
  if (options.length < 2 || !options.some((option) => option.hasCursor)) return undefined
  const request = requestRows(rows, q)
  return { kind: 'permission', ...(request ? { request } : {}), question: collapse(questionRow), options, firstLine: q, lastLine: end }
}

/** Reads 1 screen text: its dialogs, its last prompt row and the last row that marks a dialog. */
export function readScreen(text: string): ScreenView {
  const rows = text.split('\n').map(trimEnd)
  const dialogs: ScreenDialog[] = []
  let lastDialogMark = -1
  let promptLine = -1
  let promptText = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? ''
    const option = optionRow(rows, i)
    const claimed = dialogs.some((dialog) => i >= dialog.firstLine && i <= dialog.lastLine)
    const dialog = claimed ? undefined : CHIP_ROW.test(row) ? questionAt(rows, i) : option?.digit === 1 ? permissionAt(rows, i) : undefined
    if (dialog) {
      dialogs.push(dialog)
      lastDialogMark = Math.max(lastDialogMark, dialog.lastLine)
    }
    if (option?.hasCursor) lastDialogMark = Math.max(lastDialogMark, i)
    const prompt = option ? undefined : PROMPT_ROW.exec(row)
    if (prompt) {
      promptLine = i
      promptText = collapse(prompt[1] ?? '')
    }
  }
  return { dialogs, promptLine, promptText, lastDialogMark }
}

/**
 * The dialog at the bottom of the screen, when it is the only dialog and the last thing on the screen: no prompt
 * row and no other cursor row below it.
 */
function soleDialog(view: ScreenView): ScreenDialog | undefined {
  const dialog = view.dialogs[view.dialogs.length - 1]
  if (!dialog || view.dialogs.length !== 1) return undefined
  return view.promptLine > dialog.lastLine || view.lastDialogMark > dialog.lastLine ? undefined : dialog
}

const refuse = (refusal: DeliverRefusal): ScreenMatch => ({ isMatch: false, refusal })

/**
 * Checks a question answer: the screen shows 1 question dialog with 1 question and 1 selection, the same header,
 * the same question, the cursor on an option row, and the confirmed label at the confirmed digit.
 */
export function matchAnswer(view: ScreenView, want: Pick<AnswerIntent, 'header' | 'question' | 'option' | 'label'>): ScreenMatch {
  const dialog = soleDialog(view)
  if (dialog?.kind !== 'question') return refuse('screen-changed')
  if (dialog.chips !== 1 || dialog.hasTabs || dialog.isMultiSelect) return refuse('multi-question')
  if (dialog.header !== want.header.trim() || dialog.question !== collapse(want.question) || !dialog.other) return refuse('screen-changed')
  const cursors = [...dialog.options, dialog.other, ...(dialog.chat ? [dialog.chat] : [])].filter((row) => row.hasCursor)
  if (cursors.length !== 1 || !dialog.options.includes(cursors[0] as ScreenOption)) return refuse('screen-changed')
  const option = dialog.options.find((row) => row.digit === want.option)
  if (!option || option.label !== trimEnd(want.label)) return refuse('screen-changed')
  return { isMatch: true, digit: option.digit }
}

/** The shell command of a request, as its rows and its description, or undefined when the request has none. */
function commandOf(tool: string, input: string | undefined): { rows: string[]; description: string } | undefined {
  if (tool !== 'Bash' || input === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return undefined
  }
  const { command, description } = (parsed ?? {}) as { command?: unknown; description?: unknown }
  if (typeof command !== 'string') return undefined
  const rows = command.split('\n').map(collapse).filter((row) => row !== '')
  return rows.length > 0 ? { rows, description: typeof description === 'string' ? collapse(description) : '' } : undefined
}

/**
 * True when the request shows the command rows, in order and next to each other, as the whole command: the row
 * before them and the row after them are each less indented than the command, or are the command description.
 * So a command whose first or last rows are the confirmed command does not pass.
 */
function showsCommand(request: readonly RequestRow[], command: { rows: readonly string[]; description: string }): boolean {
  const ends = (row: RequestRow | undefined, depth: number): boolean => !row || row.indent < depth || (command.description !== '' && row.text === command.description)
  for (let i = 0; i + command.rows.length <= request.length; i++) {
    const depth = request[i]?.indent ?? 0
    if (command.rows.every((row, k) => request[i + k]?.text === row) && ends(request[i - 1], depth) && ends(request[i + command.rows.length], depth)) return true
  }
  return false
}

/**
 * Checks a permission answer: the screen shows 1 permission dialog for the same shell command, with the cursor
 * on 1 row, and exactly 1 option labeled exactly `Yes` (or `No`). The plan ties only a shell command to the screen,
 * so any other tool gives screen-changed.
 */
export function matchPermission(view: ScreenView, want: Pick<PermissionIntent, 'choice' | 'tool' | 'input'>): ScreenMatch {
  const dialog = soleDialog(view)
  if (dialog?.kind !== 'permission' || !dialog.request) return refuse('screen-changed')
  const command = commandOf(want.tool, want.input)
  if (!command || !showsCommand(dialog.request, command)) return refuse('screen-changed')
  if (dialog.options.filter((row) => row.hasCursor).length !== 1) return refuse('screen-changed')
  const label = want.choice === 'yes' ? 'Yes' : 'No'
  const hits = dialog.options.filter((row) => row.label === label)
  return hits.length === 1 && hits[0] ? { isMatch: true, digit: hits[0].digit } : refuse('label-not-found')
}

/** Checks a prompt: no dialog on the screen, and the last prompt row is empty, with no cursor row below it. */
export function matchPrompt(view: ScreenView): DeliverRefusal | undefined {
  if (view.dialogs.length > 0 || view.promptLine < 0 || view.lastDialogMark > view.promptLine || view.promptText !== '') return 'screen-changed'
  return undefined
}
