/**
 * The text output of the 4 store reads of `orangu suggest` (`--queue`, `--todo`, `--lessons`, `--history`) and the
 * moves that `--show` prints. Each function takes a read after the output boundary (`visible` in suggest.ts) and the
 * line measure, and gives the lines that the CLI prints. A title wraps under itself at whole words (`wrapWords`), as
 * `recordLines` in suggest.ts wraps it. A command and a path are never cut: a row is wider than the measure only when
 * the 1 command or path on it is wider than its room.
 *
 * The queue text is for a person, so it names no `orangu suggest` command. The next step of an item is its `next`,
 * whole on a row of its own, or no row when `next` is null.
 */
import { plural } from '../../harness/report.js'
import { COHORT_MAX } from '../../suggest/cohort-stats.js'
import { reasonCodeOf, type ChangeRow, type LessonRead } from '../../suggest/lessons.js'
import { QUEUE_GROUPS, type QueueGroup, type QueueItem, type SuggestionQueue, type TodoRead } from '../../suggest/queue.js'
import type { RejectReasonCode } from '../../suggest/reason-codes.js'
import type { SuggestionRecord, SuggestionStatus } from '../../suggest/types.js'
import { fmtAge } from '../summary.js'
import { displayWidth, padCell, wrapValue, wrapWords } from '../tty.js'

const INDENT = '  '
/** The indent of the rows under an item: its facts and its next step. */
const UNDER = '    '
/** The narrowest title column, as in suggest.ts: below it, the line runs past the measure rather than print a word per line. */
const MIN_TITLE_COLUMNS = 20

/** A control byte becomes a space, as `terminal` in suggest.ts does: a stored id or path can carry any text. */
function terminal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

/** A time as `YYYY-MM-DD HH:MM` in UTC, the form of `orangu list`. A time that is not a date prints as its number. */
function when(ms: number): string {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : String(ms)
}

const fmtCount = (n: number): string => n.toLocaleString('en-US')

/** The head of an item or a change row: the id, the status and the title, which wraps under itself (suggest.ts recordLines). */
function headLines(id: string, status: string, title: string, width: number): string[] {
  const head = `${INDENT}${terminal(id)}  [${terminal(status)}]  `
  const column = displayWidth(head)
  const [first = '', ...rest] = wrapWords(title, Math.max(MIN_TITLE_COLUMNS, width - column))
  return [(head + first).trimEnd(), ...rest.map((line) => ' '.repeat(column) + line)]
}

/** Prose under an item: it wraps at whole words inside the measure, each line at the same indent. */
function proseLines(text: string, width: number): string[] {
  return wrapWords(text, width - UNDER.length).map((line) => UNDER + line)
}

/** Short facts under an item, joined with ` · `: they break only between 2 facts, so a fact stays whole. */
function factLines(facts: readonly string[], width: number): string[] {
  return facts.length ? wrapValue(facts.map(terminal).join(' · '), width - UNDER.length).map((line) => UNDER + line) : []
}

/** The workspace of an item, whole on its own row: a cut path is no path. */
const workspaceRow = (path: string): string => `${UNDER}Workspace: ${terminal(path)}`

/** The name of a read scope: a workspace path, every workspace, or the global records. */
function scopeLine(scope: string): string {
  if (scope === 'all') return `${INDENT}Every workspace on this machine`
  if (scope === 'global') return `${INDENT}The global records, which belong to no workspace`
  return `${INDENT}Workspace: ${terminal(scope)}`
}

// ---------- the queue ----------

/** The heading of each group, in the words of the person who works the queue. */
const GROUP_TITLES: Record<QueueGroup, string> = {
  verdict: 'Ready for a verdict',
  regressed: 'Worse after the change: keep it or undo it',
  apply: 'Ready to apply',
  review: 'To review',
  running: 'Started in Claude Code',
  wait: 'Waiting for later sessions',
}

/** The row of an item whose queue check was past the byte budget of the read. It has no command. */
export const DEFERRED_TEXT = 'orangu did not check this change in this read, because the read reached its byte budget. Run orangu again to check it.'

/** The last row of the queue. */
export const QUEUE_APP_ROW = 'See this queue in the app: orangu serve'

/** The checkpoint of a queue check, as a phrase. */
function checkpointPhrase(checkpoint: QueueItem['checkpoint']): string {
  if (checkpoint === 'first') return 'at the first checkpoint'
  if (checkpoint === 'complete') return 'at the complete checkpoint'
  return 'before the first checkpoint'
}

/**
 * The facts of 1 queue item, in reading order. Each fact is a sentence that wraps as prose on rows of its own, so it
 * reads apart from the title above it, which has no end mark.
 */
function itemFacts(item: QueueItem, now: number): string[] {
  const facts: string[] = []
  if (item.ids.length > 1) facts.push(`${item.ids.length} records of this rule: ${item.ids.join(', ')}.`)
  if (item.check === 'ran' && item.verdict !== undefined) {
    facts.push(`Checked: ${item.verdict} ${checkpointPhrase(item.checkpoint ?? null)}${item.leaning === 'worse' ? ', and it leans worse' : ''}.`)
  }
  if (item.candidates) facts.push(`Sessions: ${item.candidates.baseline} before the change, ${item.candidates.later} of ${COHORT_MAX} after it.`)
  if (item.cannotVerify) facts.push(`Cannot verify: ${item.cannotVerify}.`)
  if (item.group === 'running') {
    const age = fmtAge(item.lastMoveAt, now)
    facts.push(age === 'now' ? 'Started less than 1m ago.' : `Started ${age} ago.`)
  }
  if (item.earlierCount > 0) facts.push(`Earlier records of this rule: ${item.earlierCount}.`)
  return facts
}

/** 1 queue item: its head, its facts, the deferred row or the next command. */
function itemLines(item: QueueItem, now: number, allWorkspaces: boolean, width: number): string[] {
  const lines = headLines(item.id, item.status, item.title, width)
  if (allWorkspaces && item.workspace !== null) lines.push(workspaceRow(item.workspace))
  for (const fact of itemFacts(item, now)) lines.push(...proseLines(terminal(fact), width))
  if (item.check === 'deferred') lines.push(...proseLines(DEFERRED_TEXT, width))
  // A command is a paste target: it stays whole on its own row, also when it is wider than the measure.
  if (item.next !== null) lines.push(UNDER + terminal(item.next))
  return lines
}

/**
 * The queue as terminal lines: the counts, the scope, each group that has an item, in the order that a person works
 * them, and the app row last. A row has a command only when the item has a next step.
 */
export function queueLines(queue: SuggestionQueue, width: number): string[] {
  const all = queue.scope === 'all'
  const lines = ['', `${INDENT}Improvements · ${queue.counts.due} due · ${queue.counts.open} open`, scopeLine(queue.scope)]
  if (queue.globalOpen > 0) lines.push(`${INDENT}Open global records that this queue leaves out: ${queue.globalOpen}.`)
  if (queue.counts.open === 0) lines.push('', `${INDENT}orangu found no open record ${all ? 'on this machine' : 'in this workspace'}.`)
  for (const group of QUEUE_GROUPS) {
    const items = queue.groups[group]
    if (!items.length) continue
    lines.push('', `${INDENT}${GROUP_TITLES[group]} (${items.length})`)
    for (const item of items) lines.push(...itemLines(item, queue.now, all, width))
  }
  lines.push('', INDENT + QUEUE_APP_ROW)
  return lines
}

// ---------- the todo read ----------

const GROUP_COLUMN = Math.max(...QUEUE_GROUPS.map((group) => group.length))
const STATUS_COLUMN = 'kicked-off'.length

/** The todo read as text: the counts, then 1 row for each item (group, id, status and rule), then the omitted count. */
export function todoLines(todo: TodoRead): string[] {
  const lines = [`${INDENT}Workspace: ${terminal(todo.workspace)} · ${todo.counts.due} due · ${todo.counts.open} open`]
  if (!todo.items.length) lines.push(`${INDENT}orangu found no open item that needs a step.`)
  for (const item of todo.items) {
    lines.push(`${INDENT}${padCell(item.group, GROUP_COLUMN)}  ${terminal(item.id)}  ${padCell(terminal(item.status), STATUS_COLUMN)}  ${terminal(item.ruleId ?? 'unknown-rule')}`)
  }
  if (todo.omitted > 0) lines.push(`${INDENT}${todo.omitted} more items do not fit in ${fmtCount(todo.maxBytes)} B.`)
  return lines
}

// ---------- the lesson read ----------

/** The lesson read as text: the scope, then each lesson with its facts and checks, newest decision first. */
export function lessonLines(read: LessonRead, width: number): string[] {
  const lines = ['', `${INDENT}Lessons · ${plural(read.lessons.length, 'lesson')} shown`, scopeLine(read.scope)]
  if (read.omitted > 0) {
    lines.push(`${INDENT}${read.omitted} older lessons do not fit in ${read.maxBytes === null ? 'this read' : `${fmtCount(read.maxBytes)} B`}.`)
  }
  if (!read.lessons.length) lines.push('', `${INDENT}orangu found no lesson in this scope.`)
  for (const lesson of read.lessons) {
    lines.push('', `${INDENT}${terminal(lesson.id)}  [${terminal(lesson.status)}]  decided ${when(lesson.decidedAt)}`)
    const facts = [
      `rule ${lesson.ruleId ?? 'unknown-rule'}`,
      lesson.verdict === null ? 'no verdict' : `verdict ${lesson.verdict}`,
      ...(lesson.reasonCode ? [`reason ${lesson.reasonCode}`] : []),
      `sessions: ${lesson.baseline} before the change, ${lesson.later} after it`,
    ]
    lines.push(...factLines(facts, width))
    if (lesson.confoundedBy.length) lines.push(...proseLines(terminal(`measured together with ${lesson.confoundedBy.join(', ')}`), width))
    for (const check of lesson.checks) lines.push(...factLines([`${check.metric} ${check.comparison}: ${check.verdict}`], width))
  }
  return lines
}

// ---------- the history ----------

/** The status of a change row: a verified row whose receipt does not grade again is not shown as verified (suggest.ts recordLines). */
const rowStatus = (row: ChangeRow): string => (row.status === 'verified' && !row.verdictTrusted ? 'legacy-unverified' : row.status)

/** The history as text: each applied change, oldest first, with its times, its verdict, its checks and its files. */
export function historyLines(rows: readonly ChangeRow[], width: number): string[] {
  const lines = ['', `${INDENT}History · ${plural(rows.length, 'applied change')}, oldest first`]
  if (!rows.length) lines.push('', `${INDENT}orangu found no applied change in this scope.`)
  for (const row of rows) {
    lines.push('', ...headLines(row.id, rowStatus(row), row.title, width))
    const facts = [
      ...(row.appliedAt !== undefined ? [`applied ${when(row.appliedAt)}`] : []),
      row.decidedAt !== undefined ? `decided ${when(row.decidedAt)}` : 'open',
      row.verdict === null ? 'no verdict' : `verdict ${row.verdict}`,
      ...(row.reasonCode ? [`reason ${row.reasonCode}`] : []),
      `rule ${row.ruleId ?? 'unknown-rule'}`,
    ]
    lines.push(...factLines(facts, width))
    for (const check of row.checks) lines.push(...proseLines(`${check.metric} ${check.comparison}: ${check.before} → ${check.after}, ${check.verdict}`, width))
    if (row.files.length) lines.push(...wrapValue(`files: ${row.files.map(terminal).join(', ')}`, width - UNDER.length, ', ').map((line) => UNDER + line))
  }
  return lines
}

// ---------- the moves of --show ----------

/** 1 move of a record: a store line whose status differs from the line before it. Only a rejection has a reason code. */
export interface Transition {
  status: SuggestionStatus
  statusAt: number
  reasonCode?: RejectReasonCode
}

/** The moves of 1 record, in file order, from its store lines. The first line of a record is its first move. */
export function transitionsOf(lines: readonly SuggestionRecord[]): Transition[] {
  const moves: Transition[] = []
  let before: SuggestionStatus | undefined
  for (const line of lines) {
    if (line.status === before) continue
    before = line.status
    const reasonCode = reasonCodeOf(line)
    moves.push({ status: line.status, statusAt: line.statusAt, ...(reasonCode !== undefined ? { reasonCode } : {}) })
  }
  return moves
}

/** The moves of a record as rows under it: the time, the status and the reason code of a rejection. */
export function transitionLines(transitions: readonly Transition[]): string[] {
  if (!transitions.length) return []
  return [`${UNDER}moves:`, ...transitions.map((move) => `${UNDER}  ${when(move.statusAt)}  ${terminal(move.status)}${move.reasonCode ? ` (${move.reasonCode})` : ''}`)]
}
