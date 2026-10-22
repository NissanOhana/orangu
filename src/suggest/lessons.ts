/**
 * The lesson read and the history: what each closed record taught, as ids, codes, enum values, counts and times, and
 * each applied change for a person and the app. Also the record reads that the queue shares: the workspace rule, the
 * time of each move and the verdict that a record can show.
 *
 * Pure: no node import and no clock. The store records, the store lines and the sessions of the workspace are inputs.
 * A verdict comes only from a receipt that the trust policy grades again on this read, so a changed line shows no
 * verdict.
 *
 * The store checks the top-level fields of a record and no nested field, and it accepts any text as a rule id. So each
 * read takes a nested field only in its own form, gives an id only in the form that orangu writes, and leaves out a
 * record that still fails. A read never stops on 1 bad record.
 */
import { allEntries } from './catalog.js'
import { isChangeClass, type ChangeClass } from './change-classes.js'
import { isDirectional, type CohortCheckVerdict, type CohortVerdict } from './cohort-stats.js'
import { REJECT_REASON_CODES, type RejectReasonCode } from './reason-codes.js'
import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  type SuggestionRecord,
  type SuggestionScope,
  type SuggestionStatus,
  type SuggestionVerificationComparison,
  type SuggestionVerificationIntent,
  type SuggestionVerificationMetric,
} from './types.js'
import { applicationTime, isTrustedComputedVerification, outcomeReceiptViolation } from './verification-policy.js'

/** The hard cap of the lesson read on the CLI, in bytes of the exact output with its trailing newline. */
export const LESSONS_MAX_BYTES = 16_384

/** The most earlier records that 1 queue item lists, newest first. `earlierCount` counts them all. */
export const EARLIER_MAX = 10

/** The rule ids that the catalog knows (`allEntries` of `src/suggest/catalog.ts`, the ids that `matchRule` matches). */
let knownRuleIds: ReadonlySet<string> | undefined
function knownRules(): ReadonlySet<string> {
  knownRuleIds ??= new Set(allEntries().map((entry) => entry.pattern.ruleId).filter((id): id is string => typeof id === 'string'))
  return knownRuleIds
}

/** A number suffix of an insight id, as the analyzer writes it: `<ruleId>-<n>`. */
const INSIGHT_SUFFIX_RE = /^[0-9]{1,9}$/

/** The rule id of a record only when the catalog knows it, else null: a stored rule id can be any text. */
export function ruleIdOf(record: SuggestionRecord): string | null {
  const value: unknown = record.ruleId
  return typeof value === 'string' && knownRules().has(value) ? value : null
}

/** The insight id of a record only when it is the record's own known rule id, a `-` and a number. */
export function insightIdOf(record: SuggestionRecord): string | undefined {
  const rule = ruleIdOf(record)
  const value: unknown = record.insightId
  if (rule === null || typeof value !== 'string' || !value.startsWith(`${rule}-`)) return undefined
  return INSIGHT_SUFFIX_RE.test(value.slice(rule.length + 1)) ? value : undefined
}

/** The change class of the proposal, only when it is 1 of the change classes. */
export function changeClassOf(record: SuggestionRecord): ChangeClass | undefined {
  const value: unknown = record.proposal?.changeClass
  return typeof value === 'string' && isChangeClass(value) ? value : undefined
}

/** The reason code of a rejected record, only when it is 1 of the codes. */
export function reasonCodeOf(record: SuggestionRecord): RejectReasonCode | undefined {
  const value: unknown = record.reasonCode
  return record.status === 'rejected' && typeof value === 'string' && (REJECT_REASON_CODES as readonly string[]).includes(value) ? (value as RejectReasonCode) : undefined
}

/** The canonical workspace path that the record names: its proposal workspace, else its bound workspace. */
export function workspaceOf(record: SuggestionRecord): string | undefined {
  const proposal: unknown = record.proposal?.workspace?.cwd
  if (typeof proposal === 'string') return proposal
  const bound: unknown = record.workspaceCwd
  return typeof bound === 'string' ? bound : undefined
}

/** The reviewed checks, only when each is a metric and a comparison; else undefined. */
export function reviewedChecks(record: SuggestionRecord): SuggestionVerificationIntent[] | undefined {
  const checks: unknown = record.proposal?.verificationChecks
  if (!Array.isArray(checks)) return undefined
  const valid = checks.every(
    (check: unknown) =>
      !!check &&
      typeof check === 'object' &&
      (SUGGESTION_VERIFICATION_METRICS as readonly unknown[]).includes((check as { metric?: unknown }).metric) &&
      (SUGGESTION_VERIFICATION_COMPARISONS as readonly unknown[]).includes((check as { comparison?: unknown }).comparison),
  )
  return valid ? (checks as SuggestionVerificationIntent[]) : undefined
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

/** A list of strings, or an empty list for any other value. */
function stringList(value: unknown): string[] {
  return isStringList(value) ? [...value] : []
}

/** The bytes of the `--json` form of a read: 2-space JSON and a newline. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n').length
}

/**
 * The read with the most first items whose measure fits `maxBytes`, and the rest counted as omitted. The measure grows
 * with each item, so a binary search finds the count.
 */
export function fitFirst<T, R>(all: readonly T[], build: (kept: T[], omitted: number) => R, measure: (read: R) => number, maxBytes: number): R {
  let low = 0
  let high = all.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(build(all.slice(0, mid), all.length - mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return build(all.slice(0, low), all.length - low)
}

/** The statuses of a lesson: a closed record, or a `regressed` one that waits for keep or reject. */
export const LESSON_STATUSES: readonly SuggestionStatus[] = ['verified', 'regressed', 'unproven', 'kept', 'rejected']

/** The workspace of a read: its canonical path, and the lowercase ids of the sessions that discovery lists for it. */
export interface WorkspaceMembership {
  cwd: string
  sessionIds: readonly string[]
}

/** A workspace, every workspace (`all`), or only the global records, which belong to no workspace (`global`). */
export type ReadScope = { workspace: WorkspaceMembership } | 'all' | 'global'

/** 1 set for each list of workspace sessions, so the rule stays linear over the records of a read. */
const sessionSets = new WeakMap<readonly string[], Set<string>>()

/** The session id that a selector names: a session id, or the file name of a transcript path. */
function selectorSessionId(selector: string): string {
  const trimmed = selector.trim()
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
  return name.replace(/\.jsonl$/i, '').toLowerCase()
}

/**
 * The workspace rule: a record is in the workspace when its proposal workspace or its bound workspace is the canonical
 * path, or when 1 of its sessions is a session of the workspace. A global record is in no workspace.
 */
export function inWorkspace(record: SuggestionRecord, membership: WorkspaceMembership): boolean {
  if (record.scope === 'global') return false
  if (record.proposal?.workspace?.cwd === membership.cwd || record.workspaceCwd === membership.cwd) return true
  let sessions = sessionSets.get(membership.sessionIds)
  if (!sessions) {
    sessions = new Set(membership.sessionIds)
    sessionSets.set(membership.sessionIds, sessions)
  }
  const found = sessions
  return record.sessionIds.some((selector) => found.has(selectorSessionId(selector)))
}

/** The records of a read scope. */
export function inScope(record: SuggestionRecord, scope: ReadScope): boolean {
  if (scope === 'all') return true
  if (scope === 'global') return record.scope === 'global'
  return inWorkspace(record, scope.workspace)
}

/** The name of a read scope in its output: the canonical workspace path, `all` or `global`. */
export function scopeName(scope: ReadScope): string {
  return scope === 'all' || scope === 'global' ? scope : scope.workspace.cwd
}

/**
 * The `statusAt` of the newest move of each record, by record id. A move is a line whose status differs from the line
 * before it for the same record. The lines of a legacy id count for the record that lists it. A record with no line
 * gives its own `statusAt`.
 */
export function lastMoveTimes(records: readonly SuggestionRecord[], lines: readonly SuggestionRecord[]): Map<string, number> {
  const canonical = new Map<string, string>()
  for (const record of records) {
    canonical.set(record.id, record.id)
    for (const legacy of record.legacyIds ?? []) if (!canonical.has(legacy)) canonical.set(legacy, record.id)
  }
  const last = new Map<string, { status: SuggestionStatus; at: number }>()
  for (const line of lines) {
    const id = canonical.get(line.id) ?? line.id
    const before = last.get(id)
    if (!before || before.status !== line.status) last.set(id, { status: line.status, at: line.statusAt })
  }
  return new Map(records.map((record) => [record.id, last.get(record.id)?.at ?? record.statusAt]))
}

/** 1 graded check of a lesson. */
export interface LessonCheck {
  metric: SuggestionVerificationMetric
  comparison: SuggestionVerificationComparison
  verdict: CohortCheckVerdict
}

/** 1 graded check of a change row: the lesson check and its cohort means. A check of the earlier receipt form has no p-value. */
export interface ChangeCheck extends LessonCheck {
  before: number
  after: number
  pLower: number | null
  pHigher: number | null
}

/** What a record can show as its verdict: only the numbers of a receipt that grades again on this read. */
export interface RecordVerdict {
  verdict: CohortVerdict | null
  verdictTrusted: boolean
  laterComplete?: boolean
  confoundedBy: string[]
  baseline: number
  later: number
  checks: ChangeCheck[]
}

const NO_VERDICT = (): RecordVerdict => ({ verdict: null, verdictTrusted: false, confoundedBy: [], baseline: 0, later: 0, checks: [] })

/**
 * The verdict of a record. `verified` only when the trust policy accepts the verification receipt of a verified
 * record. Else the verdict of an outcome receipt that grades again, as the move that wrote it: `regressed` for a
 * regressed or kept record, `unproven` for an unproven one, and the move that its verdict fits for a rejected one.
 * Else no verdict, also when a field of the record is not in its form.
 */
export function recordVerdict(record: SuggestionRecord): RecordVerdict {
  try {
    return trustedVerdict(record)
  } catch {
    return NO_VERDICT()
  }
}

function trustedVerdict(record: SuggestionRecord): RecordVerdict {
  if (record.status === 'verified') {
    const receipt = record.verificationReceipt
    if (!receipt || !isTrustedComputedVerification(record)) return NO_VERDICT()
    if (receipt.v === 2) {
      return {
        verdict: 'verified',
        verdictTrusted: true,
        confoundedBy: [...receipt.confoundedBy],
        baseline: receipt.baselineSessionIds.length,
        later: receipt.measuredSessionIds.length,
        checks: receipt.checks.map((check) => ({ metric: check.metric, comparison: check.comparison, verdict: check.verdict, before: check.before, after: check.after, pLower: check.pLower, pHigher: check.pHigher })),
      }
    }
    // The earlier receipt form stores each check that passed, with its means and no rank test.
    return {
      verdict: 'verified',
      verdictTrusted: true,
      confoundedBy: [],
      baseline: 0,
      later: receipt.measuredSessionIds.length,
      checks: receipt.checks.map((check) => ({
        metric: check.metric,
        comparison: check.comparison,
        verdict: isDirectional(check.comparison) ? 'improved' : 'held',
        before: check.before,
        after: check.after,
        pLower: null,
        pHigher: null,
      })),
    }
  }
  const receipt = record.outcomeReceipt
  const reviewed = reviewedChecks(record)
  if (receipt === undefined || reviewed === undefined || !['regressed', 'unproven', 'kept', 'rejected'].includes(record.status)) return NO_VERDICT()
  const move: 'regressed' | 'unproven' =
    record.status === 'regressed' || record.status === 'kept' ? 'regressed' : record.status === 'unproven' ? 'unproven' : receipt.verdict === 'regressed' ? 'regressed' : 'unproven'
  if (outcomeReceiptViolation(receipt, move, reviewed, applicationTime(record), record.frozenBaseline) !== undefined) return NO_VERDICT()
  return {
    verdict: receipt.verdict,
    verdictTrusted: true,
    laterComplete: receipt.laterComplete,
    confoundedBy: [...receipt.confoundedBy],
    baseline: receipt.baselineSessionIds.length,
    later: receipt.measuredSessionIds.length,
    checks: receipt.checks.map((check) => ({ metric: check.metric, comparison: check.comparison, verdict: check.verdict, before: check.before, after: check.after, pLower: check.pLower, pHigher: check.pHigher })),
  }
}

/** 1 lesson: ids, codes, enum values, counts and times. No title, no file, no proposal text, no metric value. */
export interface Lesson {
  id: string
  scope: SuggestionScope
  /** null when the catalog does not know the stored rule id */
  ruleId: string | null
  insightId?: string
  changeClass?: ChangeClass
  status: SuggestionStatus
  reasonCode?: RejectReasonCode
  verdict: CohortVerdict | null
  verdictTrusted: boolean
  laterComplete?: boolean
  confoundedBy: string[]
  baseline: number
  later: number
  checks: LessonCheck[]
  appliedAt?: number
  decidedAt: number
}

/** The lesson read, v1. `maxBytes` is null on the app route, which has no cap. */
export interface LessonRead {
  v: 1
  scope: string
  maxBytes: number | null
  omitted: number
  lessons: Lesson[]
}

/** 1 record as a change, for a person and the app: the lesson keys plus the title, the files and the check means. */
export interface ChangeRow extends Omit<Lesson, 'checks' | 'decidedAt'> {
  checks: ChangeCheck[]
  /** absent on an open row (`applied` or `regressed`) */
  decidedAt?: number
  title: string
  files: string[]
}

export interface LessonInput {
  /** every record of the store: the last line of each id */
  records: readonly SuggestionRecord[]
  /** every valid store line in file order */
  lines: readonly SuggestionRecord[]
  scope: ReadScope
  /** keep only these rule ids */
  rules?: readonly string[]
  /** `LESSONS_MAX_BYTES` on the CLI, null on the app route */
  maxBytes: number | null
  /** the bytes of the exact output form; the `--json` form by default */
  measure?: (read: LessonRead) => number
}

/** The keys of a lesson or a change row up to its checks, in the order of the lesson shape. */
function lessonHead(record: SuggestionRecord, verdict: RecordVerdict): Omit<Lesson, 'checks' | 'appliedAt' | 'decidedAt'> {
  const changeClass = changeClassOf(record)
  const insightId = insightIdOf(record)
  const reasonCode = reasonCodeOf(record)
  return {
    id: record.id,
    scope: record.scope,
    ruleId: ruleIdOf(record),
    ...(insightId !== undefined ? { insightId } : {}),
    ...(changeClass !== undefined ? { changeClass } : {}),
    status: record.status,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    verdict: verdict.verdict,
    verdictTrusted: verdict.verdictTrusted,
    ...(verdict.laterComplete !== undefined ? { laterComplete: verdict.laterComplete } : {}),
    confoundedBy: verdict.confoundedBy,
    baseline: verdict.baseline,
    later: verdict.later,
  }
}

function lessonOf(record: SuggestionRecord, decidedAt: number): Lesson {
  const verdict = recordVerdict(record)
  const appliedAt = applicationTime(record)
  return {
    ...lessonHead(record, verdict),
    checks: verdict.checks.map(({ metric, comparison, verdict: checkVerdict }) => ({ metric, comparison, verdict: checkVerdict })),
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    decidedAt,
  }
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function filtered(input: Pick<LessonInput, 'records' | 'scope' | 'rules'>): SuggestionRecord[] {
  const rules = input.rules ? new Set(input.rules) : undefined
  return input.records.filter((record) => inScope(record, input.scope) && (!rules || rules.has(record.ruleId)))
}

/**
 * The lesson read: each lesson of the scope, newest decision first, ties by id. A read of every workspace puts the
 * global lessons last. With `maxBytes`, it keeps the newest lessons whose output fits and counts the rest in
 * `omitted`. With null it keeps every lesson.
 */
export function buildLessonRead(input: LessonInput): LessonRead {
  const moves = lastMoveTimes(input.records, input.lines)
  const lessons: Lesson[] = []
  for (const record of filtered(input)) {
    if (!LESSON_STATUSES.includes(record.status)) continue
    try {
      lessons.push(lessonOf(record, moves.get(record.id) ?? record.statusAt))
    } catch {
      // A record that still fails is left out, and the read goes on.
    }
  }
  lessons.sort((a, b) => Number(a.scope === 'global') - Number(b.scope === 'global') || b.decidedAt - a.decidedAt || byId(a, b))
  const build = (kept: Lesson[], omitted: number): LessonRead => ({ v: 1, scope: scopeName(input.scope), maxBytes: input.maxBytes, omitted, lessons: kept })
  return input.maxBytes === null ? build(lessons, 0) : fitFirst(lessons, build, input.measure ?? jsonBytes, input.maxBytes)
}

/** The history: 1 change row for each record with an application time, oldest first, ties by id. */
export function buildHistory(input: Omit<LessonInput, 'maxBytes' | 'measure'>): ChangeRow[] {
  const moves = lastMoveTimes(input.records, input.lines)
  const rows: Array<ChangeRow & { appliedAt: number }> = []
  for (const record of filtered(input)) {
    const appliedAt = applicationTime(record)
    if (appliedAt === undefined) continue
    try {
      const verdict = recordVerdict(record)
      const open = record.status === 'applied' || record.status === 'regressed'
      // The files that the apply step changed, else the files of the proposal, each only as a list of strings.
      const applied: unknown = record.application?.files
      rows.push({
        ...lessonHead(record, verdict),
        checks: verdict.checks,
        appliedAt,
        ...(open ? {} : { decidedAt: moves.get(record.id) ?? record.statusAt }),
        title: record.title,
        files: isStringList(applied) ? [...applied] : stringList(record.proposal?.files),
      })
    } catch {
      // A record that still fails is left out, and the read goes on.
    }
  }
  return rows.sort((a, b) => a.appliedAt - b.appliedAt || byId(a, b))
}
