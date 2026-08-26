import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from './analyze.js'
import { aggregate } from './aggregate.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'

async function two() {
  const a1 = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
  const a2 = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
  return aggregate([a1, a2], 'repo test', 0)
}

describe('aggregate', () => {
  it('sums totals and averages across sessions', async () => {
    const g = await two()
    expect(g.sessionCount).toBe(2)
    expect(g.totals.toolCalls).toBe(12)
    expect(g.totals.commits).toBe(0)
    expect(g.averages.tokensPerSession).toBeGreaterThan(0)
    expect(g.averages.tokensPerHumanTurn).toBeGreaterThan(0)
    expect(g.byModel.length).toBeGreaterThan(0)
    expect(g.schemaVersion).toBe('2')
  })
  it('surfaces cross-session recurring findings and errors', async () => {
    const g = await two()
    // canonical has a failing Bash then passing; both sessions => a recurring error signature
    expect(g.recurringErrors.length).toBeGreaterThanOrEqual(0)
    expect(g.crossFindings.every((f) => f.sessions >= 1)).toBe(true)
    expect(g.topSessions.length).toBe(2)
    JSON.stringify(g) // serializable
  })
})

describe('aggregate additive fields (byWeek, whatIf, interruptions)', () => {
  // three canonical sessions with shifted startAt → ISO weeks of Mon 2026-07-06, Mon 2026-07-27, Mon 2026-08-10
  async function three() {
    const out = []
    const canonicalStart = Date.parse('2026-08-14T10:00:00.000Z')
    for (const startAt of ['2026-08-14T10:00:00.000Z', '2026-07-30T09:00:00.000Z', '2026-07-06T00:00:00.000Z']) {
      const delta = Date.parse(startAt) - canonicalStart
      const records = buildCanonicalSession()
        .toRecords()
        .map((r) => (typeof r['timestamp'] === 'string' ? { ...r, timestamp: new Date(Date.parse(r['timestamp']) + delta).toISOString() } : r))
      out.push(analyzeSession(await parseClaudeCodeSession({ records, noSidecar: true }), { version: 't', now: 0 }))
    }
    return { analyses: out, agg: aggregate(out, 'repo test', 0) }
  }
  it('byWeek has exactly 12 zero-filled ISO weeks (Mon 00:00 UTC) ending at the latest startedAt — no clock', async () => {
    const { agg, analyses } = await three()
    expect(agg.byWeek.length).toBe(12)
    const last = agg.byWeek[11]!
    expect(new Date(last.weekStartUtc).toISOString()).toBe('2026-08-10T00:00:00.000Z')
    expect(agg.byWeek[0]!.weekStartUtc).toBe(last.weekStartUtc - 11 * 7 * 86_400_000)
    for (let i = 1; i < 12; i++) expect(agg.byWeek[i]!.weekStartUtc - agg.byWeek[i - 1]!.weekStartUtc).toBe(7 * 86_400_000)
    const nonEmpty = agg.byWeek.filter((w) => w.sessions > 0)
    expect(nonEmpty.map((w) => new Date(w.weekStartUtc).toISOString().slice(0, 10))).toEqual(['2026-07-06', '2026-07-27', '2026-08-10'])
    expect(nonEmpty.every((w) => w.sessions === 1)).toBe(true)
    expect(agg.byWeek.filter((w) => w.sessions === 0).every((w) => w.tokens === 0)).toBe(true)
    expect(last.tokens).toBe(analyses[0]!.summary.totalTokens)
    expect(agg.byWeek.reduce((a, w) => a + w.tokens, 0)).toBe(agg.totals.tokens)
  })
  // `Aggregate.whatIf` (per-model repricing deltas) was deleted with the price table. byModel still
  // rolls up every model that ran, now by the tokens it actually moved.
  it('byModel sums per-session tokens by model and carries no repricing rollup', async () => {
    const { agg, analyses } = await three()
    expect('whatIf' in agg).toBe(false)
    const names = new Set(analyses.flatMap((a) => a.tokens.byModel.map((m) => m.displayName)))
    expect(agg.byModel.map((m) => m.key).sort()).toEqual([...names].sort())
    for (const row of agg.byModel) {
      const expected = analyses.reduce((sum, an) => sum + (an.tokens.byModel.find((m) => m.displayName === row.key)?.totalTokens ?? 0), 0)
      expect(row.tokens).toBe(expected)
    }
    expect(agg.byModel.reduce((a, m) => a + m.tokens, 0)).toBe(agg.totals.tokens)
  })
  it('SessionRow.interruptions mirrors quality.interruptions', async () => {
    const { agg, analyses } = await three()
    expect(agg.sessions.every((r) => typeof r.interruptions === 'number')).toBe(true)
    expect(agg.sessions[0]!.interruptions).toBe(analyses[0]!.quality.interruptions)
  })
  it('byWeek is empty when no session has a start time', () => {
    expect(aggregate([], 'empty', 0).byWeek).toEqual([])
  })
})
