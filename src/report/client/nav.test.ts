import { describe, it, expect } from 'vitest'
import { NAV_GROUPS, SCREEN_IDS, cleanHash, defaultScreen, liveRows, navFor, parseHash, startZoom, writeHash, type NavGroup, type RouteState } from './nav.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { Analysis } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'

/** navFor only reads the subagent run count off the Analysis; the rest of the shape is irrelevant here. */
const analysis = { session: { id: 'abc12345-6789' }, agents: { runs: [] } } as unknown as Analysis
/** The same session with 1 subagent run: the sidebar then lists Agents. */
const withAgent = { session: { id: 'abc12345-6789' }, agents: { runs: [{ agentId: 'a1' }] } } as unknown as Analysis

/** The items of 1 group, by its id. */
const group = (groups: NavGroup[], id: NavGroup['id']): NavGroup => groups.find((g) => g.id === id)!

function row(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    id: 'abc12345-6789',
    projectSlug: 'demo',
    path: '/tmp/abc.jsonl',
    source: 'claude-code',
    sizeBytes: 100,
    mtimeMs: 0,
    badge: 'ended',
    ageMs: 10_000_000,
    possiblyLive: false,
    ...over,
  }
}

function appData(over: Partial<AppData> = {}): AppData {
  return {
    v: '1',
    mode: 'file',
    version: 'test',
    generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: 'abc12345-6789',
    session: analysis,
    sessions: [row()],
    aggregates: {},
    suggestions: [],
    ...over,
  }
}

/** The scope label a saved aggregate carries: already redacted by the CLI before it reaches the file. */
function agg(scope: string, sessionCount: number): Aggregate {
  return { scope, sessionCount } as unknown as Aggregate
}

/** A saved `orangu repo --html` / `orangu global --html` file: aggregates, and no session at all. */
function aggReport(aggregates: AppData['aggregates']): AppData {
  return appData({ selectedId: undefined, session: undefined, sessions: [], aggregates })
}

describe('nav model', () => {
  it('has the four zoom group labels', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['One session', 'Sessions and agents', 'This machine', 'Improve'])
  })

  it('draws the labels of NAV_GROUPS, in its order, so the list and the sidebar cannot drift apart', () => {
    for (const d of [appData(), appData({ mode: 'serve' })]) {
      const labelled = navFor(d, { screen: 'overview' }).filter((g) => g.label)
      expect(labelled.map((g) => [g.id, g.label])).toEqual(NAV_GROUPS.map((g) => [g.id, g.label]))
    }
  })

  it('has the twelve screen ids, the start view first', () => {
    expect(SCREEN_IDS).toEqual(['start', 'live', 'overview', 'timeline', 'tools', 'agents', 'context', 'coverage', 'repo', 'global', 'harness', 'suggest'])
  })

  it('puts each screen in its zoom group, in order: Start, then one session, the sessions and agents, this machine, Improve', () => {
    const d = appData({ mode: 'serve', session: withAgent, sessions: [row({ id: 'aaaa1111-x', badge: 'live' }), row({ id: 'bbbb2222-y', badge: 'live' }), row({ id: 'cccc3333-z' })] })
    expect(navFor(d, { screen: 'start' }).map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ['', ['Start']],
      ['One session', ['Overview', 'Timeline', 'Tools & calls', 'Agents', 'Context & tokens', 'Coverage']],
      ['Sessions and agents', ['All live · 2', 'aaaa1111 · demo', 'bbbb2222 · demo', 'Repo']],
      ['This machine', ['Global · all time', 'Harness']],
      ['Improve', ['Improvements']],
    ])
  })

  it('lists Start in serve only: a file report has no start view to open', () => {
    expect(group(navFor(appData({ mode: 'serve' }), { screen: 'overview' }), 'start').items).toEqual([{ id: 'start', label: 'Start', screen: 'start' }])
    expect(group(navFor(appData(), { screen: 'overview' }), 'start').items).toEqual([])
    expect(group(navFor(appData({ sessions: [row({ badge: 'live', ageMs: 1000 })], capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, watch: true } }), { screen: 'overview' }), 'start').items).toEqual([])
  })

  it('lists Harness under This machine, serve-only like Repo and Global', () => {
    const file = group(navFor(appData(), { screen: 'overview' }), 'machine').items.find((i) => i.screen === 'harness')!
    expect(file.hint).toBe('needs orangu serve')
    const serve = group(navFor(appData({ mode: 'serve' }), { screen: 'overview' }), 'machine').items.find((i) => i.screen === 'harness')!
    expect(serve.hint).toBeUndefined()
    expect(parseHash('#harness').screen).toBe('harness')
  })

  it('Plain language hides the three detailed-only items while retaining dev as the protocol value', () => {
    const detailed = navFor(appData(), { screen: 'overview', audience: 'dev' })
    const plain = navFor(appData(), { screen: 'overview', audience: 'plain' })
    const detailedIds = detailed.flatMap((g) => g.items.map((i) => i.screen))
    const plainIds = plain.flatMap((g) => g.items.map((i) => i.screen))
    expect(detailedIds).toContain('context')
    expect(detailedIds).toContain('coverage')
    for (const hidden of ['agents', 'context', 'coverage']) expect(plainIds).not.toContain(hidden)
  })

  /** The Live items of the Sessions and agents group: the group keeps Repo, so the group itself never empties. */
  const liveItems = (groups: NavGroup[]) => group(groups, 'sessions').items.filter((i) => i.screen === 'live')

  it('lists no Live item in a plain file-mode report even when the row badge says live', () => {
    const snapshot = navFor(appData({ sessions: [row({ badge: 'live', ageMs: 1000 })] }), { screen: 'overview' })
    expect(liveItems(snapshot)).toEqual([])
    const watched = navFor(
      appData({ sessions: [row({ badge: 'live', ageMs: 1000 })], capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, watch: true } }),
      { screen: 'overview' },
    )
    expect(liveItems(watched)).toHaveLength(1)
  })

  it('lists no Live item when no session is live and 1 when one is, before Repo', () => {
    const none = navFor(appData(), { screen: 'overview' })
    expect(liveItems(none)).toHaveLength(0)
    expect(group(none, 'sessions').items.map((i) => i.screen)).toEqual(['repo'])
    const live = navFor(appData({ mode: 'serve', sessions: [row({ badge: 'live', ageMs: 1000 })] }), { screen: 'overview' })
    expect(liveItems(live)).toHaveLength(1)
    expect(liveItems(live)[0]!.label).toContain('Watch')
    expect(group(live, 'sessions').items.map((i) => i.screen)).toEqual(['live', 'repo'])
  })

  it('adds an "All live · N" item when more than one session is live', () => {
    const d = appData({ mode: 'serve', sessions: [row({ id: 'aaaa1111-x', badge: 'live' }), row({ id: 'bbbb2222-y', badge: 'live' })] })
    const items = liveItems(navFor(d, { screen: 'live' }))
    expect(items[0]!.label).toBe('All live · 2')
    expect(items).toHaveLength(3)
  })
})

// A7: one live array, one count. Every surface (sidebar, header, fleet gate, start zoom, alt+arrow) reads liveRows().
describe('liveRows / defaultScreen', () => {
  const three = [row({ id: 'aaaa1111-x', badge: 'live' }), row({ id: 'bbbb2222-y', badge: 'live' }), row({ id: 'cccc3333-z', badge: 'live' }), row({ id: 'dddd4444-w', badge: 'idle' })]

  it('is the same array the sidebar counts from', () => {
    const d = appData({ mode: 'serve', sessions: three })
    expect(liveRows(d).map((r) => r.id)).toEqual(['aaaa1111-x', 'bbbb2222-y', 'cccc3333-z'])
    const items = group(navFor(d, { screen: 'live' }), 'sessions').items.filter((i) => i.screen === 'live')
    expect(items[0]!.label).toBe(`All live · ${liveRows(d).length}`)
    expect(items).toHaveLength(liveRows(d).length + 1)
  })

  it('is empty in a plain file report (the Track 0 guard) and real for a watch-generated one', () => {
    const snapshot = appData({ sessions: [row({ badge: 'live', ageMs: 1000 })] })
    expect(liveRows(snapshot)).toEqual([])
    expect(group(navFor(snapshot, { screen: 'overview' }), 'sessions').items.filter((i) => i.screen === 'live')).toEqual([])
    const watched = appData({ sessions: [row({ badge: 'live', ageMs: 1000 })], capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, watch: true } })
    expect(liveRows(watched)).toHaveLength(1)
  })

  it('lands an empty hash on the start view for each serve-mode AppData, the case with more than 1 live session included', () => {
    expect(defaultScreen(appData({ mode: 'serve', sessions: three }))).toBe('start')
    expect(defaultScreen(appData({ mode: 'serve', sessions: [three[0]!, three[3]!] }))).toBe('start')
    expect(defaultScreen(appData({ mode: 'serve', sessions: [three[3]!] }))).toBe('start')
    expect(defaultScreen(appData({ mode: 'serve', selectedId: undefined, session: undefined, sessions: [] }))).toBe('start')
    // parseHash itself is unchanged: an explicit #overview stays overview, an empty hash still parses to overview
    expect(parseHash('#overview').screen).toBe('overview')
    expect(parseHash('').screen).toBe('overview')
  })

  it('keeps the landing of today for each file-mode AppData: Overview, or the scope of a sessionless file', () => {
    expect(defaultScreen(appData({ sessions: three }))).toBe('overview')
    expect(defaultScreen(appData({ sessions: three, capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, watch: true } }))).toBe('overview')
    expect(defaultScreen(appData())).toBe('overview')
    expect(defaultScreen(aggReport({ global: agg('global', 103) }))).toBe('global')
  })

  it('opens the start view at the sessions and their agents when more than 1 session is live, else at one session', () => {
    expect(startZoom(appData({ mode: 'serve', sessions: three }), { screen: 'start' })).toBe('sessions')
    expect(startZoom(appData({ mode: 'serve', sessions: [three[0]!, three[3]!] }), { screen: 'start' })).toBe('session')
    expect(startZoom(appData({ mode: 'serve', sessions: [three[3]!] }), { screen: 'start' })).toBe('session')
    expect(startZoom(appData({ mode: 'serve', sessions: [] }), { screen: 'start' })).toBe('session')
    // a zoom in the hash wins over the default
    expect(startZoom(appData({ mode: 'serve', sessions: three }), { screen: 'start', zoom: 'machine' })).toBe('machine')
    expect(startZoom(appData({ mode: 'serve', sessions: [three[3]!] }), { screen: 'start', zoom: 'sessions' })).toBe('sessions')
  })
})

describe('hash routes', () => {
  it('parses screen, session, filters, audience and theme', () => {
    const st = parseHash('#timeline?s=abc&tool=Bash&turn=4&err=1&filter=errors&audience=plain&theme=dark&scope=repo')
    expect(st.screen).toBe('timeline')
    expect(st.s).toBe('abc')
    expect(st.tool).toBe('Bash')
    expect(st.turn).toBe(4)
    expect(st.errorsOnly).toBe(true)
    expect(st.filter).toBe('errors')
    expect(st.audience).toBe('plain')
    expect(st.theme).toBe('dark')
    expect(st.scope).toBe('repo')
  })

  it('defaults an unknown screen to overview', () => {
    expect(parseHash('#bogus').screen).toBe('overview')
    expect(parseHash('').screen).toBe('overview')
  })

  it('round-trips through writeHash and never emits density', () => {
    const st: RouteState = { screen: 'suggest', scope: 'global', audience: 'dev', theme: 'light' }
    const hash = writeHash(st)
    expect(hash).not.toContain('density')
    expect(parseHash(hash)).toEqual(st)
  })

  it('preserves the dev and plain audience protocol values', () => {
    expect(writeHash({ screen: 'overview', audience: 'dev' })).toContain('audience=dev')
    expect(parseHash('#overview?audience=plain').audience).toBe('plain')
  })

  it('round-trips the zoom of the start view and the theme: #start?zoom=machine&theme=dark', () => {
    const st = parseHash('#start?zoom=machine&theme=dark')
    expect(st).toEqual({ screen: 'start', zoom: 'machine', theme: 'dark' })
    expect(writeHash(st)).toBe('#start?zoom=machine&theme=dark')
    for (const zoom of ['session', 'sessions', 'machine'] as const) expect(parseHash(writeHash({ screen: 'start', s: 'abc', zoom }))).toEqual({ screen: 'start', s: 'abc', zoom })
  })

  it('drops a zoom that names no level, so a typed hash falls back to the default zoom', () => {
    expect(parseHash('#start?zoom=galaxy').zoom).toBeUndefined()
    expect(parseHash('#start?zoom=').zoom).toBeUndefined()
  })

  it('clears the zoom on a link into another screen, and keeps the theme', () => {
    expect(cleanHash({ screen: 'start', s: 'abc', zoom: 'machine', theme: 'dark' }, { screen: 'global' })).toBe('#global?s=abc&theme=dark')
  })
})

/**
 * The aggregate file report is the one shell state with no session. Nothing here is new UI: it is
 * decided by what the sidebar and the router SUBTRACT, so that no link promises a screen the file
 * cannot render.
 */
describe('the shell of a report that has no session', () => {
  it('lands on the scope the file is about instead of an Overview with nothing in it', () => {
    expect(defaultScreen(aggReport({ repo: agg('repo orangu', 12) }))).toBe('repo')
    expect(defaultScreen(aggReport({ global: agg('global', 103) }))).toBe('global')
  })

  it('still lands on Overview when the file has a session, aggregate or not', () => {
    expect(defaultScreen(appData({ aggregates: { repo: agg('repo orangu', 12) } }))).toBe('overview')
    expect(defaultScreen(appData())).toBe('overview')
  })

  it('falls back to Overview when a sessionless file carries no aggregate either', () => {
    expect(defaultScreen(aggReport({}))).toBe('overview')
  })

  it('omits the session group rather than linking to five screens that can only say "no session"', () => {
    expect(navFor(aggReport({ repo: agg('repo orangu', 12) }), { screen: 'repo' }).find((g) => g.id === 'session')!.items).toEqual([])
  })

  it('keeps the session group in serve, whose first frame can arrive before any analysis does', () => {
    // serve bootstraps AppData with session: undefined when the registry is still empty or the first
    // analysis throws (src/serve/api.ts appData, src/serve/registry.ts analysis), and nothing ever
    // writes d.session afterwards: the pane reads ctx.a, not d.session. Subtracting on "no session"
    // alone would strip the whole group for the life of that page, while defaultScreen still lands on
    // Overview. Only a saved file that is about a scope has no session to observe.
    const bootstrapping = appData({ mode: 'serve', selectedId: undefined, session: undefined, sessions: [] })
    expect(navFor(bootstrapping, { screen: 'overview' }).find((g) => g.id === 'session')!.items.map((i) => i.screen)).toEqual(['overview', 'timeline', 'tools', 'context', 'coverage'])
    const withRow = appData({ mode: 'serve', session: undefined, sessions: [row({ badge: 'live', ageMs: 1000 })] })
    expect(navFor(withRow, { screen: 'overview' }).find((g) => g.id === 'session')!.items).toHaveLength(5)
  })

  it('keeps the unchanged five-item session group when the file has a session', () => {
    const items = navFor(appData(), { screen: 'overview' }).find((g) => g.id === 'session')!.items
    expect(items.map((i) => i.screen)).toEqual(['overview', 'timeline', 'tools', 'context', 'coverage'])
  })

  /** Repo of the Sessions and agents group, and Global and Harness of the This machine group, by screen. */
  const scopeItem = (groups: NavGroup[], screen: 'repo' | 'global' | 'harness') => group(groups, screen === 'repo' ? 'sessions' : 'machine').items.find((i) => i.screen === screen)!

  it('counts the scope the file carries and keeps the hint on the one it does not', () => {
    const groups = navFor(aggReport({ global: agg('global', 103) }), { screen: 'global' })
    expect(scopeItem(groups, 'global').label).toBe('Global · 103 sessions')
    expect(scopeItem(groups, 'global').hint).toBeUndefined()
    expect(scopeItem(groups, 'repo').hint).toBe('needs orangu serve')
    expect(scopeItem(groups, 'harness').hint).toBe('needs orangu serve')
  })

  it('counts both scopes when a session file carries them beside the session (the published sample)', () => {
    const data = { ...appData(), aggregates: { repo: agg('repo checkout-api', 7), global: agg('global (1 root)', 11) } }
    const groups = navFor(data, { screen: 'overview' })
    expect(group(groups, 'session').items.map((i) => i.screen)).toEqual(['overview', 'timeline', 'tools', 'context', 'coverage'])
    expect(scopeItem(groups, 'repo').label).toBe('Repo · 7 sessions')
    expect(scopeItem(groups, 'repo').hint).toBeUndefined()
    expect(scopeItem(groups, 'global').label).toBe('Global · 11 sessions')
    expect(scopeItem(groups, 'global').hint).toBeUndefined()
    expect(scopeItem(groups, 'harness').hint).toBe('needs orangu serve')
  })

  it('leaves the Global label alone when no global aggregate is in the file', () => {
    expect(scopeItem(navFor(appData(), { screen: 'overview' }), 'global').label).toBe('Global · all time')
  })

  it('keeps "Global · all time" in serve, where the count arrives mid-session', () => {
    // serve fetches the global aggregate while the page is open, so counting there would rewrite the
    // label under the reader. The count is a fact about a saved scope file, and fileScope is the one
    // predicate every sessionless subtraction in this function asks.
    const served = appData({ mode: 'serve', aggregates: { global: agg('global', 103) } })
    const item = scopeItem(navFor(served, { screen: 'overview' }), 'global')
    expect(item.label).toBe('Global · all time')
    expect(item.hint).toBeUndefined()
  })
})
