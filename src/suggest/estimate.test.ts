import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { estimateFor } from './estimate.js'
import { slimAnalysis } from './slim.js'
import { ESTIMATE_TOKEN_THRESHOLD } from './types.js'
import type { Analysis } from '../model/analysis.js'

async function canonicalAnalysis(): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}

describe('estimateFor', () => {
  it('bytes = slim JSON size; approxTokens = ceil(bytes/4); counts sessions and files', async () => {
    const a = await canonicalAnalysis()
    const est = await estimateFor(['x'], async () => a)
    const expectBytes = Buffer.byteLength(JSON.stringify(slimAnalysis(a)))
    expect(est.bytes).toBe(expectBytes)
    expect(est.approxTokens).toBe(Math.ceil(expectBytes / 4))
    expect(est.sessions).toBe(1)
    expect(est.files).toBe(1 + a.session.subagentPaths.length)
    expect(est.overThreshold).toBe(est.approxTokens > ESTIMATE_TOKEN_THRESHOLD)
  })

  it('sums across sessions and skips unresolvable ids', async () => {
    const a = await canonicalAnalysis()
    const est = await estimateFor(['x', 'missing', 'y'], async (id) => (id === 'missing' ? undefined : a))
    expect(est.sessions).toBe(2)
    expect(est.bytes).toBe(2 * Buffer.byteLength(JSON.stringify(slimAnalysis(a))))
  })

  it('flags overThreshold above ~20 KB (5,000 tokens)', async () => {
    // inflate one slim-visible field past the threshold
    const inflated = async (): Promise<Analysis> => ({
      ...(await canonicalAnalysis()),
      insights: [{ id: 'i', ruleId: 'r', severity: 'low', axis: 'tokens', title: 'x'.repeat(25_000), detail: '', recommendation: '', evidence: {}, turnIndexes: [], personas: [] }],
    }) as Analysis
    const est = await estimateFor(['a'], inflated)
    expect(est.approxTokens).toBeGreaterThan(ESTIMATE_TOKEN_THRESHOLD)
    expect(est.overThreshold).toBe(true)
  })
})
