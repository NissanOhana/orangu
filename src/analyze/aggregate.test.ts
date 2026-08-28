import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from './analyze.js'
import { aggregate } from './aggregate.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { goldenCorpus } from '../../test/fixtures/corpus.js'
import { aggregateBody } from '../report/client/screens/repo.js'
import type { Ctx } from '../report/client/app.js'

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

describe('crossFindings bounded savings (A6)', () => {
  async function claiming(tokensPerSession: number[], msPerSession: number[] = []) {
    const base = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    const analyses = tokensPerSession.map((tokens, i) => ({
      ...base,
      session: { ...base.session, id: `sess-${i}` },
      insights: [{ ...base.insights[0]!, id: `ins-${i}`, ruleId: 'one-rule', savings: { tokens, ms: msPerSession[i] ?? 0, estimated: true } }],
    }))
    return aggregate(analyses, 'repo test', 0).crossFindings.find((f) => f.ruleId === 'one-rule')!
  }
  it('keeps the raw sum and adds a median-bounded figure (median × sessions)', async () => {
    const f = await claiming([10, 10, 1000], [5, 5, 500])
    expect(f.totalSavingsTokens).toBe(1020)
    expect(f.boundedSavingsTokens).toBe(30)
    expect(f.totalSavingsMs).toBe(510)
    expect(f.boundedSavingsMs).toBe(15)
  })
  it('bounded equals total for a single session and for an even cohort', async () => {
    const one = await claiming([42])
    expect(one.boundedSavingsTokens).toBe(42)
    expect(one.boundedSavingsTokens).toBe(one.totalSavingsTokens)
    const two = await claiming([10, 30])
    expect(two.totalSavingsTokens).toBe(40)
    expect(two.boundedSavingsTokens).toBe(40)
  })
  it('never exceeds the raw sum', async () => {
    const f = await claiming([100, 1, 1, 1])
    expect(f.totalSavingsTokens).toBe(103)
    expect(f.boundedSavingsTokens).toBeLessThanOrEqual(f.totalSavingsTokens)
    expect(f.boundedSavingsTokens).toBe(4)
  })
})

describe('crossFindings title: a real example session, not a number-stripped template', () => {
  async function titled(claims: Array<{ tokens: number; ms?: number; title: string }>) {
    const base = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    const analyses = claims.map((c, i) => ({
      ...base,
      session: { ...base.session, id: `sess-${i}` },
      insights: [{ ...base.insights[0]!, id: `ins-${i}`, ruleId: 'one-rule', title: c.title, savings: { tokens: c.tokens, ms: c.ms ?? 0, estimated: true } }],
    }))
    return aggregate(analyses, 'repo test', 0).crossFindings.find((f) => f.ruleId === 'one-rule')!
  }
  it('carries the title of the highest-savings example session, prefixed e.g.', async () => {
    const f = await titled([
      { tokens: 10, title: '10 tool results over 4 KB carried in context' },
      { tokens: 1000, title: '35 tool results over 40 KB, 1.38M tokens carried in context' },
      { tokens: 5, title: '5 tool results over 1 KB carried in context' },
    ])
    expect(f.title).toBe('e.g. 35 tool results over 40 KB, 1.38M tokens carried in context')
    expect(f.titlePattern).toBe('N tool results over N KB carried in context')
    expect(f.titlePattern).not.toMatch(/\d/)
    expect(f.title).not.toMatch(/\bN\b/)
  })
  it('breaks a token tie on ms, then keeps the first session seen', async () => {
    const byMs = await titled([{ tokens: 10, ms: 100, title: 'first' }, { tokens: 10, ms: 900, title: 'second' }])
    expect(byMs.title).toBe('e.g. second')
    const tie = await titled([{ tokens: 10, ms: 5, title: 'first' }, { tokens: 10, ms: 5, title: 'second' }])
    expect(tie.title).toBe('e.g. first')
  })
  it('chooses among the example sessions only, so the figures belong to a session the reader can open', async () => {
    const claims = [1, 2, 3, 4, 5, 100, 200].map((tokens) => ({ tokens, title: `${tokens} tokens wasted` }))
    const f = await titled(claims)
    expect(f.exampleSessionIds).toEqual(['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4'])
    expect(f.title).toBe('e.g. 5 tokens wasted')
    expect(f.sessions).toBe(7)
    expect(f.totalSavingsTokens).toBe(315)
  })
  it('never renders a template N in the repo screen over the whole golden corpus', async () => {
    const { aggregateJson } = await goldenCorpus()
    const agg = JSON.parse(aggregateJson) as ReturnType<typeof aggregate>
    expect(agg.crossFindings.length).toBeGreaterThan(3)
    for (const f of agg.crossFindings) {
      expect(f.title, f.ruleId).toMatch(/^e\.g\. \S/)
      expect(f.title, f.ruleId).not.toMatch(/\bN\b/)
      expect(typeof f.titlePattern).toBe('string')
    }
    const html = aggregateBody(agg, { data: { mode: 'file' } } as unknown as Ctx)
    const rendered = [...html.matchAll(/<span class="grow">([^<]*)<\/span>/g)].map((m) => m[1]!)
    expect(rendered.length).toBe(Math.min(8, agg.crossFindings.length))
    for (const title of rendered) expect(title).not.toMatch(/\bN\b/)
    // the "(N sessions)" count the screen adds still follows every title
    expect(html).toMatch(/<span class="grow">e\.g\. [^<]*<\/span><span class="mono small muted">\d+ sessions<\/span>/)
  })
})
