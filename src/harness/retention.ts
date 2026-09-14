/**
 * Measures what Claude Code's own cleanup will delete out from under orangu.
 *
 * Claude Code sweeps `projects/<project>/<session>.jsonl` and that session's `subagents/` and `tool-results/`
 * once they are older than `cleanupPeriodDays`, which is exactly the evidence every other harness surface is
 * computed from. The auto-memory directory beside them is not swept, and Claude Desktop / Cowork transcripts
 * are kept at any age unless `desktopSessionCleanupPeriodDays` gives them their own window, so those sessions
 * are counted apart rather than reported as at-risk.
 *
 * This module states both halves of the tradeoff and picks neither: a longer window leaves more history to
 * measure, and leaves plaintext transcripts on disk for longer. It emits numbers, not a recommendation.
 *
 * `now` is INJECTED, never read: no clock call appears in this module or anywhere under `src/harness/`, which
 * `test/lint.test.ts` ratchets, so the same inputs always produce the same bytes.
 * Shape and doc-comment density copied from `src/harness/report.ts:1-11`.
 */
import { isDesktopSessionPath } from '../discover/discover.js'
import type { HarnessRetention, HarnessSettingsFile } from './types.js'
import { byPrecedence as orderByPrecedence } from './precedence.js'

/** Claude Code's built-in window when no settings file sets one */
export const RETENTION_DEFAULT_DAYS = 30

/** Claude Code rejects anything smaller, so a value below this is drift, not a configuration */
export const RETENTION_MIN_DAYS = 1

/** how close to the cutoff a session has to be before it is counted as expiring */
export const RETENTION_EXPIRING_WINDOW_DAYS = 7

const DAY_MS = 86_400_000

// Claude Code's settings precedence lives in `precedence.ts`, shared with the crosswalk: managed policy first
// (its drop-ins in reverse merge order), then project local, shared project, user local, user.

/** the three fields retention needs from a discovered session (`SessionRef`, `src/discover/discover.ts:40-49`) */
export interface RetentionSessionRef {
  path: string
  sizeBytes: number
  mtimeMs: number
}

/** a window has to be a whole number of days at or above the minimum; anything else is drift to be ignored */
function usableDays(v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  return Number.isInteger(v) && v >= RETENTION_MIN_DAYS ? v : undefined
}

/** whole days between `mtimeMs` and `now`; a future mtime is age zero rather than a negative count */
function ageDays(mtimeMs: number, now: number): number {
  return Math.max(0, Math.floor((now - mtimeMs) / DAY_MS))
}

/**
 * The settings files that can set a window for the swept corpus, highest precedence first.
 *
 * Files nested in a Cowork / Claude Desktop tree are dropped first. Under `--global`, `claudeRoots()` returns
 * those roots too and the collector labels every root's `settings.local.json` `global-local`, which outranks
 * the user's own `settings.json`. Those files govern Desktop sessions, which `cleanupPeriodDays` does not
 * reach, so letting one win would set the reported window for the whole machine from a single Desktop
 * session. `cleanPath` keeps the marker segment in the `~`-relativized path, so the predicate still matches.
 */
function byPrecedence(settings: readonly HarnessSettingsFile[]): HarnessSettingsFile[] {
  return orderByPrecedence(settings.filter((s) => !isDesktopSessionPath(s.file)))
}

export function computeRetention(settings: readonly HarnessSettingsFile[], sessions: readonly RetentionSessionRef[], now: number): HarnessRetention {
  const ordered = byPrecedence(settings)

  // An unusable value does not stop the resolution: it is counted and the next scope is read, because the
  // report must never crash or go silent on a configuration it did not expect.
  let effectiveDays = RETENTION_DEFAULT_DAYS
  let source: HarnessRetention['source']
  let invalidConfigured = 0
  for (const s of ordered) {
    if (s.cleanupPeriodDays === undefined) continue
    const days = usableDays(s.cleanupPeriodDays)
    if (days === undefined) {
      invalidConfigured++
      continue
    }
    if (source === undefined) {
      effectiveDays = days
      source = { scope: s.scope, file: s.file }
    }
  }
  const desktopDays = ordered.map((s) => usableDays(s.desktopSessionCleanupPeriodDays)).find((d) => d !== undefined)

  const sweepable = { sessions: 0, bytes: 0 }
  const exempt = { sessions: 0, bytes: 0 }
  const expiring = { sessions: 0, bytes: 0 }
  const pastCutoff = { sessions: 0, bytes: 0 }
  let oldestSweepableDays: number | undefined
  const expiresAtDays = effectiveDays - RETENTION_EXPIRING_WINDOW_DAYS
  for (const ref of sessions) {
    if (isDesktopSessionPath(ref.path)) {
      exempt.sessions++
      exempt.bytes += ref.sizeBytes
      continue
    }
    sweepable.sessions++
    sweepable.bytes += ref.sizeBytes
    const age = ageDays(ref.mtimeMs, now)
    if (oldestSweepableDays === undefined || age > oldestSweepableDays) oldestSweepableDays = age
    // The window is bounded at both ends. A session already older than the cutoff is not "within N days of
    // it": the sweep should have taken it, and a paused sweep or a just-lowered window is why it is still
    // here. Counting it apart keeps the two lines from contradicting each other.
    if (age >= effectiveDays) {
      pastCutoff.sessions++
      pastCutoff.bytes += ref.sizeBytes
    } else if (age >= expiresAtDays) {
      expiring.sessions++
      expiring.bytes += ref.sizeBytes
    }
  }

  return {
    effectiveDays,
    isDefault: source === undefined,
    ...(source ? { source } : {}),
    ...(invalidConfigured > 0 ? { invalidConfigured } : {}),
    sweepable,
    exempt: { ...exempt, ...(desktopDays !== undefined ? { configuredDays: desktopDays } : {}) },
    ...(oldestSweepableDays !== undefined ? { oldestSweepableDays } : {}),
    expiringSoon: { ...expiring, windowDays: RETENTION_EXPIRING_WINDOW_DAYS },
    pastCutoff,
  }
}
