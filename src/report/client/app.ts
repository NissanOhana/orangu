/**
 * App shell + router. One screen mounted per hash; the sidebar is the design's four groups;
 * the hash is the saved view. mountApp(ds) is the only entry; no DOM access at module top level.
 */
import type { Analysis } from '../../model/analysis.js'
import type { AppData } from '../../model/app-data.js'
import type { DataSource } from './data.js'
import type { ServeEvent } from '../../serve/types.js'
import { cleanHash, defaultScreen, fileScope, liveRows, navFor, parseHash, writeHash, shortId, type RouteState } from './nav.js'
import { badgeCopy, mergeOpenIds } from './derive.js'
import { esc, num } from './format.js'
import { mascotSvg } from './mascot.js'
import { h, wireExpandables, wireCopyButtons } from './dom.js'
import { plainSentence, type Audience } from './strings.js'
import { renderLive } from './screens/live.js'
import { renderOverview } from './screens/overview.js'
import { renderTimeline } from './screens/timeline.js'
import { renderTools } from './screens/tools.js'
import { aggregateEmpty } from './screens/repo.js'
import { renderSuggest } from './screens/suggest.js'
import { renderAgents } from './screens/agents.js'
import { renderContext } from './screens/context.js'
import { renderCoverage } from './screens/coverage.js'

export interface Ctx {
  data: AppData
  /** the selected session's Analysis (undefined on aggregate-only screens or before load) */
  a?: Analysis
  ds: DataSource
  state: RouteState
  audience: Audience
  /** serve mode: EventSource connection state ; undefined in file mode */
  conn?: 'connected' | 'reconnecting'
  /** serve mode: an aggregate fetch for this screen is in flight */
  aggLoading?: boolean
  /** serve-only whole-harness CTA; aggregate screens are unavailable in file mode */
  megaReview?: (scope: 'repo' | 'global') => string
  /** serve-only Overview card from the harness report ('' until it has loaded; kicks the fetch) */
  harnessCard?: () => string
  go(next: Partial<RouteState>, opts?: { push?: boolean }): void
}

type ScreenRenderer = (ctx: Ctx) => HTMLElement

const SCREENS: Record<string, ScreenRenderer> = {
  live: renderLive,
  overview: renderOverview,
  timeline: renderTimeline,
  tools: renderTools,
  suggest: renderSuggest,
  agents: renderAgents,
  context: renderContext,
  coverage: renderCoverage,
}

const TITLES: Record<string, string> = {
  live: 'Live',
  overview: 'Overview',
  timeline: 'Timeline',
  tools: 'Tools & calls',
  repo: 'Repo',
  global: 'Global',
  harness: 'Harness',
  suggest: 'Improve the next outcome',
  agents: 'Agents',
  context: 'Context & tokens',
  coverage: 'Coverage',
}
function screenTitle(id: string): string {
  return TITLES[id] ?? 'Overview'
}

/** Exported for the unit test: the header must never describe a scope the body did not render. */
export function screenSub(ctx: Ctx): string {
  const a = ctx.a
  const aud = ctx.audience
  switch (ctx.state.screen) {
    case 'live': {
      const live = liveRows(ctx.data)
      if (live.length > 1) return `${live.length} running sessions · ${live.reduce((n, r) => n + (r.agentsRunning ?? 0), 0)} agents active`
      const row = ctx.data.sessions.find((r) => r.id === (ctx.state.s ?? ctx.data.selectedId))
      return row ? `${shortId(row.id)} · ${badgeCopy(row)}` : ''
    }
    case 'overview': {
      if (!a) return ''
      return plainSentence(`outcome and evidence · ${shortId(a.session.id)} · ${a.summary.turns} turns · ${a.summary.toolCalls} tool calls`, aud)
    }
    case 'timeline':
      return a ? plainSentence(`every step and tool call · ${a.summary.turns} turns · ${a.summary.toolErrors} errors`, aud) : ''
    case 'tools':
      return a ? plainSentence(`${a.summary.toolCalls} tool calls · ${a.tools.byName.length} tools`, aud) : ''
    case 'repo':
      return `${ctx.data.aggregates.repo ? ctx.data.aggregates.repo.sessionCount + ' sessions · ' : ''}recurring evidence in this repository`
    case 'global':
      return `${ctx.data.aggregates.global ? ctx.data.aggregates.global.sessionCount + ' sessions · ' : ''}recurring evidence across this machine`
    case 'harness':
      return 'declared vs used, in tokens'
    case 'suggest': {
      // the same default the screen itself applies: an unscoped hash in a file with no session is
      // about that file's scope, so the header may not still promise one finding from one session
      const scope = ctx.state.scope ?? fileScope(ctx.data)
      return scope === 'repo' || scope === 'global' ? 'recurring patterns · bounded proposals · whole-harness review' : 'one finding · one bounded proposal'
    }
    case 'agents':
      return a ? `${a.agents.runs.length} runs · up to ${a.agents.maxConcurrency} parallel` : ''
    case 'context':
      return a ? `peak ${num(a.context.peak)} · ${a.context.compactions.length} compactions` : ''
    case 'coverage':
      return a ? `${num(a.parse.totalLines)} records · ${a.parse.badLines} unreadable` : ''
    default:
      return ''
  }
}

/** Serve-only chrome injected by serve-entry.ts so its bytes stay out of the file-mode bundle. */
export interface ServeUi {
  pickerHtml(d: AppData, row: import('../../model/app-data.js').SessionSummaryRow | undefined): string
  wirePicker(el: HTMLElement, go: (next: { s?: string }, opts?: { push?: boolean }) => void): void
  /** kicks the repo/global fetch this screen needs; true while it is in flight (renders aggScreen) */
  ensureAggregate(d: AppData, ds: DataSource, state: RouteState, onLoaded: () => void): boolean
  /** "Analysing sessions…" placeholder while an aggregate computes */
  aggScreen(): HTMLElement
  /** repo/global rendering is serve-only; file mode keeps only the small local-viewer empty state */
  aggregateView(ctx: Ctx): HTMLElement
  megaReview(scope: 'repo' | 'global'): string
  /** kicks the harness fetch the #harness screen (or the Overview card) needs; true while the first one is in flight */
  ensureHarness(ds: DataSource, onLoaded: () => void): boolean
  /** the registry moved (an SSE session frame): the next screen that needs the harness re-fetches it */
  invalidateHarness(): void
  harnessView(ctx: Ctx): HTMLElement
  /** the Overview card; `href` is the #harness route carrying the current session key */
  harnessCard(ds: DataSource, onLoaded: () => void, href: string): string
}

/** Refresh persisted suggestion state after an SSE transition without erasing the last good view. */
export async function refreshSuggestions(d: AppData, ds: Pick<DataSource, 'suggestions'>, visible: boolean, rerender: () => void): Promise<void> {
  try {
    d.suggestions = await ds.suggestions()
    if (visible) rerender()
  } catch {
    /* keep the last good records; a later SSE frame can retry */
  }
}

/** Close both the initial-bootstrap and reconnect windows with an authoritative store read. */
export async function refreshSuggestionsOnConnection(
  ev: ServeEvent,
  d: AppData,
  ds: Pick<DataSource, 'suggestions'>,
  visible: boolean,
  rerender: () => void,
): Promise<void> {
  if (ev.type === 'connection' && ev.state === 'connected') await refreshSuggestions(d, ds, visible, rerender)
}

/**
 * Light is the only default: dark exists solely under `data-theme="dark"`, never from the system
 * colour scheme, so any hash value that is not `dark` reads as light.
 */
export function themeName(theme: string | undefined): 'light' | 'dark' {
  return theme === 'dark' ? 'dark' : 'light'
}

/** The sidebar control toggles the two states; light clears `theme=` so its hash stays shareable. */
export function cycleTheme(theme: string | undefined): string | undefined {
  return themeName(theme) === 'dark' ? undefined : 'dark'
}

/**
 * The sidebar card names what the file is about. Only a saved file about a scope reads `Scope`: serve
 * renders the session picker in this card and can bootstrap with no session, so it keeps `Session`.
 */
export function sesscardEyebrow(d: AppData): string {
  return fileScope(d) === undefined ? 'Session' : 'Scope'
}

/** The browser tab: the session's title, else its short id, else the scope a saved aggregate covers. */
export function docTitle(d: AppData, a: Analysis | undefined, s: string | undefined): string {
  const scope = fileScope(d)
  return 'orangu · ' + (a?.session.title || shortId(s ?? '') || (scope && d.aggregates[scope]?.scope) || 'report')
}

export async function mountApp(ds: DataSource, serveUi?: ServeUi): Promise<void> {
  const app = document.getElementById('app')
  if (!app) return
  let data: AppData | null = null
  try {
    data = await ds.load()
  } catch {
    data = null
  }
  if (!data) {
    app.innerHTML = `<div class="page"><div class="card"><div class="empty-hero">${mascotSvg(48)}<div class="t">No analysis data in this file.</div><div class="s mono">node dist/orangu.js report</div></div></div></div>`
    return
  }
  const d = data

  // an empty hash lands on the fleet when several sessions are live (serve), else on Overview;
  // parseHash itself is unchanged, so every explicit hash keeps its meaning
  const routeFor = (hash: string): RouteState => {
    const st = parseHash(hash)
    if (!hash.replace(/^#/, '')) st.screen = defaultScreen(d)
    if (!st.s) st.s = d.selectedId
    return st
  }
  let state = routeFor(location.hash)

  const analysisFor = async (id: string | undefined): Promise<Analysis | undefined> => {
    if (!id) return d.session
    if (d.mode !== 'serve') {
      if (d.session && d.session.session.id === id) return d.session
      return (await ds.session(id)) ?? d.session
    }
    // serve: the embedded snapshot goes stale, so refetch through the source's 2 s per-session throttle
    const fresh = await ds.session(id)
    if (fresh) return fresh
    return d.session && d.session.session.id === id ? d.session : undefined
  }

  const applyTheme = (): void => {
    const root = document.documentElement
    if (themeName(state.theme) === 'dark') root.setAttribute('data-theme', 'dark')
    else root.removeAttribute('data-theme')
  }

  const go = (next: Partial<RouteState>, opts: { push?: boolean } = {}): void => {
    state = { ...state, ...next }
    const hash = writeHash(state)
    if (opts.push) history.pushState(null, '', hash)
    else history.replaceState(null, '', hash)
    void render()
  }

  // serve mode: connection state; on-demand aggregates live in serve-ui (bundle-size, policy)
  let conn: 'connected' | 'reconnecting' | undefined

  const ctxFor = async (): Promise<Ctx> => ({
    data: d,
    a: await analysisFor(state.s),
    ds,
    state,
    audience: state.audience === 'plain' ? 'plain' : 'dev',
    conn,
    aggLoading: serveUi ? (state.screen === 'harness' ? serveUi.ensureHarness(ds, scheduleRender) : serveUi.ensureAggregate(d, ds, state, scheduleRender)) : false,
    megaReview: serveUi?.megaReview,
    harnessCard: serveUi ? () => serveUi.harnessCard(ds, scheduleRender, cleanHash(state, { screen: 'harness' })) : undefined,
    go,
  })

  // Live updates re-render at most ~1–2 Hz via the client-side throttle.
  let renderQueued = false
  let lastRenderMs = 0
  const RENDER_MIN_MS = 600
  function scheduleRender(): void {
    if (renderQueued) return
    renderQueued = true
    const wait = Math.max(0, lastRenderMs + RENDER_MIN_MS - Date.now())
    setTimeout(() => {
      renderQueued = false
      void render()
    }, wait)
  }

  function sidebar(ctx: Ctx): HTMLElement {
    const groups = navFor(d, state)
    const row = d.sessions.find((r) => r.id === state.s) ?? d.sessions[0]
    const nav = groups
      .filter((g) => g.items.length)
      .map(
        (g) => `<div class="navgroup"><div class="navgroup-label">${esc(g.label)}</div>${g.items
          .map((it) => {
            const target = cleanHash(state, { screen: it.screen, s: it.s ?? state.s, scope: state.scope })
            const active = state.screen === it.screen && (it.s === undefined || it.s === state.s)
            const dot = it.dot ? `<span class="ldot${it.dot === 'hollow' ? ' hollow' : it.dot === 'ended' ? ' done' : ''}"${it.dot === 'pulse' ? ' data-pulse="1"' : ''} aria-hidden="true"></span><span class="vh">${it.dot === 'pulse' ? 'live' : it.dot === 'hollow' ? 'quiet' : 'ended'}</span>` : ''
            return `<a class="navitem" href="${esc(target)}"${active ? ' aria-current="page"' : ''}>${dot}${esc(it.label)}${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</a>`
          })
          .join('')}</div>`,
      )
      .join('')
    const liveN = liveRows(d).length
    const foot =
      d.mode === 'serve'
        ? 'Served from 127.0.0.1<br/>nothing leaves this machine.' + (liveN > 1 ? '<br/>alt+↑↓ switch session' : '')
        : 'Self-contained report.<br/>0 network requests.'
    const el = h(`<aside class="side">
<div class="brand">${mascotSvg(26)}<span class="name">orangu</span><span class="ver">v${esc(d.version)}</span></div>
<div class="sesscard"><div class="eyebrow">${sesscardEyebrow(d)}</div>${serveUi ? serveUi.pickerHtml(d, row) : `<div class="sid">${row ? esc(shortId(row.id)) + ' · ' + esc(row.projectSlug || row.source) : '–'}</div>`}</div>
<div class="navwrap"><nav aria-label="Report">${nav}</nav></div>
<div class="side-foot">
<button class="themebtn" id="btn-theme">◐ theme · ${themeName(state.theme)}</button>
<div class="note">${foot}</div>
</div>
</aside>`)
    el.querySelector('#btn-theme')!.addEventListener('click', () => go({ theme: cycleTheme(state.theme) }))
    serveUi?.wirePicker(el, go)
    return el
  }

  function pageHead(ctx: Ctx): HTMLElement {
    const aud = ctx.audience
    const el = h(`<header class="page-head">
<div><h1>${esc(screenTitle(state.screen))}</h1><div class="sub">${esc(screenSub(ctx))}</div></div>
<div class="page-tools">
<div class="aud" role="group" aria-label="Detail level">
<button id="aud-dev" aria-pressed="${aud === 'dev'}">Detailed</button>
<button id="aud-plain" aria-pressed="${aud === 'plain'}">Plain language</button>
</div>
<button class="btn" id="btn-export">↓ Export HTML</button>
</div>
</header>`)
    el.querySelector('#aud-dev')!.addEventListener('click', () => go({ audience: undefined }))
    el.querySelector('#aud-plain')!.addEventListener('click', () => go({ audience: 'plain' }))
    el.querySelector('#btn-export')!.addEventListener('click', () => {
      const href = ds.exportHref(state.s ?? '')
      if (href) {
        location.href = href
        return
      }
      const blob = new Blob(['<!doctype html>\n' + document.documentElement.outerHTML], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `orangu-${shortId(state.s ?? 'report')}.html`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    })
    return el
  }

  // Re-render preservation seam: every render wipes the DOM, so expandables with a stable id
  // (data-sid, or an id like the timeline's turn-N) and the scroll position are captured before
  // the wipe and re-applied after: an SSE tick must not collapse what the user opened.
  let openIds: string[] = []
  const EXPANDABLE = 'details[data-sid],details[id]'
  const keyOf = (el: HTMLElement): string => el.dataset['sid'] ?? el.id

  async function render(): Promise<void> {
    lastRenderMs = Date.now()
    applyTheme()
    const ctx = await ctxFor()
    document.title = docTitle(d, ctx.a, state.s)
    const renderer = SCREENS[state.screen] ?? renderOverview
    const aggregateScope = state.screen === 'repo' || state.screen === 'global' || state.screen === 'harness' ? state.screen : undefined
    const screenEl =
      ctx.aggLoading && serveUi
        ? serveUi.aggScreen()
        : aggregateScope
          ? (serveUi ? (aggregateScope === 'harness' ? serveUi.harnessView(ctx) : serveUi.aggregateView(ctx)) : h(`<section>${aggregateEmpty(aggregateScope, d)}</section>`))
          : renderer(ctx)
    screenEl.classList.add('screen')
    screenEl.id = 'screen-' + state.screen
    const page = h('<div class="page"></div>')
    if (d.illustrative)
      page.appendChild(h('<div class="sample-note" role="note"><b>Illustrative synthetic sample.</b> Its numbers come from made-up input, not a measured customer result.</div>'))
    page.appendChild(pageHead(ctx))
    page.appendChild(screenEl)
    const main = h('<main class="main"></main>')
    main.appendChild(page)
    const oldOpen: Array<{ id: string; open: boolean }> = []
    app!.querySelectorAll<HTMLDetailsElement>(EXPANDABLE).forEach((el) => oldOpen.push({ id: keyOf(el), open: el.open }))
    openIds = mergeOpenIds(openIds, oldOpen)
    // .main is the app's one scroller (the window never scrolls in this layout)
    const scrollTop = app!.querySelector('.main')?.scrollTop ?? 0
    app!.innerHTML = ''
    app!.appendChild(sidebar(ctx))
    app!.appendChild(main)
    // re-open BEFORE wiring so aria-expanded is stamped from the restored state
    app!.querySelectorAll<HTMLDetailsElement>(EXPANDABLE).forEach((el) => {
      if (openIds.includes(keyOf(el))) el.open = true
    })
    main.scrollTop = scrollTop
    wireExpandables(app!)
    wireCopyButtons(app!)
    // cross-screen jumps: any [data-turns] button opens the timeline at its first turn
    app!.querySelectorAll<HTMLElement>('[data-turns]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault()
        const first = Number(b.dataset['turns']!.split(',')[0])
        go({ screen: 'timeline', turn: first }, { push: true })
      }),
    )
  }

  window.addEventListener('hashchange', () => {
    state = routeFor(location.hash)
    void render()
  })

  // Alt+↑/↓ cycles live sessions on a Live screen
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    if (state.screen !== 'live') return
    const live = liveRows(d)
    if (live.length < 2) return
    const i = live.findIndex((r) => r.id === state.s)
    const next = live[(i + (e.key === 'ArrowDown' ? 1 : live.length - 1)) % live.length]!
    e.preventDefault()
    go({ s: next.id }, { push: true })
  })

  // generic live-update handling; renders are throttled to ~1–2 Hz
  ds.subscribe((ev) => {
    if (ev.type === 'session-updated') {
      const i = d.sessions.findIndex((r) => r.id === ev.id)
      if (i >= 0) d.sessions[i] = ev.row
      serveUi?.invalidateHarness()
      if (state.s === ev.id || state.screen === 'live') scheduleRender()
    } else if (ev.type === 'session-added') {
      d.sessions.push(ev.row)
      serveUi?.invalidateHarness()
      scheduleRender()
    } else if (ev.type === 'session-live') {
      const row = d.sessions.find((r) => r.id === ev.id)
      if (row) {
        row.badge = ev.badge
        row.ageMs = ev.ageMs
      }
      if (state.screen === 'live') scheduleRender()
    } else if (ev.type === 'suggestion-updated') {
      void refreshSuggestions(d, ds, state.screen === 'suggest', scheduleRender)
    } else if (ev.type === 'connection') {
      const prev = conn
      conn = ev.state
      void refreshSuggestionsOnConnection(ev, d, ds, state.screen === 'suggest', scheduleRender)
      if (prev !== conn) scheduleRender()
    }
  })

  await render()
}
