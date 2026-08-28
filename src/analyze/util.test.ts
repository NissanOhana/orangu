import { describe, expect, it } from 'vitest'
import { fmtTokens } from './util.js'
import { tok } from '../report/client/format.js'

describe('fmtTokens', () => {
  it('formats small numbers plainly and keeps the k and M tiers', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1_500)).toBe('1.5k')
    expect(fmtTokens(2_345_678)).toBe('2.35M')
    expect(fmtTokens(9.99e8)).toMatch(/M$/)
  })
  // the CLI's counterpart of the tok() B-tier test in src/report/client/format.test.ts: `orangu repo`
  // printed a fleet-wide total as "1180.16M" because this helper stopped at the M tier
  it('has a B tier so fleet-wide totals never read as thousands of millions', () => {
    expect(fmtTokens(1_180_160_000)).toBe('1.2B')
    expect(fmtTokens(1_180_160_000)).not.toBe('1180.16M')
    expect(fmtTokens(1.44e9)).toBe('1.4B')
    expect(fmtTokens(1e10)).toBe('10B')
    expect(fmtTokens(39_384_000_000)).toBe('39B')
  })
  it('agrees with the report client at the B tier', () => {
    for (const n of [1e9, 1_180_160_000, 1.44e9, 9.99e9, 1e10, 39_384_000_000]) expect(fmtTokens(n)).toBe(tok(n))
  })
})
