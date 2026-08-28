import { describe, expect, it } from 'vitest'
import { ms, plural, tok } from './format.js'

const H = 3_600_000

describe('ms', () => {
  it('keeps the ms / s / m / h tiers', () => {
    expect(ms(420)).toBe('420ms')
    expect(ms(9_400)).toBe('9.4s')
    expect(ms(125_000)).toBe('2m 5s')
    expect(ms(23 * H + 59 * 60_000)).toBe('23h 59m')
    expect(ms(undefined)).toBe('–')
    expect(ms(NaN)).toBe('–')
  })
  it('has a day tier so fleet-wide active time never reads as thousands of hours', () => {
    expect(ms(3705.25 * H)).toBe('154d 9h')
    expect(ms(1311 * H + 10 * 60_000)).toBe('54d 15h')
    expect(ms(24 * H)).toBe('1d 0h')
    expect(ms(3705 * H)).not.toContain('3705h')
  })
})

describe('plural', () => {
  it('agrees the noun with the count', () => {
    expect(plural(1, 'session')).toBe('1 session')
    expect(plural(2, 'session')).toBe('2 sessions')
    expect(plural(1200, 'source')).toBe('1,200 sources')
  })
})

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
