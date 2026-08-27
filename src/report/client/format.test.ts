import { describe, expect, it } from 'vitest'
import { tok } from './format.js'

describe('tok', () => {
  it('formats small numbers plainly', () => {
    expect(tok(0)).toBe('0')
    expect(tok(999)).toBe('999')
  })
  it('keeps the k and M tiers', () => {
    expect(tok(1_500)).toBe('1.5k')
    expect(tok(9.99e8)).toMatch(/M$/)
  })
  it('has a B tier so fleet-wide totals never read as thousands of millions', () => {
    const fleet = tok(39_384_000_000)
    expect(fleet).not.toBe('39384M')
    expect(fleet.startsWith('39')).toBe(true)
    expect(fleet.endsWith('B')).toBe(true)
    expect(tok(1.44e9)).toBe('1.4B')
    expect(tok(1e10)).toBe('10B')
  })
})
