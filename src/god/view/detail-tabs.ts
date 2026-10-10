/**
 * The content of each tab of the detail, as lines of the detail width. Each text shows whole: it wraps, and
 * src/god/view/detail.ts cuts only by rows, with a count line that names its key.
 * - Now: the open question (the header chip, the question, each option as `<n>: <label>`), or the open permission
 *   request and its whole input with its spaces as written, or the current tool call and the API error at the end; then the last reply.
 *   Each option that a digit answers is 1 Button whose hotkey is its digit, and the engine paints that digit as
 *   `1: ` before the label. A Bash request also gets `1: Yes` and `2: No`, the 2 answers that the pane can send to
 *   it; a request of any other tool gets 1 line that says to answer it in its tab. With no cmux, or while a draft of
 *   r or m is open (a digit then types into the draft), the digits draw dim and no Button has a hotkey.
 * - History: the last turns, the newest first, each as your prompt and then the reply.
 * - Agents: the running subagents and background tasks first, then the ended ones, then the subagent files that
 *   no task of the read part names.
 * - Screen: the last read of the cmux tab, with its spaces, under the line of a refusal, and under the line that says
 *   that the newest read failed. While the tab map can be old (the last cmux read failed), the no-tab line only, and
 *   with no cmux the no-cmux line only, each under the line of a refusal.
 * - Recap: the x key, which makes the Recap of this session, then the hint, or the model text under its label and its
 *   token count, or the reason that the Recap has no text. The x key is 1 segment that a hotkey Button presses, and it
 *   shows only while no Recap runs, so 1 model call runs at a time. While a Recap of this session runs, the tab says
 *   so, and while a Recap of another session runs, it says that. A Recap that runs for RECAP_STALE_MS or more is a
 *   call that a reload of the code cut (the call itself stops at its time limit first), so the x key shows again.
 * The session texts are sanitized and redacted before they come here. Outside text that the detail shows on 1 line
 * is flattened, so no line break gets into a line. The clock comes in as `now`.
 */
import { NO_REPLY, NO_TRANSCRIPT, WAITS } from '../model/summary.js'
import type { AgentTask, DeliverOutcome, DetailTab, GodSession, Question, RecapFailure, RecapState, ScreenRead } from '../types.js'
import { DIM } from '../ui/theme.js'
import { levelTime } from './board.js'
import { cellWidth } from './cells.js'
import { MULTI_DIALOG, MULTI_DIALOG_NO_CMUX, outcomeLines } from './confirm.js'
import { pressSegment } from './keys.js'
import type { Line, Segment } from './types.js'
import { flat, keptLines, screenLines, textLines, wrapSegments } from './wrap.js'

export const NO_HISTORY = 'The part of the transcript that the pane read has no turn.'
export const NO_AGENTS = 'This session has no subagent and no background task.'
export const SCREEN_NO_CMUX = 'cmux is not on this machine, so the pane cannot show the screen.'
export const SCREEN_NO_TAB = 'This session has no cmux tab, so the pane cannot show its screen.'
export const SCREEN_READING = 'Reading the screen.'
export const SCREEN_FAILED = 'cmux did not read the screen. The pane tries again in 1 s.'
export const RECAP_HINT = 'The Recap is model text, and it uses tokens.'
export const RECAP_RUNNING = 'The model writes the Recap.'
export const RECAP_BUSY = 'The model writes a Recap of another session now. Wait for it to end.'
/** What the x key does, as the engine paints its Button: `x: make a Recap`. */
export const RECAP_KEY_LABEL = 'make a Recap'
/** The key that makes a Recap. */
export const RECAP_KEY = 'x'
/** A Recap that runs this long is a cut call: longer than the time limit of the call (src/god/act/recap.ts, a test holds the order). */
export const RECAP_STALE_MS = 2 * 60_000
/** The label above a Recap: the only model text of the pane. */
export const MODEL_TEXT = 'model text'
export const RECAP_FAILURE: Readonly<Record<RecapFailure, string>> = {
  'api-error': 'The model call failed. Press x to try again.',
  'empty-reply': 'The model gave no text. Press x to try again.',
  aborted: 'The Recap stopped before its end. Press x to try again.',
  refused: 'Claude Code refused the model call. Press x to try again.',
}

/** The line of a request of a tool that the pane does not answer. */
export const PERMISSION_JUMP = 'The pane answers only a Bash request with Yes or No. Press j to answer this request in its tab.'
export const PERMISSION_JUMP_NO_CMUX = 'The pane answers only a Bash request with Yes or No. Answer this request in its tab.'

/** The 2 answers of a Bash request in the pane: the choice, its label and the digit that the pane gives it. */
export const PERMISSION_ANSWERS = [
  { choice: 'yes', label: 'Yes', digit: 1 },
  { choice: 'no', label: 'No', digit: 2 },
] as const

/** The only tool whose request the pane answers: its dialog shows the exact command that the screen check reads. */
export const ANSWERED_TOOL = 'Bash'

/**
 * A line that a digit answers: its line key, its digit, true when the digits are off (no cmux), and for the Yes or
 * No of a Bash request, the choice.
 */
export type OptionKey = { key: string; digit: number; isOff: boolean; choice?: 'yes' | 'no' }

/** The lines of 1 tab, and the option keys among them. */
export type TabContent = { lines: Line[]; options: OptionKey[] }

/** What a tab reads. */
export type TabInput = {
  session: GodSession
  width: number
  now: number
  isCmuxMissing: boolean
  /** true while a draft of r or m is open: the digits draw dim with no hotkey, so a digit arms no y */
  isDraftOpen?: boolean
  /** the last read of a screen: the Screen tab shows it when it is a read of this session */
  screen?: ScreenRead
  /** true when the newest screen read of this session failed: the Screen tab says so over the last read */
  isScreenFailed?: boolean
  /** true when the last cmux read failed or did not end: the tab map can be old, so the Screen tab reads nothing */
  isTabMapOld?: boolean
  /** the last Recap: the Recap tab shows it when it is a Recap of this session */
  recap?: RecapState
  /** the last outcome of the key path: the Screen tab shows a refusal of this session above its screen */
  outcome?: DeliverOutcome
}

/** The text under a label starts at this column. */
const TEXT_INDENT = 3

/** True when the digits draw dim with no hotkey: no cmux, or a draft is open. */
const areDigitsOff = (input: TabInput): boolean => input.isCmuxMissing || input.isDraftOpen === true

/** The key of the line of option n. */
export const optionKey = (digit: number): string => `option:${digit}`

/** The key of the line of the Yes or the No of a Bash request. */
export const permissionKey = (choice: 'yes' | 'no'): string => `permission:${choice}`

/** `now`, or the time since `at` as `12m ago`; '' with no time. */
export function ago(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const time = levelTime(at, now)
  return time === 'now' ? time : `${time} ago`
}

/** A wait as `40s`, `5m`, `6h 41m` or `2d 3h`. */
export function waitText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** The wait of a session that needs you, after a header chip: ` · waits 6h 41m`. */
const waitChip = ({ session, now }: TabInput): Segment[] => (session.level === 'needs-you' ? [{ text: ` · waits ${waitText(now - session.levelSince)}`, ...DIM }] : [])

/** A sentence of the pane on its own lines. */
const message = (text: string, width: number, style: Omit<Segment, 'text'> = {}): Line[] => wrapSegments([{ ...style, text }], width)

/** A bold label, then a text, then a dim time. */
function labelLine(width: number, label: Segment, text = '', time = ''): Line[] {
  return wrapSegments([{ bold: true, ...label }, ...(text === '' ? [] : [{ text: `  ${text}` }]), ...(time === '' ? [] : [{ text: `  ${time}`, ...DIM }])], width, 1, TEXT_INDENT)
}

/** The segments with their first `count` cells gone: the cells of an indent that the painted hotkey takes. */
function dropLead(segments: readonly Segment[], count: number): Segment[] {
  const [head, ...tail] = segments
  if (head === undefined || count <= 0) return [...segments]
  if (head.text.length > count) return [{ ...head, text: head.text.slice(count) }, ...tail]
  return dropLead(tail, count - head.text.length)
}

/**
 * The lines of a choice that a digit presses: 1 space, then the hotkey as the engine paints it (`1: `), then the
 * text, which wraps after the hang. Only the first line is the Button.
 */
function keyedLines(key: string, digit: number, segments: readonly Segment[], width: number): Line[] {
  const painted = `${digit}: `
  const lead = 1 + cellWidth(painted)
  const [first, ...rest] = wrapSegments(segments, width, lead, TEXT_INDENT)
  return [{ key, hotkey: String(digit), segments: [{ text: ' ' }, { text: painted, isPainted: true }, ...dropLead(first?.segments ?? [], lead)] }, ...rest]
}

function questionLines(input: TabInput, question: Question, index: number, hasDigits: boolean): TabContent {
  const { width } = input
  const lines = [...wrapSegments([{ text: `☐ ${flat(question.header)}`, bold: true }, ...(index === 0 ? waitChip(input) : [])], width), ...textLines(question.text, width, 1)]
  const options: OptionKey[] = []
  question.options.forEach((option, at) => {
    const digit = at + 1
    const keyed = hasDigits && digit <= 9
    const about = option.description === undefined || flat(option.description) === '' ? [] : [{ text: `  ${flat(option.description)}`, ...DIM }]
    if (keyed && !areDigitsOff(input)) {
      lines.push(...keyedLines(optionKey(digit), digit, [{ text: flat(option.label) }, ...about], width))
      options.push({ key: optionKey(digit), digit, isOff: false })
      return
    }
    const mark: Segment = { text: hasDigits ? String(digit) : '•', ...DIM }
    const [first, ...rest] = wrapSegments([mark, { text: ` ${flat(option.label)}` }, ...about], width, 1, TEXT_INDENT)
    if (!keyed) {
      lines.push(first!, ...rest)
      return
    }
    lines.push({ ...first!, key: optionKey(digit) }, ...rest)
    options.push({ key: optionKey(digit), digit, isOff: true })
  })
  return { lines, options }
}

/** The answers of an open request: Yes and No of a Bash request, else the line that says to answer it in its tab. */
function permissionAnswers(input: TabInput, tool: string): TabContent {
  const { width } = input
  if (tool !== ANSWERED_TOOL) return { lines: message(input.isCmuxMissing ? PERMISSION_JUMP_NO_CMUX : PERMISSION_JUMP, width), options: [] }
  const lines: Line[] = []
  const options: OptionKey[] = []
  for (const { choice, label, digit } of PERMISSION_ANSWERS) {
    const key = permissionKey(choice)
    const isOff = areDigitsOff(input)
    if (isOff) lines.push({ key, segments: [{ text: ' ' }, { text: String(digit), ...DIM }, { text: ` ${label}` }] })
    else lines.push(...keyedLines(key, digit, [{ text: label }], width))
    options.push({ key, digit, isOff, choice })
  }
  return { lines, options }
}

/** The open question: each question with its options, and the line of a dialog that the digits cannot answer. */
function openQuestionLines(input: TabInput): TabContent {
  const questions = input.session.transcript?.openQuestion?.questions ?? []
  const isMulti = questions.length > 1
  const isMultiSelect = questions.some((question) => question.multiSelect)
  const parts = questions.map((question, index) => questionLines(input, question, index, !isMulti && !isMultiSelect))
  const lines = parts.flatMap((part) => part.lines)
  if (isMulti || isMultiSelect) lines.push(...message(input.isCmuxMissing ? MULTI_DIALOG_NO_CMUX : MULTI_DIALOG, input.width))
  return { lines, options: parts.flatMap((part) => part.options) }
}

/** The Now tab. */
function nowContent(input: TabInput): TabContent {
  const { session, width, now } = input
  const transcript = session.transcript
  if (transcript === undefined) return { lines: message(NO_TRANSCRIPT, width), options: [] }
  const activity = transcript.activity
  let top: TabContent = { lines: [], options: [] }
  if (transcript.openQuestion !== undefined && transcript.openQuestion.questions.length > 0) top = openQuestionLines(input)
  else if (session.level === 'needs-you' && session.waitingFor === 'permission prompt' && activity?.isOpen === true) {
    const request = [...wrapSegments([{ text: '☐ Permission', bold: true }, ...waitChip(input)], width), ...wrapSegments([{ text: flat(activity.text) }], width)]
    const toolInput = activity.input === undefined ? labelLine(width, { text: 'Input' }, 'none') : [...labelLine(width, { text: 'Input' }), ...keptLines(activity.input, width, TEXT_INDENT)]
    const answers = permissionAnswers(input, activity.tool)
    top = { lines: [...request, ...toolInput, ...answers.lines], options: answers.options }
  } else {
    if (activity !== undefined) top.lines.push(...labelLine(width, { text: activity.isOpen ? 'Runs' : 'Last tool' }, flat(activity.text), ago(activity.at, now)))
    const error = transcript.errorTail
    if (error !== undefined) top.lines.push(...labelLine(width, { text: error.kind === 'api-error' ? 'API error' : 'API retry', token: '--warn' }, flat(error.text)))
    if (session.level === 'needs-you') top.lines.push(...(session.waitingFor === undefined ? message(WAITS, width) : labelLine(width, { text: 'Waits for' }, flat(session.waitingFor))))
  }
  const reply = [...labelLine(width, { text: 'Last reply' }), ...textLines(transcript.lastReply ?? NO_REPLY, width, TEXT_INDENT)]
  return { lines: [...top.lines, ...reply], options: top.options }
}

/** The History tab. */
function historyLines({ session, width, now }: TabInput): Line[] {
  const history = session.transcript?.history ?? []
  if (history.length === 0) return message(NO_HISTORY, width)
  return [...history].reverse().flatMap((turn) => [
    ...(turn.prompt === undefined ? [] : [...labelLine(width, { text: 'You' }, '', ago(turn.promptAt, now)), ...textLines(turn.prompt, width, TEXT_INDENT)]),
    ...labelLine(width, { text: 'Reply' }, '', ago(turn.replyAt, now)),
    ...textLines(turn.reply ?? NO_REPLY, width, TEXT_INDENT),
  ])
}

/** 1 row of the Agents tab: runs, ended, or a subagent file that no task of the read part names. */
export type AgentRow = { status: 'runs' | 'ended' | 'older'; text: string; type?: string; at?: number }

const newestFirst = (a: AgentRow, b: AgentRow): number => (b.at ?? 0) - (a.at ?? 0)

/** The rows of the Agents tab, in their order. */
export function agentRows(session: GodSession): AgentRow[] {
  const tasks = session.transcript?.agents ?? []
  const typeOf = (task: AgentTask): string | undefined => task.agentType ?? session.subagents.find((file) => file.toolUseId === task.toolUseId)?.agentType
  const row = (task: AgentTask): AgentRow => {
    const type = typeOf(task)
    const at = task.isRunning ? task.startedAt : (task.endedAt ?? task.startedAt)
    return { status: task.isRunning ? 'runs' : 'ended', text: task.text, ...(type === undefined ? {} : { type }), ...(at === undefined ? {} : { at }) }
  }
  const named = new Set(tasks.map((task) => task.toolUseId))
  const older = session.subagents
    .filter((file) => file.toolUseId === undefined || !named.has(file.toolUseId))
    .map((file): AgentRow => ({ status: 'older', text: file.description ?? file.agentId, ...(file.agentType === undefined ? {} : { type: file.agentType }), at: file.mtimeMs }))
  return [...tasks.filter((task) => task.isRunning).map(row).sort(newestFirst), ...tasks.filter((task) => !task.isRunning).map(row).sort(newestFirst), ...older.sort(newestFirst)]
}

/** The Agents tab. */
function agentLines({ session, width, now }: TabInput): Line[] {
  const rows = agentRows(session)
  if (rows.length === 0) return message(NO_AGENTS, width)
  return rows.flatMap((row) => {
    const status: Segment = { text: row.status, ...(row.status === 'runs' ? { bold: true } : DIM) }
    const parts: Segment[] = [status, { text: ' '.repeat(7 - row.status.length) }, { text: flat(row.text) }]
    if (row.type !== undefined && flat(row.type) !== '') parts.push({ text: `  ${flat(row.type)}` })
    const time = ago(row.at, now)
    if (time !== '') parts.push({ text: `  ${time}`, ...DIM })
    return wrapSegments(parts, width, 1, 8)
  })
}

/** The Screen tab: why it has no screen, or the newest read of this session under the line of a refusal. */
function screenTabLines({ session, width, isCmuxMissing, screen, isScreenFailed, isTabMapOld, outcome }: TabInput): Line[] {
  const own = outcome !== undefined && outcome.intent.target.sessionId === session.sessionId ? outcome : undefined
  const notice = own !== undefined && (own.status === 'refused' || own.status === 'not-delivered' || own.status === 'failed') ? outcomeLines(own, width) : []
  if (isCmuxMissing) return [...notice, ...message(SCREEN_NO_CMUX, width)]
  if (session.tab === undefined || isTabMapOld === true) return [...notice, ...message(SCREEN_NO_TAB, width)]
  const fresh = own !== undefined && 'screen' in own ? own.screen : undefined
  const reads = [screen, fresh].filter((read): read is ScreenRead => read !== undefined && read.sessionId === session.sessionId)
  const newest = reads.sort((a, b) => b.readAt - a.readAt)[0]
  const failed = isScreenFailed === true ? message(SCREEN_FAILED, width, { token: '--warn' }) : []
  const shown = newest === undefined ? (isScreenFailed === true ? [] : message(SCREEN_READING, width)) : screenLines(newest.text, width)
  return [...notice, ...failed, ...shown]
}

/** A token count with a comma between each group of 3 digits. */
const tokenCount = (tokens: number): string => `${String(Math.max(0, Math.round(tokens))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} tokens`

/** The line of the x key: 1 space, then the key as the engine paints its Button. */
const recapKeyLine = (): Line => ({ segments: [{ text: ' ' }, pressSegment(RECAP_KEY, RECAP_KEY_LABEL)] })

/** The Recap tab. */
function recapLines({ session, width, recap, now }: TabInput): Line[] {
  if (recap?.status === 'running' && now - recap.startedAt < RECAP_STALE_MS) return message(recap.sessionId === session.sessionId ? RECAP_RUNNING : RECAP_BUSY, width)
  if (recap === undefined || recap.status === 'running' || recap.sessionId !== session.sessionId) return [recapKeyLine(), ...message(RECAP_HINT, width)]
  const count = message(tokenCount(recap.tokens), width, DIM)
  if (recap.status === 'failed') return [recapKeyLine(), ...message(RECAP_FAILURE[recap.reason], width, { token: '--warn' }), ...count]
  return [recapKeyLine(), ...message(MODEL_TEXT, width, DIM), ...textLines(recap.text, width, TEXT_INDENT), ...count]
}

/** The content of the open tab. */
export function tabContent(tab: DetailTab, input: TabInput): TabContent {
  if (tab === 'now') return nowContent(input)
  const lines = tab === 'history' ? historyLines(input) : tab === 'agents' ? agentLines(input) : tab === 'screen' ? screenTabLines(input) : recapLines(input)
  return { lines, options: [] }
}
