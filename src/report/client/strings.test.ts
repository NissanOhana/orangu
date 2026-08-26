import { describe, it, expect } from 'vitest'
import { currencyHits, moneyHits } from '../../../test/money-vocabulary.js'
import { PLAIN_TERMS, term, plainSentence } from './strings.js'

describe('plain-language vocabulary', () => {
  it('maps detailed terms to plain words', () => {
    expect(term('turn', 'plain')).toBe('exchange')
    expect(term('turns', 'plain')).toBe('exchanges')
    expect(term('subagent', 'plain')).toBe('helper')
    expect(term('tool call', 'plain')).toBe('step')
    expect(term('compaction', 'plain')).toBe('memory refresh')
    expect(term('context window', 'plain')).toBe('working memory')
    expect(term('tokens', 'plain')).toBe('work units')
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
    expect(plainSentence('3 turns used the context window', 'plain')).toBe('3 exchanges used the working memory')
    expect(plainSentence('3 turns used the context window', 'dev')).toBe('3 turns used the context window')
  })
})
