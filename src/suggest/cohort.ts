/**
 * Orangu-owned cohorts for noise-aware verification.
 *
 * A proposal's own evidence sessions were chosen because they went badly, so they are a biased baseline, and a
 * later session the model picks is a chosen answer. Orangu therefore picks both sides itself from the
 * proposal's canonical workspace, cut at the recorded application time:
 *
 * - baseline: the most recent settled sessions that ended before application, minus the finding's own sessions;
 * - later: the first settled sessions that started after application.
 *
 * A session that spans the application belongs to neither. Reading is sequential under a per-session and a
 * whole-cohort byte budget. Discovery and loading are injected so the selection rules are testable without disk.
 */
import { basename } from 'node:path'
import { MAX_EVIDENCE_SESSION_BYTES } from '../adapters/claude-code/evidence-input.js'
import { SESSION_ID_RE } from '../discover/discover.js'
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
  type SuggestionRecord,
  type SuggestionVerificationMetric,
  type SuggestionVerificationReceiptV2,
  type SuggestionWorkspaceIdentity,
} from './types.js'
import { applicationTime, cohortReceiptSummary } from './verification-policy.js'

/** Whole-cohort transcript budget: up to twenty sessions, each still capped at the 64 MiB evidence limit. */
export const COHORT_TOTAL_BYTES = 512 * 1024 * 1024

export const COHORT_SKIP_REASONS = [
  'evidence-session',
  'spans-application',
  'still-settling',
  'other-workspace',
  'over-budget',
  'unreadable',
] as const
export type CohortSkipReason = (typeof COHORT_SKIP_REASONS)[number]

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
  startedAt: number
  endedAt: number
  metrics: Record<SuggestionVerificationMetric, number>
}

export type CohortLoad =
  | { session: CohortSession; bytesRead: number }
  | { skip: 'still-settling' | 'over-budget' | 'unreadable'; bytesRead: number }

export interface CohortDeps {
  listCandidates(workspaceCwd: string): Promise<CohortCandidate[]>
  loadCandidate(candidate: CohortCandidate, maxBytes: number): Promise<CohortLoad>
  /** Resolve the reviewed workspace identity to its canonical path; throws when it no longer matches. */
  canonicalWorkspace(identity: SuggestionWorkspaceIdentity): Promise<string>
}

export interface CohortEffect {
  id: string
  scope: 'session' | 'repo'
  appliedAt: number
  verdict: CohortVerdict
  baseline: CohortSession[]
  later: CohortSession[]
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

export async function measureCohortEffect(
  record: SuggestionRecord,
  others: readonly SuggestionRecord[],
  deps: CohortDeps,
): Promise<CohortEffect> {
  if (record.scope === 'global') throw new Error(`suggestion ${record.id}: global suggestions are review-only and cannot be verified`)
  if (record.status !== 'applied' && record.status !== 'verified') {
    throw new Error(`suggestion ${record.id} has not been applied (status ${record.status})`)
  }
  const proposal = record.proposal
  const intents = proposal?.verificationChecks
  if (proposal?.v !== 1 || !proposal.workspace || !intents?.length) {
    throw new Error(`suggestion ${record.id} has no reviewed verification checks and workspace`)
  }
  const appliedAt = applicationTime(record)
  if (appliedAt === undefined) throw new Error(`suggestion ${record.id}: its application time is unknown, so later sessions cannot be cut from it`)

  const cwd = await deps.canonicalWorkspace(proposal.workspace)
  const candidates = await deps.listCandidates(cwd)
  const skipped = Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>
  const excluded = evidenceSessionIds(record.sessionIds)
  const baselineCandidates = candidates.filter((c) => c.mtimeMs < appliedAt).sort((a, b) => b.mtimeMs - a.mtimeMs || byPath(a, b))
  const laterCandidates = candidates.filter((c) => c.mtimeMs > appliedAt).sort((a, b) => a.mtimeMs - b.mtimeMs || byPath(a, b))
  skipped['spans-application'] += candidates.filter((c) => c.mtimeMs === appliedAt).length

  let bytesUsed = 0
  const seen = new Set<string>()
  const take = async (list: CohortCandidate[], side: 'baseline' | 'later'): Promise<CohortSession[]> => {
    const accepted: CohortSession[] = []
    for (const candidate of list) {
      if (accepted.length >= COHORT_MAX) break
      const id = candidate.sessionId.toLowerCase()
      if (seen.has(id)) continue
      if (excluded.has(id)) {
        skipped['evidence-session']++
        continue
      }
      const maxBytes = Math.min(MAX_EVIDENCE_SESSION_BYTES, COHORT_TOTAL_BYTES - bytesUsed)
      if (maxBytes < 1) {
        skipped['over-budget']++
        continue
      }
      const loaded = await deps.loadCandidate(candidate, maxBytes)
      bytesUsed += loaded.bytesRead
      if ('skip' in loaded) {
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
      if (side === 'baseline' ? session.endedAt > appliedAt : session.startedAt <= appliedAt) {
        skipped['spans-application']++
        continue
      }
      seen.add(id)
      accepted.push({ ...session, id })
    }
    return accepted
  }
  const baseline = await take(baselineCandidates, 'baseline')
  const later = await take(laterCandidates, 'later')

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
    scope: record.scope,
    appliedAt,
    verdict: overallVerdict(checks, baseline.length, later.length),
    baseline,
    later,
    checks,
    confoundedBy,
    skipped,
  }
}

/** One plain next step for each verdict. */
export function nextStep(effect: Pick<CohortEffect, 'id' | 'verdict' | 'baseline' | 'later'>): string {
  switch (effect.verdict) {
    case 'verified':
      return `record it: orangu suggest --set ${effect.id} verified`
    case 'within-noise':
      return `${effect.later.length} of ${COHORT_MAX} later sessions counted: add sessions, or reject the proposal`
    case 'not-enough-sessions':
      return `needs at least ${COHORT_MIN} settled sessions on each side (has ${effect.baseline.length} before, ${effect.later.length} after)`
    case 'regressed':
      return 'a check moved the wrong way beyond chance: review the change, or reject the proposal'
    case 'no-directional-check':
      return 'no reviewed check names a direction to improve, so nothing can be verified'
  }
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
