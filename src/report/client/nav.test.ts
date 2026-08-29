import { describe, it, expect } from 'vitest'
import { NAV_GROUPS, SCREEN_IDS, defaultScreen, liveRows, navFor, parseHash, writeHash, type RouteState } from './nav.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { Analysis } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'

/** navFor only reads the subagent run count off the Analysis; the rest of the shape is irrelevant here. */
const analysis = { session: { id: 'abc12345-6789' }, agents: { runs: [] } } as unknown as Analysis

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
  it('has the four design group labels', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Live', 'Observe this session', 'Recurring patterns', 'Improve the next run'])
  })

  it('has the eleven screen ids', () => {
    expect(SCREEN_IDS).toEqual(['live', 'overview', 'timeline', 'tools', 'agents', 'context', 'coverage', 'repo', 'global', 'harness', 'suggest'])
  })

  it('lists Harness under Recurring patterns, serve-only like Repo and Global', () => {
    const file = navFor(appData(), { screen: 'overview' }).find((g) => g.id === 'across')!.items.find((i) => i.screen === 'harness')!
    expect(file.hint).toBe('needs orangu serve')
    const serve = navFor(appData({ mode: 'serve' }), { screen: 'overview' }).find((g) => g.id === 'across')!.items.find((i) => i.screen === 'harness')!
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

  it('hides the Live group in a plain file-mode report even when the row badge says live', () => {
    const snapshot = navFor(appData({ sessions: [row({ badge: 'live', ageMs: 1000 })] }), { screen: 'overview' })
    expect(snapshot.find((g) => g.id === 'live')!.items).toEqual([])
    const watched = navFor(
      appData({ sessions: [row({ badge: 'live', ageMs: 1000 })], capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, watch: true } }),
      { screen: 'overview' },
    )
    expect(watched.find((g) => g.id === 'live')!.items).toHaveLength(1)
  })

  it('hides the Live group when no session is live and shows it when one is', () => {
    const none = navFor(appData(), { screen: 'overview' })
    expect(none.find((g) => g.id === 'live')!.items).toHaveLength(0)
    const live = navFor(appData({ mode: 'serve', sessions: [row({ badge: 'live', ageMs: 1000 })] }), { screen: 'overview' })
    const g = live.find((g) => g.id === 'live')!
    expect(g.items).toHaveLength(1)
    expect(g.items[0]!.label).toContain('Watch')
  })

  it('adds an "All live · N" item when more than one session is live', () => {
    const d = appData({ mode: 'serve', sessions: [row({ id: 'aaaa1111-x', badge: 'live' }), row({ id: 'bbbb2222-y', badge: 'live' })] })
    const g = navFor(d, { screen: 'live' }).find((g) => g.id === 'live')!
    expect(g.items[0]!.label).toBe('All live · 2')
    expect(g.items).toHaveLength(3)
  })
})

// A7: one live array, one count. Every surface (sidebar, header, fleet gate, alt+arrow) reads liveRows().
describe('liveRows / defaultScreen', () => {
  const three = [row({ id: 'aaaa1111-x', badge: 'live' }), row({ id: 'bbbb2222-y', badge: 'live' }), row({ id: 'cccc3333-z', badge: 'live' }), row({ id: 'dddd4444-w', badge: 'idle' })]

  it('is the same array the sidebar counts from', () => {
    const d = appData({ mode: 'serve', sessions: three })
    expect(liveRows(d).map((r) => r.id)).toEqual(['aaaa1111-x', 'bbbb2222-y', 'cccc3333-z'])
    const g = navFor(d, { screen: 'live' }).find((g) => g.id === 'live')!
    expect(g.items[0]!.label).toBe(`All live · ${liveRows(d).length}`)
    expect(g.items).toHaveLength(liveRows(d).length + 1)
  })

  it('is empty in a plain file report (the Track 0 guard) and real for a watch-generated one', () => {
    const snapshot = appData({ sessions: [row({ badge: 'live', ageMs: 1000 })] })
    expect(liveRows(snapshot)).toEqual([])
    expect(navFor(snapshot, { screen: 'overview' }).find((g) => g.id === 'live')!.items).toEqual([])
    const watched = appData({ sessions: [row({ badge: 'live', ageMs: 1000 })], capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, watch: true } })
    expect(liveRows(watched)).toHaveLength(1)
  })

  it('lands an empty hash on the fleet only when serve has more than one live session', () => {
    expect(defaultScreen(appData({ mode: 'serve', sessions: three }))).toBe('live')
    expect(defaultScreen(appData({ mode: 'serve', sessions: [three[0]!, three[3]!] }))).toBe('overview')
    expect(defaultScreen(appData({ sessions: three }))).toBe('overview')
    // parseHash itself is unchanged: an explicit #overview stays overview, an empty hash still parses to overview
    expect(parseHash('#overview').screen).toBe('overview')
    expect(parseHash('').screen).toBe('overview')
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

  it('keeps the unchanged five-item session group when the file has a session', () => {
    const items = navFor(appData(), { screen: 'overview' }).find((g) => g.id === 'session')!.items
    expect(items.map((i) => i.screen)).toEqual(['overview', 'timeline', 'tools', 'context', 'coverage'])
  })

  it('counts the scope the file carries and keeps the hint on the one it does not', () => {
    const across = navFor(aggReport({ global: agg('global', 103) }), { screen: 'global' }).find((g) => g.id === 'across')!
    const item = (screen: string): (typeof across.items)[number] => across.items.find((i) => i.screen === screen)!
    expect(item('global').label).toBe('Global · 103 sessions')
    expect(item('global').hint).toBeUndefined()
    expect(item('repo').hint).toBe('needs orangu serve')
    expect(item('harness').hint).toBe('needs orangu serve')
  })

  it('leaves the Global label alone when no global aggregate is in the file', () => {
    expect(navFor(appData(), { screen: 'overview' }).find((g) => g.id === 'across')!.items.find((i) => i.screen === 'global')!.label).toBe('Global · all time')
  })
})
