/**
 * Pure nav + route model for the app client. No DOM access; unit-tested in node.
 * The hash is the saved view: #<screen>?s=&scope=&tool=&cat=&agent=&turn=&err=1&filter=&zoom=&audience=&theme=
 */
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'

export interface NavItem {
  /** dom id suffix + aria key */
  id: string
  label: string
  /** target screen id (SCREEN_IDS member) */
  screen: string
  /** session id carried into the hash (live items, picker) */
  s?: string
  /** muted hint rendered right-aligned (e.g. "needs orangu serve") */
  hint?: string
  /** live dot state for Live items */
  dot?: 'pulse' | 'hollow' | 'ended'
}

export interface NavGroup {
  /** `start` holds the Start item of serve only. Its label is empty, so the sidebar draws no heading above it. */
  id: 'start' | 'session' | 'sessions' | 'machine' | 'improve'
  label: string
  items: NavItem[]
}

/** The labelled groups: the 3 zoom levels of the start view, then Improve. The CSS sets them in capitals. */
export const NAV_GROUPS: ReadonlyArray<{ id: NavGroup['id']; label: string }> = [
  { id: 'session', label: 'One session' },
  { id: 'sessions', label: 'Sessions and agents' },
  { id: 'machine', label: 'This machine' },
  { id: 'improve', label: 'Improve' },
]

export const SCREEN_IDS = ['start', 'live', 'overview', 'timeline', 'tools', 'agents', 'context', 'coverage', 'repo', 'global', 'harness', 'suggest'] as const

export type ScreenId = (typeof SCREEN_IDS)[number]

/** The 3 zoom levels of the start view: one session, the sessions and their agents, the whole machine. */
export type StartZoom = 'session' | 'sessions' | 'machine'

export interface RouteState {
  screen: string
  s?: string
  scope?: 'session' | 'repo' | 'global'
  tool?: string
  cat?: string
  agent?: string
  turn?: number
  errorsOnly?: boolean
  filter?: 'all' | 'errors' | 'agents' | 'human'
  /** the zoom of the start view; absent, startZoom() gives the default */
  zoom?: StartZoom
  theme?: string
  audience?: 'dev' | 'plain'
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * The live sessions every surface counts from (sidebar, header, fleet gate, alt+arrow cycling):
 * a plain `orangu report` is a snapshot, so only a watch-generated file (or serve) has a real one.
 */
export function liveRows(data: AppData): SessionSummaryRow[] {
  if (data.mode === 'file' && !data.capabilities.watch) return []
  return data.sessions.filter((r) => r.badge === 'live')
}

/**
 * The scope a saved file is about, when it is about a scope rather than a session: `orangu repo
 * --html` / `orangu global --html` write an aggregate with no session in it. Serve always has a
 * session to select, so it is never one of these.
 */
export function fileScope(data: AppData): 'repo' | 'global' | undefined {
  if (data.mode !== 'file' || data.session) return undefined
  return data.aggregates.repo ? 'repo' : data.aggregates.global ? 'global' : undefined
}

/**
 * Where an empty hash lands: the start view in serve (its zoom shows the running sessions when more than one is
 * live), the scope when the file has no session to show, else this session's Overview.
 */
export function defaultScreen(data: AppData): ScreenId {
  if (data.mode === 'serve') return 'start'
  return fileScope(data) ?? 'overview'
}

/**
 * The zoom of the start view: the one in the hash, else the sessions and their agents when more than one session is
 * live, else one session. Only the serve modules call it, so the file bundles leave it out.
 */
export function startZoom(data: AppData, state: RouteState): StartZoom {
  return state.zoom ?? (liveRows(data).length > 1 ? 'sessions' : 'session')
}

/**
 * The sidebar model. Data-driven: groups always exist, and an empty group means "hide it". Start comes first, with no
 * heading, then the 3 zoom levels and Improve: the screens of one session, the live sessions and Repo, then Global
 * and Harness, then Improvements.
 */
export function navFor(data: AppData, state: RouteState): NavGroup[] {
  const audience = state.audience === 'plain' ? 'plain' : 'dev'
  const live = liveRows(data)
  const liveItems: NavItem[] = []
  if (live.length > 1) liveItems.push({ id: 'live-all', label: `All live · ${live.length}`, screen: 'live', dot: 'pulse' })
  for (const r of live)
    liveItems.push({
      id: 'live-' + r.id,
      label: live.length > 1 ? `${shortId(r.id)} · ${r.projectSlug}` : `Watch · ${shortId(r.id)}`,
      screen: 'live',
      s: r.id,
      dot: 'pulse',
    })

  // A file about a scope has no session group: app.ts drops an empty group, so an aggregate report
  // hides the whole "One session" block instead of offering five links that can only answer
  // "no session". The gate is fileScope, the same answer defaultScreen routes on, so the group and the
  // landing screen can never contradict each other. It is deliberately not "no session": serve can
  // bootstrap with none (an empty registry, or a first analysis that throws) and never write one back,
  // and its pane fills in from ctx.a, so subtracting there would strip the group for the whole page.
  const sessionItems: NavItem[] = []
  if (fileScope(data) === undefined) {
    sessionItems.push({ id: 'overview', label: 'Overview', screen: 'overview' }, { id: 'timeline', label: 'Timeline', screen: 'timeline' }, { id: 'tools', label: 'Tools & calls', screen: 'tools' })
    if (audience === 'dev') {
      if ((data.session?.agents.runs.length ?? 0) > 0) sessionItems.push({ id: 'agents', label: 'Agents', screen: 'agents' })
      sessionItems.push({ id: 'context', label: 'Context & tokens', screen: 'context' })
      sessionItems.push({ id: 'coverage', label: 'Coverage', screen: 'coverage' })
    }
  }

  const repoN = data.aggregates.repo?.sessionCount
  // The count belongs to a saved file: whatever aggregate a file embeds is fixed, whether the file is
  // about a scope or a session that carries the scopes beside it (the published sample). Serve fetches
  // the global aggregate while the page is open, and counting there would rewrite "Global · all time"
  // under the reader mid-session, so serve never counts.
  const globalN = data.mode === 'file' ? data.aggregates.global?.sessionCount : undefined
  const needsServe = data.mode === 'file' ? 'needs orangu serve' : undefined
  liveItems.push({ id: 'repo', label: repoN !== undefined ? `Repo · ${repoN} sessions` : 'Repo', screen: 'repo', hint: repoN === undefined ? needsServe : undefined })

  return [
    // the start view is serve only (serve-ui.ts), so a file report lists no Start item
    { id: 'start', label: '', items: data.mode === 'serve' ? [{ id: 'start', label: 'Start', screen: 'start' }] : [] },
    { id: 'session', label: 'One session', items: sessionItems },
    { id: 'sessions', label: 'Sessions and agents', items: liveItems },
    {
      id: 'machine',
      label: 'This machine',
      items: [
        { id: 'global', label: globalN !== undefined ? `Global · ${globalN} sessions` : 'Global · all time', screen: 'global', hint: globalN === undefined ? needsServe : undefined },
        { id: 'harness', label: 'Harness', screen: 'harness', hint: needsServe },
      ],
    },
    { id: 'improve', label: 'Improve', items: [{ id: 'suggest', label: 'Improvements', screen: 'suggest' }] },
  ]
}

/** Parse a location.hash string (with or without leading '#'). Unknown screen → overview. */
export function parseHash(raw: string): RouteState {
  const st: RouteState = { screen: 'overview' }
  const clean = raw.replace(/^#/, '')
  const [sec, query] = clean.split('?')
  if (sec && (SCREEN_IDS as readonly string[]).includes(sec)) st.screen = sec
  if (query)
    for (const kv of query.split('&')) {
      const eq = kv.indexOf('=')
      if (eq < 0) continue
      const k = kv.slice(0, eq)
      const v = decodeURIComponent(kv.slice(eq + 1))
      if (k === 's') st.s = v
      else if (k === 'scope' && (v === 'session' || v === 'repo' || v === 'global')) st.scope = v
      else if (k === 'tool') st.tool = v
      else if (k === 'cat') st.cat = v
      else if (k === 'agent') st.agent = v
      else if (k === 'turn') st.turn = Number(v)
      else if (k === 'err') st.errorsOnly = v === '1'
      else if (k === 'filter' && (v === 'all' || v === 'errors' || v === 'agents' || v === 'human')) st.filter = v
      else if (k === 'zoom' && (v === 'session' || v === 'sessions' || v === 'machine')) st.zoom = v
      else if (k === 'theme') st.theme = v
      else if (k === 'audience' && (v === 'dev' || v === 'plain')) st.audience = v
    }
  return st
}

/** A link into another screen with every aggregate/filter key and the start zoom cleared, so the target starts clean. */
export function cleanHash(st: RouteState, next: Partial<RouteState>): string {
  return writeHash({ ...st, scope: undefined, tool: undefined, cat: undefined, agent: undefined, turn: undefined, errorsOnly: undefined, filter: undefined, zoom: undefined, ...next })
}

/** Serialise a RouteState to a hash string. Never emits `density` (dead control, removed). */
export function writeHash(st: RouteState): string {
  const q: string[] = []
  if (st.s) q.push('s=' + encodeURIComponent(st.s))
  if (st.scope) q.push('scope=' + st.scope)
  if (st.tool) q.push('tool=' + encodeURIComponent(st.tool))
  if (st.cat) q.push('cat=' + encodeURIComponent(st.cat))
  if (st.agent) q.push('agent=' + encodeURIComponent(st.agent))
  if (st.turn !== undefined) q.push('turn=' + st.turn)
  if (st.errorsOnly) q.push('err=1')
  if (st.filter) q.push('filter=' + st.filter)
  if (st.zoom) q.push('zoom=' + st.zoom)
  if (st.audience) q.push('audience=' + st.audience)
  if (st.theme) q.push('theme=' + st.theme)
  return '#' + st.screen + (q.length ? '?' + q.join('&') : '')
}
