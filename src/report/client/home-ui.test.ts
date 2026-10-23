import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppData } from '../../model/app-data.js'
import type { ServeEvent } from '../../serve/types.js'
import { queueFixture } from '../../../test/fixtures/suggestion-queue.js'
import type { Ctx } from './app.js'
import type { DataSource } from './data.js'
import type { QueueRead } from './queue-types.js'

/** The document parts that the frame touches, and what it did with them. */
interface FakeDocument {
  clicks: Array<(event: { target: unknown }) => void>
  regions: Array<{ textContent: string }>
  focused: number
}

let page: FakeDocument
let observe: (() => void) | undefined

beforeEach(() => {
  page = { clicks: [], regions: [], focused: 0 }
  observe = undefined
  vi.stubGlobal('Element', class {})
  vi.stubGlobal('HTMLDetailsElement', class {})
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) {
      observe = callback
    }
    observe(): void {}
  })
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: (event: { target: unknown }) => void) => {
      if (type === 'click') page.clicks.push(fn)
    },
    getElementById: (id: string) => (id === 'app' ? {} : id === 'home-status' ? page.regions[0] ?? null : null),
    createElement: () => {
      const region = { id: '', className: '', textContent: '', setAttribute: () => {} }
      page.regions.push(region)
      return region
    },
    body: { appendChild: () => {} },
    querySelector: (selector: string) => (selector === '#home-queue > summary' ? { focus: () => page.focused++ } : null),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The frame module with no read yet: its reads are module state. */
async function freshHome() {
  vi.resetModules()
  return import('./home-ui.js')
}

/** A data source whose queue read gives each value of `reads` in turn, and whose live frames the test sends. */
function source(...reads: Array<QueueRead | null>) {
  const listeners: Array<(event: ServeEvent) => void> = []
  const queue = vi.fn(async () => (reads.length > 1 ? reads.shift()! : reads[0]!))
  const ds = { queue, subscribe: (fn: (event: ServeEvent) => void) => (listeners.push(fn), () => {}) } as unknown as DataSource
  return { ds, queue, send: (event: ServeEvent) => listeners.forEach((fn) => fn(event)) }
}

function ctx(suggestions: AppData['suggestions'] = []): Ctx {
  const data = { mode: 'serve', suggestions, aggregates: {} } as unknown as AppData
  return { data, ds: {} as DataSource, state: { screen: 'suggest' }, audience: 'dev', go: vi.fn() }
}

const SUGGEST = { screen: 'suggest' }
const fixture = (): QueueRead => queueFixture()

describe('the home frame: the queue read', () => {
  it('starts the read on the Improvements screen and on the Overview only, once, and renders again when it lands', async () => {
    const home = await freshHome()
    const { ds, queue } = source(fixture())
    const rerender = vi.fn()
    home.ensureQueue(ds, { screen: 'timeline' }, rerender)
    expect(queue).not.toHaveBeenCalled()
    home.ensureQueue(ds, SUGGEST, rerender)
    home.ensureQueue(ds, { screen: 'overview' }, rerender)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(home.queueRead()).toBeUndefined()
    expect(home.homeSections(ctx(), 'session')).toContain('aria-busy="true"')
    await flush()
    expect(rerender).toHaveBeenCalledTimes(1)
    expect(home.queueRead()?.counts.open).toBeGreaterThan(0)
    const html = home.homeSections(ctx(), 'session')
    expect(html).toContain('id="q-0-verdict"')
    expect(html.endsWith('<h3 class="mb16">Findings in this scope</h3>')).toBe(true)
  })

  it('shows the error state when the first read fails, and when the source has no queue read', async () => {
    let home = await freshHome()
    home.ensureQueue(source(null).ds, SUGGEST, vi.fn())
    await flush()
    expect(home.homeSections(ctx(), 'session')).toContain('orangu could not compute the queue.')
    home = await freshHome()
    home.ensureQueue({ subscribe: () => () => {} } as unknown as DataSource, SUGGEST, vi.fn())
    await flush()
    expect(home.queueRead()).toBeNull()
  })

  it('draws nothing in a file report', async () => {
    const home = await freshHome()
    const file = ctx()
    file.data.mode = 'file'
    expect(home.homeSections(file, 'session')).toBe('')
  })
})

describe('the home frame: reads again', () => {
  it('reads again on a suggestion-updated frame, and a failed read keeps the last good list with a line that says so', async () => {
    const home = await freshHome()
    const { ds, queue, send } = source(fixture(), null)
    const rerender = vi.fn()
    home.ensureQueue(ds, SUGGEST, rerender)
    await flush()
    send({ type: 'suggestion-updated', id: 'sg_000000000001', status: 'rejected' })
    await flush()
    expect(queue).toHaveBeenCalledTimes(2)
    expect(rerender).toHaveBeenCalledTimes(2)
    const html = home.homeSections(ctx(), 'session')
    expect(html).toContain('id="q-0-verdict"')
    expect(html).toContain('orangu could not count the queue again. This list is from the last count.')
    expect(page.regions[0]?.textContent).toBe('orangu could not count the queue again. This list is from the last count.')
  })

  it('shows the stale strip after a session ends, never counts again by itself, and clears the strip on a new read', async () => {
    const home = await freshHome()
    const { ds, queue, send } = source(fixture())
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    send({ type: 'session-live', id: 'a', badge: 'idle', ageMs: 1 })
    expect(home.homeSections(ctx(), 'session')).not.toContain('New sessions ended after this count.')
    send({ type: 'session-live', id: 'a', badge: 'ended', ageMs: 1 })
    expect(home.homeSections(ctx(), 'session')).toContain('New sessions ended after this count. Count again to update the queue.')
    expect(queue).toHaveBeenCalledTimes(1)
    send({ type: 'suggestion-updated', id: 'sg_000000000001', status: 'rejected' })
    await flush()
    expect(home.homeSections(ctx(), 'session')).not.toContain('New sessions ended after this count.')
  })

  it('reads again on Count again, and moves focus to the Queue summary after the render that shows the new count', async () => {
    const home = await freshHome()
    const { ds, queue } = source(fixture())
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    observe?.()
    expect(page.focused).toBe(0)
    const control = { hasAttribute: (name: string) => name === 'data-q-count' }
    const target = Object.assign(new (globalThis.Element as unknown as new () => object)(), { closest: () => control })
    for (const click of page.clicks) click({ target })
    expect(queue).toHaveBeenCalledTimes(2)
    await flush()
    observe?.()
    expect(page.focused).toBe(1)
    observe?.()
    expect(page.focused).toBe(1)
  })

  it('says how many records the store holds: an empty store is "Your queue is empty."', async () => {
    const home = await freshHome()
    const empty: QueueRead = { ...fixture(), counts: { verdict: 0, regressed: 0, apply: 0, review: 0, running: 0, wait: 0, due: 0, open: 0 }, groups: { verdict: [], regressed: [], apply: [], review: [], running: [], wait: [] } }
    home.ensureQueue(source(empty).ds, SUGGEST, vi.fn())
    await flush()
    expect(home.homeSections(ctx(), 'session')).toContain('Your queue is empty.')
    expect(home.homeSections(ctx([{ id: 'sg_000000000001' } as AppData['suggestions'][number]]), 'session')).toContain('Nothing waits for you.')
  })
})
