/**
 * A session where the session-scoped hidden-iterations rule fires: a refusal switched the model for the rest
 * of the session, and 2 earlier attempts used 41.2k tokens that never showed as a message. No golden fixture
 * fires this rule, so the rendered STE rows (scripts/ste-surfaces.ts) add this session to the golden corpus.
 *
 * Its title is the longest one a cross finding composes: "In one session: " + 23 words = 26 words, one over
 * the 25-word limit for a description. The rendered rows must see that composition (test/ste.test.ts).
 *
 * Not in test/fixtures/corpus.ts, so test/golden/ does not move. Synthetic and deterministic, like the corpus:
 * the id counter is reset, the analysis runs with version 'golden' and now 0, and the clock fields are masked.
 */
import { SessionBuilder, resetIds } from './session-builder.js'
import { parseClaudeCodeSession } from '../../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../../src/analyze/analyze.js'
import { aggregate, type Aggregate } from '../../src/analyze/aggregate.js'
import type { Analysis } from '../../src/model/analysis.js'

/** the file the rendered rows name as the source of this session */
export const HIDDEN_ITERATIONS_FIXTURE = 'test/fixtures/hidden-iterations.ts'

/** One earlier attempt of 20,600 tokens on the fallback model, then the attempt that showed as the message. */
const fallbackUsage = {
  input_tokens: 5,
  cache_read_input_tokens: 12_000,
  output_tokens: 90,
  iterations: [
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 4, cache_read_input_tokens: 20_480, cache_creation_input_tokens: 0, output_tokens: 116 },
    { type: 'message', input_tokens: 5, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 0, output_tokens: 90 },
  ],
}

export function hiddenIterationsSession(sessionId = '1a1a1a1a-0000-4000-8000-000000000008'): SessionBuilder {
  const b = new SessionBuilder({ sessionId, startAt: '2026-08-21T09:30:00.000Z' })
  b.userPrompt('Summarize the security review notes')
  b.tick(900)
  b.system('model_refusal_fallback', { content: 'refusal fallback', originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-4-8', scope: 'session' })
  b.assistant([{ type: 'text', text: 'Reading the notes.' }], { usage: fallbackUsage })
  b.tick(1200)
  b.assistant([{ type: 'text', text: 'Here is the summary.' }], { usage: fallbackUsage })
  b.turnDuration(2_500, 3)
  return b
}

export async function hiddenIterationsAnalysis(sessionId?: string): Promise<Analysis> {
  resetIds()
  const s = await parseClaudeCodeSession({ records: hiddenIterationsSession(sessionId).toRecords(), noSidecar: true })
  const a = analyzeSession(s, { version: 'golden', now: 0 })
  a.generator.generatedAt = 0
  a.parse.parseMs = 0
  return a
}

/** The repo view of 2 such sessions: one recurring hidden-iterations finding, with its marked title. */
export async function hiddenIterationsAggregate(): Promise<Aggregate> {
  const sessions = [await hiddenIterationsAnalysis('1a1a1a1a-0000-4000-8000-000000000008'), await hiddenIterationsAnalysis('2b2b2b2b-0000-4000-8000-000000000009')]
  return aggregate(sessions, 'repo fixture', 0)
}
