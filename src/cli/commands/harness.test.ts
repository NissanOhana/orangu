import { describe, it, expect } from 'vitest'
import type { HarnessListingRow } from '../../harness/types.js'
import { printedListings } from './harness.js'

const row = (type: string, perMainSession: number, treeTokens: number): HarnessListingRow => ({
  type,
  main: { sessions: 1, injections: 1, bytes: treeTokens * 4, approxTokens: treeTokens },
  subagent: { sessions: 0, injections: 0, bytes: 0, approxTokens: 0 },
  approxTokensPerInjection: treeTokens,
  approxTokensPerMainSession: perMainSession,
})

describe('printedListings', () => {
  it('ranks the printed slice by the column it prints (tokens per main session), not by the JSON order (whole-tree tokens)', () => {
    // the JSON array is ranked by whole-tree tokens, so `big-tree` comes first there; the printout's headline
    // column is tokens per main session, and a slice taken in JSON order would hide the two rows that matter
    const rows = [row('big-tree', 100, 9_000_000), row('mid', 2_732, 4_000_000), row('heavy-per-session', 16_744, 50_000)]
    expect(printedListings(rows, 2).map((r) => r.type)).toEqual(['heavy-per-session', 'mid'])
    expect(printedListings(rows).map((r) => r.type)).toEqual(['heavy-per-session', 'mid', 'big-tree'])
  })
  it('breaks ties by type so two runs print the same order', () => {
    const rows = [row('b', 5, 1), row('a', 5, 1)]
    expect(printedListings(rows).map((r) => r.type)).toEqual(['a', 'b'])
  })
})
