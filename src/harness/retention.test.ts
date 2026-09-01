/**
 * Retention engine tests: precedence, the built-in default, invalid values, the Desktop/Cowork exemption,
 * the expiring-soon window, and byte-identical output for identical input.
 *
 * Fixtures are plain objects. No transcript is read, and `now` is a literal in every case: the module under
 * test never reads a clock, so a test that passed one would be testing something else.
 */
import { describe, it, expect } from 'vitest'
import {
  computeRetention,
  RETENTION_DEFAULT_DAYS,
  RETENTION_EXPIRING_WINDOW_DAYS,
  RETENTION_MIN_DAYS,
  type RetentionSessionRef,
} from './retention.js'
import type { HarnessConfigScope, HarnessSettingsFile } from './types.js'

const DAY = 86_400_000
/** a fixed instant, so every age below is exact */
const NOW = 1_700_000_000_000

function settings(scope: HarnessConfigScope, over: Partial<HarnessSettingsFile> = {}): HarnessSettingsFile {
  return {
    scope,
    file: `~/.claude/${scope}-settings.json`,
    keys: [],
    permissions: { allow: 0, deny: 0, ask: 0 },
    hooks: [],
    env: { count: 0, names: [] },
    statusLine: false,
    enabledPlugins: [],
    ...over,
  }
}

/** a session `ageDays` old, `kb` kilobytes on disk, under a normal Claude Code root */
function session(ageDays: number, kb = 1, name = `s${ageDays}`): RetentionSessionRef {
  return { path: `/roots/.claude/projects/-repo/${name}.jsonl`, sizeBytes: kb * 1024, mtimeMs: NOW - ageDays * DAY }
}

/** the same, but nested in a Cowork / Claude Desktop local-mode root */
function desktopSession(ageDays: number, kb = 1, name = `d${ageDays}`): RetentionSessionRef {
  return {
    path: `/base/Library/Application Support/Claude/local-agent-mode-sessions/a/b/local_1/.claude/projects/-repo/${name}.jsonl`,
    sizeBytes: kb * 1024,
    mtimeMs: NOW - ageDays * DAY,
  }
}

describe('computeRetention: resolving the effective window', () => {
  it('falls back to the built-in default when no settings file sets the key', () => {
    const r = computeRetention([settings('global'), settings('repo')], [], NOW)
    expect(r.effectiveDays).toBe(RETENTION_DEFAULT_DAYS)
    expect(RETENTION_DEFAULT_DAYS).toBe(30)
    expect(r.isDefault).toBe(true)
    expect(r.source).toBeUndefined()
    expect(r.invalidConfigured).toBeUndefined()
  })

  it('takes the value from the highest-precedence scope: repo-local > repo > global-local > global', () => {
    const all = [
      settings('global', { cleanupPeriodDays: 4 }),
      settings('global-local', { cleanupPeriodDays: 3 }),
      settings('repo', { cleanupPeriodDays: 2 }),
      settings('repo-local', { cleanupPeriodDays: 1 }),
    ]
    expect(computeRetention(all, [], NOW).effectiveDays).toBe(1)
    expect(computeRetention(all.slice(0, 3), [], NOW).effectiveDays).toBe(2)
    expect(computeRetention(all.slice(0, 2), [], NOW).effectiveDays).toBe(3)
    expect(computeRetention(all.slice(0, 1), [], NOW).effectiveDays).toBe(4)
  })

  it('names the file the winning value came from', () => {
    const r = computeRetention([settings('global', { cleanupPeriodDays: 45 })], [], NOW)
    expect(r.isDefault).toBe(false)
    expect(r.source).toEqual({ scope: 'global', file: '~/.claude/global-settings.json' })
  })

  it('ignores a value below the minimum or one that is not a whole number, and counts it', () => {
    for (const bad of [0, -1, 0.5, 30.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = computeRetention([settings('repo', { cleanupPeriodDays: bad })], [], NOW)
      expect(r.effectiveDays, `${bad} must not become the window`).toBe(RETENTION_DEFAULT_DAYS)
      expect(r.isDefault).toBe(true)
      expect(r.invalidConfigured).toBe(1)
    }
    expect(RETENTION_MIN_DAYS).toBe(1)
  })

  it('falls through an invalid higher-precedence value to the next usable one', () => {
    const r = computeRetention([settings('repo-local', { cleanupPeriodDays: 0 }), settings('global', { cleanupPeriodDays: 60 })], [], NOW)
    expect(r.effectiveDays).toBe(60)
    expect(r.source?.scope).toBe('global')
    expect(r.invalidConfigured).toBe(1)
  })

  it('never reports zero as a window, because Claude Code rejects it', () => {
    const r = computeRetention([settings('global', { cleanupPeriodDays: 0 })], [session(1)], NOW)
    expect(r.effectiveDays).toBeGreaterThanOrEqual(RETENTION_MIN_DAYS)
    expect(JSON.stringify(r)).not.toContain('"effectiveDays":0')
  })
})

describe('computeRetention: which sessions the sweep can reach', () => {
  it('counts normal roots as sweepable and keeps Desktop/Cowork sessions out of that bucket', () => {
    const r = computeRetention([], [session(1, 2), session(2, 3), desktopSession(400, 10)], NOW)
    expect(r.sweepable).toEqual({ sessions: 2, bytes: 5 * 1024 })
    expect(r.exempt.sessions).toBe(1)
    expect(r.exempt.bytes).toBe(10 * 1024)
  })

  it('reports the oldest sweepable age in whole days, and omits it when nothing is sweepable', () => {
    expect(computeRetention([], [session(3), session(41), session(9)], NOW).oldestSweepableDays).toBe(41)
    const noneSweepable = computeRetention([], [desktopSession(90)], NOW)
    expect(noneSweepable.oldestSweepableDays).toBeUndefined()
    expect(noneSweepable.sweepable).toEqual({ sessions: 0, bytes: 0 })
  })

  it('surfaces the Desktop/Cowork limit only when a settings file sets one', () => {
    expect(computeRetention([settings('global')], [desktopSession(10)], NOW).exempt.configuredDays).toBeUndefined()
    const limited = computeRetention([settings('global', { desktopSessionCleanupPeriodDays: 90 })], [desktopSession(10)], NOW)
    expect(limited.exempt.configuredDays).toBe(90)
    // the same validity rule as the main key: a value below the minimum is not a window
    expect(computeRetention([settings('global', { desktopSessionCleanupPeriodDays: 0 })], [desktopSession(10)], NOW).exempt.configuredDays).toBeUndefined()
  })

  it('clamps a future mtime to age zero instead of producing a negative day count', () => {
    const r = computeRetention([], [{ path: '/roots/.claude/projects/-repo/future.jsonl', sizeBytes: 1, mtimeMs: NOW + 5 * DAY }], NOW)
    expect(r.oldestSweepableDays).toBe(0)
    expect(r.expiringSoon.sessions).toBe(0)
  })
})

describe('computeRetention: the expiring-soon window', () => {
  it('counts a sweepable session once it is within the window of the cutoff', () => {
    expect(RETENTION_EXPIRING_WINDOW_DAYS).toBe(7)
    // default 30-day window: the boundary is 23 days of age
    const r = computeRetention([], [session(22, 1), session(23, 2), session(29, 4), session(31, 8)], NOW)
    expect(r.expiringSoon.windowDays).toBe(7)
    expect(r.expiringSoon.sessions).toBe(3)
    expect(r.expiringSoon.bytes).toBe((2 + 4 + 8) * 1024)
  })

  it('moves the boundary with the configured window', () => {
    const refs = [session(2), session(4), session(20)]
    expect(computeRetention([settings('repo', { cleanupPeriodDays: 10 })], refs, NOW).expiringSoon.sessions).toBe(2)
    expect(computeRetention([settings('repo', { cleanupPeriodDays: 90 })], refs, NOW).expiringSoon.sessions).toBe(0)
  })

  it('never counts a Desktop/Cowork session as expiring, whatever its age', () => {
    const r = computeRetention([], [desktopSession(365, 5)], NOW)
    expect(r.expiringSoon).toEqual({ sessions: 0, bytes: 0, windowDays: RETENTION_EXPIRING_WINDOW_DAYS })
  })
})

describe('computeRetention: deterministic', () => {
  it('produces byte-identical JSON for identical input', () => {
    const cfg = [settings('repo-local', { cleanupPeriodDays: 14 }), settings('global', { cleanupPeriodDays: 0 })]
    const refs = [session(13), session(1), desktopSession(200), session(8)]
    expect(JSON.stringify(computeRetention(cfg, refs, NOW))).toBe(JSON.stringify(computeRetention(cfg, refs, NOW)))
  })

  it('depends on the injected instant, not on a clock', () => {
    const refs = [session(20)]
    expect(computeRetention([], refs, NOW).expiringSoon.sessions).toBe(0)
    expect(computeRetention([], refs, NOW + 3 * DAY).expiringSoon.sessions).toBe(1)
  })
})
