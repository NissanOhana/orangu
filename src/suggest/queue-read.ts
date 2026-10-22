/**
 * The queue reads: the queue, the todo read, the lesson read and the history, from the store, the sessions of a
 * workspace and, for the queue, the queue check of each applied record.
 *
 * The queue check runs `measureCohortEffect` over the loaders of 1 read, which `createQueueReadDeps` puts behind the
 * cohort facts cache with 1 byte budget for the read. It checks the applied records of the scope oldest application
 * first. A record past the budget is deferred, and a record whose check cannot run gets no check. No read writes the
 * store or a proposal file. Only the queue check may write cohort facts cache entries.
 */
import { claudeRoots, listSessions, SESSION_ID_RE } from '../discover/discover.js'
import { COHORT_SIDE_BYTES, effectFinality, measureCohortEffect, type CohortDeps } from './cohort.js'
import type { CohortFactsCache } from './cohort-cache.js'
import { CohortReadDeferred, createCachedCohortDeps, type CachedCohortDeps } from './cohort-deps.js'
import { buildHistory, buildLessonRead, inWorkspace, LESSONS_MAX_BYTES, type ChangeRow, type LessonRead, type ReadScope, type WorkspaceMembership } from './lessons.js'
import { buildQueue, buildTodo, cannotVerifyOf, candidatesOf, type QueueCheck, type SuggestionQueue, type TodoRead } from './queue.js'
import type { SuggestionRecord } from './types.js'
import { applicationTime } from './verification-policy.js'
import { liveWorkspaceIdentity } from './workspace-identity.js'

/** The most transcript bytes that 1 queue read parses on a cache miss: the later budget of 1 cohort. */
export const QUEUE_CHECK_BYTES = COHORT_SIDE_BYTES

/** The store reads of a queue read: the last line of each record, and every valid line in file order. */
export interface QueueReadStore {
  all(): Promise<SuggestionRecord[]>
  lines(id?: string): Promise<SuggestionRecord[]>
}

/** 1 workspace (`--cwd <dir>`, the default) or every workspace (`--all`). */
export type QueueTarget = { cwd: string } | 'all'
/** The lesson read and the history also read only the global records (`--scope global`). */
export type LessonTarget = QueueTarget | 'global'

export interface QueueReadDeps {
  /** the clock of the read: the settle rule and the `now` of the output */
  now: number
  /** the loaders of the queue check: 1 instance for each read, so its byte budget holds for every item */
  cohort: CohortDeps
  /** the canonical path of a workspace folder; throws when it is not a folder */
  canonical(dir: string): Promise<string>
  /** the lowercase ids of the sessions that discovery lists for a canonical workspace */
  workspaceSessionIds(cwd: string): Promise<string[]>
}

/**
 * The deps of 1 read on this machine: the cohort facts cache behind the trusted loaders, with `budgetBytes` for the
 * read (`QUEUE_CHECK_BYTES`, or 0 B for a count that may parse no transcript), and the discovery of every Claude root.
 */
export function createQueueReadDeps(options: { now: number; cache: CohortFactsCache | null; budgetBytes?: number }): QueueReadDeps & { cohort: CachedCohortDeps } {
  return {
    now: options.now,
    cohort: createCachedCohortDeps({ now: () => options.now, budgetBytes: options.budgetBytes ?? QUEUE_CHECK_BYTES, cache: options.cache }),
    // The same resolution as a reviewed proposal workspace: realpath, then a folder check.
    async canonical(dir) {
      return (await liveWorkspaceIdentity(dir)).cwd
    },
    async workspaceSessionIds(cwd) {
      const refs = await listSessions({ roots: await claudeRoots(), cwd })
      return refs.filter((ref) => SESSION_ID_RE.test(ref.sessionId)).map((ref) => ref.sessionId.toLowerCase())
    },
  }
}

/** The workspace of a folder: its canonical path and its sessions. */
export async function workspaceMembership(dir: string, deps: Pick<QueueReadDeps, 'canonical' | 'workspaceSessionIds'>): Promise<WorkspaceMembership> {
  const cwd = await deps.canonical(dir)
  return { cwd, sessionIds: await deps.workspaceSessionIds(cwd) }
}

async function readScope(target: LessonTarget, deps: QueueReadDeps): Promise<ReadScope> {
  return target === 'all' || target === 'global' ? target : { workspace: await workspaceMembership(target.cwd, deps) }
}

/**
 * The queue check of each applied record of the read, oldest application first, ties by id, and the file times of
 * the sessions of its workspace. A record that cannot verify, or that can close only as unproven, is not measured.
 */
export async function checkApplied(
  records: readonly SuggestionRecord[],
  all: readonly SuggestionRecord[],
  deps: Pick<QueueReadDeps, 'now' | 'cohort'>,
): Promise<{ checks: Record<string, QueueCheck>; discovered: Record<string, number[]> }> {
  const checks: Record<string, QueueCheck> = {}
  const discovered: Record<string, number[]> = {}
  const applied = records
    .filter((record) => record.status === 'applied')
    .sort((a, b) => (applicationTime(a) ?? a.statusAt) - (applicationTime(b) ?? b.statusAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const record of applied) {
    const identity = record.proposal?.workspace
    if (identity) {
      try {
        const cwd = await deps.cohort.canonicalWorkspace(identity)
        discovered[record.id] = (await deps.cohort.listCandidates(cwd)).map((candidate) => candidate.mtimeMs)
      } catch {
        // A workspace that moved or is gone has no discovery counts.
      }
    }
    const cannotVerify = cannotVerifyOf(record, candidatesOf(record, discovered[record.id], deps.now))
    if (cannotVerify !== undefined && cannotVerify !== 'no-directional-check') continue
    try {
      const effect = await measureCohortEffect(record, all, deps.cohort)
      const { checkpoint, final, leaning } = effectFinality(effect)
      // The graded baseline count lets the queue see a baseline that the take rules left short (`cannotVerifyOf`).
      checks[record.id] = { check: 'ran', checkpoint, verdict: effect.verdict, final, ...(leaning ? { leaning } : {}), baseline: effect.baseline.length }
    } catch (error) {
      // Past the budget the item is deferred. Any other failure leaves it with no check, and the read goes on.
      if (error instanceof CohortReadDeferred) checks[record.id] = { check: 'deferred' }
    }
  }
  return { checks, discovered }
}

/** The queue of 1 workspace, or of every workspace. */
export async function readQueue(store: QueueReadStore, target: QueueTarget, deps: QueueReadDeps): Promise<SuggestionQueue> {
  const [records, lines] = [await store.all(), await store.lines()]
  const workspace = target === 'all' ? undefined : await workspaceMembership(target.cwd, deps)
  const inRead = workspace ? records.filter((record) => inWorkspace(record, workspace)) : records
  const { checks, discovered } = await checkApplied(inRead, records, deps)
  return buildQueue({ now: deps.now, ...(workspace ? { workspace } : {}), records, lines, checks, discovered })
}

/** The todo read of 1 workspace, from the same queue. `measure` gives the bytes of the exact output form (`buildTodo`). */
export async function readTodo(store: QueueReadStore, cwd: string, deps: QueueReadDeps, options: { measure?: (read: TodoRead) => number } = {}): Promise<TodoRead> {
  return buildTodo(await readQueue(store, { cwd }, deps), options.measure ? { measure: options.measure } : {})
}

/** The lesson read: `LESSONS_MAX_BYTES` by default, null on the app route. `measure` gives the bytes of the exact output form. */
export async function readLessons(
  store: QueueReadStore,
  target: LessonTarget,
  deps: QueueReadDeps,
  options: { rules?: readonly string[]; maxBytes?: number | null; measure?: (read: LessonRead) => number } = {},
): Promise<LessonRead> {
  const scope = await readScope(target, deps)
  const [records, lines] = [await store.all(), await store.lines()]
  return buildLessonRead({
    records,
    lines,
    scope,
    ...(options.rules ? { rules: options.rules } : {}),
    maxBytes: options.maxBytes === undefined ? LESSONS_MAX_BYTES : options.maxBytes,
    ...(options.measure ? { measure: options.measure } : {}),
  })
}

/** The history: 1 change row for each applied record of the scope, oldest first. */
export async function readHistory(store: QueueReadStore, target: LessonTarget, deps: QueueReadDeps, options: { rules?: readonly string[] } = {}): Promise<ChangeRow[]> {
  const scope = await readScope(target, deps)
  const [records, lines] = [await store.all(), await store.lines()]
  return buildHistory({ records, lines, scope, ...(options.rules ? { rules: options.rules } : {}) })
}
