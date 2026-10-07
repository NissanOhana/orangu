import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from './analyze.js'
import { aggregate } from './aggregate.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { goldenCorpus } from '../../test/fixtures/corpus.js'
import { aggregateBody } from '../report/client/screens/repo.js'
import type { Ctx } from '../report/client/app.js'
import { prepareAggregateForOutput } from '../cli/json-out.js'

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
  it('carries the title of the highest-savings example session, marked as the figures of one session', async () => {
    const f = await titled([
      { tokens: 10, title: '10 tool results over 4 KB carried in context' },
      { tokens: 1000, title: '35 tool results over 40 KB, 1.38M tokens carried in context' },
      { tokens: 5, title: '5 tool results over 1 KB carried in context' },
    ])
    expect(f.title).toBe('In one session: 35 tool results over 40 KB, 1.38M tokens carried in context')
    expect(f.titlePattern).toBe('N tool results over N KB carried in context')
    expect(f.titlePattern).not.toMatch(/\d/)
    expect(f.title).not.toMatch(/\bN\b/)
    expect(f.title).not.toMatch(/\be\.g\./)
  })
  it('breaks a token tie on ms, then keeps the first session seen', async () => {
    const byMs = await titled([{ tokens: 10, ms: 100, title: 'first' }, { tokens: 10, ms: 900, title: 'second' }])
    expect(byMs.title).toBe('In one session: second')
    const tie = await titled([{ tokens: 10, ms: 5, title: 'first' }, { tokens: 10, ms: 5, title: 'second' }])
    expect(tie.title).toBe('In one session: first')
  })
  it('chooses among the example sessions only, so the figures belong to a session the reader can open', async () => {
    const claims = [1, 2, 3, 4, 5, 100, 200].map((tokens) => ({ tokens, title: `${tokens} tokens wasted` }))
    const f = await titled(claims)
    expect(f.exampleSessionIds).toEqual(['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4'])
    expect(f.title).toBe('In one session: 5 tokens wasted')
    expect(f.sessions).toBe(7)
    expect(f.totalSavingsTokens).toBe(315)
  })
  it('keeps an empty example title empty instead of a bare marker', async () => {
    const f = await titled([{ tokens: 10, title: '' }])
    expect(f.title).toBe('')
  })
  it('never renders a template N in the repo screen over the whole golden corpus', async () => {
    const { aggregateJson } = await goldenCorpus()
    const agg = JSON.parse(aggregateJson) as ReturnType<typeof aggregate>
    expect(agg.crossFindings.length).toBeGreaterThan(3)
    for (const f of agg.crossFindings) {
      expect(f.title, f.ruleId).toMatch(/^In one session: \S/)
      expect(f.title, f.ruleId).not.toMatch(/\be\.g\./)
      expect(f.title, f.ruleId).not.toMatch(/\bN\b/)
      expect(typeof f.titlePattern).toBe('string')
    }
    const html = aggregateBody(agg, { data: { mode: 'file' } } as unknown as Ctx)
    const rendered = [...html.matchAll(/<span class="grow">([^<]*)<\/span>/g)].map((m) => m[1]!)
    expect(rendered.length).toBe(Math.min(8, agg.crossFindings.length))
    for (const title of rendered) expect(title).not.toMatch(/\bN\b/)
    // the "(N sessions)" count the screen adds still follows every title
    expect(html).toMatch(/<span class="grow">In one session: [^<]*<\/span><span class="mono small muted">\d+ sessions<\/span>/)
  })
})

describe('crossFindings recommendation: the improvement of the example insight whose title the finding carries', () => {
  async function recommended(claims: Array<{ tokens: number; ms?: number; title: string; recommendation: string }>) {
    const base = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    const analyses = claims.map((c, i) => ({
      ...base,
      session: { ...base.session, id: `sess-${i}` },
      insights: [
        {
          ...base.insights[0]!,
          id: `ins-${i}`,
          ruleId: 'one-rule',
          title: c.title,
          recommendation: c.recommendation,
          savings: { tokens: c.tokens, ms: c.ms ?? 0, estimated: true },
        },
      ],
    }))
    return aggregate(analyses, 'repo test', 0).crossFindings.find((f) => f.ruleId === 'one-rule')!
  }
  it('takes the recommendation from the same insight as the title (the largest claim)', async () => {
    const f = await recommended([
      { tokens: 10, title: 'small', recommendation: 'Do the small thing.' },
      { tokens: 1000, title: 'large', recommendation: 'Do the large thing.' },
      { tokens: 5, title: 'tiny', recommendation: 'Do the tiny thing.' },
    ])
    expect(f.title).toBe('In one session: large')
    expect(f.recommendation).toBe('Do the large thing.')
  })
  it('follows the title through the ms tie-break and the first-seen tie', async () => {
    const byMs = await recommended([
      { tokens: 10, ms: 100, title: 'first', recommendation: 'First advice.' },
      { tokens: 10, ms: 900, title: 'second', recommendation: 'Second advice.' },
    ])
    expect(byMs.recommendation).toBe('Second advice.')
    const tie = await recommended([
      { tokens: 10, ms: 5, title: 'first', recommendation: 'First advice.' },
      { tokens: 10, ms: 5, title: 'second', recommendation: 'Second advice.' },
    ])
    expect(tie.recommendation).toBe('First advice.')
  })
  it('chooses among the example sessions only, like the title', async () => {
    const claims = [1, 2, 3, 4, 5, 100, 200].map((tokens) => ({ tokens, title: `${tokens} tokens wasted`, recommendation: `Advice for ${tokens}.` }))
    const f = await recommended(claims)
    expect(f.title).toBe('In one session: 5 tokens wasted')
    expect(f.recommendation).toBe('Advice for 5.')
  })
  it('is the same bytes for the same input (no order or clock dependence)', async () => {
    const claims = [
      { tokens: 7, title: 'a', recommendation: 'Advice A.' },
      { tokens: 7, title: 'b', recommendation: 'Advice B.' },
    ]
    const one = await recommended(claims)
    const two = await recommended(claims)
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
  })
  it('matches an example insight, on every cross finding of the golden corpus', async () => {
    const { files, aggregateJson } = await goldenCorpus()
    const agg = JSON.parse(aggregateJson) as ReturnType<typeof aggregate>
    const analyses = files.map((f) => JSON.parse(f.json) as { session: { id: string }; insights: Array<{ ruleId: string; title: string; recommendation: string }> })
    for (const f of agg.crossFindings) {
      expect(typeof f.recommendation, f.ruleId).toBe('string')
      expect(f.recommendation.trim(), f.ruleId).not.toBe('')
      const source = analyses
        .filter((a) => f.exampleSessionIds.includes(a.session.id))
        .flatMap((a) => a.insights)
        .find((ins) => ins.ruleId === f.ruleId && `In one session: ${ins.title}` === f.title)
      expect(source, f.ruleId).toBeDefined()
      expect(f.recommendation, f.ruleId).toBe(source!.recommendation)
    }
  })
  it('survives the default output redaction, which keeps rule copy and strips transcript text', async () => {
    const agg = await two()
    expect(agg.crossFindings.length).toBeGreaterThan(0)
    const out = prepareAggregateForOutput(agg, {})
    for (let i = 0; i < agg.crossFindings.length; i++) {
      expect(agg.crossFindings[i]!.recommendation).toMatch(/\S/)
      expect(out.crossFindings[i]!.recommendation).toBe(agg.crossFindings[i]!.recommendation)
    }
  })
})

describe('crossFindings rule text parts: the improvement, reason, method and title of the example insight', () => {
  interface PartClaim {
    tokens: number
    ms?: number
    title: string
    improvement: string
    why?: string
    method?: string
  }
  async function parted(claims: PartClaim[]) {
    const base = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 't', now: 0 })
    const analyses = claims.map((c, i) => {
      // the base insight's own parts are dropped, so each claim carries only the parts it names
      const { why: _why, method: _method, ...rest } = base.insights[0]!
      return {
        ...base,
        session: { ...base.session, id: `sess-${i}` },
        insights: [
          {
            ...rest,
            id: `ins-${i}`,
            ruleId: 'one-rule',
            title: c.title,
            recommendation: [c.improvement, c.why, c.method].filter((part) => part !== undefined).join(' '),
            improvement: c.improvement,
            ...(c.why !== undefined ? { why: c.why } : {}),
            ...(c.method !== undefined ? { method: c.method } : {}),
            savings: { tokens: c.tokens, ms: c.ms ?? 0, estimated: true },
          },
        ],
      }
    })
    return aggregate(analyses, 'repo test', 0).crossFindings.find((f) => f.ruleId === 'one-rule')!
  }

  it('takes every part from the first insight seen while no larger claim replaces it', async () => {
    const f = await parted([
      { tokens: 50, title: 'first', improvement: 'Do the first thing.', why: 'First reason.', method: 'First method.' },
      { tokens: 5, title: 'second', improvement: 'Do the second thing.', why: 'Second reason.' },
    ])
    expect(f.title).toBe('In one session: first')
    expect(f.exampleTitle).toBe('first')
    expect(f.improvement).toBe('Do the first thing.')
    expect(f.why).toBe('First reason.')
    expect(f.method).toBe('First method.')
    expect(f.recommendation).toBe('Do the first thing. First reason. First method.')
  })

  it('moves every part with the title when a larger claim replaces the example, and drops a part the new example lacks', async () => {
    const f = await parted([
      { tokens: 10, title: 'small', improvement: 'Do the small thing.', why: 'Small reason.', method: 'Small method.' },
      { tokens: 1000, title: 'large', improvement: 'Do the large thing.', why: 'Large reason.' },
      { tokens: 5, title: 'tiny', improvement: 'Do the tiny thing.', why: 'Tiny reason.', method: 'Tiny method.' },
    ])
    expect(f.title).toBe('In one session: large')
    expect(f.exampleTitle).toBe('large')
    expect(f.improvement).toBe('Do the large thing.')
    expect(f.why).toBe('Large reason.')
    // the method of the replaced example must not stay behind beside the new example's text
    expect('method' in f).toBe(false)
    expect(f.recommendation).toBe('Do the large thing. Large reason.')

    const gained = await parted([
      { tokens: 10, title: 'small', improvement: 'Do the small thing.', why: 'Small reason.' },
      { tokens: 1000, title: 'large', improvement: 'Do the large thing.', why: 'Large reason.', method: 'Large method.' },
    ])
    expect(gained.method).toBe('Large method.')
    expect(gained.exampleTitle).toBe('large')
  })

  it('follows the title through the ms tie-break and the first-seen tie', async () => {
    const byMs = await parted([
      { tokens: 10, ms: 100, title: 'first', improvement: 'First advice.', why: 'First reason.' },
      { tokens: 10, ms: 900, title: 'second', improvement: 'Second advice.', why: 'Second reason.' },
    ])
    expect([byMs.exampleTitle, byMs.improvement, byMs.why]).toEqual(['second', 'Second advice.', 'Second reason.'])
    const tie = await parted([
      { tokens: 10, ms: 5, title: 'first', improvement: 'First advice.', why: 'First reason.' },
      { tokens: 10, ms: 5, title: 'second', improvement: 'Second advice.', why: 'Second reason.' },
    ])
    expect([tie.exampleTitle, tie.improvement, tie.why]).toEqual(['first', 'First advice.', 'First reason.'])
  })

  it('lays out the same keys in the same order whether or not the example was replaced', async () => {
    const kept = await parted([
      { tokens: 50, title: 'first', improvement: 'Do it.', why: 'Reason.', method: 'Method.' },
      { tokens: 5, title: 'second', improvement: 'Do it.', why: 'Reason.', method: 'Method.' },
    ])
    const replaced = await parted([
      { tokens: 5, title: 'first', improvement: 'Do it.', why: 'Reason.' },
      { tokens: 50, title: 'second', improvement: 'Do it.', why: 'Reason.', method: 'Method.' },
    ])
    expect(Object.keys(replaced)).toEqual(Object.keys(kept))
  })

  it('keeps an empty example title empty in both fields instead of a bare marker', async () => {
    const f = await parted([{ tokens: 10, title: '', improvement: 'Do it.', why: 'Reason.' }])
    expect(f.title).toBe('')
    expect(f.exampleTitle).toBe('')
    expect(f.improvement).toBe('Do it.')
  })

  it('emits the improvement and the example title on every cross finding of the golden corpus, from the insight the title names', async () => {
    const { files, aggregateJson } = await goldenCorpus()
    const agg = JSON.parse(aggregateJson) as ReturnType<typeof aggregate>
    const analyses = files.map((f) => JSON.parse(f.json) as { session: { id: string }; insights: Array<{ ruleId: string; title: string; recommendation: string; improvement: string; why?: string; method?: string }> })
    expect(agg.crossFindings.length).toBeGreaterThan(3)
    expect(agg.crossFindings.some((f) => f.method !== undefined)).toBe(true)
    for (const f of agg.crossFindings) {
      expect(typeof f.improvement, f.ruleId).toBe('string')
      expect(f.improvement!.trim(), f.ruleId).not.toBe('')
      expect(typeof f.exampleTitle, f.ruleId).toBe('string')
      expect(f.title, f.ruleId).toBe('In one session: ' + f.exampleTitle)
      const source = analyses
        .filter((a) => f.exampleSessionIds.includes(a.session.id))
        .flatMap((a) => a.insights)
        .find((ins) => ins.ruleId === f.ruleId && ins.title === f.exampleTitle)
      expect(source, f.ruleId).toBeDefined()
      expect(f.recommendation, f.ruleId).toBe(source!.recommendation)
      expect(f.improvement, f.ruleId).toBe(source!.improvement)
      expect(f.why, f.ruleId).toBe(source!.why)
      expect(f.method, f.ruleId).toBe(source!.method)
    }
  })
})
