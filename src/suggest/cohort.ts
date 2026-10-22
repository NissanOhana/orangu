/**
 * Orangu-owned cohorts for noise-aware verification.
 *
 * A proposal's own evidence sessions were chosen because they went badly, so they are a biased baseline, and a
 * later session the model picks is a chosen answer. Orangu therefore picks both sides itself from the
 * proposal's canonical workspace, cut at the recorded application time:
 *
 * - baseline: the most recent settled sessions that ended before application, minus the finding's own sessions. The
 *   apply step freezes them once (freezeBaseline), and a later read grades against the frozen numbers and reads no
 *   baseline transcript. An older record with no frozen baseline reads them live;
 * - later: the first settled sessions that started after application, graded at 2 checkpoints only: the first 3, then
 *   the complete cohort (10 sessions, or its byte budget spent).
 *
 * A session that spans the application belongs to neither, and neither does a session that ran orangu's own
 * lifecycle (an orangu skill or CLI call): checking a result must never become evidence for it. Reading is
 * sequential; a session over the 64 MiB evidence cap is skipped on either side, and each side has its own byte
 * budget and stops, in order, once it is spent, so session size cannot decide who is in a cohort. Discovery and
 * loading are injected so the selection rules are testable without disk.
 */
import { basename } from 'node:path'
import { MAX_EVIDENCE_SESSION_BYTES } from '../adapters/claude-code/evidence-input.js'
import { SESSION_ID_RE } from '../discover/discover.js'
import { COHORT_SKIP_REASONS, type CohortSkipReason } from './cohort-skip-reasons.js'
import {
  COHORT_ALPHA,
  COHORT_MAX,
  COHORT_MIN,
  evaluateCheck,
  overallVerdict,
  type CohortCheckResult,
  type CohortVerdict,
} from './cohort-stats.js'
import {
  SUGGESTION_VERIFICATION_METRICS,
  type SuggestionCohortCheck,
  type SuggestionFrozenBaseline,
  type SuggestionOutcomeCheck,
  type SuggestionOutcomeReceipt,
  type SuggestionRecord,
  type SuggestionVerificationMetric,
  type SuggestionVerificationReceiptV2,
  type SuggestionWorkspaceIdentity,
} from './types.js'
import { applicationTime, cohortReceiptSummary, frozenBaselineViolation } from './verification-policy.js'

/** Transcript budget per side (baseline, later); each session is also capped at the 64 MiB evidence limit. */
export const COHORT_SIDE_BYTES = 256 * 1024 * 1024

export { COHORT_SKIP_REASONS, type CohortSkipReason }

export interface CohortCandidate {
  sessionId: string
  path: string
  mtimeMs: number
}

export interface CohortSession {
  id: string
  path: string
  /** canonical (realpath) session cwd */
  cwd: string
  /** the session ran an orangu skill or CLI command; see ranOranguLifecycle */
  ranOrangu: boolean
  startedAt: number
  endedAt: number
  metrics: Record<SuggestionVerificationMetric, number>
}

/** The facts of 1 baseline session that a grade reads. A frozen baseline stores these and nothing more. */
export type CohortSessionFacts = Pick<CohortSession, 'id' | 'startedAt' | 'endedAt' | 'metrics'>

export type CohortLoad =
  | { session: CohortSession; bytesRead: number }
  | { skip: 'still-settling' | 'over-budget' | 'unreadable'; bytesRead: number }

export interface CohortDeps {
  listCandidates(workspaceCwd: string): Promise<CohortCandidate[]>
  loadCandidate(candidate: CohortCandidate, maxBytes: number): Promise<CohortLoad>
  /** Resolve the reviewed workspace identity to its canonical path; throws when it no longer matches. */
  canonicalWorkspace(identity: SuggestionWorkspaceIdentity): Promise<string>
}

/** The deps of a freeze: the cohort loaders, and the clock that gives the cut (`Date.now` when absent). */
export interface FreezeDeps extends CohortDeps {
  now?: () => number
}

/** 1 of the 2 points where orangu grades the later side: its first `COHORT_MIN` sessions, or the complete cohort. */
export type CohortCheckpoint = 'first' | 'complete'

export interface CohortEffect {
  id: string
  status: SuggestionRecord['status']
  scope: 'session' | 'repo'
  appliedAt: number
  /** graded at the latest checkpoint that the later side reached, or over the later sessions so far before the first */
  verdict: CohortVerdict
  /** the frozen baseline of the record, or the live baseline of an older record that has none */
  baseline: CohortSessionFacts[]
  /** the baseline is the record's frozen baseline, read from the store and from no transcript */
  baselineFrozen: boolean
  /** the graded later sessions: the first `COHORT_MIN` until the later cohort is complete, then all of it */
  later: CohortSession[]
  /** every later session accepted so far, the graded ones included */
  laterCount: number
  /** no newer session can join the later cohort: it holds ten, or its byte budget is spent */
  laterComplete: boolean
  checks: CohortCheckResult[]
  confoundedBy: string[]
  skipped: Record<CohortSkipReason, number>
}

/** The transcript facts a cohort metric reads, a subset of `Analysis`. */
export interface CohortAnalysis {
  summary: {
    totalTokens: number
    toolCalls: number
    toolErrors: number
    activeMs: number
    contextPeak: number
    outcomes: { testRunsFailed: number; buildRunsFailed: number }
  }
  turns: Array<{ interrupted: boolean }>
}

export function metricValues(analysis: CohortAnalysis): Record<SuggestionVerificationMetric, number> {
  const values: Record<SuggestionVerificationMetric, number> = {
    avgTotalTokens: analysis.summary.totalTokens,
    avgToolCalls: analysis.summary.toolCalls,
    avgToolErrors: analysis.summary.toolErrors,
    avgActiveMs: analysis.summary.activeMs,
    avgContextPeak: analysis.summary.contextPeak,
    avgTestRunsFailed: analysis.summary.outcomes.testRunsFailed,
    avgBuildRunsFailed: analysis.summary.outcomes.buildRunsFailed,
    avgInterruptions: analysis.turns.filter((turn) => turn.interrupted).length,
  }
  for (const metric of SUGGESTION_VERIFICATION_METRICS) {
    if (!Number.isFinite(values[metric]) || values[metric] < 0) throw new Error(`analysis has an invalid ${metric} value`)
  }
  return values
}

const ORANGU_SKILL_RE = /^\/?orangu[:-][a-z-]+$/i
const ORANGU_CLI_RE = /\borangu(?:\.cli\.mjs|\.js)?["']?\s+(?:suggest|evidence|estimate|harness)\b/

/**
 * True when a session ran orangu itself: an orangu skill (Skill tool or slash command) or an orangu CLI call that
 * reads evidence or moves a suggestion. Such a session is a check-in on the work, not the work.
 */
export function ranOranguLifecycle(session: {
  skills: ReadonlyArray<{ name: string }>
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>
}): boolean {
  if (session.skills.some((skill) => ORANGU_SKILL_RE.test(skill.name.trim()))) return true
  return session.toolCalls.some((call) => {
    if (call.name !== 'Bash' || !call.input || typeof call.input !== 'object') return false
    const command = (call.input as { command?: unknown }).command
    return typeof command === 'string' && ORANGU_CLI_RE.test(command)
  })
}

/** Session ids named by the finding, whether given as a UUID or as a transcript path. */
function evidenceSessionIds(selectors: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const selector of selectors) {
    const trimmed = selector.trim()
    for (const candidate of [trimmed, basename(trimmed).replace(/\.jsonl$/i, '')]) {
      if (SESSION_ID_RE.test(candidate)) ids.add(candidate.toLowerCase())
    }
  }
  return ids
}

const byPath = (a: CohortCandidate, b: CohortCandidate): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Baseline candidates, newest first: each was last written before the cut. */
const baselineCandidates = (candidates: readonly CohortCandidate[], cutAt: number): CohortCandidate[] =>
  candidates.filter((c) => c.mtimeMs < cutAt).sort((a, b) => b.mtimeMs - a.mtimeMs || byPath(a, b))

/** Later candidates, oldest first: each was last written after the cut. */
const laterCandidates = (candidates: readonly CohortCandidate[], cutAt: number): CohortCandidate[] =>
  candidates.filter((c) => c.mtimeMs > cutAt).sort((a, b) => a.mtimeMs - b.mtimeMs || byPath(a, b))

const noSkips = (): Record<CohortSkipReason, number> => Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>

/** What the sides of 1 cohort read share: the workspace, the cut, the sessions to leave out, and the skip counts. */
interface TakeContext {
  deps: CohortDeps
  cwd: string
  /** the application time, or the freeze time of a frozen baseline */
  cutAt: number
  /** the finding's own sessions */
  excluded: ReadonlySet<string>
  /** the ids that a side took already, so the 2 cohorts stay disjoint */
  seen: Set<string>
  skipped: Record<CohortSkipReason, number>
}

/**
 * The take rules of 1 side, in list order: at most `COHORT_MAX` sessions, never the finding's own, each read inside
 * the side's byte budget, and each settled, in the workspace, wholly on its side of the cut, and not an orangu session.
 * The freeze and the measure step share them, so a frozen baseline holds the sessions that a live read takes.
 */
async function take(ctx: TakeContext, list: CohortCandidate[], side: 'baseline' | 'later'): Promise<{ accepted: CohortSession[]; budgetSpent: boolean }> {
  const { deps, cwd, cutAt, excluded, seen, skipped } = ctx
  const accepted: CohortSession[] = []
  let sideBytes = 0
  let budgetSpent = false
  for (const candidate of list) {
    if (accepted.length >= COHORT_MAX) break
    const id = candidate.sessionId.toLowerCase()
    if (seen.has(id)) continue
    if (excluded.has(id)) {
      skipped['evidence-session']++
      continue
    }
    const remaining = COHORT_SIDE_BYTES - sideBytes
    if (remaining < 1) {
      skipped['budget-spent']++
      budgetSpent = true
      break
    }
    const maxBytes = Math.min(MAX_EVIDENCE_SESSION_BYTES, remaining)
    const loaded = await deps.loadCandidate(candidate, maxBytes)
    sideBytes += loaded.bytesRead
    if ('skip' in loaded) {
      // Over the fixed per-session cap: skipped on either side alike. Over what is left of this side's
      // budget: the side stops here rather than reaching past it for smaller sessions.
      if (loaded.skip === 'over-budget' && maxBytes < MAX_EVIDENCE_SESSION_BYTES) {
        skipped['budget-spent']++
        budgetSpent = true
        break
      }
      skipped[loaded.skip]++
      continue
    }
    const session = loaded.session
    if (session.id.toLowerCase() !== id) {
      skipped.unreadable++
      continue
    }
    if (session.cwd !== cwd) {
      skipped['other-workspace']++
      continue
    }
    if (side === 'baseline' ? session.endedAt > cutAt : session.startedAt <= cutAt) {
      skipped['spans-application']++
      continue
    }
    if (session.ranOrangu) {
      skipped['orangu-session']++
      continue
    }
    seen.add(id)
    accepted.push({ ...session, id })
  }
  return { accepted, budgetSpent }
}

export async function measureCohortEffect(
  record: SuggestionRecord,
  others: readonly SuggestionRecord[],
  deps: CohortDeps,
): Promise<CohortEffect> {
  if (record.scope === 'global') throw new Error(`suggestion ${record.id}: global suggestions are review-only and cannot be verified`)
  if (record.status !== 'applied' && record.status !== 'verified') {
    throw new Error(`suggestion ${record.id} is not applied (status ${record.status})`)
  }
  const proposal = record.proposal
  const intents = proposal?.verificationChecks
  if (proposal?.v !== 1 || !proposal.workspace || !intents?.length) {
    throw new Error(`suggestion ${record.id} has no reviewed verification checks and workspace`)
  }
  const appliedAt = applicationTime(record)
  if (appliedAt === undefined) throw new Error(`suggestion ${record.id}: its application time is unknown, so later sessions cannot be cut from it`)
  // The stored frozen baseline crosses a JSON boundary: it passes the store's own check before any read, or nothing is graded.
  const frozen = record.frozenBaseline
  if (frozen !== undefined) {
    const violation = frozenBaselineViolation(frozen, appliedAt)
    if (violation) throw new Error(`suggestion ${record.id}: its frozen baseline is not valid (${violation})`)
  }

  const cwd = await deps.canonicalWorkspace(proposal.workspace)
  const candidates = await deps.listCandidates(cwd)
  // A frozen baseline brings the skip counts of its own read.
  const skipped = frozen ? { ...frozen.skipped } : noSkips()
  skipped['spans-application'] += candidates.filter((c) => c.mtimeMs === appliedAt).length
  const ctx: TakeContext = {
    deps,
    cwd,
    cutAt: appliedAt,
    excluded: evidenceSessionIds(record.sessionIds),
    seen: new Set<string>(frozen ? frozen.sessions.map((s) => s.id) : []),
    skipped,
  }
  // With a frozen baseline, no baseline transcript is read: the stored numbers and times are the baseline.
  const baseline: CohortSessionFacts[] = frozen
    ? frozen.sessions.map(({ id, startedAt, endedAt, metrics }) => ({ id, startedAt, endedAt, metrics: { ...metrics } }))
    : (await take(ctx, baselineCandidates(candidates, appliedAt), 'baseline')).accepted
  const laterSide = await take(ctx, laterCandidates(candidates, appliedAt), 'later')
  // Recheck after transcript I/O, so replacing the directory while sessions were read cannot keep its trust.
  if ((await deps.canonicalWorkspace(proposal.workspace)) !== cwd) {
    throw new Error(`suggestion ${record.id}: the reviewed workspace changed while its sessions were read`)
  }
  const laterComplete = laterSide.accepted.length >= COHORT_MAX || laterSide.budgetSpent
  // The 2 checkpoints: until the later cohort is complete, only its first COHORT_MIN sessions are graded. Those
  // sessions are fixed once they settle, so a look between the checkpoints gives the first verdict again.
  const later = laterComplete ? laterSide.accepted : laterSide.accepted.slice(0, COHORT_MIN)

  const checks = intents.map((intent) =>
    evaluateCheck(
      intent,
      baseline.map((s) => s.metrics[intent.metric]),
      later.map((s) => s.metrics[intent.metric]),
    ),
  )
  const measured = [...baseline, ...later]
  const windowStart = measured.length ? Math.min(...measured.map((s) => s.startedAt)) : appliedAt
  const windowEnd = measured.length ? Math.max(...measured.map((s) => s.endedAt)) : appliedAt
  const confoundedBy = [
    ...new Set(
      others
        .filter((other) => other.id !== record.id && other.proposal?.workspace?.cwd === proposal.workspace!.cwd)
        .filter((other) => {
          const at = applicationTime(other)
          return at !== undefined && at >= windowStart && at <= windowEnd
        })
        .map((other) => other.id),
    ),
  ].sort()

  return {
    id: record.id,
    status: record.status,
    scope: record.scope,
    appliedAt,
    verdict: overallVerdict(checks, baseline.length, later.length),
    baseline,
    baselineFrozen: frozen !== undefined,
    later,
    laterCount: laterSide.accepted.length,
    laterComplete,
    checks,
    confoundedBy,
    skipped,
  }
}

/**
 * Measure the baseline side once, at the apply step and before the `applied` move, so a later read grades against
 * these numbers and reads no baseline transcript. The cut is the clock time of the call, and the store stamps the
 * application time after it, so the cut is never later. The take rules of measureCohortEffect pick the sessions. The
 * result holds numbers and session ids only, sorted by id, and it passes the store's own check before it returns. A
 * throw means that no baseline is frozen: the caller writes the move without one and says so.
 *
 * `_others` keeps the call shape of measureCohortEffect. A freeze stores no confounder: the measure step names them from
 * the stored session times.
 */
export async function freezeBaseline(
  record: SuggestionRecord,
  _others: readonly SuggestionRecord[],
  deps: FreezeDeps,
): Promise<SuggestionFrozenBaseline> {
  if (record.scope === 'global') throw new Error(`suggestion ${record.id}: global suggestions are review-only and cannot be verified`)
  if (record.status !== 'proposed') throw new Error(`suggestion ${record.id} is not proposed (status ${record.status}), so it has no baseline to freeze`)
  const proposal = record.proposal
  if (proposal?.v !== 1 || !proposal.workspace || !proposal.verificationChecks?.length) {
    throw new Error(`suggestion ${record.id} has no reviewed verification checks and workspace`)
  }
  const cutAt = (deps.now ?? Date.now)()
  if (!Number.isFinite(cutAt) || cutAt <= 0) throw new Error(`suggestion ${record.id}: the clock gave no valid cut time, so the baseline cannot be frozen`)

  const cwd = await deps.canonicalWorkspace(proposal.workspace)
  const candidates = await deps.listCandidates(cwd)
  const skipped = noSkips()
  skipped['spans-application'] += candidates.filter((c) => c.mtimeMs === cutAt).length
  const ctx: TakeContext = { deps, cwd, cutAt, excluded: evidenceSessionIds(record.sessionIds), seen: new Set<string>(), skipped }
  const { accepted } = await take(ctx, baselineCandidates(candidates, cutAt), 'baseline')
  if ((await deps.canonicalWorkspace(proposal.workspace)) !== cwd) {
    throw new Error(`suggestion ${record.id}: the reviewed workspace changed while its baseline sessions were read`)
  }
  // A loader is a boundary: keep the 4 session keys and the 8 verification metrics, and nothing that it adds.
  const sessions = accepted
    .map((session) => ({
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      metrics: Object.fromEntries(SUGGESTION_VERIFICATION_METRICS.map((metric) => [metric, session.metrics[metric]])) as Record<SuggestionVerificationMetric, number>,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const frozen: SuggestionFrozenBaseline = { v: 1, cutAt, sessions, skipped }
  const violation = frozenBaselineViolation(frozen, undefined)
  if (violation) throw new Error(`suggestion ${record.id}: the baseline cannot be frozen (${violation})`)
  return frozen
}

/** Whether a step can record the verdict now: 1 answer for each row of the verdict table. */
export interface CohortFinality {
  /** the latest checkpoint that the later side reached, or null before the first */
  checkpoint: CohortCheckpoint | null
  /** a step can record the verdict now */
  final: boolean
  /** only when the first verdict is `regressed`: a hint computed on each read, never stored and never a lesson */
  leaning?: 'worse'
}

/**
 * The verdict table, 9 rows. A baseline below `COHORT_MIN` decides first: a frozen one cannot change, so its
 * `not-enough-sessions` is final at any later count, and the live baseline of an older record is never final. Else
 * nothing is final before the first checkpoint. A win is final at either checkpoint. Every other verdict waits for the
 * complete checkpoint, and a `regressed` first verdict shows only as `leaning: 'worse'`.
 */
export function effectFinality(effect: Pick<CohortEffect, 'verdict' | 'baseline' | 'baselineFrozen' | 'laterCount' | 'laterComplete'>): CohortFinality {
  const checkpoint: CohortCheckpoint | null = effect.laterComplete ? 'complete' : effect.laterCount >= COHORT_MIN ? 'first' : null
  if (effect.baseline.length < COHORT_MIN) return { checkpoint, final: effect.baselineFrozen }
  if (checkpoint === null) return { checkpoint, final: false }
  if (effect.verdict === 'verified' || checkpoint === 'complete') return { checkpoint, final: true }
  return effect.verdict === 'regressed' ? { checkpoint, final: false, leaning: 'worse' } : { checkpoint, final: false }
}

/** The checkpoint and the later sessions that it grades, for the next step. */
function checkpointLabel(effect: Pick<CohortEffect, 'later'>, checkpoint: CohortCheckpoint): string {
  if (checkpoint === 'first') return `the first checkpoint (the first ${COHORT_MIN} later sessions)`
  const n = effect.later.length
  return `the complete checkpoint (${n >= COHORT_MAX ? `${COHORT_MAX} of ${COHORT_MAX} later sessions` : `${n} later sessions, the byte budget is spent`})`
}

/**
 * One plain next step for each row of the verdict table. It names `orangu suggest --record <id>` exactly on the rows
 * where that step writes, and `orangu suggest --set <id> verified` on the 2 rows of a win. Before a checkpoint it says
 * how many settled sessions each side needs.
 */
export function nextStep(
  effect: Pick<CohortEffect, 'id' | 'status' | 'verdict' | 'baseline' | 'baselineFrozen' | 'later' | 'laterCount' | 'laterComplete'>,
): string {
  // Both recording steps take an applied record only, so a verified record has no step left.
  if (effect.status === 'verified') return 'already recorded as verified'
  const counts = `(has ${effect.baseline.length} before, ${effect.laterCount} after)`
  if (effect.baseline.length < COHORT_MIN) {
    if (effect.baselineFrozen) {
      return `the frozen baseline has ${effect.baseline.length} of the ${COHORT_MIN} sessions that a verdict needs, and it cannot change. Record it as unproven: orangu suggest --record ${effect.id}`
    }
    return `needs at least ${COHORT_MIN} settled sessions on each side ${counts}. This older record has no frozen baseline, so orangu cannot record a verdict. Reject it: orangu suggest --set ${effect.id} rejected --reason other`
  }
  const { checkpoint } = effectFinality(effect)
  if (checkpoint === null) return `needs at least ${COHORT_MIN} settled sessions on each side ${counts}. Orangu grades at ${COHORT_MIN} and at ${COHORT_MAX} later sessions`
  const at = checkpointLabel(effect, checkpoint)
  if (effect.verdict === 'verified') return `${at} beat the baseline beyond chance. Record it: orangu suggest --set ${effect.id} verified`
  if (checkpoint === 'first') {
    const wait = `That is not final. Orangu grades again when the later cohort is complete (${effect.laterCount} of ${COHORT_MAX} so far)`
    if (effect.verdict === 'regressed') return `${at} leans worse: a check moved the wrong way beyond chance. ${wait}`
    return `${at} did not beat the baseline beyond chance. ${wait}`
  }
  if (effect.verdict === 'regressed') return `${at} found a check that moved the wrong way beyond chance. Record it as regressed: orangu suggest --record ${effect.id}`
  return `${at} did not beat the baseline beyond chance. Record it as unproven: orangu suggest --record ${effect.id}`
}

/** The store patch for a verified effect; anything else is refused with its verdict and next step. */
export function verificationPatch(effect: CohortEffect): {
  verificationReceipt: SuggestionVerificationReceiptV2
  effect: NonNullable<SuggestionRecord['effect']>
} {
  if (effect.verdict !== 'verified') throw new Error(`not verified: ${effect.verdict}; ${nextStep(effect)}`)
  const checks: SuggestionCohortCheck[] = effect.checks.map((check) => ({
    metric: check.metric,
    comparison: check.comparison,
    name: check.name,
    before: check.before,
    after: check.after,
    beforeMedian: check.beforeMedian,
    afterMedian: check.afterMedian,
    pLower: check.pLower,
    pHigher: check.pHigher,
    verdict: check.verdict === 'improved' ? 'improved' : 'held',
    evidence: check.evidence,
    ok: true,
  }))
  const receipt: SuggestionVerificationReceiptV2 = {
    v: 2,
    method: 'cohort-rank-v1',
    alpha: COHORT_ALPHA,
    appliedAt: effect.appliedAt,
    summary: '',
    baselineSessionIds: effect.baseline.map((s) => s.id).sort(),
    measuredSessionIds: effect.later.map((s) => s.id).sort(),
    confoundedBy: [...effect.confoundedBy],
    checks,
  }
  receipt.summary = cohortReceiptSummary(receipt)
  return {
    verificationReceipt: receipt,
    effect: {
      before: Object.fromEntries(checks.map((check) => [check.metric, check.before])),
      after: Object.fromEntries(checks.map((check) => [check.metric, check.after])),
      measuredSessionIds: receipt.measuredSessionIds,
    },
  }
}

/**
 * The store patch for a final verdict that is not `verified`: the outcome receipt of a `regressed` move (its verdict is
 * `regressed`) or of an `unproven` move (any other verdict). It holds numbers, ids and enum values only, so each check
 * has the 10 keys of an outcome check and no evidence line. Anything else is refused with the step to take instead.
 */
export function outcomePatch(effect: CohortEffect): { outcomeReceipt: SuggestionOutcomeReceipt } {
  if (effect.status !== 'applied') throw new Error(`suggestion ${effect.id} is not applied (status ${effect.status})`)
  const verdict = effect.verdict
  if (verdict === 'verified') throw new Error(`record it as verified: orangu suggest --set ${effect.id} verified`)
  if (!effectFinality(effect).final) throw new Error(`not final: ${verdict}. ${nextStep(effect)}`)
  const checks: SuggestionOutcomeCheck[] = effect.checks.map((check) => ({
    metric: check.metric,
    comparison: check.comparison,
    name: check.name,
    before: check.before,
    after: check.after,
    beforeMedian: check.beforeMedian,
    afterMedian: check.afterMedian,
    pLower: check.pLower,
    pHigher: check.pHigher,
    verdict: check.verdict,
  }))
  return {
    outcomeReceipt: {
      v: 1,
      method: 'cohort-rank-v1',
      alpha: COHORT_ALPHA,
      appliedAt: effect.appliedAt,
      // The store accepts only this pairing: complete exactly when the later cohort is complete.
      checkpoint: effect.laterComplete ? 'complete' : 'first',
      verdict,
      laterComplete: effect.laterComplete,
      confoundedBy: [...effect.confoundedBy],
      baselineSessionIds: effect.baseline.map((s) => s.id).sort(),
      measuredSessionIds: effect.later.map((s) => s.id).sort(),
      checks,
    },
  }
}
