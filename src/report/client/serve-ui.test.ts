import { describe, expect, it, vi } from 'vitest'
import { HARNESS_REFRESH_MS, ensureHarness, invalidateHarness, serveUi } from './serve-ui.js'
import { megaReview } from './mega-review.js'
import { proposalsUi } from './proposals-ui.js'
import { queueCardHtml, queueCardText } from './queue-card.js'
import type { QueueRead } from './queue-types.js'

describe('the serve-only proposals seam', () => {
  it('serve provides the stored-proposal block and the improvement home', () => {
    expect(serveUi.proposals).toBe(proposalsUi)
  })

  it('wraps the whole-harness card in the anchor that the Queue section scrolls to', () => {
    expect(serveUi.megaReview('repo')).toBe(`<div id="home-mega">${megaReview('repo')}</div>`)
  })
})

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
    expect(megaReview('repo')).toContain('Improve the harness of this repository')
    expect(megaReview('repo')).toContain('It ranks a plan of changes to your harness and your scripts. Then it waits until you approve the plan.')
    expect(megaReview('repo')).toContain('Approve the items that you want. Claude applies them.')
    expect(megaReview('repo')).not.toContain('review only')
    const global = megaReview('global')
    expect(global).toContain('Review every harness on this machine')
    expect(global).not.toContain('Claude applies them')
    expect((global.match(/Global scope is for review only\. Claude applies nothing\./g) ?? []).length).toBe(2)
  })

  // the copied text is `claude "/orangu:harness …"`, a shell command that starts Claude Code
  it.each([
    ['repo', 'Paste it in a terminal in this repository. It starts Claude Code.'],
    ['global', 'Paste it in a terminal. It starts Claude Code.'],
  ] as const)('says to paste the %s command in a terminal', (scope, paste) => {
    expect(megaReview(scope)).toContain(`<li><span>${paste}</span></li>`)
    expect(megaReview(scope)).not.toContain('Paste it in Claude Code')
  })
})

describe('the Overview harness card (M3)', () => {
  // the queue read never lands here, so each render of the card is the harness card's own state
  const OVERVIEW = { screen: 'overview', s: 'abc' }
  const pending = () => new Promise(() => {})

  it('renders the loading state while the first fetch is in flight, then the report line or the degraded line', async () => {
    vi.resetModules() // the report cache is module state; start from "never fetched"
    const { serveUi } = await import('./serve-ui.js')
    let resolve!: (r: unknown) => void
    const ds = { harness: vi.fn(() => new Promise((r) => { resolve = r })), queue: vi.fn(pending) } as unknown as Parameters<typeof serveUi.harnessCard>[0]
    const onLoaded = vi.fn()
    const loading = serveUi.harnessCard(ds, onLoaded, '#harness?s=abc', OVERVIEW)
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('href="#harness?s=abc"')
    expect(loading).toContain('Harness')
    expect(serveUi.harnessCard(ds, onLoaded, '#harness?s=abc', OVERVIEW)).toBe(loading) // one fetch, same state
    resolve({ inventory: { settings: [], skills: [], agents: [], plugins: [], mcpServers: [], claudeMd: [] } })
    await new Promise((r) => setTimeout(r, 0))
    expect(onLoaded).toHaveBeenCalledTimes(1)
    const loaded = serveUi.harnessCard(ds, onLoaded, '#harness?s=abc', OVERVIEW)
    expect(loaded.match(/aria-busy/g), 'only the queue card still loads').toHaveLength(1)
    expect(loaded).toContain('orangu found no harness config under the scanned roots')

    vi.resetModules()
    const fresh = (await import('./serve-ui.js')).serveUi
    const failing = { harness: vi.fn(async () => { throw new Error('502') }), queue: vi.fn(pending) } as unknown as Parameters<typeof fresh.harnessCard>[0]
    expect(fresh.harnessCard(failing, onLoaded, '#harness', OVERVIEW)).toContain('aria-busy="true"')
    await new Promise((r) => setTimeout(r, 0))
    expect(fresh.harnessCard(failing, onLoaded, '#harness', OVERVIEW)).toContain('orangu could not compute the harness report.')
  })
})

describe('the Overview queue card', () => {
  const read = (counts: Partial<QueueRead['counts']>): QueueRead => ({
    v: 1, scope: '~/code/demo', now: 0, globalOpen: 0,
    counts: { verdict: 0, regressed: 0, apply: 0, review: 0, running: 0, wait: 0, due: 0, open: 0, ...counts },
    groups: { verdict: [], regressed: [], apply: [], review: [], running: [], wait: [] },
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('puts the queue card first and the harness card second in 1 row in Detailed, each with no margin of its own', async () => {
    vi.resetModules()
    const { serveUi } = await import('./serve-ui.js')
    const ds = { harness: vi.fn(() => new Promise(() => {})), queue: vi.fn(async () => read({ due: 1, verdict: 1, open: 1 })) } as unknown as Parameters<typeof serveUi.harnessCard>[0]
    const onLoaded = vi.fn()
    serveUi.harnessCard(ds, onLoaded, '#harness?s=abc', { screen: 'overview', s: 'abc' })
    await flush()
    expect(onLoaded).toHaveBeenCalledTimes(1)
    const html = serveUi.harnessCard(ds, onLoaded, '#harness?s=abc', { screen: 'overview', s: 'abc' })
    expect(html.startsWith('<div class="two-up mb16"><a class="card pad harness-card" href="#suggest?s=abc">')).toBe(true)
    expect(html.indexOf('Improvements: 1 due')).toBeLessThan(html.indexOf('href="#harness?s=abc"'))
    expect(html).toContain('<a class="card pad harness-card" href="#harness?s=abc"')
    expect(html).not.toContain('pad mb16 harness-card')
    expect(ds.queue).toHaveBeenCalledTimes(1)
  })

  it('shows the queue card alone, with its own margin, in Plain language, and reads no harness report', async () => {
    vi.resetModules()
    const { serveUi } = await import('./serve-ui.js')
    const ds = { harness: vi.fn(), queue: vi.fn(async () => read({})) } as unknown as Parameters<typeof serveUi.harnessCard>[0]
    const plain = { screen: 'overview', s: 'abc', audience: 'plain' as const, theme: 'dark' }
    serveUi.harnessCard(ds, vi.fn(), '#harness', plain)
    await flush()
    const html = serveUi.harnessCard(ds, vi.fn(), '#harness', plain)
    expect(html).toBe('<a class="card pad mb16 harness-card" href="#suggest?s=abc&amp;audience=plain&amp;theme=dark"><div class="eyebrow">Queue</div><div class="card-title" style="margin:2px 0">Your queue is empty</div><div class="small muted">Open Improvements →</div></a>')
    expect(ds.harness).not.toHaveBeenCalled()
  })

  it.each([
    ['loading', undefined, 'Improvements', 'orangu counts the queue.'],
    ['items', read({ due: 3, verdict: 3, regressed: 1, apply: 2, wait: 4, open: 10 }), 'Improvements: 3 due, 1 regressed, 2 to apply', 'Open the queue →'],
    ['open items, none due', read({ review: 12, wait: 4, open: 16 }), 'Improvements: 16 open, nothing due', 'Open the queue →'],
    ['empty', read({}), 'Your queue is empty', 'Open Improvements →'],
    ['error', null, 'orangu could not compute the queue', 'Open Improvements to see the reason →'],
  ] as const)('shows the %s state with its title and its hint, and links to the Improvements screen', (_, q, title, hint) => {
    const html = queueCardHtml(q, '#suggest?s=abc')
    expect(html).toContain(`<div class="card-title" style="margin:2px 0">${title}</div><div class="small muted">${hint}</div>`)
    expect(html).toContain('href="#suggest')
    expect(html.includes('aria-busy="true"')).toBe(q === undefined)
    expect(queueCardText(q)).toEqual({ title, hint })
  })

  it('leaves out each count of 0 from the title', () => {
    expect(queueCardText(read({ regressed: 2, open: 2 })).title).toBe('Improvements: 2 regressed')
    expect(queueCardText(read({ apply: 1, review: 1, open: 2 })).title).toBe('Improvements: 1 to apply')
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
