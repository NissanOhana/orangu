import { describe, it, expect } from 'vitest'
import {
  endingWord,
  outcomeHeadline,
  qualityHeadline,
  qualityScope,
  foldHiddenErrors,
  callsForTurn,
  catMixForTurn,
  compactionGroups,
  weekPoints,
  per30d,
  sourceLabel,
  liveFeed,
  badgeCopy,
  topTokenThreshold,
  mergeOpenIds,
  fleetFeed,
  savingsShare,
  savingsText,
  recoverableLine,
  timeAxis,
  insightLink,
  outcomeBits,
  compactionMarkers,
  contextHeadline,
} from './derive.js'
import type { Analysis, QualitySignal, Summary, TurnAnalysis } from '../../model/analysis.js'

function sig(id: string, tone: QualitySignal['tone'], value: number | string = 1): QualitySignal {
  return { id, label: id, value, tone }
}

describe('endingWord', () => {
  it('maps the four endings to plain sentences and never says "finished"', () => {
    expect(endingWord('clean')).toBe('The last check it ran passed')
    expect(endingWord('clean').toLowerCase()).not.toContain('test')
    expect(endingWord('interrupted')).toBe('You stopped it')
    expect(endingWord('failing')).toContain('failing')
    expect(endingWord('unknown').toLowerCase()).not.toContain('finished')
  })

  it('a clean ending over mixed test runs says so, instead of contradicting the "N of M failed" headline', () => {
    const o = (testRuns: number, testRunsFailed: number) => ({ testRuns, testRunsFailed }) as Summary['outcomes']
    expect(endingWord('clean', o(133, 8))).toBe('The last check it ran passed; 8 of 133 test runs failed earlier')
    expect(endingWord('clean', o(133, 0))).toBe('The last check it ran passed')
    expect(endingWord('clean', o(0, 0))).toBe('The last check it ran passed')
    // a failing ending already agrees with the headline; interrupted never mentions tests
    expect(endingWord('failing', o(133, 8))).toBe('The last test run was failing')
    expect(endingWord('interrupted', o(133, 8))).toBe('You stopped it')
  })
})

describe('qualityScope', () => {
  it('is "last run" only when the test runs were mixed', () => {
    expect(qualityScope({ testRuns: 133, testRunsFailed: 8 })).toBe('last run')
    expect(qualityScope({ testRuns: 133, testRunsFailed: 0 })).toBe('')
    expect(qualityScope({ testRuns: 3, testRunsFailed: 3 })).toBe('')
    expect(qualityScope({ testRuns: 0, testRunsFailed: 0 })).toBe('')
  })
})

describe('foldHiddenErrors', () => {
  const groups = [
    { name: 'Bash', signature: '', count: 27, sessions: 6 },
    { name: 'Bash', signature: '', count: 14, sessions: 6 },
    { name: 'Read', signature: 'ENOENT: no such file', count: 3, sessions: 2 },
    { name: 'Bash', signature: '', count: 51, sessions: 5 },
    { name: 'Edit', signature: '', count: 2, sessions: 2 },
  ]
  it('folds stripped signatures into one row per tool and passes the rest through in order', () => {
    const { kept, hidden } = foldHiddenErrors(groups, (g) => ({ tool: g.name, total: g.count, sessions: g.sessions }))
    expect(kept.map((g) => g.signature)).toEqual(['ENOENT: no such file'])
    expect(hidden).toEqual([
      { tool: 'Bash', total: 92, signatures: 3, sessions: 6 },
      { tool: 'Edit', total: 2, signatures: 1, sessions: 2 },
    ])
  })
  it('is a no-op when every signature survived (include-text) and reports 0 sessions for a single session', () => {
    const { kept, hidden } = foldHiddenErrors(groups.slice(2, 3), (g) => ({ tool: g.name, total: g.count }))
    expect(kept).toHaveLength(1)
    expect(hidden).toEqual([])
    expect(foldHiddenErrors(groups.slice(0, 1), (g) => ({ tool: g.name, total: g.count })).hidden).toEqual([{ tool: 'Bash', total: 27, signatures: 1, sessions: 0 }])
  })
})

function summary(over: Partial<Omit<Summary, 'outcomes'>> & { outcomes?: Partial<Summary['outcomes']> } = {}): Summary {
  const { outcomes, ...rest } = over
  return {
    turns: 0, humanTurns: 0, toolCalls: 0, agents: 0, ending: 'unknown',
    ...rest,
    outcomes: { prLinks: [], gitCommits: 0, testRuns: 0, testRunsFailed: 0, buildRuns: 0, buildRunsFailed: 0, filesRead: 0, filesEdited: 0, filesWritten: 0, webLookups: 0, ...outcomes },
  } as Summary
}

describe('outcomeHeadline', () => {
  it('never names a test run when only a build run passed (the F2 contradiction)', () => {
    const s = summary({ ending: 'clean', outcomes: { testRuns: 0, buildRuns: 1 }, toolCalls: 41, humanTurns: 1, agents: 4 })
    const out = outcomeHeadline(s)
    expect(out).toBe('1 request, 4 subagents, nothing committed')
    expect(out.toLowerCase()).not.toContain('test')
  })
  it('joins shipped work with a middle dot and reports green tests', () => {
    expect(outcomeHeadline(summary({ ending: 'clean', outcomes: { gitCommits: 41, testRuns: 126, testRunsFailed: 0 } }))).toBe('41 commits · 126 test runs green')
    expect(outcomeHeadline(summary({ outcomes: { prLinks: [{ label: 'x', turnIndex: 0 }], filesEdited: 2, filesWritten: 1 } }))).toBe('1 PR · 3 files changed')
    expect(outcomeHeadline(summary({ outcomes: { testRuns: 3, testRunsFailed: 1 } }))).toBe('1 of 3 test runs failed')
    expect(outcomeHeadline(summary({ outcomes: { testRuns: 1, testRunsFailed: 1 } }))).toBe('1 of 1 test run failed')
    // a red build is never buried behind green tests (sessionEnding derives 'failing' from tests ∪ builds)
    expect(outcomeHeadline(summary({ ending: 'failing', outcomes: { filesEdited: 3, testRuns: 2, testRunsFailed: 0, buildRuns: 1, buildRunsFailed: 1 } }))).toBe('3 files changed · 1 of 1 build run failed · 2 test runs green')
    expect(outcomeHeadline(summary({ ending: 'failing', outcomes: { buildRuns: 2, buildRunsFailed: 1 } }))).toBe('1 of 2 build runs failed')
    expect(outcomeHeadline(summary({ outcomes: { gitCommits: 1, testRuns: 1 } }))).toBe('1 commit · 1 test run green')
  })
  it('names an interruption first, whatever else happened', () => {
    expect(outcomeHeadline(summary({ ending: 'interrupted', turns: 7, outcomes: { gitCommits: 2 } }))).toBe('Stopped by you after 7 turns')
    expect(outcomeHeadline(summary({ ending: 'interrupted', turns: 1 }))).toBe('Stopped by you after 1 turn')
  })
  it('describes effort without subagents, and a session with no tool calls', () => {
    expect(outcomeHeadline(summary({ toolCalls: 5, humanTurns: 3 }))).toBe('3 requests, nothing committed')
    expect(outcomeHeadline(summary({ humanTurns: 2 }))).toBe('2 requests, no tool calls recorded')
  })
  it('is pure and safe on an all-zero session', () => {
    const zero = summary()
    const out = outcomeHeadline(zero)
    expect(out).toBe(outcomeHeadline(zero))
    expect(out).not.toMatch(/NaN|undefined|finished|—/)
    expect(out).toBe('0 requests, no tool calls recorded')
  })
})

describe('qualityHeadline', () => {
  it('is passing/failing from the tests signal, shipped from commits/prs, else –', () => {
    expect(qualityHeadline([sig('tests', 'good')])).toBe('passing')
    expect(qualityHeadline([sig('tests', 'bad')])).toBe('failing')
    expect(qualityHeadline([sig('tests', 'unknown', 0), sig('commits', 'good', 3)])).toBe('shipped')
    expect(qualityHeadline([sig('tests', 'unknown', 0), sig('commits', 'neutral', 0)])).toBe('–')
  })
})

describe('catMixForTurn', () => {
  it('includes main-thread and subagent calls, with an exact agent drill-down', () => {
    const calls = [
      { turnIndex: 1, category: 'read', name: 'Read' },
      { turnIndex: 1, category: 'read', name: 'Read' },
      { turnIndex: 1, category: 'exec', name: 'Bash' },
      { turnIndex: 1, category: 'edit', name: 'Edit', agentId: 'a1' },
      { turnIndex: 2, category: 'edit', name: 'Edit' },
    ] as never[]
    const segs = catMixForTurn(calls, 1)
    expect(segs).toEqual([
      { cat: 'read', pct: 50 },
      { cat: 'exec', pct: 25 },
      { cat: 'edit', pct: 25 },
    ])
    expect(callsForTurn(calls, 1)).toHaveLength(4)
    expect(callsForTurn(calls, 1, 'a1').map((c) => c.name)).toEqual(['Edit'])
    expect(catMixForTurn(calls, 1, 'a1')).toEqual([{ cat: 'edit', pct: 100 }])
    expect(catMixForTurn(calls, 99)).toEqual([])
  })
})

describe('compactionGroups', () => {
  it('splits turns at every compaction boundary', () => {
    const turns = [0, 1, 2, 3, 4].map((i) => ({ index: i }) as TurnAnalysis)
    const comps = [
      { turnIndex: 2, contextBefore: 100, contextAfter: 40 },
      { turnIndex: 4, contextBefore: 90, contextAfter: 30 },
    ]
    const groups = compactionGroups(turns, comps)
    expect(groups.map((g) => g.turns.map((t) => t.index))).toEqual([[0, 1], [2, 3], [4]])
    expect(groups[0]!.after?.turnIndex).toBe(2)
    expect(groups[2]!.after).toBeUndefined()
  })

  it('is a single group with no compactions', () => {
    const turns = [0, 1].map((i) => ({ index: i }) as TurnAnalysis)
    expect(compactionGroups(turns, [])).toEqual([{ turns, after: undefined }])
  })
})

describe('weekPoints', () => {
  it('maps 12 buckets onto the 600x110 viewBox with baseline 104', () => {
    const buckets = Array.from({ length: 12 }, (_, i) => ({ weekStartUtc: i, tokens: i === 5 ? 100_000 : 0, sessions: 1 }))
    const pts = weekPoints(buckets)
    const pairs = pts.split(' ').map((p) => p.split(',').map(Number))
    expect(pairs).toHaveLength(12)
    expect(pairs[0]![0]).toBe(0)
    expect(pairs[11]![0]).toBe(600)
    // the busiest week reaches the top pad, an empty week sits at the baseline
    expect(Math.min(...pairs.map((p) => p[1]!))).toBeLessThan(20)
    expect(pairs[0]![1]).toBe(104)
    expect(weekPoints([])).toBe('')
  })
})

describe('per30d', () => {
  it('normalises a total over the observed span to a 30-day figure (label /30d, policy)', () => {
    const day = 86_400_000
    // 60 days observed, 60 tokens total -> 30 per 30d
    expect(per30d(60, [{ startedAt: 0 }, { startedAt: 60 * day }])).toBeCloseTo(30)
    // span shorter than a day clamps to 1 day
    expect(per30d(2, [{ startedAt: 0 }, { startedAt: 1000 }])).toBeCloseTo(60)
    expect(per30d(10, [{}])).toBeUndefined()
  })
})

describe('sourceLabel', () => {
  it('maps the fixed keys and passes unknown through (policy)', () => {
    expect(sourceLabel('claude-code')).toBe('Claude Code')
    expect(sourceLabel('cowork')).toBe('Cowork')
    expect(sourceLabel('desktop')).toBe('Desktop')
    expect(sourceLabel('weird-cli')).toBe('weird-cli')
  })
})

describe('liveFeed', () => {
  it('merges tool calls, events and agent spawns sorted by ts then toolUseId, last n', () => {
    const a = {
      tools: {
        calls: [
          { toolUseId: 'tb', name: 'Bash', category: 'exec', summary: 'npm test', turnIndex: 1, startTs: 200, durationMs: 10, isError: false, parallelGroupSize: 1 },
          { toolUseId: 'ta', name: 'Read', category: 'read', summary: 'a.ts', turnIndex: 1, startTs: 200, durationMs: 5, isError: false, parallelGroupSize: 1 },
        ],
      },
      events: [{ kind: 'api-error', ts: 300, turnIndex: 1, label: 'overloaded' }],
      agents: { runs: [{ agentId: 'ag1', agentType: 'reviewer', startTs: 100, turnIndex: 1 }] },
    } as unknown as Analysis
    const feed = liveFeed(a, 10)
    expect(feed.map((f) => f.name)).toEqual(['reviewer', 'Read', 'Bash', 'api-error'])
    expect(liveFeed(a, 2)).toHaveLength(2)
    // last n keeps the newest
    expect(liveFeed(a, 2).map((f) => f.name)).toEqual(['Bash', 'api-error'])
  })
})

describe('badgeCopy', () => {
  it('says possibly live only on a trailing partial, otherwise a relative age; never "finished"', () => {
    expect(badgeCopy({ badge: 'live', possiblyLive: true, ageMs: 1000 })).toBe('Watching · possibly live')
    expect(badgeCopy({ badge: 'live', possiblyLive: false, ageMs: 42_000 })).toBe('updated 42s ago')
    expect(badgeCopy({ badge: 'idle', possiblyLive: false, ageMs: 600_000 })).toBe('updated 10m ago')
    const ended = badgeCopy({ badge: 'ended', possiblyLive: true, ageMs: 7_200_000 })
    expect(ended).toBe('ended · updated 2h ago')
    expect(ended.toLowerCase()).not.toContain('finished')
  })
})

describe('topTokenThreshold', () => {
  it('returns the token cutoff for the top 20% of turns', () => {
    const turns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ totalTokens: n * 1000 }))
    const thr = topTokenThreshold(turns)
    expect(turns.filter((t) => t.totalTokens >= thr)).toHaveLength(2)
    expect(topTokenThreshold([])).toBe(Infinity)
  })
})

describe('mergeOpenIds: expansion survives a re-render', () => {
  it('DOM state wins for rendered rows; unrendered rows keep their saved state', () => {
    const saved = ['sg_a', 'turn-3']
    // sg_a still rendered and now closed by the user → dropped; sg_b newly opened → added;
    // turn-3 not rendered on this screen → kept for when it returns
    const next = mergeOpenIds(saved, [
      { id: 'sg_a', open: false },
      { id: 'sg_b', open: true },
      { id: 'sg_c', open: false },
    ])
    expect([...next].sort()).toEqual(['sg_b', 'turn-3'].sort())
  })

  it('round-trips: re-capturing a DOM the saved ids were applied to is a no-op', () => {
    const saved = ['sg_a', 'sg_c']
    const rendered = ['sg_a', 'sg_b', 'sg_c'].map((id) => ({ id, open: saved.includes(id) }))
    expect([...mergeOpenIds(saved, rendered)].sort()).toEqual([...saved].sort())
    // and once more (idempotent)
    expect([...mergeOpenIds(mergeOpenIds(saved, rendered), rendered)].sort()).toEqual([...saved].sort())
  })

  it('dedupes and returns a new array (never mutates the input)', () => {
    const saved = ['x']
    const out = mergeOpenIds(saved, [{ id: 'x', open: true }])
    expect(out).toEqual(['x'])
    expect(out).not.toBe(saved)
  })
})

describe('fleetFeed', () => {
  const ev = (ts: number | undefined, name: string) => ({ ts, name, category: 'exec', summary: name })
  it('merges lastEvents rings across rows, sorted by ts then sid, tagged with the source sid', () => {
    const rows = [
      { id: 'bbbbbbbb-1', lastEvents: [ev(100, 'Read'), ev(300, 'Bash')] },
      { id: 'aaaaaaaa-2', lastEvents: [ev(200, 'Edit'), ev(300, 'Write')] },
      { id: 'cccccccc-3' }, // no ring yet (analysis pending) → contributes nothing
    ]
    const feed = fleetFeed(rows, 10)
    expect(feed.map((f) => f.name)).toEqual(['Read', 'Edit', 'Write', 'Bash'])
    expect(feed.map((f) => f.sid)).toEqual(['bbbbbbbb-1', 'aaaaaaaa-2', 'aaaaaaaa-2', 'bbbbbbbb-1'])
  })
  it('keeps the LAST n overall and is deterministic on ties', () => {
    const rows = [
      { id: 'b', lastEvents: [ev(100, 'one'), ev(400, 'four')] },
      { id: 'a', lastEvents: [ev(200, 'two'), ev(300, 'three')] },
    ]
    expect(fleetFeed(rows, 2).map((f) => f.name)).toEqual(['three', 'four'])
    // undefined ts sorts last (an event with no timestamp is "newest unknown")
    const undef = fleetFeed([{ id: 'a', lastEvents: [ev(undefined, 'x'), ev(100, 'y')] }], 10)
    expect(undef.map((f) => f.name)).toEqual(['y', 'x'])
  })
})

describe('savingsShare (A6b: a bounded, explained savings pill)', () => {
  it('is a share of the session when the total is known and the claim fits inside it', () => {
    const r = savingsShare({ tokens: 1_380_000, estimated: true }, 3_910_000, 'oversized-tool-results')!
    expect(r.text).toBe('~35% of this session')
    expect(r.title).toBe('≈1.38M tokens of the 3.91M this session measured; estimated by rule oversized-tool-results')
  })
  it('never exceeds 100%: a claim larger than the session falls back to the absolute figure', () => {
    const r = savingsShare({ tokens: 5000, estimated: true }, 4000, 'r')!
    expect(r.text).toBe('save ~5.0k tokens')
    expect(r.title).toBe('≈5.0k tokens; estimated by rule r')
  })
  it('falls back to the absolute figure when the session total is unknown or zero', () => {
    expect(savingsShare({ tokens: 500, estimated: false }, 0, 'r')!.text).toBe('save 500 tokens')
    expect(savingsShare({ tokens: 500, estimated: false }, undefined, 'r')!.title).toBe('≈500 tokens; measured by rule r')
  })
  it('rounds a tiny share to "under 1%" and words a time-only claim in time', () => {
    expect(savingsShare({ tokens: 10, estimated: true }, 1_000_000, 'r')!.text).toBe('under 1% of this session')
    const t = savingsShare({ ms: 125_000, estimated: true }, 1_000_000, 'slow-tools')!
    expect(t.text).toBe('save ~2m 5s')
    expect(t.title).toBe('≈2m 5s; estimated by rule slow-tools')
  })
  it('is undefined when nothing is claimed', () => {
    expect(savingsShare(undefined, 100, 'r')).toBeUndefined()
    expect(savingsShare({ estimated: true }, 100, 'r')).toBeUndefined()
    expect(savingsText(undefined)).toBe('')
  })
})

describe('recoverableLine', () => {
  it('words the sum over the rows shown, and is empty when nothing is claimed', () => {
    expect(recoverableLine({ tokens: 2_100_000, ms: 0 }, 7)).toBe('≈2.10M tokens recoverable across 7 findings')
    expect(recoverableLine({ tokens: 900, ms: 5000 }, 1)).toBe('≈900 tokens recoverable across 1 finding')
    expect(recoverableLine({ tokens: 0, ms: 65_000 }, 2)).toBe('≈1m 5s recoverable across 2 findings')
    expect(recoverableLine({ tokens: 0, ms: 0 }, 3)).toBe('')
    expect(recoverableLine({ tokens: 10, ms: 0 }, 0)).toBe('')
  })
})

describe('timeAxis (A1: the Time axis is ACTIVE time)', () => {
  it('leads with active time and notes wall and waiting', () => {
    expect(timeAxis(summary({ activeMs: 2_078_000, wallMs: 3_132_000, humanWaitMs: 257_000 }))).toEqual({ value: '34m 38s', note: 'over 52m 12s wall · 4m 17s waiting for you' })
  })
  it('never puts NaN or a dash in the big slot for a single-message session', () => {
    const t = timeAxis(summary({ activeMs: 0, humanWaitMs: 0 }))
    expect(t).toEqual({ value: '0ms', note: 'single-message session' })
    expect(t.value).not.toContain('NaN')
  })
})

describe('outcomeBits', () => {
  it('is the same wording the headline uses (test RUNS, not tests)', () => {
    const s = summary({ outcomes: { gitCommits: 2, testRuns: 3 } })
    expect(outcomeBits(s)).toEqual(['2 commits', '3 test runs green'])
    expect(outcomeHeadline(s)).toBe('2 commits · 3 test runs green')
    expect(outcomeBits(summary())).toEqual([])
  })
})

describe('insightLink', () => {
  it('names the tool from evidence.calls or evidence.tools, else the first turn, else nothing', () => {
    expect(insightLink({ evidence: { calls: [{ tool: 'Bash' }] }, turnIndexes: [4] })).toEqual({ tool: 'Bash' })
    expect(insightLink({ evidence: { calls: [{ name: 'Read', count: 3 }] }, turnIndexes: [] })).toEqual({ tool: 'Read' })
    expect(insightLink({ evidence: { tools: [{ name: 'WebFetch' }] }, turnIndexes: [] })).toEqual({ tool: 'WebFetch' })
    expect(insightLink({ evidence: { files: [] }, turnIndexes: [7, 9] })).toEqual({ turn: 7 })
    expect(insightLink({ evidence: {}, turnIndexes: [] })).toBeUndefined()
  })
})

describe('compactionMarkers', () => {
  it('marks the first main-thread point at or after each compaction, clamping to the last point', () => {
    const main = [{ ts: 10 }, { ts: 20 }, { ts: 30 }]
    expect(compactionMarkers([{ ts: 15, turnIndex: 2 }, { ts: 99, turnIndex: 5 }], main)).toEqual([
      { x: 1, label: 'compaction @turn 2' },
      { x: 2, label: 'compaction @turn 5' },
    ])
    expect(compactionMarkers([{ turnIndex: 1 }], [])).toEqual([{ x: 0, label: 'compaction @turn 1' }])
  })
})

describe('contextHeadline (A5)', () => {
  const base = { summary: summary({ totalTokens: 100_000, contextPeak: 75_000, cacheHitRatio: 0.97 }), context: { contextWindow: 100_000 }, tokens: { agents: 58_000 } }
  it('joins the three measured clauses', () => {
    expect(contextHeadline(base as never)).toBe('Context grew to 75% of the window; 97% of tokens were cache reads; 58% went to subagents.')
  })
  it('drops every clause whose input is missing, down to a designed empty sentence', () => {
    expect(contextHeadline({ ...base, context: {} } as never)).toBe('97% of tokens were cache reads; 58% went to subagents.')
    expect(contextHeadline({ ...base, tokens: { agents: 0 } } as never)).toBe('Context grew to 75% of the window; 97% of tokens were cache reads.')
    expect(contextHeadline({ summary: summary({ totalTokens: 0 }), context: {}, tokens: { agents: 0 } } as never)).toBe('No token usage was recorded for this session.')
  })
})
