/**
 * Pure Suggest-screen row selection: plan rows per scope, Recoverable derived from the
 * same rows, and status-record matching by ruleId+scope across sources.
 */
import { describe, it, expect } from 'vitest'
import type { Analysis } from '../../model/analysis.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { SuggestionRecord } from '../../suggest/types.js'
import { suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import {
  SAVED_PROPOSAL_LIMIT,
  findingForRow,
  hasValidProposal,
  kickoffFailureMessage,
  megaCommand,
  planRows,
  recoverableFrom,
  recordForRow,
  savedProposalRecords,
  titleForRule,
} from './suggest-rows.js'

const analysis = {
  session: { id: 'sess-1' },
  insights: [
    {
      id: 'ins-1',
      ruleId: 'reread-files',
      title: 'Re-read files',
      detail: 'd1',
      recommendation: 'r1',
      savings: { tokens: 2000, ms: 60_000, estimated: true },
    },
    { id: 'ins-2', ruleId: 'context-bloat', title: 'Context bloat', detail: 'd2', recommendation: 'r2', savings: { tokens: 1000, estimated: true } },
  ],
} as unknown as Analysis

const agg = {
  sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
  crossFindings: [
    { ruleId: 'small', title: 'Small', sessions: 2, totalSavingsTokens: 500, totalSavingsMs: 1000, axis: 'tokens', severity: 'low', exampleSessionIds: ['a'] },
    { ruleId: 'big', title: 'Big', sessions: 5, totalSavingsTokens: 9000, totalSavingsMs: 120_000, axis: 'tokens', severity: 'high', exampleSessionIds: ['a', 'b'] },
    // `big` leads on BOTH severity and tokens here, so this fixture alone cannot tell the two
    // comparators apart — the mixed fixture in the test above is what pins severity-first.
  ],
} as unknown as Aggregate

describe('planRows', () => {
  it('keeps privacy-stripped findings actionable with deterministic, non-sensitive fallback copy', () => {
    const redacted = { ...analysis, insights: [{ ...analysis.insights[0]!, title: '', detail: '' }] }
    const row = planRows('session', redacted, undefined)[0]!
    expect(titleForRule('tool-errors')).toBe('Tool errors')
    expect(row.title).toBe('Reread files')
    expect(row.detail).toBe('The deterministic reread files rule matched this evidence.')
    expect(findingForRow(row, 'session').title).toBe('Reread files')
  })

  it('session scope: one row per insight, carrying the session id', () => {
    const rows = planRows('session', analysis, undefined)
    expect(rows.map((r) => r.ruleId)).toEqual(['reread-files', 'context-bloat'])
    expect(rows[0]!.sessionIds).toEqual(['sess-1'])
    expect(rows[0]!.recommendation).toBe('r1')
    expect(rows[0]!.insightId).toBe('ins-1')
  })
  // Severity-first, not savings-first. Omitting an unsupported savings figure must not demote a
  // high-severity finding beneath a low-severity finding that reports savings.
  it('a high finding with no savings outranks a low finding that has one', () => {
    const mixed = {
      sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      crossFindings: [
        { ruleId: 'write-not-edit', title: 'W', sessions: 11, totalSavingsTokens: 900_000, totalSavingsMs: 0, axis: 'tokens', severity: 'low', exampleSessionIds: ['a'] },
        { ruleId: 'cache-invalidation', title: 'C', sessions: 91, totalSavingsTokens: 0, totalSavingsMs: 0, axis: 'tokens', severity: 'high', exampleSessionIds: ['b'] },
        { ruleId: 'reread-files', title: 'R', sessions: 40, totalSavingsTokens: 100, totalSavingsMs: 0, axis: 'tokens', severity: 'high', exampleSessionIds: ['c'] },
      ],
    } as unknown as Aggregate
    const rows = planRows('repo', analysis, mixed)
    // both highs first; within `high`, the larger token figure leads
    expect(rows.map((r) => r.ruleId)).toEqual(['reread-files', 'cache-invalidation', 'write-not-edit'])
  })

  it('repo/global scope: rows come from crossFindings ranked severity-first, then by tokens', () => {
    const rows = planRows('repo', analysis, agg)
    expect(rows.map((r) => r.ruleId)).toEqual(['big', 'small'])
    expect(rows[0]!.sessionIds).toEqual(['a', 'b'])
    expect(rows[0]!.sessions).toBe(5)
    expect(rows[0]!.cohortFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(rows[0]!.savings).toEqual({ tokens: 9000, ms: 120_000, estimated: true })
    expect(rows[0]!.detail).toContain('5 sessions')
  })

  it('changes aggregate finding identity when the full cohort grows even if examples stay fixed', () => {
    const first = planRows('repo', analysis, agg)[0]!
    const grown = planRows('repo', analysis, { ...agg, sessions: [...agg.sessions, { id: 'new-session' }] } as unknown as Aggregate)[0]!
    expect(first.sessionIds).toEqual(grown.sessionIds)
    expect(suggestionIdV2(suggestionKey(findingForRow(first, 'repo'), 'report'))).not.toBe(
      suggestionIdV2(suggestionKey(findingForRow(grown, 'repo'), 'report')),
    )
  })
  it('repo/global scope without an aggregate yields no rows (designed empty state)', () => {
    expect(planRows('global', analysis, undefined)).toEqual([])
  })
})

describe('recoverableFrom', () => {
  it('sums tokens and ms over the rows it is given', () => {
    expect(recoverableFrom(planRows('session', analysis, undefined))).toEqual({ tokens: 3000, ms: 60_000 })
    // Repo/global Recoverable derives from crossFindings, not the selected session.
    expect(recoverableFrom(planRows('repo', analysis, agg))).toEqual({ tokens: 9500, ms: 121_000 })
  })
})

describe('finding identity and status', () => {
  const rec = (over: Partial<SuggestionRecord>): SuggestionRecord =>
    ({
      id: 'sg_x',
      v: 1,
      createdAt: 1,
      source: 'report',
      scope: 'session',
      sessionIds: ['sess-1'],
      ruleId: 'reread-files',
      title: 't',
      evidence: { estimated: true },
      status: 'new',
      statusAt: 1,
      ...over,
    }) as SuggestionRecord

  const row = planRows('session', analysis, undefined)[0]!
  const finding = findingForRow(row, 'session')
  const sid = suggestionIdV2(suggestionKey(finding, 'report'))

  it('builds the same scoped finding used for copy and run', () => {
    expect(finding).toMatchObject({ ruleId: 'reread-files', scope: 'session', sessionIds: ['sess-1'], insightId: 'ins-1' })
    expect(finding.evidence).toMatchObject({ savingsTokens: 2000, savingsMs: 60_000 })
  })

  it('matches the canonical id and does not collapse a different v2 source or scope', () => {
    const exact = rec({ id: sid, v: 2, status: 'proposed' })
    const other = rec({ id: 'sg_other', v: 2, source: 'skill', status: 'applied', statusAt: 99 })
    expect(recordForRow([other, exact], row, 'session', sid)?.status).toBe('proposed')
    expect(recordForRow([other], row, 'session', sid)).toBeUndefined()
  })

  it('keeps readable v1 records as a field-matched fallback and picks the freshest', () => {
    const old = rec({ id: 'sg_old', status: 'rejected', statusAt: 5, insightId: 'ins-1' })
    const fresh = rec({ id: 'sg_fresh', status: 'kicked-off', statusAt: 9, insightId: 'ins-1' })
    const otherScope = rec({ id: 'sg_other', scope: 'repo', status: 'applied', statusAt: 99 })
    expect(recordForRow([old, fresh, otherScope], row, 'session', sid)?.id).toBe('sg_fresh')
  })

  it('keeps whole-harness actions exact and scope-specific', () => {
    expect(megaCommand('repo')).toBe('claude "/orangu:mega --scope repo"')
    expect(megaCommand('global')).toBe('claude "/orangu:mega --scope global"')
  })

  it('keeps a persisted workflow failure visible after an SSE rerender', () => {
    expect(kickoffFailureMessage(rec({ status: 'failed', kickoff: { mode: 'serve', command: 'claude x', error: 'spawn claude ENOENT' } }))).toBe(
      'Improvement workflow failed: spawn claude ENOENT',
    )
    expect(kickoffFailureMessage(rec({ status: 'new' }))).toBe('')
  })
})

describe('saved proposal selection and handoffs', () => {
  const proposalRecord = (n: number, over: Partial<SuggestionRecord> = {}): SuggestionRecord => ({
    id: `sg_${n.toString(16).padStart(12, '0')}`,
    v: 2,
    createdAt: n,
    source: 'skill',
    scope: 'session',
    sessionIds: ['sess-1'],
    ruleId: `rule-${n}`,
    title: `Finding ${n}`,
    evidence: { estimated: true },
    proposal: { v: 1, title: `Proposal ${n}`, change: `Change ${n}`, effort: 'S', proposalPath: `/tmp/proposal-${n}.md` },
    status: 'proposed',
    statusAt: n,
    ...over,
  })

  it('accepts structured and legacy proposals but rejects unsafe command ids and malformed required fields', () => {
    expect(hasValidProposal(proposalRecord(1))).toBe(true)
    expect(hasValidProposal(proposalRecord(2, { proposal: { title: 'Legacy', change: 'Do it', effort: 'M', proposalPath: '/tmp/legacy.md' } }))).toBe(true)
    expect(hasValidProposal(proposalRecord(3, { id: 'sg_$(touch bad)' }))).toBe(false)
    expect(hasValidProposal(proposalRecord(4, { proposal: { v: 1, title: '', change: 'x', effort: 'S', proposalPath: '/tmp/x' } }))).toBe(false)
  })

  it('filters the session inbox to the selected id and removes every record represented by a measured row', () => {
    const row = planRows('session', analysis, undefined)[0]!
    const sid = suggestionIdV2(suggestionKey(findingForRow(row, 'session'), 'report'))
    const mapped = proposalRecord(20, { id: sid, source: 'report', ruleId: row.ruleId, insightId: row.insightId })
    const saved = proposalRecord(21)
    const otherSession = proposalRecord(22, { sessionIds: ['sess-2'] })
    expect(recordForRow([mapped, saved, otherSession], row, 'session', sid)).toBe(mapped)
    expect(savedProposalRecords([mapped, saved, otherSession], 'session', 'sess-1', [], [mapped])).toEqual([saved])
  })

  it('requires repo/global evidence overlap, deduplicates proposal paths, and caps the newest results', () => {
    const duplicatePath = '/tmp/shared.md'
    const records = Array.from({ length: SAVED_PROPOSAL_LIMIT + 4 }, (_, i) =>
      proposalRecord(100 + i, {
        scope: 'repo',
        sessionIds: i === 0 ? ['outside'] : ['active'],
        ...(i >= SAVED_PROPOSAL_LIMIT + 2 ? { proposal: { v: 1, title: `Duplicate ${i}`, change: 'x', effort: 'S', proposalPath: duplicatePath } } : {}),
      }),
    )
    const saved = savedProposalRecords(records, 'repo', undefined, ['active'], [])
    expect(saved).toHaveLength(SAVED_PROPOSAL_LIMIT)
    expect(saved.every((record) => record.sessionIds.includes('active'))).toBe(true)
    expect(saved.filter((record) => record.proposal?.proposalPath === duplicatePath)).toHaveLength(1)
    expect(saved[0]!.statusAt).toBeGreaterThan(saved.at(-1)!.statusAt)
    expect(savedProposalRecords(records, 'global', undefined, ['active'], [])).toEqual([])
  })
})
