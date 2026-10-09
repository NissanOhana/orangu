/**
 * The content of each tab of the detail, as lines of the detail width. Each text shows whole: it wraps, and
 * src/god/view/detail.ts cuts only by rows, with a count line that names its key.
 * - Now: the open question (the header chip, the question, each option as `<n> <label>`), or the open permission
 *   request and its whole input with its spaces as written, or the current tool call and the API error at the end; then the last reply.
 * - History: the last turns, the newest first, each as your prompt and then the reply.
 * - Agents: the running subagents and background tasks first, then the ended ones, then the subagent files that
 *   no task of the read part names.
 * - Screen: the last read of the cmux tab, with its spaces, under the line of a refusal.
 * - Recap: the hint, or the model text under its label and its token count.
 * The session texts are sanitized and redacted before they come here. Outside text that the detail shows on 1 line
 * is flattened, so no line break gets into a line. The clock comes in as `now`.
 */
import { NO_REPLY, NO_TRANSCRIPT, WAITS } from '../model/summary.js'
import type { AgentTask, DeliverOutcome, DetailTab, GodSession, Question, RecapFailure, RecapState, ScreenRead } from '../types.js'
import { DIM } from '../ui/theme.js'
import { levelTime } from './board.js'
import { MULTI_DIALOG, MULTI_DIALOG_NO_CMUX, outcomeLines } from './confirm.js'
import type { Line, Segment } from './types.js'
import { flat, keptLines, screenLines, textLines, wrapSegments } from './wrap.js'

export const NO_HISTORY = 'The part of the transcript that the pane read has no turn.'
export const NO_AGENTS = 'This session has no subagent and no background task.'
export const SCREEN_NO_CMUX = 'cmux is not on this machine, so the pane cannot show the screen.'
export const SCREEN_NO_TAB = 'This session has no cmux tab, so the pane cannot show its screen.'
export const SCREEN_READING = 'Reading the screen.'
export const RECAP_HINT = 'Press x to make a Recap. The Recap is model text, and it uses tokens.'
export const RECAP_RUNNING = 'The model writes the Recap.'
/** The label above a Recap: the only model text of the pane. */
export const MODEL_TEXT = 'model text'
export const RECAP_FAILURE: Readonly<Record<RecapFailure, string>> = {
  'api-error': 'The model call failed. Press x to try again.',
  'empty-reply': 'The model gave no text. Press x to try again.',
  aborted: 'The Recap stopped before its end. Press x to try again.',
  refused: 'Claude Code refused the model call. Press x to try again.',
}

/** An option line that a digit answers: its line key, its digit, and true when the digits are off (no cmux). */
export type OptionKey = { key: string; digit: number; isOff: boolean }

/** The lines of 1 tab, and the option keys among them. */
export type TabContent = { lines: Line[]; options: OptionKey[] }

/** What a tab reads. */
export type TabInput = {
  session: GodSession
  width: number
  now: number
  isCmuxMissing: boolean
  /** the last read of a screen: the Screen tab shows it when it is a read of this session */
  screen?: ScreenRead
  /** the last Recap: the Recap tab shows it when it is a Recap of this session */
  recap?: RecapState
  /** the last outcome of the key path: the Screen tab shows a refusal of this session above its screen */
  outcome?: DeliverOutcome
}

/** The text under a label starts at this column. */
const TEXT_INDENT = 3

/** The key of the line of option n. */
export const optionKey = (digit: number): string => `option:${digit}`

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

function questionLines(input: TabInput, question: Question, index: number, hasDigits: boolean): TabContent {
  const { width } = input
  const lines = [...wrapSegments([{ text: `☐ ${flat(question.header)}`, bold: true }, ...(index === 0 ? waitChip(input) : [])], width), ...textLines(question.text, width, 1)]
  const options: OptionKey[] = []
  question.options.forEach((option, at) => {
    const digit = at + 1
    const keyed = hasDigits && digit <= 9
    const mark: Segment = keyed ? { text: String(digit), ...(input.isCmuxMissing ? DIM : { bold: true }) } : { text: hasDigits ? String(digit) : '•', ...DIM }
    const about = option.description === undefined || flat(option.description) === '' ? [] : [{ text: `  ${flat(option.description)}`, ...DIM }]
    const [first, ...rest] = wrapSegments([mark, { text: ` ${flat(option.label)}` }, ...about], width, 1, TEXT_INDENT)
    if (!keyed) {
      lines.push(first!, ...rest)
      return
    }
    lines.push({ ...first!, key: optionKey(digit) }, ...rest)
    options.push({ key: optionKey(digit), digit, isOff: input.isCmuxMissing })
  })
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
    top = { lines: [...request, ...toolInput], options: [] }
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
function screenTabLines({ session, width, isCmuxMissing, screen, outcome }: TabInput): Line[] {
  if (isCmuxMissing) return message(SCREEN_NO_CMUX, width)
  if (session.tab === undefined) return message(SCREEN_NO_TAB, width)
  const own = outcome !== undefined && outcome.intent.target.sessionId === session.sessionId ? outcome : undefined
  const notice = own !== undefined && (own.status === 'refused' || own.status === 'not-delivered' || own.status === 'failed') ? outcomeLines(own, width) : []
  const fresh = own !== undefined && 'screen' in own ? own.screen : undefined
  const reads = [screen, fresh].filter((read): read is ScreenRead => read !== undefined && read.sessionId === session.sessionId)
  const newest = reads.sort((a, b) => b.readAt - a.readAt)[0]
  return [...notice, ...(newest === undefined ? message(SCREEN_READING, width) : screenLines(newest.text, width))]
}

/** A token count with a comma between each group of 3 digits. */
const tokenCount = (tokens: number): string => `${String(Math.max(0, Math.round(tokens))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} tokens`

/** The Recap tab. */
function recapLines({ session, width, recap }: TabInput): Line[] {
  if (recap === undefined || recap.sessionId !== session.sessionId) return message(RECAP_HINT, width)
  if (recap.status === 'running') return message(RECAP_RUNNING, width)
  const count = message(tokenCount(recap.tokens), width, DIM)
  if (recap.status === 'failed') return [...message(RECAP_FAILURE[recap.reason], width, { token: '--warn' }), ...count]
  return [...message(MODEL_TEXT, width, DIM), ...textLines(recap.text, width, TEXT_INDENT), ...count]
}

/** The content of the open tab. */
export function tabContent(tab: DetailTab, input: TabInput): TabContent {
  if (tab === 'now') return nowContent(input)
  const lines = tab === 'history' ? historyLines(input) : tab === 'agents' ? agentLines(input) : tab === 'screen' ? screenTabLines(input) : recapLines(input)
  return { lines, options: [] }
}
