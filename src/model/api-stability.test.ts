import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { ANALYSIS_SCHEMA_VERSION } from './analysis.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { currencyHits, moneyHits } from '../../test/money-vocabulary.js'

// Guards the PUBLIC JSON API (orangu analyze --json). If a key here changes, that is a
// breaking change and schemaVersion MUST bump. This test makes that decision explicit.
describe('Analysis API stability (schemaVersion ' + ANALYSIS_SCHEMA_VERSION + ')', () => {
  it('top-level keys are exactly the documented set', async () => {
    const a = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    expect(Object.keys(a).sort()).toEqual(
      ['agents', 'context', 'events', 'files', 'generator', 'hooks', 'insights', 'parse', 'quality', 'schemaVersion', 'session', 'skills', 'summary', 'time', 'tokens', 'tools', 'turns'].sort(),
    )
    expect(a.schemaVersion).toBe(ANALYSIS_SCHEMA_VERSION)
  })
  it('summary carries the documented KPI fields', async () => {
    const a = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    for (const k of ['turns', 'humanTurns', 'toolCalls', 'toolErrors', 'agents', 'skills', 'compactions', 'activeMs', 'humanWaitMs', 'tokens', 'totalTokens', 'contextPeak', 'cacheHitRatio', 'outcomes', 'narrative']) {
      expect(a.summary, `summary.${k}`).toHaveProperty(k)
    }
    expect(typeof a.summary.totalTokens).toBe('number')
    expect(a.summary.totalTokens).toBe(a.summary.tokens.input + a.summary.tokens.output + a.summary.tokens.cacheRead + a.summary.tokens.cacheWrite)
  })
  it('canonical fixture yields stable headline numbers (regression guard)', async () => {
    const a = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    // These are fully determined by the fixture; a change here means analyzer math moved.
    expect(a.summary.turns).toBe(2)
    expect(a.summary.humanTurns).toBe(2)
    expect(a.summary.toolCalls).toBe(6)
    expect(a.summary.toolErrors).toBe(1)
    expect(a.summary.agents).toBe(1)
    expect(a.summary.outcomes.testRuns).toBe(2)
    expect(a.summary.outcomes.filesEdited).toBe(1)
    expect(a.parse.reconciliation.ok).toBe(true)
    // tokens come straight from the transcript; assert the shape and sign, not a brittle exact value
    expect(a.summary.totalTokens).toBeGreaterThan(0)
    expect(a.tokens.totalTokens).toBe(a.summary.totalTokens)
  })

  // The product reports tokens and never money. This is a contract guard, not a style check: if a
  // currency field ever reappears in `analyze --json`, that is an API change and must fail here.
  it('the serialized Analysis contains no currency field anywhere', async () => {
    const a = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    const json = JSON.stringify(a)
    const hits = moneyHits(json)
    expect(hits, `analyze --json leaks money vocabulary: ${hits.join(' || ')}`).toEqual([])
    expect(currencyHits(json)).toEqual([])
    expect(json.includes('$')).toBe(false)
    for (const i of a.insights) expect(['quality', 'time', 'tokens', 'context']).toContain(i.axis)
  })
})
