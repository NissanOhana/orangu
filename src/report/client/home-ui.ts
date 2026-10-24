/**
 * Serve only: the frame of the improvement home on the Improvements screen. It draws the home sections above the scope
 * chips and the heading "Findings in this scope" under them, and it owns the reads that the sections and the Overview
 * card show. Only serve-ui.ts and proposals-ui.ts import this file, so the file bundles carry none of it.
 *
 * The reads are fill-on-demand, as the aggregates and the harness report are: the first render of #suggest or
 * #overview starts the queue read (serve-ui.ts calls ensureQueue from the screen data seam), and the app renders
 * again when it lands. The first render of #suggest also starts the History and the Lessons reads, beside the queue
 * read. A `suggestion-updated` frame and the Count again control read the 3 again. The last good read
 * stays on screen until the new one lands, as refreshSuggestions keeps the last good records (app.ts). A
 * `session-live` frame that ends a session after the read shows the stale strip: orangu never counts again by itself.
 * When the first read of each of the 3 failed, each section says that orangu could not read the store.
 *
 * Every read goes through the data source with no `cwd`, so the route takes the `--cwd` of serve, and no raw path of
 * the browser reaches it. The `scope` of the read says which read the app got: 1 workspace, or `all` when serve has
 * no `--cwd`. The history read has no `scope`, so History takes the scope of the queue read, else of the lesson read.
 * Each All workspaces disclosure reads `all=1` on its first open only.
 *
 * The controls of the home are wired once, by 1 delegated listener on the document keyed by data attributes, so a
 * re-render needs no new wiring. The status region lives on the body, outside the root that each render replaces.
 *
 * The Dismiss confirm (dismiss-ui.ts) lives in this module's memory: the open confirm, its checked reason and the id of
 * its focused control. Each render draws it again and puts focus back on the same control. A step of the confirm draws
 * only the Dismiss part of its row again, in place, so a click needs no render of the app. After a done dismiss, the
 * queue is read again and the row leaves it, and focus moves to the next row of its group.
 */
import type { Ctx } from './app.js'
import type { DataSource } from './data.js'
import type { RouteState } from './nav.js'
import type { SuggestionScope } from '../../suggest/types.js'
import { REJECT_REASON_CODES } from '../../suggest/reason-codes.js'
import type { QueueRead, QueueRow } from './queue-types.js'
import type { ChangeRow, LessonRead } from './lesson-types.js'
import { queueSection } from './queue-ui.js'
import { historySection } from './history-ui.js'
import { lessonsSection } from './lessons-ui.js'
import { confirmOf, dismissIds, dismissLine, dismissPart, type DismissState } from './dismiss-ui.js'

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
/** the open Dismiss confirm: each render draws it again */
let confirm: DismissState | undefined
/** the id of the focused control of the confirm: a render puts focus back on it */
let focusId: string | undefined
/** after a done dismiss: the row that leaves, and the disclosure whose summary takes focus when it is gone */
let leaving: { row: string; next: string } | undefined

/** 1 read of History or Lessons: undefined until it lands, null when its first read failed. */
interface StoreRead<T> {
  value: T | null | undefined
  busy: boolean
  again: boolean
}
const storeRead = <T>(): StoreRead<T> => ({ value: undefined, busy: false, again: false })
const history = storeRead<ChangeRow[]>()
const allHistory = storeRead<ChangeRow[]>()
const lessons = storeRead<LessonRead>()
const allLessons = storeRead<LessonRead>()
/** the first render of #suggest started the History and the Lessons reads */
let storeStarted = false

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
    pruneConfirm()
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
  if (read) pruneConfirm()
  if (shown()) rerender()
}

/**
 * 1 read of History or Lessons, as readAll reads every workspace: a failed read again keeps the last good one. A read
 * that comes while one runs runs once more after it, so the last state of the store wins.
 */
async function fill<T>(slot: StoreRead<T>, get: () => Promise<T | null> | undefined): Promise<void> {
  if (slot.busy) {
    slot.again = true
    return
  }
  slot.busy = true
  let read: T | null = null
  try {
    read = (await get()) ?? null
  } catch {
    read = null
  }
  slot.busy = false
  slot.value = read ?? (slot.value || null)
  if (slot.again) {
    slot.again = false
    return fill(slot, get)
  }
  if (shown()) rerender()
}

/** Read History and Lessons, and the read of every workspace of each once its disclosure has read it. */
function readStore(): void {
  void fill(history, () => source?.history?.())
  void fill(lessons, () => source?.lessons?.())
  if (allHistory.value !== undefined) void fill(allHistory, () => source?.history?.(true))
  if (allLessons.value !== undefined) void fill(allLessons, () => source?.lessons?.(true))
}

/** Read again: the queue, and every workspace once the disclosure has read it, then History and Lessons once started. */
function readAgain(): void {
  void readQueue()
  if (allQueue !== undefined) void readAll()
  if (storeStarted) readStore()
}

/** Every row of the 2 reads. */
function rows(): QueueRow[] {
  return [queue, allQueue].flatMap((read) => (read ? Object.values(read.groups).flat() : []))
}

/** The row that holds the confirm `c`, in the last reads. */
const rowOf = (c: DismissState | undefined): QueueRow | undefined => rows().find((row) => confirmOf(row, c))

/**
 * After a read, unless the calls of the confirm run: a confirm whose row left the reads goes. Else it keeps only the
 * ids that its row still holds, so a record that another writer closed is not sent again. The set only gets smaller.
 */
function pruneConfirm(): void {
  if (!confirm || confirm.busy) return
  const row = rowOf(confirm)
  if (!row) {
    confirm = undefined
    focusId = undefined
  } else if (!confirm.done) confirm.ids = confirm.ids.filter((id) => row.ids.includes(id))
}

/** Draw the Dismiss part of `row` again in place, with no render of the app, then put focus on the control `focus`. */
function redraw(row: QueueRow, key: string, focus?: string): void {
  const part = document.getElementById(`qx-${key}`)
  if (part) part.outerHTML = dismissPart(row, confirm)
  if (!focus) return
  focusId = focus
  document.getElementById(focus)?.focus()
}

/** The row's Dismiss: open its confirm, hide the button, and put focus on the first reason. 1 confirm at a time. */
function openConfirm(id: string): void {
  const row = rows().find((r) => r.id === id)
  if (!row || confirm?.busy) return
  const before = confirm && rowOf(confirm)
  const beforeKey = confirm?.key
  confirm = { key: row.id, ids: [...row.ids], busy: false, done: false, line: '' }
  // the person works on another row now, so a row that leaves later takes no focus from this one
  leaving = undefined
  if (before && beforeKey !== undefined && before !== row) redraw(before, beforeKey)
  redraw(row, row.id, `qd-${row.id}-${REJECT_REASON_CODES[0]}`)
}

/** Cancel and Escape: close the confirm, show the row's Dismiss again, and put focus on it. */
function cancelConfirm(): void {
  const c = confirm
  if (!c || c.busy || c.done) return
  const row = rowOf(c)
  confirm = undefined
  if (row) redraw(row, c.key, `qd-${row.id}-open`)
}

/**
 * A checked reason. Only a code of the fixed list is kept, whatever the value of the option says. While the calls run,
 * the code stays the one that they send, so a retry after a stop sends the same code.
 */
function pickReason(value: string): void {
  const code = REJECT_REASON_CODES.find((known) => known === value)
  if (!confirm || !code || confirm.busy || confirm.done) return
  confirm.reason = code
  document.getElementById(`qd-${confirm.key}-go`)?.setAttribute('aria-disabled', 'false')
}

/**
 * The confirm's Dismiss. With no reason, focus moves to the first reason and nothing is sent. Else 1 call for each
 * folded id, newest first, which stops at the first failure. The line says how many records changed. After a stop,
 * the confirm stays open and holds only the ids that did not change. When any record changed, the queue is read again.
 */
async function confirmDismiss(ds: DataSource): Promise<void> {
  const c = confirm
  const row = rowOf(c)
  if (!c || !row || c.busy || c.done) return
  if (!c.reason) {
    document.getElementById(`qd-${c.key}-${REJECT_REASON_CODES[0]}`)?.focus()
    return
  }
  const go = `qd-${c.key}-go`
  const total = c.ids.length
  // where focus goes when the row leaves: the next row of its group, else the row before it, else the Queue summary
  const element = document.getElementById(`q-${row.id}`)
  const next = (element?.nextElementSibling ?? element?.previousElementSibling)?.id || 'home-queue'
  c.busy = true
  c.line = 'orangu dismisses the item.'
  redraw(row, c.key, go)
  announce(c.line)
  const done = await dismissIds(ds, c.ids, c.reason)
  c.busy = false
  c.done = done === total
  c.line = dismissLine(done, total)
  if (!c.done) c.ids = c.ids.slice(done)
  announce(c.line)
  // a read can land while the calls run: it can name the row by its next record, or hold it no more
  const now = rowOf(c)
  if (c.done) leaving = { row: `q-${(now ?? row).id}`, next }
  if (now && confirm === c) redraw(now, c.key, go)
  pruneConfirm()
  if (!now) afterRender()
  if (done) readAgain()
}

/** After each render of the app: move focus where a control asked for it, or back to the confirm control it was on. */
function afterRender(): void {
  if (leaving && !document.getElementById(leaving.row)) {
    const next = document.getElementById(leaving.next)?.querySelector<HTMLElement>(':scope > summary') ?? document.querySelector<HTMLElement>('#home-queue > summary')
    leaving = undefined
    next?.focus()
    return
  }
  const active = document.activeElement
  if (focusId && (!active || active === document.body)) document.getElementById(focusId)?.focus({ preventScroll: true })
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

/**
 * The listeners of the home: 1 delegated click, 1 toggle in the capture phase, the reason options, Escape in the
 * confirm, the focus of the confirm controls, the live frames and the render hook.
 */
function wire(ds: DataSource): void {
  document.addEventListener('click', (event) => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-q-count],[data-q-mega],[data-q-dismiss],[data-q-confirm],[data-q-cancel]') : null
    if (!control) return
    if (control.hasAttribute('data-q-mega')) return jumpToMega()
    if (control.hasAttribute('data-q-dismiss')) return openConfirm(control.getAttribute('data-q-dismiss') ?? '')
    if (control.hasAttribute('data-q-confirm')) return void confirmDismiss(ds)
    if (control.hasAttribute('data-q-cancel')) return cancelConfirm()
    focusQueue = true
    readAgain()
  })
  document.addEventListener('change', (event) => {
    const option = event.target
    if (option instanceof Element && option.hasAttribute('data-q-reason')) pickReason((option as HTMLInputElement).value)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('.dismiss')) cancelConfirm()
  })
  document.addEventListener('focusin', (event) => {
    const id = event.target instanceof Element ? event.target.id : ''
    focusId = id.startsWith('qd-') ? id : undefined
  })
  document.addEventListener('focusout', (event) => {
    const left = event.target
    if (!(left instanceof Element) || left.id !== focusId) return
    // A render removes the control, so its id stays. A click on the page leaves the control in place with no focus.
    setTimeout(() => {
      if (left.isConnected && focusId === left.id && document.activeElement !== left) focusId = undefined
    })
  })
  // `toggle` does not bubble, so the document hears it in the capture phase
  document.addEventListener(
    'toggle',
    (event) => {
      const details = event.target
      if (!(details instanceof HTMLDetailsElement)) return
      if (!details.open && STARTS_OPEN.test(details.id)) closed.add(details.id)
      if (details.open && details.id === 'home-all-queue' && allQueue === undefined) void readAll()
      if (details.open && details.id === 'home-all-history' && allHistory.value === undefined && !allHistory.busy) void fill(allHistory, () => source?.history?.(true))
      if (details.open && details.id === 'home-all-lessons' && allLessons.value === undefined && !allLessons.busy) void fill(allLessons, () => source?.lessons?.(true))
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
 * Start the queue read that #suggest and #overview show, once, and on #suggest the History and the Lessons reads, once.
 * `loaded` renders the app again when a read lands. The screen data seam of serve calls it on every render, so it also
 * knows which screen is on the page.
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
  if (screen === 'suggest' && !storeStarted) {
    storeStarted = true
    readStore()
  }
}

/** The queue read as the Overview card shows it: undefined while the first read runs, null when it failed. */
export function queueRead(): QueueRead | null | undefined {
  return queue
}

/** The inbox seam of the Improvements screen: the Queue, History and Lessons sections, then the heading of the findings under them. */
export function homeSections(ctx: Ctx, scope: SuggestionScope): string {
  if (ctx.data.mode !== 'serve') return ''
  const records = new Map(ctx.data.suggestions.map((record) => [record.id, record]))
  const storeError = queue === null && history.value === null && lessons.value === null
  const section = queueSection(
    { main: queue, all: allQueue, stale, refreshFailed, closed, confirm, storeError },
    {
      records,
      storeEmpty: !ctx.data.suggestions.length,
      megaButton: scope !== 'session' && !!ctx.data.aggregates[scope] && !!ctx.megaReview,
      ...(ctx.proposals ? { details: ctx.proposals.details } : {}),
    },
  )
  const plain = ctx.audience === 'plain'
  const store = { records }
  const changes = historySection({ main: history.value, all: allHistory.value, scope: queue?.scope ?? lessons.value?.scope, storeError, plain }, store)
  const taught = lessonsSection({ main: lessons.value, all: allLessons.value, storeError, plain }, store)
  return `${section}${changes}${taught}<h3 class="mb16">Findings in this scope</h3>`
}
