import { describe, it, expect } from 'vitest'
import { currencyHits, moneyHits } from '../../../test/money-vocabulary.js'
import { PLAIN_TERMS, term, plainSentence, leadSentence } from './strings.js'

describe('plain-language vocabulary', () => {
  it('maps only mechanism terms to plain words', () => {
    expect(term('compaction', 'plain')).toBe('memory refresh')
    expect(term('context window', 'plain')).toBe('working memory')
    expect(term('cache read', 'plain')).toBe('reused context')
  })

  // A3: one vocabulary. "tokens" is the word in both audiences; turns, tool calls and subagents keep
  // their names. Plain mode removes panels instead of swapping nouns.
  it('keeps tokens, turns, tool calls and subagents as they are in Plain mode', () => {
    for (const w of ['tokens', 'turn', 'turns', 'tool call', 'tool calls', 'tool errors', 'subagent', 'subagents', 'agents']) expect(term(w, 'plain')).toBe(w)
    expect(plainSentence('3 turns · 12 tool calls · 40k tokens · 2 subagents', 'plain')).toBe('3 turns · 12 tool calls · 40k tokens · 2 subagents')
  })

  it('never invents a noun (ratchet)', () => {
    const invented = ['work units', 'work unit', 'helpers', 'helper', 'exchanges', 'exchange', 'steps', 'step']
    for (const v of Object.values(PLAIN_TERMS)) for (const bad of invented) expect(v, `PLAIN_TERMS value "${v}"`).not.toBe(bad)
  })

  it('is the identity in the Detailed view', () => {
    expect(term('turn', 'dev')).toBe('turn')
    expect(term('cache read', 'dev')).toBe('cache read')
  })

  it('contains no jargon in any plain value', () => {
    const banned = ['tool_use', 'cache_creation', 'sidechain', 'p95']
    for (const v of Object.values(PLAIN_TERMS)) {
      for (const b of banned) expect(v).not.toContain(b)
    }
  })

  // Keep legacy price language out of every rendered audience variant.
  // Money left the product, so there is no money term left to translate, in either direction.
  it('has no money vocabulary on either side of the map', () => {
    for (const [k, v] of Object.entries(PLAIN_TERMS)) {
      expect(moneyHits(`${k} ${v}`), `PLAIN_TERMS entry "${k}" -> "${v}"`).toEqual([])
      expect(currencyHits(`${k} ${v}`)).toEqual([])
    }
  })

  it('rewrites a whole sentence in plain audience', () => {
    expect(plainSentence('3 turns used the context window', 'plain')).toBe('3 turns used the working memory')
    expect(plainSentence('3 turns used the context window', 'dev')).toBe('3 turns used the context window')
  })
})

// The Plain "What happened" line is the narrative's first sentence. Splitting on the first ". " cut
// "made 19 requests (26 turns incl. commands/automation) over 34h 59m; ..." at "incl." with an open
// parenthesis (the common case: every session with automation turns).
describe('leadSentence', () => {
  const narrative =
    'In this session, the human made 19 requests (26 turns incl. commands/automation) over 34h 59m; the agent was busy for 3h 39m of that. It made 800 tool calls (8 failed), ran 14 subagents, and processed 1.2M tokens. Visible outcomes: 108 commits.'
  it('keeps a parenthetical abbreviation inside the sentence', () => {
    expect(leadSentence(narrative)).toBe(
      'In this session, the human made 19 requests (26 turns incl. commands/automation) over 34h 59m; the agent was busy for 3h 39m of that.',
    )
  })
  it('still cuts at the first real sentence end', () => {
    expect(leadSentence('It made 3 tool calls. Visible outcomes: 1 commit.')).toBe('It made 3 tool calls.')
    expect(leadSentence('No commits, PRs or test runs were detected.')).toBe('No commits, PRs or test runs were detected.')
  })
  it('never ends on an abbreviation outside parentheses, and returns the whole text without an acceptable cut', () => {
    expect(leadSentence('Read 4 files incl. tests. Then stopped.')).toBe('Read 4 files incl. tests.')
    expect(leadSentence('one sentence without a period')).toBe('one sentence without a period')
    expect(leadSentence('  spaced  ')).toBe('spaced')
  })
})
