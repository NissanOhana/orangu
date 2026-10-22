/**
 * The improvement queue: every open record of a workspace, or of every workspace, in 6 groups, each item with the
 * next step that a person can paste.
 *
 * Pure: no node import and no clock. `now`, the store records and lines, the sessions of the workspace, the file times
 * that discovery lists and the queue check of each applied record are inputs, so the same input gives the same JSON
 * bytes. "Due" comes from the measured check, never from the discovery counts.
 *
 * A next step is a handoff to the Claude Code door, or null when no step can run now. It never names an
 * `orangu suggest` command: those are the store API that the skills call.
 */
import { MIN_VERIFICATION_QUIET_MS } from '../adapters/claude-code/discovered-analysis.js'
import type { ChangeClass } from './change-classes.js'
import type { CohortCheckpoint } from './cohort.js'
import { COHORT_MAX, COHORT_MIN, isDirectional, type CohortVerdict } from './cohort-stats.js'
import { isSuggestionId, kickoffCommands } from './id.js'
import {
  changeClassOf,
  fitFirst,
  EARLIER_MAX,
  inWorkspace,
  jsonBytes,
  lastMoveTimes,
  reasonCodeOf,
  recordVerdict,
  reviewedChecks,
  ruleIdOf,
  workspaceOf,
  type WorkspaceMembership,
} from './lessons.js'
import type { RejectReasonCode } from './reason-codes.js'
import type { SuggestionRecord, SuggestionScope, SuggestionStatus } from './types.js'
import { applicationTime, frozenBaselineViolation } from './verification-policy.js'

/** The 6 groups of the queue, in the order that a person works them. */
export const QUEUE_GROUPS = ['verdict', 'regressed', 'apply', 'review', 'running', 'wait'] as const
export type QueueGroup = (typeof QUEUE_GROUPS)[number]

/** Why an applied record can never verify, or can close only one way. */
export type CannotVerify = 'few-baseline-sessions' | 'no-directional-check' | 'baseline-gone' | 'legacy-record'

/** The statuses of a closed record: it is in no group. */
const CLOSED: readonly SuggestionStatus[] = ['verified', 'unproven', 'kept', 'rejected']

/** The queue check of 1 applied record: the measured verdict at its latest checkpoint, or deferred past the byte bound of the read. */
export type QueueCheck =
  | { check: 'ran'; checkpoint: CohortCheckpoint | null; verdict: CohortVerdict; final: boolean; leaning?: 'worse' }
  | { check: 'deferred' }

/** 1 earlier record of the same workspace and rule: a closed one or a regressed one. */
export interface QueueEarlier {
  id: string
  status: SuggestionStatus
  verdict: CohortVerdict | null
  reasonCode?: RejectReasonCode
}

/** 1 queue item. The keys are additive within v1. */
export interface QueueItem {
  group: QueueGroup
  /** the newest record id of the item */
  id: string
  /** every folded record id, newest move first: more than 1 only in `review` */
  ids: string[]
  status: SuggestionStatus
  scope: SuggestionScope
  /** null when the stored rule id is not an analyzer rule id or `harness:` and a change class */
  ruleId: string | null
  changeClass?: ChangeClass
  /** the stored title: it can be model text, so every surface escapes it */
  title: string
  /** the canonical workspace path of the record, or of the read that took it, or null */
  workspace: string | null
  /** the `statusAt` of the newest move of the item */
  lastMoveAt: number
  appliedAt?: number
  /** discovery counts for the row text: they never decide due */
  candidates?: { baseline: number; later: number }
  check?: 'ran' | 'deferred'
  checkpoint?: CohortCheckpoint | null
  verdict?: CohortVerdict
  final?: boolean
  leaning?: 'worse'
  cannotVerify?: CannotVerify
  /** the `EARLIER_MAX` newest earlier records of the same workspace and rule */
  earlier: QueueEarlier[]
  /** the count of every earlier record, so a cut list hides none of them */
  earlierCount: number
  /** a handoff command, or null when no step can run now */
  next: string | null
}

export interface QueueCounts {
  verdict: number
  regressed: number
  apply: number
  review: number
  running: number
  wait: number
  /** the items that 1 step can close now: the `verdict` group */
  due: number
  /** every item of the 6 groups */
  open: number
}

/** The queue read, v1. */
export interface SuggestionQueue {
  v: 1
  /** the canonical workspace path, or `all` */
  scope: string
  now: number
  counts: QueueCounts
  groups: Record<QueueGroup, QueueItem[]>
  /** the open global records that a workspace read leaves out, 0 in a read of every workspace */
  globalOpen: number
}

export interface QueueInput {
  now: number
  /** the workspace of the read, or absent for every workspace */
  workspace?: WorkspaceMembership
  /** every record of the store: the last line of each id */
  records: readonly SuggestionRecord[]
  /** every valid store line in file order, for the moves */
  lines: readonly SuggestionRecord[]
  /** the queue check of each applied record that has one, by record id */
  checks?: Readonly<Record<string, QueueCheck>>
  /** the file times of the sessions of the workspace of each applied record, by record id */
  discovered?: Readonly<Record<string, readonly number[]>>
}

function canonicalId(id: string): string {
  if (!isSuggestionId(id)) throw new Error(`${JSON.stringify(id)} is not a suggestion id`)
  return id
}

/** The handoff that measures and records the verdict of a change, or that asks keep or undo after a regression. */
export function verifyCommand(id: string): string {
  return `claude "/orangu:improve --verify ${canonicalId(id)}"`
}

/** The handoff that applies a reviewed proposal. */
export function applyCommand(id: string): string {
  return `claude "/orangu:apply ${canonicalId(id)}"`
}

/** A frozen baseline that passes the store's own check, or undefined. */
function trustedFrozen(record: SuggestionRecord): SuggestionRecord['frozenBaseline'] {
  const frozen = record.frozenBaseline
  return frozen !== undefined && frozenBaselineViolation(frozen, applicationTime(record)) === undefined ? frozen : undefined
}

/**
 * The 2 discovery counts of an applied record: the frozen baseline (or, for an older record, the sessions last written
 * before the change), and the later sessions that are quiet at `now`. Each stops at `COHORT_MAX`. Undefined when the
 * workspace gave no file times.
 */
export function candidatesOf(record: SuggestionRecord, times: readonly number[] | undefined, now: number): { baseline: number; later: number } | undefined {
  const appliedAt = applicationTime(record)
  if (times === undefined || appliedAt === undefined) return undefined
  const frozen = trustedFrozen(record)
  const baseline = frozen ? frozen.sessions.length : times.filter((time) => time < appliedAt).length
  const later = times.filter((time) => time > appliedAt && now - time >= MIN_VERIFICATION_QUIET_MS).length
  return { baseline: Math.min(baseline, COHORT_MAX), later: Math.min(later, COHORT_MAX) }
}

/**
 * Why an applied record cannot verify: the first value that applies, in this order. A frozen baseline below
 * `COHORT_MIN` (it can close only as unproven). Reviewed checks with no direction (it waits for the complete
 * checkpoint). An older record with no frozen baseline and fewer than `COHORT_MIN` baseline sessions on disk. A record
 * with no structured proposal, workspace or checks.
 */
export function cannotVerifyOf(record: SuggestionRecord, candidates: { baseline: number } | undefined): CannotVerify | undefined {
  if (record.status !== 'applied') return undefined
  const frozen = trustedFrozen(record)
  if (frozen && frozen.sessions.length < COHORT_MIN) return 'few-baseline-sessions'
  // A list of checks that is not in its form counts as no checks: the record is then a legacy record.
  const checks = reviewedChecks(record)
  if (checks?.length && !checks.some((check) => isDirectional(check.comparison))) return 'no-directional-check'
  const structured = record.proposal?.v === 1 && typeof record.proposal.workspace?.cwd === 'string' && !!checks?.length
  if (structured && record.frozenBaseline === undefined && (candidates?.baseline ?? 0) < COHORT_MIN) return 'baseline-gone'
  if (!structured) return 'legacy-record'
  return undefined
}

/** The group of an open record; undefined for a closed one. */
function groupOf(record: SuggestionRecord, cannotVerify: CannotVerify | undefined, check: QueueCheck | undefined): QueueGroup | undefined {
  switch (record.status) {
    case 'new':
    case 'failed':
      return 'review'
    case 'proposed':
      return record.scope === 'global' ? 'review' : 'apply'
    case 'kicked-off':
      return 'running'
    case 'regressed':
      return 'regressed'
    case 'applied': {
      if (cannotVerify === 'baseline-gone' || cannotVerify === 'legacy-record') return 'review'
      const due = cannotVerify === 'few-baseline-sessions' || (check?.check === 'ran' && check.final)
      return due ? 'verdict' : 'wait'
    }
    default:
      return undefined
  }
}

/** The next step of an item: a handoff, or null for a global proposal and for a record that waits. */
function nextOf(record: SuggestionRecord, group: QueueGroup): string | null {
  switch (group) {
    case 'verdict':
    case 'regressed':
      return verifyCommand(record.id)
    case 'apply':
      return applyCommand(record.id)
    case 'review':
      if (record.status === 'applied') return verifyCommand(record.id)
      if (record.status === 'proposed') return null
      return kickoffCommands({ ...record, id: canonicalId(record.id) }, 'serve').claude
    case 'running':
      return kickoffCommands({ ...record, id: canonicalId(record.id) }, 'serve').claude
    case 'wait':
      return null
  }
}

/** The canonical workspace path of a record, or undefined. */
const ownWorkspace = workspaceOf

/** The keys of an applied item, in the order of the item shape: the time, the counts, the queue check and the reason. */
type AppliedKeys = Pick<QueueItem, 'appliedAt' | 'candidates' | 'check' | 'checkpoint' | 'verdict' | 'final' | 'leaning' | 'cannotVerify'>

function appliedKeys(record: SuggestionRecord, input: QueueInput): AppliedKeys {
  const appliedAt = applicationTime(record)
  const candidates = candidatesOf(record, input.discovered?.[record.id], input.now)
  const cannotVerify = cannotVerifyOf(record, candidates)
  const check = input.checks?.[record.id]
  const measured: AppliedKeys =
    check?.check === 'ran'
      ? { check: 'ran', checkpoint: check.checkpoint, verdict: check.verdict, final: check.final, ...(check.leaning ? { leaning: check.leaning } : {}) }
      : check?.check === 'deferred'
        ? { check: 'deferred' }
        : {}
  return {
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    ...(candidates ? { candidates } : {}),
    ...measured,
    ...(cannotVerify ? { cannotVerify } : {}),
  }
}

const newestFirst = (moves: ReadonlyMap<string, number>) => (a: SuggestionRecord, b: SuggestionRecord): number =>
  (moves.get(b.id) ?? b.statusAt) - (moves.get(a.id) ?? a.statusAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The queue of 1 workspace (the workspace rule of `inWorkspace`, with the global records left out and counted), or of
 * every workspace. In a workspace read every record is of that workspace, so the fold and the earlier records take
 * the read's path. In a read of every workspace they take the record's own path, and a record with none is folded
 * with no other record and gets no earlier record.
 */
export function buildQueue(input: QueueInput): SuggestionQueue {
  const membership = input.workspace
  // The store accepts only canonical ids, so any other id is not a store record and is left out.
  const records = input.records.filter((record) => isSuggestionId(record.id))
  const moves = lastMoveTimes(records, input.lines)
  const members = membership ? records.filter((record) => inWorkspace(record, membership)) : records
  const workspaceKey = (record: SuggestionRecord): string | undefined => (membership ? membership.cwd : ownWorkspace(record))
  const sorted = [...members].sort(newestFirst(moves))

  const groups: Record<QueueGroup, QueueItem[]> = { verdict: [], regressed: [], apply: [], review: [], running: [], wait: [] }
  const folded = new Map<string, SuggestionRecord[]>()
  const placed: Array<{ group: QueueGroup; records: SuggestionRecord[] }> = []
  // The earlier records of each workspace and rule, closed or regressed, newest move first: 1 index for the read.
  const earlier = new Map<string, { entries: Array<{ id: string; entry: QueueEarlier }>; ids: Set<string> }>()
  for (const record of sorted) {
    try {
      const key = workspaceKey(record)
      if (key !== undefined && (CLOSED.includes(record.status) || record.status === 'regressed')) {
        const reasonCode = reasonCodeOf(record)
        const entry: QueueEarlier = { id: record.id, status: record.status, verdict: recordVerdict(record).verdict, ...(reasonCode !== undefined ? { reasonCode } : {}) }
        const indexKey = JSON.stringify([key, record.ruleId])
        const found = earlier.get(indexKey)
        if (found) {
          found.entries.push({ id: record.id, entry })
          found.ids.add(record.id)
        } else earlier.set(indexKey, { entries: [{ id: record.id, entry }], ids: new Set([record.id]) })
      }
      if (CLOSED.includes(record.status)) continue
      const candidates = record.status === 'applied' ? candidatesOf(record, input.discovered?.[record.id], input.now) : undefined
      const cannotVerify = cannotVerifyOf(record, candidates)
      const group = groupOf(record, cannotVerify, input.checks?.[record.id])
      if (group === undefined) continue
      if ((record.status === 'new' || record.status === 'failed') && key !== undefined) {
        const foldKey = JSON.stringify([key, record.scope, record.ruleId])
        const fold = folded.get(foldKey)
        if (fold) {
          fold.push(record)
          continue
        }
        folded.set(foldKey, [record])
        placed.push({ group, records: folded.get(foldKey)! })
        continue
      }
      placed.push({ group, records: [record] })
    } catch {
      // A record that still fails is left out, and the read goes on.
    }
  }

  // The EARLIER_MAX newest earlier records of the item, and the count of all of them. The work is the cap, not the list.
  const earlierOf = (item: SuggestionRecord, ids: ReadonlySet<string>): { list: QueueEarlier[]; count: number } => {
    const key = workspaceKey(item)
    const found = key === undefined ? undefined : earlier.get(JSON.stringify([key, item.ruleId]))
    if (!found) return { list: [], count: 0 }
    let own = 0
    for (const id of ids) if (found.ids.has(id)) own++
    const list: QueueEarlier[] = []
    for (const { id, entry } of found.entries) {
      if (list.length >= EARLIER_MAX) break
      if (!ids.has(id)) list.push(entry)
    }
    return { list, count: found.entries.length - own }
  }

  for (const { group, records: itemRecords } of placed) {
    try {
      const record = itemRecords[0]!
      const ids = itemRecords.map((r) => r.id)
      const changeClass = changeClassOf(record)
      const earlierRecords = earlierOf(record, new Set(ids))
      groups[group].push({
        group,
        id: record.id,
        ids,
        status: record.status,
        scope: record.scope,
        ruleId: ruleIdOf(record),
        ...(changeClass !== undefined ? { changeClass } : {}),
        title: record.title,
        workspace: ownWorkspace(record) ?? membership?.cwd ?? null,
        lastMoveAt: Math.max(...itemRecords.map((r) => moves.get(r.id) ?? r.statusAt)),
        ...(record.status === 'applied' ? appliedKeys(record, input) : {}),
        earlier: earlierRecords.list,
        earlierCount: earlierRecords.count,
        next: nextOf(record, group),
      })
    } catch {
      // An item that still fails is left out, and the read goes on.
    }
  }

  const counts: QueueCounts = {
    verdict: groups.verdict.length,
    regressed: groups.regressed.length,
    apply: groups.apply.length,
    review: groups.review.length,
    running: groups.running.length,
    wait: groups.wait.length,
    due: groups.verdict.length,
    open: QUEUE_GROUPS.reduce((sum, group) => sum + groups[group].length, 0),
  }
  const globalOpen = membership ? records.filter((record) => record.scope === 'global' && !CLOSED.includes(record.status)).length : 0
  return { v: 1, scope: membership ? membership.cwd : 'all', now: input.now, counts, groups, globalOpen }
}

/** The cap of the todo read on the CLI, in bytes of the exact output with its trailing newline. */
export const TODO_MAX_BYTES = 8_192

/** The groups of the todo read, in order: every group that has a step to take. */
const TODO_GROUPS: readonly QueueGroup[] = ['verdict', 'regressed', 'apply', 'review', 'running']

/** 1 open item that needs a step, for a skill: no title and no text. */
export interface TodoItem {
  group: QueueGroup
  id: string
  status: SuggestionStatus
  scope: SuggestionScope
  /** null when the stored rule id is not an analyzer rule id or `harness:` and a change class */
  ruleId: string | null
  changeClass?: ChangeClass
  cannotVerify?: CannotVerify
}

/** The todo read, v1: the items of 1 workspace that need a step, in group order. */
export interface TodoRead {
  v: 1
  workspace: string
  counts: QueueCounts
  maxBytes: number
  omitted: number
  items: TodoItem[]
}

/**
 * The todo read of the queue of 1 workspace: its counts, and the first items of the groups that have a step, in group
 * order, that fit `TODO_MAX_BYTES` of the output. `omitted` counts the rest. `measure` gives the bytes of the exact
 * output form, the `--json` form by default.
 */
export function buildTodo(queue: SuggestionQueue, options: { measure?: (read: TodoRead) => number } = {}): TodoRead {
  if (queue.scope === 'all') throw new Error('the todo read takes the queue of 1 workspace')
  const items = TODO_GROUPS.flatMap((group) =>
    queue.groups[group].map((item): TodoItem => ({
      group: item.group,
      id: item.id,
      status: item.status,
      scope: item.scope,
      ruleId: item.ruleId,
      ...(item.changeClass !== undefined ? { changeClass: item.changeClass } : {}),
      ...(item.cannotVerify !== undefined ? { cannotVerify: item.cannotVerify } : {}),
    })),
  )
  const build = (kept: TodoItem[], omitted: number): TodoRead => ({ v: 1, workspace: queue.scope, counts: { ...queue.counts }, maxBytes: TODO_MAX_BYTES, omitted, items: kept })
  return fitFirst(items, build, options.measure ?? jsonBytes, TODO_MAX_BYTES)
}
