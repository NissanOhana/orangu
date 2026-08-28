import { describe, expect, it, vi } from 'vitest'
import { HARNESS_REFRESH_MS, ensureHarness, invalidateHarness, megaReview } from './serve-ui.js'

describe('whole-harness review CTA', () => {
  it.each(['repo', 'global'] as const)('is an exact copy-only %s command with no row lifecycle', (scope) => {
    const html = megaReview(scope)
    expect(html).toContain(`claude &quot;/orangu:harness --scope ${scope}&quot;`)
    expect(html).toContain('data-copy=')
    expect(html).not.toContain('data-kick')
    expect(html).not.toContain('status-chip')
  })
})

describe('harness report cache', () => {
  const fakeDs = (report: unknown) => {
    const harness = vi.fn(async () => report as never)
    return { ds: { harness } as unknown as Parameters<typeof ensureHarness>[0], harness }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('fetches once, re-fetches only after an SSE invalidation older than the refresh floor, and keeps the last report meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { ds, harness } = fakeDs({ scope: {}, inventory: {}, crosswalk: {} })
      const onLoaded = vi.fn()
      expect(ensureHarness(ds, onLoaded)).toBe(true) // first fetch: the screen shows the loading state
      await flush()
      expect(harness).toHaveBeenCalledTimes(1)
      expect(onLoaded).toHaveBeenCalledTimes(1)
      expect(ensureHarness(ds, onLoaded)).toBe(false) // cached: no second request without a registry change
      expect(harness).toHaveBeenCalledTimes(1)

      invalidateHarness()
      expect(ensureHarness(ds, onLoaded)).toBe(false) // stale but inside the floor: still no request
      expect(harness).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + HARNESS_REFRESH_MS)
      expect(ensureHarness(ds, onLoaded)).toBe(false) // a refresh never returns to the loading state
      expect(harness).toHaveBeenCalledTimes(2)
      await flush()
      expect(onLoaded).toHaveBeenCalledTimes(2)
      expect(ensureHarness(ds, onLoaded)).toBe(false) // the invalidation was consumed by the refresh
      expect(harness).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
