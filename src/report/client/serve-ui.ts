/**
 * Serve-only UI: the session-picker listbox and fleet screen,
 * cards + merged cross-session feed. Imported ONLY from serve-entry.ts and injected into mountApp
 * (picker/aggregates) or registered on the `window.__ORANGU_FLEET__` seam (fleet, read by
 * screens/live.ts), so its bytes stay out of the file-mode bundle (policy: CLIENT_JS ≤ 70,000 B).
 * The fleet only exists in serve mode: file mode always carries exactly one session.
 */
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import type { Ctx, ServeUi } from './app.js'
import type { DataSource } from './data.js'
import type { RouteState } from './nav.js'
import { catColor, esc, ms, pct, timeOnly, tok } from './format.js'
import { h } from './dom.js'
import { mascotSvg } from './mascot.js'
import { shortId } from './nav.js'
import { badgeCopy, fleetFeed } from './derive.js'
import { megaReview } from './mega-review.js'
import { renderRepo } from './screens/repo.js'
import { renderGlobal } from './screens/global.js'
import { harnessCardHtml, renderHarness } from './screens/harness.js'
import type { HarnessReport } from '../../harness/types.js'

/** UX §4.1: "Last 50 rows overall": the per-session ring (≤ 5) bounds it well below this in practice. */
const FLEET_FEED_MAX = 50

/** The merged cross-session feed under the fleet cards: a leading mono shortId column per row . */
function fleetFeedHtml(live: SessionSummaryRow[]): string {
  const rows = fleetFeed(live, FLEET_FEED_MAX)
  if (!rows.length) return ''
  const body = rows
    .map(
      (r) =>
        `<div class="feedrow"><span class="ft">${esc(shortId(r.sid))}</span><span class="ft">${esc(timeOnly(r.ts))}</span><span class="sw" style="background:${catColor(r.category)}"></span><span class="fn">${esc(r.name)}</span><span class="fw">${esc(r.summary)}</span></div>`,
    )
    .join('')
  return `<div class="feed" style="margin-top:18px" aria-live="off"><div class="card-head">Fleet feed</div>${body}<div class="feedfoot">last ${rows.length} events across the live sessions</div></div>`
}

// fleet card order changes at most once per 5 s; frozen entirely under reduced motion
let fleetOrder: string[] = []
let fleetOrderTs = 0
function stableOrder(live: SessionSummaryRow[]): SessionSummaryRow[] {
  const byId = new Map(live.map((r) => [r.id, r]))
  const sameSet = fleetOrder.length === live.length && fleetOrder.every((id) => byId.has(id))
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const fresh = Date.now() - fleetOrderTs < 5_000
  if (sameSet && (fresh || reduced)) return fleetOrder.map((id) => byId.get(id)!)
  const sorted = [...live].sort((a, b) => b.mtimeMs - a.mtimeMs)
  fleetOrder = sorted.map((r) => r.id)
  fleetOrderTs = Date.now()
  return sorted
}

function fleetView(ctx: Ctx, liveIn: SessionSummaryRow[]): HTMLElement {
  const live = stableOrder(liveIn)
  const maxLive = typeof window !== 'undefined' ? window.__ORANGU_SERVE__?.maxLive : undefined
  const watching = maxLive !== undefined && ctx.data.mode === 'serve' ? `<div class="banner info">watching ${Math.min(maxLive, live.length)} of ${live.length} live session${live.length === 1 ? '' : 's'}${live.length > maxLive ? ' · raise with <span class="mono">--max-live</span>' : ''}</div>` : ''
  const reconn = ctx.conn === 'reconnecting' ? '<div class="banner warn">Connection lost · retrying. The page reconnects on its own.</div>' : ''
  const cards = live
    .map((r) => {
      const ctxPct = r.contextWindow && r.contextFinal ? r.contextFinal / r.contextWindow : 0
      const agents = Math.min(r.agentsRunning ?? 0, 8)
      const strip = agents ? `<div class="agentstrip">${'<i></i>'.repeat(agents)}${(r.agentsRunning ?? 0) > 8 ? `<span class="more">+${(r.agentsRunning ?? 0) - 8}</span>` : ''}</div>` : ''
      const last = r.lastEvent ? `last: ${r.lastEvent.name} · ${r.lastEvent.summary}` : badgeCopy(r)
      return `<a class="fleetcard" href="#live?s=${esc(r.id)}">
<div class="fh"><span class="ldot" data-pulse="1" aria-hidden="true"></span><span>${esc(shortId(r.id))}</span><span class="proj">${esc(r.projectSlug)}</span><span class="muted">turn ${r.turns ?? '–'}</span></div>
<div class="fk"><span>${r.startedAt !== undefined && r.mtimeMs > r.startedAt ? esc(ms(r.mtimeMs - r.startedAt)) : '–'}</span><span style="color:var(--accent-ink)">${r.tokens !== undefined ? esc(tok(r.tokens)) : '–'}</span><span>${r.toolCalls ?? '–'}⚙</span><span>${ctxPct ? esc(pct(ctxPct)) : '–'} ctx</span></div>
<span class="trough" style="height:6px"><i style="width:${(ctxPct * 100).toFixed(1)}%"></i></span>
<div class="fl">${esc(last)}</div>
${strip}
</a>`
    })
    .join('')
  return h(`<section>${reconn}${watching}<div class="fleet">${cards}</div>${fleetFeedHtml(live)}<p class="small muted">Each card is one running session. Click a card to watch it.</p></section>`)
}

if (typeof window !== 'undefined') window.__ORANGU_FLEET__ = fleetView

function pickerHtml(d: AppData, row: SessionSummaryRow | undefined): string {
  const label = row ? esc(shortId(row.id)) + ' · ' + esc(row.projectSlug || row.source) : '–'
  if (d.sessions.length < 2) return `<div class="sid">${label}</div>`
  const options = d.sessions
    .map((r) => {
      const dot =
        r.badge === 'live'
          ? '<span class="ldot" data-pulse="1" aria-hidden="true"></span>'
          : r.badge === 'idle'
            ? '<span class="ldot hollow" aria-hidden="true"></span>'
            : '<span class="ldot done" aria-hidden="true"></span>'
      return `<div role="option" tabindex="-1" data-id="${esc(r.id)}" aria-selected="${r.id === row?.id}">${dot}<span class="mono">${esc(shortId(r.id))}</span><span class="proj">${esc(r.projectSlug)}</span></div>`
    })
    .join('')
  return `<button class="sid pick" id="btn-pick" aria-haspopup="listbox" aria-expanded="false">${label} ▾</button>
<div class="picklist" id="pick-list" role="listbox" aria-label="Sessions" hidden>${options}</div>`
}

function wirePicker(el: HTMLElement, go: (next: { s?: string }, opts?: { push?: boolean }) => void): void {
  const btn = el.querySelector<HTMLButtonElement>('#btn-pick')
  const list = el.querySelector<HTMLElement>('#pick-list')
  if (!btn || !list) return
  const options = Array.prototype.slice.call(list.querySelectorAll<HTMLElement>('[role="option"]')) as HTMLElement[]
  const close = (): void => {
    list.hidden = true
    btn.setAttribute('aria-expanded', 'false')
  }
  btn.addEventListener('click', () => {
    const open = list.hidden
    list.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) (options.find((o) => o.getAttribute('aria-selected') === 'true') ?? options[0])?.focus()
  })
  list.addEventListener('keydown', (e) => {
    const i = options.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      close()
      btn.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      options[(i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.click()
    }
  })
  for (const o of options)
    o.addEventListener('click', () => {
      close()
      go({ s: o.dataset['id'] }, { push: true })
    })
}

const aggInFlight = new Set<string>()

/** kicks the repo/global fetch the current screen needs; true while it is in flight (policy serve fill-on-demand) */
function ensureAggregate(d: AppData, ds: DataSource, state: RouteState, onLoaded: () => void): boolean {
  let want: 'repo' | 'global' | undefined
  if (state.screen === 'repo') want = 'repo'
  else if (state.screen === 'global') want = 'global'
  else if (state.screen === 'suggest' && (state.scope === 'repo' || state.scope === 'global')) want = state.scope
  if (!want || d.aggregates[want]) return false
  if (!aggInFlight.has(want)) {
    const scope = want
    aggInFlight.add(scope)
    const row = d.sessions.find((r) => r.id === state.s) ?? d.sessions[0]
    void ds
      .aggregate(scope, scope === 'repo' ? row?.cwd : undefined)
      .then((agg) => {
        aggInFlight.delete(scope)
        if (agg) {
          d.aggregates[scope] = agg
          onLoaded()
        }
      })
      .catch(() => aggInFlight.delete(scope))
  }
  return aggInFlight.has(want)
}

function aggScreen(): HTMLElement {
  return h(
    `<section><div class="card"><div class="empty-hero">${mascotSvg(48)}<div class="t">Analysing sessions…</div><div class="s">A cold cache takes a moment; the numbers appear as soon as they are ready.</div></div></div></section>`,
  )
}

function aggregateView(ctx: Ctx): HTMLElement {
  return ctx.state.screen === 'global' ? renderGlobal(ctx) : renderRepo(ctx)
}

// The harness report is fetched on first use and kept until the registry changes: an SSE session
// event marks it stale (invalidateHarness) and the next screen that needs it re-fetches, at most
// once per HARNESS_REFRESH_MS (the server's own recompute floor), keeping the last report on screen
// until the fresh one lands. Never refetched on a timer: nothing polls while the page is idle.
export const HARNESS_REFRESH_MS = 30_000
let harnessReport: HarnessReport | null | undefined
let harnessInFlight = false
let harnessStale = false
let harnessFetchedAt = 0

/** an SSE session-added/updated frame: the registry (and so the crosswalk) may have moved */
export function invalidateHarness(): void {
  harnessStale = true
}

/**
 * kicks the /api/harness fetch when there is no report yet, or a stale one older than the refresh
 * floor; true only while the FIRST fetch is in flight (the screen renders aggScreen meanwhile; a
 * refresh keeps rendering the report it has).
 */
export function ensureHarness(ds: DataSource, onLoaded: () => void): boolean {
  const refresh = harnessStale && Date.now() - harnessFetchedAt >= HARNESS_REFRESH_MS
  if (harnessReport !== undefined && !refresh) return false
  if (!harnessInFlight) {
    harnessInFlight = true
    harnessStale = false
    void ds
      .harness()
      .then(
        (r) => {
          harnessReport = r
        },
        () => {
          // a failed refresh keeps the last good report; a failed first fetch is the designed degraded state
          if (harnessReport === undefined) harnessReport = null
        },
      )
      .finally(() => {
        harnessInFlight = false
        harnessFetchedAt = Date.now()
        // success or failure: re-render so #harness leaves the loading state (null = designed degraded state)
        onLoaded()
      })
  }
  return harnessInFlight && harnessReport === undefined
}

function harnessView(ctx: Ctx): HTMLElement {
  return renderHarness(ctx, harnessReport ?? null)
}

/** the Overview card: the loading state until the report is here (the fetch is kicked so a re-render fills it), the degraded state if it never is */
function harnessCard(ds: DataSource, onLoaded: () => void, href: string): string {
  ensureHarness(ds, onLoaded)
  return harnessCardHtml(harnessReport, href)
}

export const serveUi: ServeUi = { pickerHtml, wirePicker, ensureAggregate, aggScreen, aggregateView, megaReview, ensureHarness, invalidateHarness, harnessView, harnessCard }
