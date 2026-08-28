import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { estimateFor, type AnalysisLoad } from './estimate.js'
import { projectEvidence } from './evidence.js'
import { redactAnalysis } from '../redact/redact.js'

/** the bundle `orangu evidence` emits by default: transcript text stripped, secrets scrubbed (see evidenceBytes) */
const defaultBundle = (a: Analysis) => projectEvidence(redactAnalysis(a, { scrub: true, stripText: true }).analysis)
import { ESTIMATE_TOKEN_THRESHOLD } from './types.js'
import type { Analysis } from '../model/analysis.js'

async function canonicalAnalysis(): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}
const loaded = (analysis: Analysis): AnalysisLoad => ({ ok: true, analysis })
const missing: AnalysisLoad = { ok: false, reason: 'no such session' }

describe('estimateFor', () => {
  it('bytes = evidence bundle JSON size; approxTokens = ceil(bytes/4); counts sessions and files', async () => {
    const a = await canonicalAnalysis()
    const est = await estimateFor(['x'], async () => loaded(a))
    const expectBytes = Buffer.byteLength(JSON.stringify(defaultBundle(a)))
    expect(est.bytes).toBe(expectBytes)
    expect(est.approxTokens).toBe(Math.ceil(expectBytes / 4))
    expect(est.sessions).toBe(1)
    expect(est.files).toBe(1 + a.session.subagentPaths.length)
    expect(est.overThreshold).toBe(est.approxTokens > ESTIMATE_TOKEN_THRESHOLD)
    expect(est.skipped).toEqual([])
  })

  it('sums across sessions and names the ids it could not project instead of counting them as 0 bytes', async () => {
    const a = await canonicalAnalysis()
    const est = await estimateFor(['x', 'missing', 'y'], async (id) => (id === 'missing' ? missing : loaded(a)))
    expect(est.sessions).toBe(2)
    expect(est.bytes).toBe(2 * Buffer.byteLength(JSON.stringify(defaultBundle(a))))
    expect(est.skipped).toEqual([{ selector: 'missing', reason: 'no such session' }])
  })

  it('a session that cannot be projected is reported, never a clean 0 under the gate', async () => {
    const est = await estimateFor(['broken'], async () => ({ ok: false, reason: 'session input exceeds the byte cap' }))
    expect(est.sessions).toBe(0)
    expect(est.bytes).toBe(0)
    expect(est.skipped).toEqual([{ selector: 'broken', reason: 'session input exceeds the byte cap' }])
  })

  it('flags overThreshold above ~20 KB (5,000 tokens)', async () => {
    // projectEvidence clamps titles and finding counts, so one inflated field cannot cross the
    // gate; repetition can. Assert the arithmetic instead of assuming it.
    const a = await canonicalAnalysis()
    const one = Buffer.byteLength(JSON.stringify(defaultBundle(a)))
    const n = Math.ceil((ESTIMATE_TOKEN_THRESHOLD * 4) / one) + 1
    const est = await estimateFor(Array.from({ length: n }, (_, i) => `s${i}`), async () => loaded(a))
    expect(est.bytes).toBe(n * one)
    expect(est.approxTokens).toBeGreaterThan(ESTIMATE_TOKEN_THRESHOLD)
    expect(est.overThreshold).toBe(true)
  })
})
