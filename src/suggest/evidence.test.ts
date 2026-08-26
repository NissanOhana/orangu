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
