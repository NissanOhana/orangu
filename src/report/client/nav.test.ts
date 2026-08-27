import { describe, it, expect } from 'vitest'
import { NAV_GROUPS, SCREEN_IDS, navFor, parseHash, writeHash, type RouteState } from './nav.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'

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
    sessions: [row()],
    aggregates: {},
    suggestions: [],
    ...over,
  }
}

describe('nav model', () => {
  it('has the four design group labels', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Live', 'Observe this session', 'Recurring patterns', 'Improve the next run'])
  })

  it('has the ten screen ids', () => {
    expect(SCREEN_IDS).toEqual(['live', 'overview', 'timeline', 'tools', 'agents', 'context', 'coverage', 'repo', 'global', 'suggest'])
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
