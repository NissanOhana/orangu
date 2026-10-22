import { describe, expect, it } from 'vitest'
import { COHORT_SKIP_REASONS, type CohortSkipReason } from './cohort-skip-reasons.js'
import { evaluateCheck, overallVerdict } from './cohort-stats.js'
import {
  SUGGESTION_VERIFICATION_METRICS,
  type SuggestionFrozenBaseline,
  type SuggestionOutcomeReceipt,
  type SuggestionRecord,
  type SuggestionVerificationIntent,
  type SuggestionVerificationMetric,
  type SuggestionVerificationReceiptV2,
} from './types.js'
import {
  applicationTime,
  cohortReceiptSummary,
  frozenBaselineViolation,
  isTrustedComputedVerification,
  outcomeReceiptViolation,
} from './verification-policy.js'

const APPLIED_AT = 5_000

function v2Receipt(over: Partial<SuggestionVerificationReceiptV2> = {}): SuggestionVerificationReceiptV2 {
  const receipt: SuggestionVerificationReceiptV2 = {
    v: 2,
    method: 'cohort-rank-v1',
    alpha: 0.05,
    appliedAt: APPLIED_AT,
    summary: 'Later sessions beat the baseline beyond chance (3 before, 3 after, p ≤ 0.05): avgToolCalls decreased; avgToolErrors not-increased.',
    baselineSessionIds: ['b1', 'b2', 'b3'],
    measuredSessionIds: ['l1', 'l2', 'l3'],
    confoundedBy: [],
    checks: [
      {
        metric: 'avgToolCalls',
        comparison: 'decreased',
        name: 'avgToolCalls decreased',
        before: 12,
        after: 8,
        beforeMedian: 12,
        afterMedian: 8,
        pLower: 0.05,
        pHigher: 1,
        verdict: 'improved',
        evidence: 'avgToolCalls: 12 → 8 (median 12 → 8; exact rank test p=0.05; improved)',
        ok: true,
      },
      {
        metric: 'avgToolErrors',
        comparison: 'not-increased',
        name: 'avgToolErrors not-increased',
        before: 1,
        after: 1,
        beforeMedian: 1,
        afterMedian: 1,
        pLower: 0.65,
        pHigher: 0.65,
        verdict: 'held',
        evidence: 'avgToolErrors: 1 → 1 (median 1 → 1; exact rank test p=0.65; held)',
        ok: true,
      },
    ],
    ...over,
  }
  return receipt
}

function verifiedRecord(scope: SuggestionRecord['scope'], receipt: SuggestionVerificationReceiptV2 = v2Receipt()): SuggestionRecord {
  return {
    id: 'sg_0123456789ab',
    v: 2,
    createdAt: 1,
    source: 'report',
    scope,
    sessionIds: ['s1'],
    ruleId: 'reread-files',
    title: 'Re-read files',
    evidence: { estimated: true },
    proposal: {
      v: 1,
      title: 'Reviewed change',
      change: 'Change one file.',
      effort: 'S',
      files: ['src/a.ts'],
      proposalPath: '/p/sg_0123456789ab.md',
      manifestPath: '/p/sg_0123456789ab.json',
      changeClass: 'instruction',
      evidence: 'e',
      expectedEffect: 'x',
      risk: 'r',
      verification: 'v',
      verificationChecks: [
        { metric: 'avgToolCalls', comparison: 'decreased' },
        { metric: 'avgToolErrors', comparison: 'not-increased' },
      ],
      workspace: { cwd: '/w', device: '1', inode: '2' },
    },
    application: { v: 1, summary: 's', files: ['src/a.ts'], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.json' },
    appliedAt: APPLIED_AT,
    verificationReceipt: receipt,
    verificationTrust: 'computed-v2',
    effect: {
      before: { avgToolCalls: 12, avgToolErrors: 1 },
      after: { avgToolCalls: 8, avgToolErrors: 1 },
      measuredSessionIds: ['l1', 'l2', 'l3'],
    },
    status: 'verified',
    statusAt: 9_000,
  }
}

describe('applicationTime', () => {
  const base = verifiedRecord('session')
  it('prefers the stamped appliedAt', () => {
    expect(applicationTime(base)).toBe(APPLIED_AT)
  })
  it('falls back to statusAt only while the record is still applied', () => {
    expect(applicationTime({ ...base, appliedAt: undefined, status: 'applied', statusAt: 7_000 })).toBe(7_000)
    expect(applicationTime({ ...base, appliedAt: undefined, status: 'verified' })).toBeUndefined()
    expect(applicationTime({ ...base, appliedAt: undefined, status: 'rejected' })).toBeUndefined()
  })
})

describe('cohortReceiptSummary', () => {
  it('states the cohort sizes, the threshold, and the checks', () => {
    expect(cohortReceiptSummary(v2Receipt())).toBe(
      'Later sessions beat the baseline beyond chance (3 before, 3 after, p ≤ 0.05): avgToolCalls decreased; avgToolErrors not-increased.',
    )
  })
  it('qualifies a change measured together with other applied changes', () => {
    expect(cohortReceiptSummary(v2Receipt({ confoundedBy: ['sg_aaaaaaaaaaaa'] }))).toMatch(
      / Measured together with 1 other applied change; not attributable to this change alone\.$/,
    )
    expect(cohortReceiptSummary(v2Receipt({ confoundedBy: ['sg_aaaaaaaaaaaa', 'sg_bbbbbbbbbbbb'] }))).toMatch(
      / Measured together with 2 other applied changes; not attributable to this change alone\.$/,
    )
  })
})

describe('isTrustedComputedVerification', () => {
  it('trusts a v2 cohort receipt for session and repo scope', () => {
    expect(isTrustedComputedVerification(verifiedRecord('session'))).toBe(true)
    expect(isTrustedComputedVerification(verifiedRecord('repo'))).toBe(true)
  })

  it('never trusts a global verification', () => {
    expect(isTrustedComputedVerification(verifiedRecord('global'))).toBe(false)
  })

  it('re-grades each stored check from its own numbers', () => {
    const tampered = v2Receipt()
    tampered.checks[0] = { ...tampered.checks[0]!, pLower: 0.4, evidence: 'avgToolCalls: 12 → 8 (median 12 → 8; exact rank test p=0.4; improved)' }
    expect(isTrustedComputedVerification(verifiedRecord('session', tampered))).toBe(false)
  })

  it('rejects a receipt whose evidence text does not match its numbers', () => {
    const tampered = v2Receipt()
    tampered.checks[0] = { ...tampered.checks[0]!, evidence: 'avgToolCalls: 99 → 1 (much better)' }
    expect(isTrustedComputedVerification(verifiedRecord('session', tampered))).toBe(false)
  })

  it('rejects too few sessions, a wrong summary, or a mismatched trust marker', () => {
    const small = v2Receipt({ baselineSessionIds: ['b1', 'b2'], summary: v2Receipt().summary.replace('3 before', '2 before') })
    expect(isTrustedComputedVerification(verifiedRecord('session', small))).toBe(false)
    expect(isTrustedComputedVerification(verifiedRecord('session', v2Receipt({ summary: 'It worked.' })))).toBe(false)
    expect(isTrustedComputedVerification({ ...verifiedRecord('session'), verificationTrust: 'computed-v1' })).toBe(false)
  })

  it('keeps trusting a legacy computed-v1 session receipt', () => {
    const legacy: SuggestionRecord = {
      ...verifiedRecord('session'),
      proposal: { ...verifiedRecord('session').proposal!, verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }] },
      verificationTrust: 'computed-v1',
      verificationReceipt: {
        v: 1,
        summary: 'Later-session comparison passed: avgToolCalls decreased.',
        measuredSessionIds: ['later'],
        checks: [
          { name: 'avgToolCalls decreased', metric: 'avgToolCalls', comparison: 'decreased', before: 12, after: 8, evidence: 'avgToolCalls: 12 → 8 (decreased)', ok: true },
        ],
        receiptPath: '/p/sg_0123456789ab.verified.json',
      },
      effect: { before: { avgToolCalls: 12 }, after: { avgToolCalls: 8 }, measuredSessionIds: ['later'] },
    }
    expect(isTrustedComputedVerification(legacy)).toBe(true)
  })
})

const sid = (n: number): string => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const DECREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'decreased' }

/** A frozen baseline with 1 session for each entry: a number for every metric, or the named metrics with 0 for the rest. */
function frozen(cutAt: number, entries: Array<number | Partial<Record<SuggestionVerificationMetric, number>>>): SuggestionFrozenBaseline {
  return {
    v: 1,
    cutAt,
    sessions: entries.map((entry, index) => ({
      id: sid(index),
      startedAt: 1 + index,
      endedAt: 2 + index,
      metrics: Object.fromEntries(
        SUGGESTION_VERIFICATION_METRICS.map((metric) => [metric, typeof entry === 'number' ? entry : entry[metric] ?? 0]),
      ) as Record<SuggestionVerificationMetric, number>,
    })),
    skipped: Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>,
  }
}

/** A receipt graded by the cohort statistics from the baseline values and the later values. */
function graded(before: number[], after: number[], over: Partial<SuggestionOutcomeReceipt> = {}): SuggestionOutcomeReceipt {
  const check = evaluateCheck(DECREASED, before, after)
  const verdict = overallVerdict([check], before.length, after.length)
  if (verdict === 'verified') throw new Error('these values verify')
  const { evidence, ...numbers } = check
  void evidence
  return {
    v: 1,
    method: 'cohort-rank-v1',
    alpha: 0.05,
    appliedAt: APPLIED_AT,
    checkpoint: 'complete',
    verdict,
    laterComplete: true,
    confoundedBy: [],
    baselineSessionIds: before.map((_, index) => sid(index)),
    measuredSessionIds: after.map((_, index) => sid(100 + index)),
    checks: [numbers],
    ...over,
  }
}

const statusOf = (receipt: SuggestionOutcomeReceipt): 'regressed' | 'unproven' => (receipt.verdict === 'regressed' ? 'regressed' : 'unproven')

describe('outcomeReceiptViolation', () => {
  it('accepts a receipt graded from 0 to 10 sessions on each side', () => {
    const values = (count: number, start: number): number[] => Array.from({ length: count }, (_, index) => start + index)
    for (const [nBefore, nAfter] of [[0, 0], [0, 10], [10, 0], [1, 2], [3, 3], [10, 10]] as const) {
      const receipt = graded(values(nBefore, 1), values(nAfter, 11))
      const freeze = frozen(APPLIED_AT, values(nBefore, 1))
      expect(outcomeReceiptViolation(receipt, statusOf(receipt), [DECREASED], APPLIED_AT, freeze), `${nBefore} and ${nAfter}`).toBeUndefined()
    }
    expect(graded(values(10, 1), values(10, 11)).verdict).toBe('regressed')
    expect(graded(values(0, 1), values(10, 11)).verdict).toBe('not-enough-sessions')
  })

  it('refuses 11 sessions on either side', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => index)
    for (const receipt of [graded(eleven, [1, 2, 3]), graded([1, 2, 3], eleven)]) {
      expect(outcomeReceiptViolation(receipt, statusOf(receipt), [DECREASED], APPLIED_AT, undefined)).toMatch(/must be 0 to 10 sorted unique session ids/)
    }
  })

  it('grades the short frozen baseline exception against the stored frozen baseline', () => {
    const short = graded([1, 2], [3], { checkpoint: 'first', laterComplete: false })
    expect(outcomeReceiptViolation(short, 'unproven', [DECREASED], APPLIED_AT, frozen(APPLIED_AT, [1, 2]))).toBeUndefined()
    expect(outcomeReceiptViolation(short, 'unproven', [DECREASED], APPLIED_AT, undefined)).toMatch(/laterComplete must be true/)
    expect(outcomeReceiptViolation(short, 'unproven', [DECREASED], APPLIED_AT, frozen(APPLIED_AT, [1]))).toMatch(/baselineSessionIds must equal the frozen baseline/)
    expect(outcomeReceiptViolation(short, 'unproven', [DECREASED], APPLIED_AT, frozen(APPLIED_AT, [1, 4]))).toMatch(/before must be the mean of the frozen baseline, 2.5/)
    // A stored frozen baseline that fails its own check cannot open the exception.
    expect(outcomeReceiptViolation(short, 'unproven', [DECREASED], APPLIED_AT, frozen(APPLIED_AT + 1, [1, 2]))).toMatch(/the stored frozenBaseline is not valid/)
  })
})

describe('frozenBaselineViolation', () => {
  const ones = (count: number): number[] => Array.from({ length: count }, () => 1)
  it('accepts 0 to 10 sorted sessions with every metric and every skip reason', () => {
    for (const count of [0, 1, 10]) expect(frozenBaselineViolation(frozen(100, ones(count)), undefined), String(count)).toBeUndefined()
    expect(frozenBaselineViolation(frozen(100, ones(11)), undefined)).toMatch(/0 to 10 sessions/)
  })

  it('refuses a cut later than the application time when the caller names one', () => {
    expect(frozenBaselineViolation(frozen(100, ones(3)), 100)).toBeUndefined()
    expect(frozenBaselineViolation(frozen(101, ones(3)), 100)).toMatch(/cutAt must not be later than the application time/)
  })
})

describe('isTrustedComputedVerification with a frozen baseline', () => {
  // The 2 reviewed checks of v2Receipt: avgToolCalls 12 before (median 12), avgToolErrors 1 before (median 1).
  const session = { avgToolCalls: 12, avgToolErrors: 1 }
  const ids = [sid(0), sid(1), sid(2)]
  const bound = (freeze: SuggestionFrozenBaseline): SuggestionRecord => ({
    ...verifiedRecord('session', v2Receipt({ baselineSessionIds: ids })),
    frozenBaseline: freeze,
  })

  it('trusts a receipt that grades against the frozen sessions and their numbers', () => {
    expect(isTrustedComputedVerification(bound(frozen(APPLIED_AT, [session, session, session])))).toBe(true)
  })

  it('does not trust a receipt that names other baseline sessions, other numbers, or a frozen baseline that fails its check', () => {
    const freeze = frozen(APPLIED_AT, [session, session, session])
    expect(isTrustedComputedVerification({ ...verifiedRecord('session'), frozenBaseline: freeze })).toBe(false)
    expect(isTrustedComputedVerification(bound(frozen(APPLIED_AT, [session, session])))).toBe(false)
    expect(isTrustedComputedVerification(bound(frozen(APPLIED_AT, [session, session, { ...session, avgToolCalls: 30 }])))).toBe(false)
    expect(isTrustedComputedVerification(bound(frozen(APPLIED_AT, [session, session, { ...session, avgToolErrors: 0 }])))).toBe(false)
    expect(isTrustedComputedVerification(bound(frozen(APPLIED_AT + 1, [session, session, session])))).toBe(false)
  })
})
