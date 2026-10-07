import { describe, expect, it } from 'vitest'
import { aggregate } from '../analyze/aggregate.js'
import { analyzeSession } from '../analyze/analyze.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { findingForRow, planRows } from '../report/client/suggest-rows.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { decodeFinding, suggestionIdV2, suggestionKey } from './id.js'
import { slimAnalysis } from './slim.js'
import {
  DEFAULT_EVIDENCE_LIMIT,
  EVIDENCE_SCHEMA_VERSION,
  MAX_EVIDENCE_ARTIFACT_BYTES,
  MAX_EVIDENCE_INPUT_FINDINGS,
  MAX_EVIDENCE_LIMIT,
  estimateEvidence,
  parseEvidenceArtifact,
  projectEvidence,
} from './evidence.js'
import type { Analysis, Insight } from '../model/analysis.js'

async function canonical(): Promise<Analysis> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  return analyzeSession(session, { version: 'test', now: 0 })
}

function withInsights(analysis: Analysis, insights: Insight[]): Analysis {
  return { ...analysis, insights }
}

describe('projectEvidence', () => {
  it('projects Analysis and SlimAnalysis to the exact report-row finding identities', async () => {
    const analysis = await canonical()
    const expected = planRows('session', analysis, null).map((row) => findingForRow(row, 'session'))
    const full = projectEvidence(analysis, { limit: MAX_EVIDENCE_LIMIT })
    const slim = projectEvidence(slimAnalysis(analysis), { limit: MAX_EVIDENCE_LIMIT })

    expect(full.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION)
    expect(full.source).toMatchObject({ kind: 'analysis', scope: 'session', sessions: 1 })
    expect(slim.source.kind).toBe('slim-analysis')
    expect(full.findings.map((row) => row.finding)).toEqual(expected)
    expect(slim.findings.map((row) => row.finding)).toEqual(expected)
    expect(slim.findings.map((row) => row.suggestionId)).toEqual(full.findings.map((row) => row.suggestionId))

    for (const row of full.findings) {
      expect(row.suggestionId).toBe(suggestionIdV2(suggestionKey(row.finding, 'report')))
      expect(decodeFinding(row.findingToken)).toEqual({ v: 2, source: 'report', finding: row.finding })
    }
  })

  it('requires explicit Aggregate scope and preserves repo/global report-row parity', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    expect(() => projectEvidence(input)).toThrow(/explicit --scope repo\|global/)

    const expected = planRows('repo', undefined, input).map((row) => findingForRow(row, 'repo'))
    const repo = projectEvidence(input, { scope: 'repo', limit: MAX_EVIDENCE_LIMIT })
    const global = projectEvidence(input, { scope: 'global', limit: MAX_EVIDENCE_LIMIT })
    expect(repo.source).toMatchObject({ kind: 'aggregate', scope: 'repo', sessions: 1 })
    expect(repo.findings.map((row) => row.finding)).toEqual(expected)
    expect(repo.findings.map((row) => row.suggestionId)).not.toEqual(global.findings.map((row) => row.suggestionId))
    expect(global.findings.every((row) => row.finding.scope === 'global')).toBe(true)
  })

  it('changes Aggregate identities when the full cohort grows while examples stay the same', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    const first = projectEvidence(input, { scope: 'repo' })
    const grownInput = {
      ...input,
      sessionCount: input.sessionCount + 1,
      sessions: [...input.sessions, { ...input.sessions[0]!, id: 'cohort-growth-session' }],
    }
    const grown = projectEvidence(grownInput, { scope: 'repo' })
    expect(first.findings.map((row) => row.finding.sessionIds)).toEqual(grown.findings.map((row) => row.finding.sessionIds))
    expect(first.findings.map((row) => row.suggestionId)).not.toEqual(grown.findings.map((row) => row.suggestionId))
  })

  it('rejects impossible Aggregate recurrence counts and examples outside the cohort', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    const finding = input.crossFindings[0]!
    expect(() =>
      projectEvidence({ ...input, crossFindings: [{ ...finding, sessions: input.sessionCount + 1 }] }, { scope: 'repo' }),
    ).toThrow(/must not exceed Aggregate\.sessionCount/)
    expect(() =>
      projectEvidence({ ...input, crossFindings: [{ ...finding, exampleSessionIds: ['outside-the-cohort'] }] }, { scope: 'repo' }),
    ).toThrow(/must belong to Aggregate\.sessions/)
  })

  it('projects the cross-finding recommendation into repo and global rows, scrubbed of secrets', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    for (const scope of ['repo', 'global'] as const) {
      const bundle = projectEvidence(input, { scope, limit: MAX_EVIDENCE_LIMIT })
      expect(bundle.findings.length).toBeGreaterThan(0)
      for (const row of bundle.findings) {
        const source = input.crossFindings.find((f) => f.ruleId === row.finding.ruleId)!
        expect(row.recommendation).toMatch(/\S/)
        expect(row.recommendation).toBe(source.recommendation)
      }
    }
    const secret = 'sk-ant-api03-abc123def456ghi789'
    const planted = { ...input, crossFindings: input.crossFindings.map((f) => ({ ...f, recommendation: `Remove ${secret}` })) }
    const json = JSON.stringify(projectEvidence(planted, { scope: 'global' }))
    expect(json).not.toContain(secret)
    expect(json).toContain('‹anthropic-key›')
  })

  it('accepts older Aggregate JSON without a cross-finding recommendation and leaves the field out', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    const legacy = JSON.parse(JSON.stringify(input)) as { crossFindings: Array<Record<string, unknown>> }
    for (const f of legacy.crossFindings) delete f['recommendation']
    const bundle = parseEvidenceArtifact(JSON.stringify(legacy), { scope: 'repo' })
    expect(bundle.findings.length).toBeGreaterThan(0)
    for (const row of bundle.findings) expect('recommendation' in row).toBe(false)
    // the field is copy, not identity: the same findings keep the same suggestion ids with or without it
    expect(bundle.findings.map((row) => row.suggestionId)).toEqual(projectEvidence(input, { scope: 'repo' }).findings.map((row) => row.suggestionId))
  })

  it('rejects a cross-finding recommendation that is not a bounded string', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    const finding = input.crossFindings[0]!
    expect(() => projectEvidence({ ...input, crossFindings: [{ ...finding, recommendation: 42 }] }, { scope: 'repo' })).toThrow(
      /crossFindings\[0\]\.recommendation must be/,
    )
    expect(() => projectEvidence({ ...input, crossFindings: [{ ...finding, recommendation: 'x'.repeat(16_385) }] }, { scope: 'repo' })).toThrow(
      /crossFindings\[0\]\.recommendation exceeds/,
    )
  })

  it('keeps the evidence schema version at 1, because the rule text parts are additive', () => {
    expect(EVIDENCE_SCHEMA_VERSION).toBe('1')
  })

  it("carries each insight's own improvement, reason and method beside the whole recommendation", async () => {
    const analysis = await canonical()
    // the canonical session emits no method, so one insight carries a method to prove that it is copied too
    const withMethod: Insight = { ...analysis.insights[0]!, id: 'with-method-1', method: 'The rule counts each failed call once.' }
    const input = withInsights(analysis, [...analysis.insights, withMethod])
    for (const value of [input, slimAnalysis(input)]) {
      const bundle = projectEvidence(value, { limit: MAX_EVIDENCE_LIMIT })
      expect(bundle.findings.length).toBe(input.insights.length)
      for (const row of bundle.findings) {
        const source = input.insights.find((i) => i.id === row.finding.insightId)!
        expect(source.why, source.ruleId).toMatch(/\S/)
        expect(row.improvement, source.ruleId).toBe(source.improvement)
        expect(row.why, source.ruleId).toBe(source.why)
        expect(row.method, source.ruleId).toBe(source.method)
        expect(row.recommendation, source.ruleId).toBe(source.recommendation)
        // the parts are not the joined text: the improvement alone is shorter than the recommendation
        expect(row.improvement, source.ruleId).not.toBe(row.recommendation)
        // the marker-free title is a repo and global field only
        expect('exampleTitle' in row).toBe(false)
      }
      expect(bundle.findings.some((row) => row.method !== undefined)).toBe(true)
    }
  })

  it("carries each cross finding's improvement, reason, method and example title into repo and global rows", async () => {
    const analysis = await canonical()
    const withMethod: Insight = { ...analysis.insights[0]!, id: 'with-method-1', ruleId: 'method-rule', method: 'The rule counts each failed call once.' }
    const input = aggregate([withInsights(analysis, [...analysis.insights, withMethod])], 'repo demo', 0)
    for (const scope of ['repo', 'global'] as const) {
      const bundle = projectEvidence(input, { scope, limit: MAX_EVIDENCE_LIMIT })
      expect(bundle.findings.length).toBe(input.crossFindings.length)
      for (const row of bundle.findings) {
        const source = input.crossFindings.find((f) => f.ruleId === row.finding.ruleId)!
        expect(source.improvement, source.ruleId).toMatch(/\S/)
        expect(source.exampleTitle, source.ruleId).toMatch(/\S/)
        expect(row.improvement, source.ruleId).toBe(source.improvement)
        expect(row.why, source.ruleId).toBe(source.why)
        expect(row.method, source.ruleId).toBe(source.method)
        expect(row.exampleTitle, source.ruleId).toBe(source.exampleTitle)
        expect(row.recommendation, source.ruleId).toBe(source.recommendation)
        // the marked title stays the finding identity: the suggestion id and the token still hash it
        expect(row.finding.title, source.ruleId).toBe(source.title)
      }
      expect(bundle.findings.some((row) => row.method !== undefined)).toBe(true)
    }
  })

  it('shows the rule name as the example title when the example insight has an empty title, as the finding title does', async () => {
    const analysis = await canonical()
    const untitled: Insight = { ...analysis.insights[0]!, id: 'untitled-1', ruleId: 'untitled-rule', title: '' }
    const input = aggregate([withInsights(analysis, [untitled])], 'repo demo', 0)
    expect(input.crossFindings[0]).toMatchObject({ title: '', exampleTitle: '' })
    const row = projectEvidence(input, { scope: 'repo' }).findings[0]!
    expect(row.finding.title).toBe('Untitled rule')
    expect(row.exampleTitle).toBe('Untitled rule')
  })

  it('accepts an older Analysis without the parts and uses its recommendation as the improvement', async () => {
    const analysis = await canonical()
    const legacy = JSON.parse(JSON.stringify(analysis)) as { insights: Array<Record<string, unknown>> }
    for (const insight of legacy.insights) {
      delete insight['improvement']
      delete insight['why']
      delete insight['method']
    }
    const bundle = parseEvidenceArtifact(JSON.stringify(legacy), { limit: MAX_EVIDENCE_LIMIT })
    expect(bundle.findings.length).toBe(analysis.insights.length)
    for (const row of bundle.findings) {
      expect(row.recommendation).toMatch(/\S/)
      expect(row.improvement).toBe(row.recommendation)
      expect('why' in row).toBe(false)
      expect('method' in row).toBe(false)
    }
    // the parts are copy, not identity: the same findings keep the same suggestion ids with or without them
    expect(bundle.findings.map((row) => row.suggestionId)).toEqual(projectEvidence(analysis, { limit: MAX_EVIDENCE_LIMIT }).findings.map((row) => row.suggestionId))
  })

  it('accepts an older Aggregate without the parts and uses its recommendation as the improvement', async () => {
    const analysis = await canonical()
    const input = aggregate([analysis], 'repo demo', 0)
    const legacy = JSON.parse(JSON.stringify(input)) as { crossFindings: Array<Record<string, unknown>> }
    for (const f of legacy.crossFindings) {
      delete f['improvement']
      delete f['why']
      delete f['method']
      delete f['exampleTitle']
    }
    const bundle = parseEvidenceArtifact(JSON.stringify(legacy), { scope: 'repo', limit: MAX_EVIDENCE_LIMIT })
    expect(bundle.findings.length).toBe(input.crossFindings.length)
    for (const row of bundle.findings) {
      expect(row.recommendation).toMatch(/\S/)
      expect(row.improvement).toBe(row.recommendation)
      expect('why' in row).toBe(false)
      expect('method' in row).toBe(false)
      expect('exampleTitle' in row).toBe(false)
    }
    expect(bundle.findings.map((row) => row.suggestionId)).toEqual(projectEvidence(input, { scope: 'repo', limit: MAX_EVIDENCE_LIMIT }).findings.map((row) => row.suggestionId))

    // an Aggregate older than the recommendation too has no rule text, so its row carries no improvement
    for (const f of legacy.crossFindings) delete f['recommendation']
    const older = parseEvidenceArtifact(JSON.stringify(legacy), { scope: 'repo', limit: MAX_EVIDENCE_LIMIT })
    expect(older.findings.length).toBe(input.crossFindings.length)
    for (const row of older.findings) expect('improvement' in row).toBe(false)
  })

  it('rejects rule text parts that are not bounded strings', async () => {
    const analysis = await canonical()
    const insight = analysis.insights[0]!
    for (const key of ['improvement', 'why', 'method'] as const) {
      expect(() => projectEvidence(withInsights(analysis, [{ ...insight, [key]: 42 } as unknown as Insight]))).toThrow(new RegExp(`insights\\[0\\]\\.${key} must be`))
      expect(() => projectEvidence(withInsights(analysis, [{ ...insight, [key]: 'x'.repeat(16_385) }]))).toThrow(new RegExp(`insights\\[0\\]\\.${key} exceeds`))
    }
    const input = aggregate([analysis], 'repo demo', 0)
    const finding = input.crossFindings[0]!
    for (const key of ['improvement', 'why', 'method', 'exampleTitle'] as const) {
      expect(() => projectEvidence({ ...input, crossFindings: [{ ...finding, [key]: 42 }] }, { scope: 'repo' })).toThrow(
        new RegExp(`crossFindings\\[0\\]\\.${key} must be`),
      )
      expect(() => projectEvidence({ ...input, crossFindings: [{ ...finding, [key]: 'x'.repeat(16_385) }] }, { scope: 'repo' })).toThrow(
        new RegExp(`crossFindings\\[0\\]\\.${key} exceeds`),
      )
    }
  })

  it('scrubs a secret planted in any rule text part', async () => {
    const analysis = await canonical()
    const secret = 'sk-ant-api03-abc123def456ghi789'
    const insight: Insight = { ...analysis.insights[0]!, improvement: `Remove ${secret}`, why: `It leaks ${secret}`, method: `It counts ${secret}` }
    const session = JSON.stringify(projectEvidence(withInsights(analysis, [insight])))
    expect(session).not.toContain(secret)
    expect(session.match(/‹anthropic-key›/g)?.length).toBeGreaterThanOrEqual(3)
    const input = aggregate([analysis], 'repo demo', 0)
    const planted = {
      ...input,
      crossFindings: input.crossFindings.map((f) => ({ ...f, improvement: `Remove ${secret}`, why: `It leaks ${secret}`, method: `It counts ${secret}`, exampleTitle: `Saw ${secret}` })),
    }
    const repo = JSON.stringify(projectEvidence(planted, { scope: 'repo' }))
    expect(repo).not.toContain(secret)
    expect(repo.match(/‹anthropic-key›/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('states the recurrence against the cohort total, never as a bare "Recurs in" count', async () => {
    const analysis = await canonical()
    const cohort = (withFinding: number) =>
      aggregate(
        Array.from({ length: 7 }, (_, i) => ({ ...analysis, session: { ...analysis.session, id: `cohort-${i}` }, insights: i < withFinding ? analysis.insights : [] })),
        'repo demo',
        0,
      )
    const details = (input: unknown) => projectEvidence(input, { scope: 'repo', limit: MAX_EVIDENCE_LIMIT }).findings.map((row) => row.detail)
    const once = details(cohort(1))
    const thrice = details(cohort(3))
    expect(once.length).toBeGreaterThan(0)
    expect(new Set(once)).toEqual(new Set(['This pattern shows in 1 of 7 sessions.']))
    expect(new Set(thrice)).toEqual(new Set(['This pattern shows in 3 of 7 sessions.']))
    expect(new Set(details(aggregate([analysis], 'repo demo', 0)))).toEqual(new Set(['This pattern shows in 1 of 1 session.']))
    for (const detail of [...once, ...thrice]) expect(detail).not.toMatch(/Recurs in/)
  })

  it('keeps curated catalog matches first, bounded, and linked to canonical suggestions', async () => {
    const analysis = await canonical()
    const base = analysis.insights[0]!
    const reread: Insight = {
      ...base,
      id: 'reread-files-1',
      ruleId: 'reread-files',
      title: 'A file was repeatedly re-read',
      evidence: {},
    }
    const bundle = projectEvidence(withInsights(analysis, [reread]))
    expect(Object.keys(bundle).indexOf('catalogMatches')).toBeLessThan(Object.keys(bundle).indexOf('findings'))
    expect(bundle.catalogMatches.length).toBeGreaterThan(0)
    expect(bundle.catalogMatches.every((match) => match.suggestionId === bundle.findings[0]!.suggestionId)).toBe(true)
    expect(bundle.findings[0]!.catalogMatchIds).toEqual(bundle.catalogMatches.map((match) => match.id))
  })

  it('redacts planted secrets from copy, catalog evidence, and encoded findings', async () => {
    const analysis = await canonical()
    const secret = 'sk-ant-api03-abc123def456ghi789'
    const base = analysis.insights[0]!
    const planted: Insight = {
      ...base,
      id: 'repeated-commands-1',
      ruleId: 'repeated-commands',
      title: `Repeated command carried ${secret}`,
      detail: `Do not expose ${secret}`,
      recommendation: `Remove ${secret}`,
      evidence: { commands: [{ command: `grep ${secret} src`, count: 6 }] },
    }
    const bundle = projectEvidence(withInsights(analysis, [planted]))
    const json = JSON.stringify(bundle)
    expect(json).not.toContain(secret)
    expect(json).toContain('‹anthropic-key›')
    expect(JSON.stringify(decodeFinding(bundle.findings[0]!.findingToken))).not.toContain(secret)
  })

  it('rejects secrets in canonical identifiers instead of hashing or tokenizing them', async () => {
    const analysis = await canonical()
    expect(() => projectEvidence({ ...analysis, session: { ...analysis.session, id: 'sk-ant-api03-abc123def456ghi789' } })).toThrow(/sensitive material/)
    expect(() => projectEvidence(withInsights(analysis, [{ ...analysis.insights[0]!, ruleId: 'sk-ant-api03-abc123def456ghi789' }]))).toThrow(/sensitive material/)
  })

  it('enforces current schemas, input bounds, output limits, and exact estimates', async () => {
    const analysis = await canonical()
    expect(() => projectEvidence({ ...analysis, schemaVersion: '1' })).toThrow(/current/)
    expect(() => projectEvidence({ schemaVersion: '2', insights: [] })).toThrow(/generator/)
    expect(() => projectEvidence({ ...analysis, insights: Array(MAX_EVIDENCE_INPUT_FINDINGS + 1).fill(analysis.insights[0]) })).toThrow(/exceeds/)
    expect(() =>
      projectEvidence(withInsights(analysis, [{ ...analysis.insights[0]!, evidence: { giant: 'x'.repeat(16_385) } }])),
    ).toThrow(/characters/)
    expect(() => projectEvidence(analysis, { limit: 0 })).toThrow(/--limit/)
    expect(() => projectEvidence(analysis, { limit: MAX_EVIDENCE_LIMIT + 1 })).toThrow(/--limit/)

    const many = Array.from({ length: DEFAULT_EVIDENCE_LIMIT + 3 }, (_, index) => ({
      ...analysis.insights[0]!,
      id: `tool-errors-${index}`,
    }))
    const limited = projectEvidence(withInsights(analysis, many))
    expect(limited.selectedFindings).toBe(DEFAULT_EVIDENCE_LIMIT)
    expect(limited.totalFindings).toBe(many.length)
    expect(limited.truncated).toBe(true)

    const compact = JSON.stringify(limited)
    expect(estimateEvidence(limited)).toMatchObject({
      bytes: Buffer.byteLength(compact),
      approxTokens: Math.ceil(Buffer.byteLength(compact) / 4),
      thresholdTokens: 5_000,
    })
    expect(() => parseEvidenceArtifact(' '.repeat(MAX_EVIDENCE_ARTIFACT_BYTES + 1))).toThrow(/exceeds/)
    expect(() => parseEvidenceArtifact('{bad json')).toThrow(/invalid evidence JSON/)
  })
})
