/** Live badge = pure function of mtime (policy). `possiblyLive` only changes the copy, never the badge. */
import type { LiveBadge } from '../model/app-data.js'
import { LIVE_THRESHOLDS_MS } from './types.js'

export function badgeFor(mtimeMs: number, now: number): { badge: LiveBadge; ageMs: number } {
  const ageMs = Math.max(0, now - mtimeMs)
  const badge: LiveBadge = ageMs < LIVE_THRESHOLDS_MS.live ? 'live' : ageMs < LIVE_THRESHOLDS_MS.idle ? 'idle' : 'ended'
  return { badge, ageMs }
}
