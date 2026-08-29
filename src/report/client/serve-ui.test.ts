import { describe, expect, it, vi } from 'vitest'
import { HARNESS_REFRESH_MS, ensureHarness, invalidateHarness } from './serve-ui.js'
import { megaReview } from './mega-review.js'

describe('whole-harness review CTA', () => {
  it.each(['repo', 'global'] as const)('is an exact copy-only %s command with no row lifecycle', (scope) => {
    const html = megaReview(scope)
    expect(html).toContain(`claude &quot;/orangu:harness --scope ${scope}&quot;`)
    expect(html).toContain('data-copy=')
    expect(html).not.toContain('data-kick')
    expect(html).not.toContain('status-chip')
  })

  // AC19: three steps, no more, no fewer, in both scopes; the block is the screen's primary action,
  // so its own control is the primary CTA class and the .cmd bar stays as the clipboard fallback.
  it.each(['repo', 'global'] as const)('is one card with a primary CTA and exactly three steps (%s)', (scope) => {
    const html = megaReview(scope)
    expect((html.match(/<li>/g) ?? []).length).toBe(3)
    expect(html).toContain('<div class="card pad mb16">')
    expect(html).toContain('<ol class="steps" aria-label="Run the whole-harness review">')
    expect(html).toContain('class="btn-primary"')
    expect(html).not.toContain('class="btn-sm"')
    expect(html).toContain('<div class="cmd">')
  })

  it('names the scope it can act on and never contradicts the global review-only boundary', () => {
    expect(megaReview('repo')).toContain('Improve this repository')
    expect(megaReview('repo')).toContain('approve the items you want')
    expect(megaReview('repo')).not.toContain('review only')
    const global = megaReview('global')
    expect(global).toContain('Review every harness on this machine')
    expect(global).not.toContain('Claude applies them')
    expect((global.match(/Global scope is review only: nothing is applied\./g) ?? []).length).toBe(2)
  })
})

describe('the Overview harness card (M3)', () => {
  it('renders the loading state while the first fetch is in flight, then the report line or the degraded line', async () => {
    vi.resetModules() // the report cache is module state; start from "never fetched"
    const { serveUi } = await import('./serve-ui.js')
    let resolve!: (r: unknown) => void
    const ds = { harness: vi.fn(() => new Promise((r) => { resolve = r })) } as unknown as Parameters<typeof serveUi.harnessCard>[0]
    const onLoaded = vi.fn()
    const loading = serveUi.harnessCard(ds, onLoaded, '#harness?s=abc')
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('href="#harness?s=abc"')
    expect(loading).toContain('Harness')
    expect(serveUi.harnessCard(ds, onLoaded, '#harness?s=abc')).toBe(loading) // one fetch, same state
    resolve({ inventory: { settings: [], skills: [], agents: [], plugins: [], mcpServers: [], claudeMd: [] } })
    await new Promise((r) => setTimeout(r, 0))
    expect(onLoaded).toHaveBeenCalledTimes(1)
    const loaded = serveUi.harnessCard(ds, onLoaded, '#harness?s=abc')
    expect(loaded).not.toContain('aria-busy')
    expect(loaded).toContain('no harness config found under the scanned roots')

    vi.resetModules()
    const fresh = (await import('./serve-ui.js')).serveUi
    const failing = { harness: vi.fn(async () => { throw new Error('502') }) } as unknown as Parameters<typeof fresh.harnessCard>[0]
    expect(fresh.harnessCard(failing, onLoaded, '#harness')).toContain('aria-busy="true"')
    await new Promise((r) => setTimeout(r, 0))
    expect(fresh.harnessCard(failing, onLoaded, '#harness')).toContain('could not be computed')
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
