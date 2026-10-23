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
  /** the other listeners of the document, by event type */
  on: Record<string, Array<(event: { target: unknown; key?: string }) => void>>
  regions: Array<{ textContent: string }>
  focused: number
}

let page: FakeDocument
let observe: (() => void) | undefined

beforeEach(() => {
  page = { clicks: [], on: {}, regions: [], focused: 0 }
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
      else (page.on[type] ??= []).push(fn)
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

describe('the home frame: Dismiss', () => {
  const NEWEST = 'sg_00000000e003'
  const MIDDLE = 'sg_00000000e002'
  const OLDEST = 'sg_00000000e001'

  /** The fixture queue with 1 item in To review that folds 3 records, newest first. */
  function folded(): QueueRead {
    const read = fixture()
    const row = { ...read.groups.review[0]!, id: NEWEST, ids: [NEWEST, MIDDLE, OLDEST], status: 'new' as const }
    return { ...read, groups: { ...read.groups, review: [row] } }
  }

  /** A click on a control of the home, as the delegated listener finds it by its data attributes. */
  const click = (attributes: Record<string, string>) => {
    const control = { hasAttribute: (name: string) => name in attributes, getAttribute: (name: string) => attributes[name] ?? null }
    const target = Object.assign(new (globalThis.Element as unknown as new () => object)(), { closest: () => control })
    for (const fn of page.clicks) fn({ target })
  }

  /** A reason option that the person checks. */
  const check = (value: string) => {
    const target = Object.assign(new (globalThis.Element as unknown as new () => object)(), { hasAttribute: (name: string) => name === 'data-q-reason', value })
    for (const fn of page.on['change'] ?? []) fn({ target })
  }

  it('dismisses a folded item 1 record at a time, newest first, and stops at the first failed call with a line that says so', async () => {
    const home = await freshHome()
    const { ds } = source(folded())
    // the second call fails: the store refused it, so it gives no record
    const setStatus = vi.fn(async (id: string) => (id === MIDDLE ? null : { id, status: 'rejected' }))
    Object.assign(ds, { setStatus })
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    click({ 'data-q-dismiss': NEWEST })
    check('not-wanted')
    click({ 'data-q-confirm': '' })
    await flush()
    expect(setStatus.mock.calls).toEqual([
      [NEWEST, 'rejected', 'not-wanted'],
      [MIDDLE, 'rejected', 'not-wanted'],
    ])
    const line = 'orangu dismissed 1 of 3 records. Then it stopped. The rest did not change.'
    expect(home.homeSections(ctx(), 'session')).toContain(`<p class="small mt8">${line}</p>`)
    expect(page.regions.at(-1)?.textContent).toBe(line)
  })

  it('sends nothing with no reason, and never sends an option value that is not 1 of the 5 codes', async () => {
    const home = await freshHome()
    const { ds } = source(folded())
    const setStatus = vi.fn(async (id: string) => ({ id, status: 'rejected' }))
    Object.assign(ds, { setStatus })
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    click({ 'data-q-dismiss': NEWEST })
    click({ 'data-q-confirm': '' })
    check('<img src=x> free text')
    click({ 'data-q-confirm': '' })
    await flush()
    expect(setStatus).not.toHaveBeenCalled()
    expect(home.homeSections(ctx(), 'session')).toContain('data-q-confirm aria-disabled="true">Dismiss</button>')
  })

  it('a done dismiss reads the queue again, and its confirm goes when the row leaves the read', async () => {
    const home = await freshHome()
    const gone: QueueRead = { ...fixture(), groups: { ...fixture().groups, review: [] } }
    const { ds, queue } = source(folded(), folded(), gone)
    const setStatus = vi.fn(async (id: string) => ({ id, status: 'rejected' }))
    Object.assign(ds, { setStatus })
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    click({ 'data-q-dismiss': NEWEST })
    check('already-handled')
    click({ 'data-q-confirm': '' })
    await flush()
    expect(setStatus.mock.calls.map(([id]) => id)).toEqual([NEWEST, MIDDLE, OLDEST])
    expect(page.regions.at(-1)?.textContent).toBe('orangu dismissed 3 records of this finding.')
    // the first read again can still hold the row: the confirm stays, done, with both buttons off
    expect(home.homeSections(ctx(), 'session')).toContain('<p class="small mt8">orangu dismissed 3 records of this finding.</p>')
    expect(queue).toHaveBeenCalledTimes(2)
    click({ 'data-q-count': '' })
    await flush()
    expect(queue).toHaveBeenCalledTimes(3)
    const html = home.homeSections(ctx(), 'session')
    expect(html).not.toContain(`id="q-${NEWEST}"`)
    expect(html).not.toContain('class="sg-proposal dismiss"')
  })

  it('moves focus to the Queue summary when a read drops the row before the last call answers', async () => {
    const home = await freshHome()
    const gone: QueueRead = { ...fixture(), groups: { ...fixture().groups, review: [] } }
    const { ds, send } = source(folded(), gone)
    let answer: (record: unknown) => void = () => {}
    const setStatus = vi.fn((id: string) => (id === OLDEST ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ id, status: 'rejected' })))
    Object.assign(ds, { setStatus })
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    click({ 'data-q-dismiss': NEWEST })
    check('other')
    click({ 'data-q-confirm': '' })
    await flush()
    // the store emits a frame for each move: its read lands while the last call still runs, and holds the row no more
    send({ type: 'suggestion-updated', id: MIDDLE, status: 'rejected' })
    await flush()
    expect(page.focused).toBe(0)
    answer({ id: OLDEST, status: 'rejected' })
    await flush()
    expect(page.focused).toBe(1)
    expect(home.homeSections(ctx(), 'session')).not.toContain('class="sg-proposal dismiss"')
  })

  it('a row that leaves after a done dismiss takes no focus from a confirm that the person opened since', async () => {
    const home = await freshHome()
    const { ds } = source(folded())
    Object.assign(ds, { setStatus: vi.fn(async (id: string) => ({ id, status: 'rejected' })) })
    home.ensureQueue(ds, SUGGEST, vi.fn())
    await flush()
    click({ 'data-q-dismiss': NEWEST })
    check('other')
    click({ 'data-q-confirm': '' })
    await flush()
    click({ 'data-q-dismiss': fixture().groups.apply[0]!.id })
    observe?.()
    expect(page.focused).toBe(0)
  })
})
