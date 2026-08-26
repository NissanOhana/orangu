import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { buildCanonicalSession, SessionBuilder, fakeToolUseId } from '../../test/fixtures/session-builder.js'
import { GOLDEN_FIXTURES, goldenAnalysis } from '../../test/fixtures/corpus.js'
import { slimAnalysis } from './slim.js'
import type { Analysis } from '../model/analysis.js'

async function analyzed(b: SessionBuilder): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}

/** a deliberately heavy session: many turns, tool calls, files, an agent — the multi-MB axis */
function buildHeavySession(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', startAt: '2026-08-14T09:00:00.000Z' })
  for (let t = 0; t < 25; t++) {
    b.userPrompt(`Task ${t}: refactor module ${t} and run the tests until green, please`)
    b.tick(1000)
    for (let c = 0; c < 8; c++) {
      b.toolCall(
        c % 3 === 0 ? 'Read' : c % 3 === 1 ? 'Bash' : 'Edit',
        { file_path: `/Users/test/Code/demo/src/mod${t}/file${c}.ts`, command: 'npm test' },
        'x'.repeat(2000),
        { durationMs: 300 + c, isError: c === 7, usage: { input_tokens: 5, cache_read_input_tokens: 40_000 + t * 500, output_tokens: 150 } },
      )
    }
    b.turnDuration(20_000, 17)
    b.tick(5_000)
  }
  // one subagent
  const agentToolId = fakeToolUseId()
  b.userPrompt('now review everything')
  b.assistant([{ type: 'tool_use', id: agentToolId, name: 'Agent', input: { description: 'Review', prompt: 'Review', subagent_type: 'reviewer' } }])
  b.sidechain('feedfeedfeedfeed')
  b.userPrompt('Review')
  b.assistant([{ type: 'text', text: 'done' }], { model: 'claude-sonnet-5', usage: { input_tokens: 9000, output_tokens: 400 } })
  b.sidechain('', false)
  b.toolResult(agentToolId, 'done', { toolUseResult: { status: 'completed', agentId: 'feedfeedfeedfeed', content: [{ type: 'text', text: 'done' }], totalDurationMs: 900, totalTokens: 9400, totalToolUseCount: 0 } })
  b.turnDuration(3_000, 4)
  return b
}

describe('slimAnalysis', () => {
  it('omits the multi-MB fields and keeps the evidence fields', async () => {
    const a = await analyzed(buildCanonicalSession())
    const slim = slimAnalysis(a) as unknown as Record<string, unknown>
    expect(slim['slim']).toBe(true)
    expect(slim['turns']).toBeUndefined()
    expect(slim['events']).toBeUndefined()
    expect((slim['tools'] as Record<string, unknown>)['calls']).toBeUndefined()
    expect((slim['tools'] as Record<string, unknown>)['byName']).toBeTruthy()
    expect((slim['context'] as Record<string, unknown>)['series']).toBeUndefined()
    expect((slim['context'] as Record<string, unknown>)['peak']).toBeTypeOf('number')
    expect((slim['files'] as Record<string, unknown>)['mostReRead']).toBeTruthy()
    expect((slim['agents'] as Record<string, unknown>)['byType']).toBeTruthy()
    expect((slim['agents'] as Record<string, unknown>)['runs']).toBeUndefined()
    expect((slim['quality'] as Record<string, unknown>)['signals']).toBeTruthy()
    // parse keeps ONLY reconciliation — no warnings / unknown-type payloads
    expect((slim['parse'] as Record<string, unknown>)['reconciliation']).toBeTruthy()
    expect(Object.keys(slim['parse'] as Record<string, unknown>)).toEqual(['reconciliation'])
    expect(slim['summary']).toBeTruthy()
    expect(slim['insights']).toBeTruthy()
  })

  it('is < 20 KB on the canonical fixture and stays small on a heavy session', async () => {
    const canonical = await analyzed(buildCanonicalSession())
    const heavy = await analyzed(buildHeavySession())
    const canonicalSlim = Buffer.byteLength(JSON.stringify(slimAnalysis(canonical)))
    const heavySlim = Buffer.byteLength(JSON.stringify(slimAnalysis(heavy)))
    const heavyFull = Buffer.byteLength(JSON.stringify(heavy))
    expect(canonicalSlim).toBeLessThan(20_000)
    expect(heavySlim).toBeLessThan(40_000)
    // the projection must actually shed the bulk
    expect(heavySlim).toBeLessThan(heavyFull / 3)
  })

  it('is < 20 KB per session on every golden fixture', async () => {
    for (const fx of GOLDEN_FIXTURES) {
      const a = await goldenAnalysis(fx)
      const bytes = Buffer.byteLength(JSON.stringify(slimAnalysis(a)))
      expect(bytes, `${fx.name}: ${bytes} bytes`).toBeLessThan(20_000)
    }
  })
})
