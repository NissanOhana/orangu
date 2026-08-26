/**
 * Performance ratchet: a large synthetic session must parse and analyze in seconds, not minutes.
 * It exercises sibling-message lookup, multi-model attribution, and per-turn usage aggregation so
 * accidental O(n²) implementations fail the time bound.
 */
import { describe, expect, it } from 'vitest'
import { SessionBuilder, fakeMessageId } from './fixtures/session-builder.js'
import { parseClaudeCodeSession } from '../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../src/analyze/analyze.js'

const TURNS = 40
const MSGS_PER_TURN = 500 // alternating models → the multi-model per-turn attribution path
const AGENTS = 300
const EVENTS_PER_AGENT = 20

function buildBigSession(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'perfperf-0000-4000-8000-000000000001', startAt: '2026-08-14T10:00:00.000Z' })
  const models = ['claude-opus-5', 'claude-sonnet-5']
  for (let t = 0; t < TURNS; t++) {
    b.userPrompt(`do thing ${t}`)
    for (let i = 0; i < MSGS_PER_TURN; i++) {
      b.tick(50)
      const model = models[i % 2] as string
      if (i % 10 === 0) {
        // a multi-chunk provider message: two records share one message id (sibling-chunk scan path)
        const mid = fakeMessageId()
        b.assistant([{ type: 'text', text: 'chunk one' }], { model, messageId: mid, stopReason: null as unknown as string })
        b.toolCall('Bash', { command: `echo ${i}`, description: 'echo' }, 'ok', { durationMs: 10, usage: { input_tokens: 2, output_tokens: 5 } })
      } else {
        b.assistant([{ type: 'text', text: `msg ${i}` }], { model, usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 1000 + i } })
      }
    }
  }
  // 300 sidechain agents, each with usage events
  for (let a = 0; a < AGENTS; a++) {
    b.sidechain(`agent-${a}`)
    for (let i = 0; i < EVENTS_PER_AGENT; i++) {
      b.tick(20)
      b.assistant([{ type: 'text', text: `agent ${a} step ${i}` }], { usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 500 } })
    }
    b.sidechain('', false)
  }
  return b
}

describe('engine perf (O(n²) ratchet)', () => {
  it('parses + analyzes a 20k+ usage-event / 300-agent session in < 3 s', async () => {
    const records = buildBigSession().toRecords()
    const t0 = performance.now()
    const s = await parseClaudeCodeSession({ records, noSidecar: true })
    const a = analyzeSession(s, { version: 'perf', now: 0 })
    const elapsedMs = performance.now() - t0
    expect(a.summary.turns).toBe(TURNS)
    expect(a.summary.agents).toBe(AGENTS)
    expect(s.usageEvents.length).toBeGreaterThan(20_000)
    expect(a.parse.reconciliation.ok).toBe(true)
    expect(elapsedMs).toBeLessThan(3000)
  }, 300_000)
})
