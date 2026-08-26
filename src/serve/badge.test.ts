import { describe, it, expect } from 'vitest'
import { badgeFor } from './badge.js'
import { LIVE_THRESHOLDS_MS } from './types.js'

describe('badgeFor (policy: live < 5 min, idle 5–30 min, ended > 30 min, by mtime)', () => {
  const now = 1_000_000_000
  it('just under 5 min is live', () => {
    expect(badgeFor(now - LIVE_THRESHOLDS_MS.live + 1, now)).toEqual({ badge: 'live', ageMs: LIVE_THRESHOLDS_MS.live - 1 })
  })
  it('exactly 5 min is idle', () => {
    expect(badgeFor(now - LIVE_THRESHOLDS_MS.live, now).badge).toBe('idle')
  })
  it('just under 30 min is idle', () => {
    expect(badgeFor(now - LIVE_THRESHOLDS_MS.idle + 1, now).badge).toBe('idle')
  })
  it('exactly 30 min and beyond is ended', () => {
    expect(badgeFor(now - LIVE_THRESHOLDS_MS.idle, now).badge).toBe('ended')
    expect(badgeFor(0, now).badge).toBe('ended')
  })
  it('a future mtime clamps age to 0 and is live', () => {
    expect(badgeFor(now + 5000, now)).toEqual({ badge: 'live', ageMs: 0 })
  })
})
