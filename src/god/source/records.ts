/**
 * The record reducer of orangu god. It reads the parsed records of 1 transcript, 1 read at a time, into a state
 * of plain JSON data, and gives the TranscriptFacts of that state. It reads only the main chain: a sidechain record
 * is the work of a subagent, not a fact of the session.
 *
 * The rules of the facts:
 * - title: the custom title, then the AI title, then the first human prompt, else the first turn, through
 *   sessionTitle as the report gives it. The head records (the first bytes of a file whose tail holds no title
 *   record) give the title order only: the bytes between them and the tail were not read, so a tool use in them
 *   has no result to pair with, and it never opens a question.
 * - lastPrompt: the last prompt that classifyPrompt calls human. lastReply: the last text of a model reply.
 * - openQuestion and activity: a call is open until its result comes. A new turn closes every call of the turn
 *   before it, and ends each subagent that had no result.
 * - agents: an Agent call runs until its result. An Agent call that the result says was launched, and a Bash
 *   call that runs in the background, run until a task notification with their tool use id and a status.
 * - context: the input, cache read and cache write tokens of the last reply, with the window of its model.
 * - errorTail: an API error or retry system record, until the next reply or the next turn.
 * - history: the last HISTORY_TURNS turns. A turn starts at a human, command, peer or scheduled prompt, and only a
 *   human or a command prompt is the prompt of the person.
 *
 * Every text field leaves transcriptFacts through cleanText, and each tool input through cleanValue
 * (src/god/sanitize.ts), so a secret that only its key names is masked too. The state keeps most text as
 * the transcript wrote it, so a read cleans only the text that the facts show. Keep the state inside the collector.
 */
import { classifyPrompt, COMMAND_RE, commandEnvelopeTitle, sessionTitle } from '../../adapters/claude-code/prompt-kind.js'
import { summarizeToolInput } from '../../adapters/claude-code/tools.js'
import { TURN_STARTING_KINDS, type PromptKind } from '../../model/session.js'
import { resolveModel } from '../../models/catalog.js'
import { cleanText, cleanValue } from '../sanitize.js'
import type { AgentTask, ContextFacts, ErrorTail, FileTouch, HistoryTurn, OpenQuestion, PrLink, Question, ToolActivity, TranscriptFacts } from '../types.js'

/** The History tab shows this many turns, the last ones. */
export const HISTORY_TURNS = 10

/** The facts of the title order that 1 part of the file gives. */
type TitleFacts = {
  customTitle?: string
  aiTitle?: string
  /** the preview of the first prompt that classifyPrompt calls human */
  firstHumanPreview?: string
  /** the preview and the command name of the first prompt that starts a turn */
  firstTurn?: { preview: string; command?: string }
}

/** 1 tool call as the transcript wrote it. */
type Call = { id: string; name: string; input: unknown; at?: number }

/** 1 agent task, its text already clean. A launched task has its result and waits for its task notification. */
type Task = AgentTask & { isLaunched?: boolean }

/** The state of the reducer for 1 transcript. Plain JSON data. */
export type RecordState = {
  /** the home folder that cleanText writes as `~` */
  home: string
  head: TitleFacts
  tail: TitleFacts
  lastPrompt?: string
  lastReply?: string
  /** the calls with no result, in call order */
  open: Call[]
  lastCall?: Call
  context?: { tokens: number; model?: string }
  permissionMode?: string
  branch?: string
  prLinks: PrLink[]
  files: FileTouch[]
  errorTail?: ErrorTail
  lastTurnEndedAt?: number
  history: HistoryTurn[]
  agents: Task[]
  parseErrors: number
}

/** What 1 read gives beside its records. */
export type ReadOptions = {
  /** the first records of the file, for the title order only */
  headRecords?: readonly unknown[]
  /** the lines of the read that did not parse */
  parseErrors?: number
}

type JsonObject = Record<string, unknown>
type Clean = (text: string) => string

const FILE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g
const NOTIFIED_ID_RE = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/
const NOTIFIED_STATUS_RE = /<status>\s*[^<\s][^<]*<\/status>/

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const obj = (v: unknown): JsonObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined)
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The time of a record, when it has one. */
function timeOf(r: JsonObject): number | undefined {
  const at = Date.parse(str(r['timestamp']) ?? '')
  return Number.isNaN(at) ? undefined : at
}

/** The value with each undefined field left out. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

/** The 1-line preview of a prompt, cut at a space near 160 characters: the same form as parse.ts gives a title. */
function previewOf(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const hard = one.slice(0, max - 1)
  const space = hard.lastIndexOf(' ')
  return (space > 0 ? hard.slice(0, space) : hard) + '…'
}

/** The text of a message: a string, or its text blocks joined by a newline, as parse.ts reads it. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return list(content)
    .map(obj)
    .flatMap((block) => (block?.['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : []))
    .join('\n')
}

/** The 1-line summary of a call, from its cleaned input, so a cut never leaves half a secret. */
function callText(name: string, input: unknown, clean: Clean): string {
  return clean(summarizeToolInput(clean(name), cleanValue(input, clean)))
}

/** The kind and the text of a user record that is a prompt, not a tool result and not a compact summary. */
function promptOf(r: JsonObject): { kind: PromptKind; text: string } | undefined {
  const message = obj(r['message'])
  if (!message || r['isCompactSummary'] === true) return undefined
  if (list(message['content']).some((block) => obj(block)?.['type'] === 'tool_result')) return undefined
  const text = textOf(message['content'])
  return { kind: classifyPrompt(r, text, r['isMeta'] === true), text }
}

/** Notes a turn-starting prompt in the title facts of 1 part, as parse.ts keeps its first prompt and first turn. */
function noteTitlePrompt(title: TitleFacts, kind: PromptKind, text: string): void {
  const preview = previewOf(text)
  if (!title.firstHumanPreview && kind === 'human') title.firstHumanPreview = preview
  title.firstTurn ??= defined({ preview, command: COMMAND_RE.exec(text)?.[1] })
}

/** Reads the title records of 1 part. True when the record is a title record. */
function readTitleRecord(title: TitleFacts, r: JsonObject): boolean {
  if (r['type'] === 'custom-title') title.customTitle = str(r['customTitle']) ?? title.customTitle
  else if (r['type'] === 'ai-title') title.aiTitle = str(r['aiTitle']) ?? title.aiTitle
  else return false
  return true
}

function readHeadRecord(head: TitleFacts, value: unknown): void {
  const r = obj(value)
  if (!r || r['isSidechain'] === true || readTitleRecord(head, r) || r['type'] !== 'user') return
  const prompt = promptOf(r)
  if (prompt && TURN_STARTING_KINDS.has(prompt.kind)) noteTitlePrompt(head, prompt.kind, prompt.text)
}

function endTask(task: Task, at: number | undefined): void {
  task.isRunning = false
  if (at !== undefined) task.endedAt = at
  delete task.isLaunched
}

/** Ends each running task that a task notification names with a status. A notification with no status is an event. */
function readNotifications(s: RecordState, text: string, at: number | undefined): void {
  for (const [, body = ''] of text.matchAll(NOTIFICATION_RE)) {
    const id = NOTIFIED_ID_RE.exec(body)?.[1]
    const task = id !== undefined && NOTIFIED_STATUS_RE.test(body) ? s.agents.find((item) => item.toolUseId === id && item.isRunning) : undefined
    if (task) endTask(task, at)
  }
}

function startTurn(s: RecordState, kind: PromptKind, text: string, at: number | undefined): void {
  noteTitlePrompt(s.tail, kind, text)
  for (const call of s.open) {
    const task = s.agents.find((item) => item.toolUseId === call.id && item.isRunning)
    if (task) endTask(task, at)
  }
  s.open = []
  delete s.errorTail
  if (kind === 'human') s.lastPrompt = text
  const command = COMMAND_RE.exec(text)?.[1]
  const prompt = kind === 'human' ? text : kind === 'command' ? commandEnvelopeTitle(text, command) : undefined
  s.history.push(defined({ prompt, promptAt: prompt === undefined ? undefined : at }))
  if (s.history.length > HISTORY_TURNS) s.history.shift()
}

/** The result of 1 call: it closes the call, and it ends its agent task unless the result says it was launched. */
function readResult(s: RecordState, block: JsonObject, r: JsonObject, at: number | undefined): void {
  const id = str(block['tool_use_id'])
  const index = s.open.findIndex((call) => call.id === id)
  if (index < 0) return
  s.open.splice(index, 1)
  const task = s.agents.find((item) => item.toolUseId === id && item.isRunning && !item.isLaunched)
  if (!task) return
  const result = obj(r['toolUseResult'])
  const isLaunched = block['is_error'] !== true && (result?.['status'] === 'async_launched' || typeof result?.['backgroundTaskId'] === 'string')
  if (isLaunched) task.isLaunched = true
  else endTask(task, at)
}

function readUser(s: RecordState, r: JsonObject, at: number | undefined): void {
  for (const block of list(obj(r['message'])?.['content'])) {
    const result = obj(block)
    if (result?.['type'] === 'tool_result') readResult(s, result, r, at)
  }
  const prompt = promptOf(r)
  if (prompt?.kind === 'notification') readNotifications(s, prompt.text, at)
  else if (prompt && TURN_STARTING_KINDS.has(prompt.kind)) startTurn(s, prompt.kind, prompt.text, at)
}

/** A subagent (Agent, Task) or a background task (Bash in the background), with its text cleaned once. */
function taskOf(s: RecordState, call: Call): Task | undefined {
  const input = obj(call.input)
  const kind = call.name === 'Agent' || call.name === 'Task' ? 'subagent' : call.name === 'Bash' && input?.['run_in_background'] === true ? 'background' : undefined
  if (kind === undefined) return undefined
  const clean: Clean = (text) => cleanText(text, s.home)
  const agentType = str(input?.['subagent_type'])
  return defined<Task>({ toolUseId: call.id, kind, text: callText(call.name, call.input, clean), agentType: agentType === undefined ? undefined : clean(agentType), isRunning: true, startedAt: call.at })
}

function readCall(s: RecordState, block: JsonObject, at: number | undefined): void {
  const id = str(block['id'])
  const name = str(block['name'])
  if (id === undefined || name === undefined) return
  const call: Call = defined({ id, name, input: block['input'], at })
  s.open.push(call)
  s.lastCall = call
  const input = obj(call.input)
  const path = str(input?.['file_path']) ?? str(input?.['notebook_path'])
  if (FILE_TOOLS.has(name) && path !== undefined && at !== undefined) {
    s.files = s.files.filter((file) => file.path !== path)
    s.files.push({ path, tool: name, at })
  }
  const task = taskOf(s, call)
  if (task) s.agents.push(task)
}

function readAssistant(s: RecordState, r: JsonObject, at: number | undefined): void {
  const message = obj(r['message'])
  if (!message) return
  const model = str(message['model'])
  const isReply = !resolveModel(model).synthetic
  const usage = obj(message['usage'])
  if (isReply) delete s.errorTail
  if (isReply && usage) s.context = defined({ tokens: count(usage['input_tokens']) + count(usage['cache_read_input_tokens']) + count(usage['cache_creation_input_tokens']), model })
  for (const value of list(message['content'])) {
    const block = obj(value)
    const text = str(block?.['text'])
    if (block?.['type'] === 'tool_use') readCall(s, block, at)
    else if (isReply && block?.['type'] === 'text' && text !== undefined && text.trim() !== '') {
      s.lastReply = text
      if (s.history.length === 0) s.history.push({})
      Object.assign(s.history[s.history.length - 1]!, defined({ reply: text, replyAt: at }))
    }
  }
}

function readSystem(s: RecordState, r: JsonObject, at: number | undefined): void {
  const subtype = r['subtype']
  if (subtype === 'turn_duration' && at !== undefined) {
    s.lastTurnEndedAt = at
    const turn = s.history[s.history.length - 1]
    if (turn) turn.endedAt = at
  } else if (subtype === 'api_error' || subtype === 'api_retry') {
    const error = obj(r['error'])
    const text = str(error?.['message']) ?? str(error?.['formatted']) ?? str(r['content']) ?? ''
    s.errorTail = defined<ErrorTail>({ kind: subtype === 'api_error' ? 'api-error' : 'api-retry', text, at })
  }
}

function readRecord(s: RecordState, value: unknown): void {
  const r = obj(value)
  if (!r) {
    s.parseErrors++
    return
  }
  if (r['isSidechain'] === true || readTitleRecord(s.tail, r)) return
  const at = timeOf(r)
  const branch = str(r['gitBranch'])
  if (branch) s.branch = branch
  const type = r['type']
  if (type === 'user') readUser(s, r, at)
  else if (type === 'assistant') readAssistant(s, r, at)
  else if (type === 'system') readSystem(s, r, at)
  else if (type === 'permission-mode') s.permissionMode = str(r['permissionMode']) ?? s.permissionMode
  else if (type === 'pr-link') {
    const url = str(r['prUrl'])
    const number = r['prNumber']
    if (url !== undefined && !s.prLinks.some((link) => link.url === url)) s.prLinks.push(defined({ url, number: Number.isInteger(number) ? (number as number) : undefined }))
  } else if (type === 'attachment') {
    const attachment = obj(r['attachment'])
    const prompt = str(attachment?.['prompt'])
    if (attachment?.['type'] === 'queued_command' && attachment['commandMode'] === 'task-notification' && prompt !== undefined) readNotifications(s, prompt, at)
  }
}

/** The state before the first read of a transcript, or after a read that starts again from the end. */
export function emptyRecordState(home: string): RecordState {
  return { home, head: {}, tail: {}, open: [], prLinks: [], files: [], history: [], agents: [], parseErrors: 0 }
}

/** The state after 1 more read. The state that it reads from does not change. */
export function readRecords(state: RecordState, records: readonly unknown[], options: ReadOptions = {}): RecordState {
  const next = JSON.parse(JSON.stringify(state)) as RecordState
  for (const record of options.headRecords ?? []) readHeadRecord(next.head, record)
  for (const record of records) readRecord(next, record)
  next.parseErrors += options.parseErrors ?? 0
  return next
}

function questionsOf(input: unknown, clean: Clean): Question[] {
  return list(obj(input)?.['questions']).flatMap((value) => {
    const q = obj(value)
    if (!q) return []
    const options = list(q['options']).flatMap((option) => {
      const o = obj(option)
      const description = str(o?.['description'])
      return o ? [defined({ label: clean(str(o['label']) ?? ''), description: description === undefined ? undefined : clean(description) })] : []
    })
    return [{ text: clean(str(q['question']) ?? ''), header: clean(str(q['header']) ?? ''), multiSelect: q['multiSelect'] === true, options }]
  })
}

function openQuestionOf(s: RecordState, clean: Clean): OpenQuestion | undefined {
  const call = [...s.open].reverse().find((item) => item.name === 'AskUserQuestion')
  return call && defined({ toolUseId: call.id, askedAt: call.at, questions: questionsOf(call.input, clean) })
}

function activityOf(s: RecordState, clean: Clean): ToolActivity | undefined {
  const open = s.open[s.open.length - 1]
  const call = open ?? s.lastCall
  if (!call) return undefined
  const input = open ? JSON.stringify(cleanValue(open.input, clean)) : undefined
  return defined({ toolUseId: call.id, tool: clean(call.name), text: callText(call.name, call.input, clean), input, isOpen: open !== undefined, at: call.at })
}

function contextOf(s: RecordState, clean: Clean): ContextFacts | undefined {
  if (!s.context) return undefined
  const model = resolveModel(s.context.model)
  if (model.contextWindow === undefined) return undefined
  return { tokens: s.context.tokens, window: model.contextWindow, model: clean(s.context.model ?? ''), isEstimated: model.estimatedMatch }
}

function titleOf(s: RecordState): string | undefined {
  const first = s.head.firstTurn ?? s.tail.firstTurn
  const firstPrompt = s.head.firstHumanPreview ?? s.tail.firstHumanPreview ?? first?.preview
  return sessionTitle(s.tail.customTitle ?? s.head.customTitle, s.tail.aiTitle ?? s.head.aiTitle, firstPrompt, first?.command)
}

/** The facts of the state. Each text field is cleaned: no control character, no secret, the home folder as `~`. */
export function transcriptFacts(s: RecordState): TranscriptFacts {
  const clean: Clean = (text) => cleanText(text, s.home)
  const maybe = (text: string | undefined): string | undefined => (text === undefined ? undefined : clean(text))
  const title = titleOf(s)
  return defined({
    title: maybe(title),
    lastPrompt: maybe(s.lastPrompt),
    lastReply: maybe(s.lastReply),
    openQuestion: openQuestionOf(s, clean),
    activity: activityOf(s, clean),
    context: contextOf(s, clean),
    permissionMode: maybe(s.permissionMode),
    branch: maybe(s.branch),
    prLinks: s.prLinks.map((link) => ({ ...link, url: clean(link.url) })),
    filesTouched: s.files.map((file) => ({ ...file, path: clean(file.path), tool: clean(file.tool) })),
    errorTail: s.errorTail && { ...s.errorTail, text: clean(s.errorTail.text) },
    lastTurnEndedAt: s.lastTurnEndedAt,
    history: s.history.map((turn) => defined({ ...turn, prompt: maybe(turn.prompt), reply: maybe(turn.reply) })),
    agents: s.agents.map(({ isLaunched: _isLaunched, ...task }) => task),
    parseErrors: s.parseErrors,
  })
}

/** The facts of 1 whole read, from an empty state: the reducer in 1 call. */
export function reduceRecords(records: readonly unknown[], options: ReadOptions & { home: string }): TranscriptFacts {
  return transcriptFacts(readRecords(emptyRecordState(options.home), records, options))
}
