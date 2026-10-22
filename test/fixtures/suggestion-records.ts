/**
 * Fixture suggestion records for the queue, lesson and history reads. Each builder gives a record that the store's own
 * record check accepts, with a structured proposal where the status needs one. No transcript and no real path.
 */
import { COHORT_SKIP_REASONS, type CohortSkipReason } from '../../src/suggest/cohort-skip-reasons.js'
import type {
  SuggestionFrozenBaseline,
  SuggestionProposal,
  SuggestionRecord,
  SuggestionVerificationIntent,
  SuggestionVerificationMetric,
} from '../../src/suggest/types.js'

/** The application time of the fixtures, and the default `now` of a read: 1 day later. */
export const APPLIED_AT = Date.parse('2026-10-01T00:00:00.000Z')
export const NOW = APPLIED_AT + 24 * 60 * 60_000
export const WORKSPACE = '/w/repo'
export const OTHER_WORKSPACE = '/w/other'
export const DECREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'decreased' }
export const NOT_INCREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'not-increased' }

/** A lowercase session id. */
export const uuid = (n: number): string => `dddddddd-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
/** A canonical suggestion id. */
export const sg = (n: number): string => `sg_${n.toString(16).padStart(12, '0')}`

export const zeroSkips = (): Record<CohortSkipReason, number> =>
  Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>

export function metricsOf(toolCalls: number): Record<SuggestionVerificationMetric, number> {
  return { avgTotalTokens: 100, avgToolCalls: toolCalls, avgToolErrors: 0, avgActiveMs: 1_000, avgContextPeak: 10, avgTestRunsFailed: 0, avgBuildRunsFailed: 0, avgInterruptions: 0 }
}

/** A frozen baseline at the cut APPLIED_AT, 1 session for each tool-call value. */
export function frozenOf(values: number[]): SuggestionFrozenBaseline {
  return {
    v: 1,
    cutAt: APPLIED_AT,
    sessions: values.map((toolCalls, index) => ({
      id: uuid(index),
      startedAt: APPLIED_AT - 50_000 + index * 1_000,
      endedAt: APPLIED_AT - 40_000 + index * 1_000,
      metrics: metricsOf(toolCalls),
    })),
    skipped: zeroSkips(),
  }
}

/** A structured v1 proposal, bound to a workspace. */
export function proposalOf(cwd = WORKSPACE, checks: SuggestionVerificationIntent[] = [DECREASED]): SuggestionProposal {
  return {
    v: 1,
    title: 'Reviewed change',
    change: 'Change one file.',
    effort: 'S',
    files: ['CLAUDE.md'],
    proposalPath: '/p/a.md',
    manifestPath: '/p/a.json',
    changeClass: 'instruction',
    evidence: 'e',
    expectedEffect: 'x',
    risk: 'r',
    verification: 'v',
    verificationChecks: checks,
    workspace: { cwd, device: '1', inode: '2' },
  }
}

/** A `new` repo record of the rule `reread-files`; `over` changes any field. */
export function recordOf(id: string, over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  return {
    id,
    v: 2,
    key: { v: 2, source: 'report', scope: over.scope ?? 'repo', ruleId: over.ruleId ?? 'reread-files', sessionIds: over.sessionIds ?? [uuid(900)] },
    createdAt: 1,
    source: 'report',
    scope: 'repo',
    sessionIds: [uuid(900)],
    ruleId: 'reread-files',
    title: 'Re-read files',
    evidence: { estimated: true },
    status: 'new',
    statusAt: APPLIED_AT - 60_000,
    ...over,
  }
}

/** An `applied` record with a structured proposal, an application receipt and a frozen baseline of 3 sessions. */
export function appliedOf(id: string, over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  return recordOf(id, {
    proposal: proposalOf(),
    application: { v: 1, summary: 's', files: ['CLAUDE.md'], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.applied.json' },
    frozenBaseline: frozenOf([10, 11, 12]),
    appliedAt: APPLIED_AT,
    status: 'applied',
    statusAt: APPLIED_AT,
    ...over,
  })
}
