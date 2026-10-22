import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GOLDEN_FIXTURES, goldenAnalysis } from '../../test/fixtures/corpus.js'
import { ANALYZER_RULE_IDS } from './rule-ids.js'

describe('ANALYZER_RULE_IDS', () => {
  it('holds exactly the rule ids that the rules of the RULES array write', () => {
    // Each rule writes its id as a literal `ruleId: '<id>'` in src/analyze/insights.ts.
    const source = readFileSync(new URL('./insights.ts', import.meta.url), 'utf8')
    const written = [...new Set([...source.matchAll(/\bruleId: '([a-z0-9-]+)'/g)].map((match) => match[1]!))].sort()
    expect(written.length).toBeGreaterThan(0)
    expect([...ANALYZER_RULE_IDS].sort()).toEqual(written)
    expect(new Set(ANALYZER_RULE_IDS).size).toBe(ANALYZER_RULE_IDS.length)
  })

  it('names the rule of each insight that the analyzer gives on the fixture corpus', async () => {
    const known: readonly string[] = ANALYZER_RULE_IDS
    for (const fixture of GOLDEN_FIXTURES) {
      for (const insight of (await goldenAnalysis(fixture)).insights) expect(known, fixture.name).toContain(insight.ruleId)
    }
  })

  it('has no import, so it adds no node module to any bundle that reads it', () => {
    const code = readFileSync(new URL('./rule-ids.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bimport\b|\brequire\(|\bfrom\s*['"]/)
  })
})
