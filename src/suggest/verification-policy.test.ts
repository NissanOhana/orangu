import { describe, expect, it } from 'vitest'
import type { SuggestionRecord, SuggestionVerificationReceiptV2 } from './types.js'
import { applicationTime, cohortReceiptSummary, isTrustedComputedVerification } from './verification-policy.js'

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
