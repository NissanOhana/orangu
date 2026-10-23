/**
 * Serve only: the frame of the improvement home on the Improvements screen. It draws the home sections above the scope
 * chips and the heading "Findings in this scope" under them, and it owns the reads that the sections and the Overview
 * card show. Only serve-ui.ts and proposals-ui.ts import this file, so the file bundles carry none of it.
 *
 * The reads are fill-on-demand, as the aggregates and the harness report are: the first render of #suggest or
 * #overview starts the queue read (serve-ui.ts calls ensureQueue from the screen data seam), and the app renders
 * again when it lands. A `suggestion-updated` frame and the Count again control read it again. The last good read
 * stays on screen until the new one lands, as refreshSuggestions keeps the last good records (app.ts). A
 * `session-live` frame that ends a session after the read shows the stale strip: orangu never counts again by itself.
 *
 * Every read goes through the data source with no `cwd`, so the route takes the `--cwd` of serve, and no raw path of
 * the browser reaches it. The `scope` of the read says which read the app got: 1 workspace, or `all` when serve has
 * no `--cwd`. The All workspaces disclosure reads `all=1` on its first open only.
 *
 * The controls of the home are wired once, by 1 delegated listener on the document keyed by data attributes, so a
 * re-render needs no new wiring. The status region lives on the body, outside the root that each render replaces.
 */
import type { Ctx } from './app.js'
import type { DataSource } from './data.js'
import type { RouteState } from './nav.js'
import type { SuggestionScope } from '../../suggest/types.js'
import type { QueueRead } from './queue-types.js'
import { queueSection } from './queue-ui.js'

let queue: QueueRead | null | undefined
let allQueue: QueueRead | null | undefined
let queueInFlight = false
let queueAgain = false
let allInFlight = false
let stale = false
let refreshFailed = false
/** the ids of the disclosures that start open and that the person closed once: they stay closed for the page */
const closed = new Set<string>()
const STARTS_OPEN = /^(?:home-queue|q-\d+-\w+)$/
/** a read that Count again started: when it lands, focus moves to the Queue summary */
let focusQueue = false
let source: DataSource | undefined
let screen = ''
let rerender: () => void = () => {}

const shown = (): boolean => screen === 'suggest' || screen === 'overview'

/** The text of the status region on the body: a screen reader hears each line once. */
function announce(text: string): void {
  if (typeof document === 'undefined') return
  let region = document.getElementById('home-status')
  if (!region) {
    region = document.createElement('div')
    region.id = 'home-status'
    region.className = 'vh'
    region.setAttribute('aria-live', 'polite')
    document.body.appendChild(region)
  }
  region.textContent = text
}

/** Read the queue of this workspace. A failed first read is the error state; a failed read again keeps the last good one. */
async function readQueue(): Promise<void> {
  if (queueInFlight) {
    queueAgain = true
    return
  }
  queueInFlight = true
  let read: QueueRead | null = null
  try {
    read = (await source?.queue?.()) ?? null
  } catch {
    read = null
  }
  queueInFlight = false
  if (read) {
    queue = read
    stale = false
    refreshFailed = false
  } else if (queue) {
    refreshFailed = true
    focusQueue = false
    announce('orangu could not count the queue again. This list is from the last count.')
  } else queue = null
  if (queueAgain) {
    queueAgain = false
    return readQueue()
  }
  if (shown()) rerender()
}

/** Read every workspace, for the All workspaces disclosure. A failed read again keeps the last good one. */
async function readAll(): Promise<void> {
  if (allInFlight) return
  allInFlight = true
  let read: QueueRead | null = null
  try {
    read = (await source?.queue?.(true)) ?? null
  } catch {
    read = null
  }
  allInFlight = false
  allQueue = read ?? (allQueue || null)
  if (shown()) rerender()
}

/** Read again: the queue, and every workspace once the disclosure has read it. */
function readAgain(): void {
  void readQueue()
  if (allQueue !== undefined) void readAll()
}

/** After each render of the app: move focus where a control asked for it. */
function afterRender(): void {
  if (!focusQueue || !queue) return
  const summary = document.querySelector<HTMLElement>('#home-queue > summary')
  if (!summary) return
  focusQueue = false
  summary.focus()
}

/** Scroll the whole-harness card into view and put focus on its copy control; with reduced motion, no animation. */
function jumpToMega(): void {
  const mega = document.getElementById('home-mega')
  if (!mega) return
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  mega.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  mega.querySelector<HTMLElement>('.btn-primary')?.focus({ preventScroll: true })
}

/** The listeners of the home: 1 delegated click, 1 toggle in the capture phase, the live frames and the render hook. */
function wire(ds: DataSource): void {
  document.addEventListener('click', (event) => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-q-count],[data-q-mega]') : null
    if (!control) return
    if (control.hasAttribute('data-q-mega')) return jumpToMega()
    focusQueue = true
    readAgain()
  })
  // `toggle` does not bubble, so the document hears it in the capture phase
  document.addEventListener(
    'toggle',
    (event) => {
      const details = event.target
      if (!(details instanceof HTMLDetailsElement)) return
      if (!details.open && STARTS_OPEN.test(details.id)) closed.add(details.id)
      if (details.open && details.id === 'home-all-queue' && allQueue === undefined) void readAll()
    },
    true,
  )
  ds.subscribe((event) => {
    if (event.type === 'suggestion-updated') readAgain()
    else if (event.type === 'session-live' && event.badge === 'ended' && queue && !stale) {
      stale = true
      if (screen === 'suggest') rerender()
    }
  })
  const app = document.getElementById('app')
  if (app && typeof MutationObserver === 'function') new MutationObserver(afterRender).observe(app, { childList: true })
}

/**
 * Start the queue read that #suggest and #overview show, once. `loaded` renders the app again when a read lands. The
 * screen data seam of serve calls it on every render, so it also knows which screen is on the page.
 */
export function ensureQueue(ds: DataSource, state: RouteState, loaded: () => void): void {
  rerender = loaded
  screen = state.screen
  if (!shown()) return
  if (!source) {
    source = ds
    if (typeof document !== 'undefined') wire(ds)
  }
  if (queue === undefined && !queueInFlight) void readQueue()
}

/** The queue read as the Overview card shows it: undefined while the first read runs, null when it failed. */
export function queueRead(): QueueRead | null | undefined {
  return queue
}

/** The inbox seam of the Improvements screen: the home sections, then the heading of the findings under them. */
export function homeSections(ctx: Ctx, scope: SuggestionScope): string {
  if (ctx.data.mode !== 'serve') return ''
  const records = new Map(ctx.data.suggestions.map((record) => [record.id, record]))
  const section = queueSection(
    { main: queue, all: allQueue, stale, refreshFailed, closed },
    {
      records,
      storeEmpty: !ctx.data.suggestions.length,
      megaButton: scope !== 'session' && !!ctx.data.aggregates[scope] && !!ctx.megaReview,
      ...(ctx.proposals ? { details: ctx.proposals.details } : {}),
    },
  )
  return `${section}<h3 class="mb16">Findings in this scope</h3>`
}
