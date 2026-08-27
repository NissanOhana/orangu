/**
 * Pure nav + route model for the app client. No DOM access; unit-tested in node.
 * The hash is the saved view: #<screen>?s=&scope=&tool=&cat=&agent=&turn=&err=1&filter=&audience=&theme=
 */
import type { AppData } from '../../model/app-data.js'

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
  id: 'live' | 'session' | 'across' | 'improve'
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: ReadonlyArray<{ id: NavGroup['id']; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'session', label: 'Observe this session' },
  { id: 'across', label: 'Recurring patterns' },
  { id: 'improve', label: 'Improve the next run' },
]

export const SCREEN_IDS = ['live', 'overview', 'timeline', 'tools', 'agents', 'context', 'coverage', 'repo', 'global', 'suggest'] as const

export type ScreenId = (typeof SCREEN_IDS)[number]

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
  theme?: string
  audience?: 'dev' | 'plain'
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** The sidebar model. Data-driven: groups always exist; empty Live group means "hide it". */
export function navFor(data: AppData, state: RouteState): NavGroup[] {
  const audience = state.audience === 'plain' ? 'plain' : 'dev'
  // a plain `orangu report` is a snapshot: only a watch-generated file (or serve) has a real live session
  const liveRows = data.mode === 'file' && !data.capabilities.watch ? [] : data.sessions.filter((r) => r.badge === 'live')
  const liveItems: NavItem[] = []
  if (liveRows.length > 1) liveItems.push({ id: 'live-all', label: `All live · ${liveRows.length}`, screen: 'live', dot: 'pulse' })
  for (const r of liveRows)
    liveItems.push({
      id: 'live-' + r.id,
      label: liveRows.length > 1 ? `${shortId(r.id)} · ${r.projectSlug}` : `Watch · ${shortId(r.id)}`,
      screen: 'live',
      s: r.id,
      dot: 'pulse',
    })

  const sessionItems: NavItem[] = [
    { id: 'overview', label: 'Overview', screen: 'overview' },
    { id: 'timeline', label: 'Timeline', screen: 'timeline' },
    { id: 'tools', label: 'Tools & calls', screen: 'tools' },
  ]
  if (audience === 'dev') {
    if ((data.session?.agents.runs.length ?? 0) > 0) sessionItems.push({ id: 'agents', label: 'Agents', screen: 'agents' })
    sessionItems.push({ id: 'context', label: 'Context & tokens', screen: 'context' })
    sessionItems.push({ id: 'coverage', label: 'Coverage', screen: 'coverage' })
  }

  const repoN = data.aggregates.repo?.sessionCount
  const globalN = data.aggregates.global?.sessionCount
  const needsServe = data.mode === 'file' ? 'needs orangu serve' : undefined
  const acrossItems: NavItem[] = [
    { id: 'repo', label: repoN !== undefined ? `Repo · ${repoN} sessions` : 'Repo', screen: 'repo', hint: repoN === undefined ? needsServe : undefined },
    { id: 'global', label: 'Global · all time', screen: 'global', hint: globalN === undefined ? needsServe : undefined },
  ]

  return [
    { id: 'live', label: 'Live', items: liveItems },
    { id: 'session', label: 'Observe this session', items: sessionItems },
    { id: 'across', label: 'Recurring patterns', items: acrossItems },
    { id: 'improve', label: 'Improve the next run', items: [{ id: 'suggest', label: 'Suggestions', screen: 'suggest' }] },
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
      else if (k === 'theme') st.theme = v
      else if (k === 'audience' && (v === 'dev' || v === 'plain')) st.audience = v
    }
  return st
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
  if (st.audience) q.push('audience=' + st.audience)
  if (st.theme) q.push('theme=' + st.theme)
  return '#' + st.screen + (q.length ? '?' + q.join('&') : '')
}
