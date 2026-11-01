/**
 * The start view of serve (#start): its 3 zoom levels, the designed states of B5 and the session rows of B6. Each state
 * test asserts its words and that no digit shows where a read did not land: a count of a read that runs, failed or did
 * not start is a false claim (src/report/client/history-ui.test.ts:202 is the same rule for History).
 */
import { describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { aggregate, type Aggregate } from '../../analyze/aggregate.js'
import { analyzeSession } from '../../analyze/analyze.js'
import type { HarnessReport } from '../../harness/types.js'
import type { Analysis } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import type { Ctx } from './app.js'
import type { DataSource } from './data.js'
import type { RouteState } from './nav.js'
import type { QueueRead } from './queue-types.js'
import { ms, pct, tok } from './format.js'
import { handoffForInsight, planRows } from './suggest-rows.js'
import { firstHtml, handoffFor, headLineHtml, loadTokens, nextHtml, panelHtml, startHtml, type StartReads } from './start-ui.js'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

/** The canonical fixture session, analyzed, under the id `id`: 2 turns, 1 subagent run and 2 findings. */
async function analysisOf(id = ID): Promise<Analysis> {
  const records = JSON.parse(JSON.stringify(buildCanonicalSession({ cwd: '/w/repo' }).toRecords()).split(ID).join(id)) as Record<string, unknown>[]
  return analyzeSession(await parseClaudeCodeSession({ records, noSidecar: true }), { version: 'test', now: 0 })
}

const A = await analysisOf()
/** The repository and the machine of 2 sessions: the tool error of the fixture recurs in both, so each has 1 cross finding. */
const BOTH = [A, await analysisOf(OTHER)]
const REPO = aggregate(BOTH, 'repo /w/repo', 0)
const MACHINE = aggregate(BOTH, 'global', 0)

function row(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return { id: ID, projectSlug: 'demo', cwd: '/w/repo', title: 'Fix foo test', path: '/tmp/a.jsonl', source: 'claude-code', sizeBytes: 100, mtimeMs: 1_000, badge: 'ended', ageMs: 3 * 86_400_000, possiblyLive: false, tokens: 179_733, agentsTotal: 1, agentsRunning: 0, ...over }
}

function data(over: Partial<AppData> = {}): AppData {
  return {
    v: '1',
    mode: 'serve',
    version: 'test',
    generatedAt: 0,
    capabilities: { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: ID,
    session: A,
    sessions: [row()],
    roots: ['~/.claude'],
    aggregates: {},
    suggestions: [],
    ...over,
  }
}

/** The context of a render of #start; `a` null is a session whose read gave nothing. */
function ctxOf(d: AppData, state: Partial<RouteState> = {}, a: Analysis | null = A): Ctx {
  return { data: d, a: a ?? undefined, ds: {} as DataSource, state: { screen: 'start', s: d.selectedId, ...state }, audience: 'dev', go: vi.fn() }
}

/** A harness report with the fields that the 2 wells read: 7 of 19 skills idle, 2 rules that did not hold, 4 listings. */
function harness(over: { listings?: Array<[string, number]>; broken?: number; record?: number } = {}): HarnessReport {
  const listings = over.listings ?? [['skill_listing', 5_200], ['deferred_tools_delta', 3_100], ['mcp_instructions_delta', 700], ['agent_listing_delta', 417], ['hook_success', 90_000]]
  return {
    inventory: { totals: { skills: 19 }, settings: [{}], skills: [{}], agents: [], plugins: [], mcpServers: [], claudeMd: [] },
    crosswalk: {
      counts: { skills: { used: 12, idle: 7, undeclared: 0 } },
      injectedListings: listings.map(([type, perSession]) => ({ type, approxTokensPerMainSession: perSession })),
    },
    enforcement: { counts: { sessionsWithRecord: over.record ?? 4, rulesBroken: over.broken ?? 2 } },
    scope: { sessionsScanned: 2 },
  } as unknown as HarnessReport
}

const QUEUE = { v: 1, scope: '~/w/repo', now: 0, counts: { verdict: 2, regressed: 0, apply: 1, review: 0, running: 0, wait: 0, due: 2, open: 3 }, groups: {}, globalOpen: 0 } as unknown as QueueRead

const reads = (over: Partial<StartReads> = {}): StartReads => ({
  harness: harness(),
  profile: { exists: true, updatedAt: '2026-11-01' },
  machine: { busy: false },
  repo: { busy: false },
  queue: undefined,
  ...over,
})

/** The text of a markup string: tags out, the 5 entities back, whitespace folded. */
const text = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/** The markup of the first element that starts with `open`, to its own close tag: a nested div does not end it. */
function element(html: string, open: string): string {
  const at = html.indexOf(open)
  if (at < 0) return ''
  const tags = /<(\/?)div\b[^>]*>/g
  tags.lastIndex = at + 1
  let depth = 1
  for (let t = tags.exec(html); t; t = tags.exec(html)) {
    depth += t[1] ? -1 : 1
    if (!depth) return html.slice(at, t.index + t[0].length)
  }
  return html.slice(at)
}

/** The KPI tiles of a panel, '' when it draws none. */
const tiles = (html: string): string => element(html, '<div class="kpis')
/** The 2 wells of the machine panel. */
const wellsOf = (html: string): string => element(html, '<div class="wells')

describe('the head line', () => {
  it('counts the sessions, the running ones and the roots that serve reads, then says local only', () => {
    const d = data({ sessions: [row({ id: 'a1', badge: 'live' }), row({ id: 'a2', badge: 'live' }), row({ id: 'a3' })], roots: ['~/.claude', '~/Library/Application Support/Claude'] })
    expect(text(headLineHtml(d))).toBe('orangu · 3 sessions · 2 running · 2 roots · local only')
    expect(text(headLineHtml(data()))).toBe('orangu · 1 session · 0 running · 1 root · local only')
  })

  it('names no root count when the app read no roots', () => {
    expect(text(headLineHtml(data({ roots: undefined })))).toBe('orangu · 1 session · 0 running · local only')
  })
})

describe('B5: no session at all', () => {
  const html = startHtml(ctxOf(data({ sessions: [], selectedId: undefined, session: undefined, roots: ['~/.claude', '~/Library/Application Support/Claude/local-agent-mode-sessions'] }), {}, null), reads())

  it('says that orangu found none, names each folder it looked in as code, and tells how to start', () => {
    expect(text(html)).toContain('orangu found no sessions on this machine.')
    expect(text(html)).toContain('orangu looked in these 2 folders.')
    expect(html).toContain('<code>~/.claude</code>')
    expect(html).toContain('<code>~/Library/Application Support/Claude/local-agent-mode-sessions</code>')
    expect(text(html)).toContain('Start a session in Claude Code, Cowork or Claude Desktop. Then load this page again.')
  })

  it('draws no zoom tabs, no findings and no Next card, and the head line counts nothing', () => {
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('What to improve first')
    expect(html).not.toContain('Next: improve with Claude')
    expect(text(headLineHtml(data({ sessions: [] })))).toBe('orangu · local only')
    expect(text(headLineHtml(data({ sessions: [] })))).not.toMatch(/\d/)
  })

  it('says "this folder" for 1 root, and names no folder when the app read no roots', () => {
    const one = startHtml(ctxOf(data({ sessions: [], session: undefined, roots: ['~/.claude'] }), {}, null), reads())
    expect(text(one)).toContain('orangu looked in this folder.')
    const none = startHtml(ctxOf(data({ sessions: [], session: undefined, roots: undefined }), {}, null), reads())
    expect(none).not.toContain('looked in')
    expect(none).not.toContain('<code>')
  })
})

describe('the zoom tabs', () => {
  it('is a tablist of 3 tabs that control the 1 panel, with the default zoom selected and the only tab stop', () => {
    const html = startHtml(ctxOf(data()), reads())
    expect(html).toContain('role="tablist" aria-label="Zoom"')
    const tabs = [...html.matchAll(/<button class="ztab" role="tab"[^>]*>([^<]*)<\/button>/g)]
    expect(tabs.map((m) => m[1])).toEqual(['One session', 'Sessions and agents', 'This machine'])
    for (const [tab] of tabs) expect(tab).toContain('aria-controls="start-panel"')
    expect(tabs.map(([tab]) => /aria-selected="true"/.test(tab))).toEqual([true, false, false])
    expect(tabs.map(([tab]) => /tabindex="0"/.test(tab))).toEqual([true, false, false])
    expect(html).toContain('id="start-panel" role="tabpanel" aria-labelledby="zt-session"')
  })

  it('selects the sessions and their agents when more than 1 session is live, and the zoom of the hash over the default', () => {
    const fleet = data({ sessions: [row({ id: 'a1', badge: 'live' }), row({ id: 'a2', badge: 'live' })] })
    expect(startHtml(ctxOf(fleet), reads())).toContain('id="start-panel" role="tabpanel" aria-labelledby="zt-sessions"')
    expect(startHtml(ctxOf(fleet, { zoom: 'machine' }), reads())).toContain('id="start-panel" role="tabpanel" aria-labelledby="zt-machine"')
  })
})

describe('One session', () => {
  it('shows the running session: its title, outcome, 4 tiles, the running agents and both links, through the hash writer', () => {
    const d = data({ sessions: [row({ badge: 'live', ageMs: 1_000, agentsRunning: 1 })] })
    const html = panelHtml(ctxOf(d, { theme: 'dark' }), reads())
    expect(text(html)).toContain('Running now')
    expect(html).toContain('<span class="ldot" data-pulse="1" aria-hidden="true"></span>')
    expect(text(html)).toContain('Fix foo test')
    expect(text(html)).toContain('1 file changed · 1 of 2 test runs failed')
    expect(text(tiles(html))).toBe('Turns 2 Tokens 180k Active time 13s Agents 1 1 running')
    expect(html).toContain(`href="#overview?s=${ID}&amp;theme=dark">Open the session</a>`)
    expect(html).toContain(`href="#agents?s=${ID}&amp;theme=dark">Open its agents</a>`)
  })

  it('B5 no live session: shows the latest session with the hollow dot, says no session runs, and no running hint', () => {
    const html = panelHtml(ctxOf(data()), reads())
    expect(text(html)).toContain('Latest session')
    expect(text(html)).toContain('No session runs now. This shows the latest session.')
    expect(html).toContain('<span class="ldot hollow" aria-hidden="true"></span>')
    expect(html).not.toContain('data-pulse')
    expect(text(html)).not.toContain('running')
  })

  it('names a session that is not the latest and not running "Selected session", with no claim about the others', () => {
    const d = data({ sessions: [row({ id: OTHER, mtimeMs: 9_000, title: 'Newer work' }), row()] })
    const html = panelHtml(ctxOf(d, { s: ID }), reads())
    expect(text(html)).toContain('Selected session')
    expect(text(html)).not.toContain('Latest session')
    expect(text(html)).not.toContain('No session runs now')
  })

  it('offers no agents link for a session with no agent', async () => {
    const solo = { ...A, agents: { ...A.agents, runs: [] } } as Analysis
    expect(panelHtml(ctxOf(data(), {}, solo), reads())).not.toContain('Open its agents')
  })

  it('says that orangu could not read the session, and shows no tile, when its read gave nothing', () => {
    const html = panelHtml(ctxOf(data(), {}, null), reads())
    expect(text(html)).toContain('orangu could not read this session.')
    expect(tiles(html)).toBe('')
  })
})

describe('Sessions and agents', () => {
  const fleet = (): AppData =>
    data({
      sessions: [
        row({ id: 'old00001', title: 'Old work', mtimeMs: 10, ageMs: 5 * 86_400_000, tokens: undefined, agentsTotal: undefined }),
        row({ id: 'run00001', title: 'Running orchestrator', mtimeMs: 900, badge: 'live', ageMs: 2_000, agentsTotal: 3, agentsRunning: 2 }),
        row({ id: 'new00001', title: 'Newest ended', mtimeMs: 800, ageMs: 40 * 60_000, agentsTotal: 0 }),
        row({ id: 'run00002', title: 'Running solo', mtimeMs: 950, badge: 'live', ageMs: 1_000, agentsTotal: 0 }),
      ],
    })

  it('lists the running sessions first, then the newest, each row 1 link through the hash writer', () => {
    const html = panelHtml(ctxOf(fleet(), { zoom: 'sessions', theme: 'dark' }), reads())
    expect(text(html)).toContain('4 sessions. Running sessions come first, then the newest.')
    const hrefs = [...html.matchAll(/<a class="srow" href="([^"]*)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(['#overview?s=run00002&amp;theme=dark', '#agents?s=run00001&amp;theme=dark', '#overview?s=new00001&amp;theme=dark', '#overview?s=old00001&amp;theme=dark'])
  })

  it('B6: a row with agents says orchestrator and the count, the running count only when live, and a row with none says nothing', () => {
    const html = panelHtml(ctxOf(fleet(), { zoom: 'sessions' }), reads())
    const rows = [...html.matchAll(/<a class="srow"[^>]*>(.*?)<\/a>/g)].map((m) => text(m[1]!))
    expect(rows[1]).toContain('orchestrator · 3 agents, 2 running')
    expect(rows[0]).not.toMatch(/orchestrator|agent/)
    expect(rows[2]).not.toMatch(/orchestrator|agent/)
    const ended = panelHtml(ctxOf(data({ sessions: [row({ agentsTotal: 3, agentsRunning: 2 })] }), { zoom: 'sessions' }), reads())
    expect(text(ended)).toContain('orchestrator · 3 agents')
    expect(text(ended)).not.toContain('running')
  })

  it('shows "running" for a live row and the age for the others, and no token count that the row did not measure', () => {
    const html = panelHtml(ctxOf(fleet(), { zoom: 'sessions' }), reads())
    const rows = [...html.matchAll(/<a class="srow"[^>]*>(.*?)<\/a>/g)].map((m) => text(m[1]!))
    expect(rows[0]).toContain('running')
    expect(rows[2]).toContain('40m ago')
    // the project as the picker and the live items name it: the project slug, not the folder
    expect(rows[3]).toBe('Old work demo 5d ago')
  })

  it('links all live sessions to the fleet, with no session in the hash, and this repository to the selected session', () => {
    const html = panelHtml(ctxOf(fleet(), { zoom: 'sessions', s: 'new00001', theme: 'dark' }), reads())
    expect(html).toContain('href="#live?theme=dark">All live sessions</a>')
    expect(html).toContain('href="#repo?s=new00001&amp;theme=dark">This repository</a>')
  })

  it('B5 no live session: says no session runs, draws no live dot, shows an age on each row, and offers no fleet link', () => {
    const d = data({ sessions: [row({ id: 'x1', ageMs: 40 * 60_000 }), row({ id: 'x2', mtimeMs: 10, ageMs: 3 * 86_400_000 })] })
    const html = panelHtml(ctxOf(d, { zoom: 'sessions' }), reads())
    expect(text(html)).toContain('No session runs now. The newest session comes first.')
    expect(html).not.toContain('data-pulse')
    expect(text(html)).not.toContain('running')
    expect(text(html)).toContain('40m ago')
    expect(text(html)).toContain('3d ago')
    expect(html).not.toContain('All live sessions')
    expect(html).toContain('This repository')
  })

  it('stops at the running sessions and the 20 newest, and says so', () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ id: `s${String(i).padStart(7, '0')}`, mtimeMs: 1_000 - i, title: `Session ${i}` }))
    many.push(row({ id: 'live0001', badge: 'live', mtimeMs: 5_000 }))
    const html = panelHtml(ctxOf(data({ sessions: many }), { zoom: 'sessions' }), reads())
    const [shown, all] = [1 + 20, many.length]
    expect([...html.matchAll(/<a class="srow"/g)]).toHaveLength(shown)
    expect(text(html)).toContain(`This list shows ${shown} of ${all} sessions. They are the running sessions and the 20 newest.`)
    expect(panelHtml(ctxOf(data(), { zoom: 'sessions' }), reads())).not.toContain('This list shows')
  })
})

describe('This machine', () => {
  const withGlobal = (): AppData => data({ sessions: [row(), row({ id: OTHER })], aggregates: { global: MACHINE } })

  it('shows the 4 totals of the global read, the 2 wells and both links', () => {
    const html = panelHtml(ctxOf(withGlobal(), { zoom: 'machine', theme: 'dark' }), reads())
    expect(text(html)).toContain('All 2 sessions on this machine.')
    expect(text(tiles(html))).toBe(`Sessions 2 Tokens ${tok(MACHINE.totals.tokens)} Read from cache ${pct(MACHINE.averages.cacheHitRatio)} average per session Active time ${ms(MACHINE.totals.activeMs)}`)
    expect(tok(MACHINE.totals.tokens)).toBe('359k')
    expect(text(html)).toContain('What your sessions load About 9,400 tokens of skill, agent and MCP tool listings in each session.')
    expect(text(html)).toContain('Harness 7 of 19 skills never fired · 2 rules did not hold')
    expect(html).toContain('href="#global?s=' + ID + '&amp;theme=dark">Open the machine report</a>')
    expect(html).toContain('href="#harness?s=' + ID + '&amp;theme=dark">Open the harness</a>')
  })

  it('says how many sessions the read covered when it read fewer than the app lists', () => {
    const d = data({ sessions: [row(), row({ id: OTHER }), row({ id: 'c3' })], aggregates: { global: MACHINE } })
    expect(text(panelHtml(ctxOf(d, { zoom: 'machine' }), reads()))).toContain('orangu read 2 of 3 sessions on this machine.')
  })

  it('B5 a read in progress: says how far the read is from the 202 body, draws a bar and skeleton tiles, and no total', () => {
    const html = panelHtml(ctxOf(data(), { zoom: 'machine' }), reads({ machine: { busy: true, done: 4, total: 11 } }))
    expect(text(html)).toContain('Reading 4 of 11 sessions.')
    expect(text(html)).toContain('orangu shows the totals when the read ends.')
    expect(html).toContain('role="progressbar" aria-label="Sessions read" aria-valuemin="0" aria-valuemax="11" aria-valuenow="4"')
    expect(html).toContain('aria-busy="true"')
    expect(tiles(html)).toContain('kpi skel')
    expect(text(tiles(html))).not.toMatch(/\d/)
  })

  it('B5 a read in progress before its first progress: no number at all', () => {
    const html = panelHtml(ctxOf(data(), { zoom: 'machine' }), reads({ machine: { busy: true } }))
    expect(text(html)).toContain('orangu reads the sessions of this machine.')
    expect(html).not.toContain('aria-valuenow')
    expect(text(tiles(html))).not.toMatch(/\d/)
  })

  it('B5 a failed read: an alert, the reason in mono, Read again and the machine report, and no tile', () => {
    const html = panelHtml(ctxOf(data(), { zoom: 'machine' }), reads({ machine: { busy: false, failed: 'aggregate capacity reached' } }))
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('The read failed. orangu shows no totals for this machine.')
    expect(html).toContain('<code>aggregate capacity reached</code>')
    expect(html).toContain('data-start-read')
    expect(text(html)).toContain('Read again')
    expect(text(html)).toContain('Open the machine report')
    expect(tiles(html)).toBe('')
  })

  it('B5 no harness data: both wells say so, with no harness number, and the harness link stays', () => {
    const html = panelHtml(ctxOf(withGlobal(), { zoom: 'machine' }), reads({ harness: null }))
    const wells = wellsOf(html)
    expect(text(wells).split('orangu has no harness data for this machine yet.')).toHaveLength(3)
    expect(text(wells)).not.toMatch(/\d/)
    expect(text(html)).toContain('Open the harness')
  })

  it('says that orangu reads the harness while its first read runs, with no number', () => {
    const wells = wellsOf(panelHtml(ctxOf(withGlobal(), { zoom: 'machine' }), reads({ harness: undefined })))
    expect(text(wells)).toContain('orangu reads the harness of this machine.')
    expect(text(wells)).not.toMatch(/\d/)
  })

  it('says that orangu measured no listing, with no digit, when the report has no row of the 4 types', () => {
    const wells = wellsOf(panelHtml(ctxOf(withGlobal(), { zoom: 'machine' }), reads({ harness: harness({ listings: [['hook_success', 90_000]] }) })))
    const load = element(wells, '<div class="well">')
    expect(text(load)).toBe('What your sessions load orangu measured no skill or tool listings in these sessions.')
    expect(text(load)).not.toMatch(/\d/)
  })

  it('names no broken rule when no session recorded the files it loaded, so orangu could not check a rule', () => {
    const html = panelHtml(ctxOf(withGlobal(), { zoom: 'machine' }), reads({ harness: harness({ record: 0 }) }))
    expect(text(html)).toContain('Harness 7 of 19 skills never fired')
    expect(text(html)).not.toContain('did not hold')
  })
})

describe('what your sessions load', () => {
  it('sums the 4 listing types per session and rounds to 2 significant digits', () => {
    expect(loadTokens(harness())).toBe(9_400)
    expect(loadTokens(harness({ listings: [['skill_listing', 449]] }))).toBe(450)
    expect(loadTokens(harness({ listings: [['skill_listing', 12_345], ['mcp_instructions_delta', 10]] }))).toBe(12_000)
    expect(loadTokens(harness({ listings: [['hook_success', 9_000]] }))).toBeUndefined()
  })
})

describe('What to improve first', () => {
  it('shows the first 3 findings of the session, each with its saving, where, improvement and the improve command', () => {
    const html = firstHtml(ctxOf(data()), reads())
    expect(text(html)).toContain('What to improve first')
    expect(text(html)).toContain('orangu found these with no model. Each line shows the change to make.')
    expect(text(html)).toContain('In this session · tool-errors')
    expect(text(html)).toContain('Improvement:')
    expect(html).toContain('claude &quot;/orangu:improve sg_')
  })

  it('copies the same command for a finding as the Overview does', () => {
    for (const insight of A.insights) {
      const row = planRows('session', A, undefined).find((r) => r.insightId === insight.id)!
      expect(handoffFor(row, 'session')).toBe(handoffForInsight(insight, A.session.id).command)
    }
  })

  it('shows the recurring findings of the repository at the sessions zoom, with the example caption', () => {
    const html = firstHtml(ctxOf(data({ aggregates: { repo: REPO } }), { zoom: 'sessions' }), reads())
    expect(text(html)).toContain('Each title shows the figures of one example session.')
    expect(text(html)).toContain('In 2 sessions in this repository · tool-errors')
    expect(html).toContain('claude &quot;/orangu:improve sg_')
  })

  it('shows the recurring findings of the machine at the machine zoom', () => {
    const html = firstHtml(ctxOf(data({ aggregates: { global: MACHINE } }), { zoom: 'machine' }), reads())
    expect(text(html)).toContain('In 2 sessions on this machine · tool-errors')
  })

  it('reads no repository aggregate of another folder: a repository read of another cwd counts as no read', () => {
    const other = aggregate(BOTH, 'repo /w/other', 0)
    const html = firstHtml(ctxOf(data({ aggregates: { repo: other } }), { zoom: 'sessions' }), reads())
    expect(text(html)).not.toContain('in this repository ·')
    expect(text(html)).toContain('orangu shows the findings when the read ends.')
  })

  it('B5 no finding: says that orangu found nothing to improve, for each zoom', () => {
    const clean = { ...A, insights: [] } as Analysis
    expect(text(firstHtml(ctxOf(data(), {}, clean), reads()))).toContain('orangu found nothing to improve in this session.')
    const none = { ...MACHINE, crossFindings: [] } as Aggregate
    expect(text(firstHtml(ctxOf(data({ aggregates: { repo: { ...none, scope: 'repo /w/repo' } } }), { zoom: 'sessions' }), reads()))).toContain('orangu found nothing to improve in this repository.')
    expect(text(firstHtml(ctxOf(data({ aggregates: { global: none } }), { zoom: 'machine' }), reads()))).toContain('orangu found nothing to improve on this machine.')
  })

  it('shows no finding and no number while the read of the zoom runs or after it failed', () => {
    const running = firstHtml(ctxOf(data(), { zoom: 'machine' }), reads({ machine: { busy: true, done: 1, total: 2 } }))
    expect(text(running)).toContain('orangu shows the findings when the read ends.')
    expect(running).not.toContain('/orangu:improve sg_')
    const failed = firstHtml(ctxOf(data(), { zoom: 'machine' }), reads({ machine: { busy: false, failed: 'gone' } }))
    expect(text(failed)).toContain('The read failed, so orangu shows no findings.')
  })

  it('shows the queue banner only when the queue has due items, with its link through the hash writer', () => {
    const html = firstHtml(ctxOf(data(), { theme: 'dark' }), reads({ queue: QUEUE }))
    expect(text(html)).toContain('2 changes are due for a check. 1 is ready to apply.')
    expect(html).toContain('href="#suggest?s=' + ID + '&amp;theme=dark">Open Improvements</a>')
    const quiet = { ...QUEUE, counts: { ...QUEUE.counts, due: 0, apply: 0 } } as QueueRead
    const applyOnly = { ...QUEUE, counts: { ...QUEUE.counts, due: 0, apply: 1 } } as QueueRead
    for (const queue of [undefined, null, quiet, applyOnly]) expect(firstHtml(ctxOf(data()), reads({ queue }))).not.toContain('Open Improvements')
    const oneDue = { ...QUEUE, counts: { ...QUEUE.counts, due: 1, apply: 0 } } as QueueRead
    expect(text(firstHtml(ctxOf(data()), reads({ queue: oneDue })))).toContain('1 change is due for a check. Open Improvements')
  })

  it('links to every finding when it shows only the first 3', () => {
    const many = { ...A, insights: [...A.insights, ...A.insights.map((i) => ({ ...i, id: i.id + '-b' }))] } as Analysis
    const html = firstHtml(ctxOf(data(), {}, many), reads())
    expect(html.match(/data-copy="claude &quot;\/orangu:improve sg_/g)).toHaveLength(3)
    expect(text(html)).toContain('Open all 4 improvements')
  })
})

describe('the queue read on #start', () => {
  it('starts the queue read of home-ui.ts on #start, so the banner can count the items that are due', async () => {
    vi.resetModules()
    const { ensureQueue, queueRead } = await import('./home-ui.js')
    const queue = vi.fn(async () => QUEUE)
    const loaded = vi.fn()
    ensureQueue({ queue, subscribe: () => () => {} } as unknown as DataSource, { screen: 'start' }, loaded)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue).toHaveBeenCalledOnce()
    expect(queueRead()).toEqual(QUEUE)
    expect(loaded).toHaveBeenCalled()
  })
})

describe('Next: improve with Claude', () => {
  it('names the improve command with a copy control and the 3 list lines', () => {
    const html = nextHtml({ exists: true, updatedAt: '2026-11-01' })
    expect(html).toContain('<p>In Claude Code, run <code>/orangu:improve</code>.</p>')
    expect(html).toContain('data-copy="/orangu:improve"')
    for (const line of ['It reads this evidence, finds patterns and proposes changes.', 'You approve each change by its id.', 'Run /orangu:interview to change your answers.']) expect(text(html)).toContain(line)
  })

  it('shows the date of the interview, or "not yet" when no profile exists, with the 3 list lines in each state', () => {
    expect(nextHtml({ exists: true, updatedAt: '2026-11-01' })).toContain('<span class="tag good">Interview: done on 2026-11-01.</span>')
    const none = nextHtml({ exists: false, updatedAt: null })
    expect(none).toContain('<span class="tag neutral">Interview: not yet.</span>')
    expect(text(none)).toContain('Run /orangu:interview to change your answers.')
  })

  it('says that orangu cannot read the answers when a file exists that does not read as a profile, and names no date', () => {
    const html = nextHtml({ exists: true, updatedAt: null })
    expect(html).toContain('<span class="tag warn">Interview: orangu cannot read your answers.</span>')
    expect(text(html)).not.toContain('done on')
  })

  it('says that the status read failed, and draws no tag while the first read runs', () => {
    expect(text(nextHtml(null))).toContain('Interview: orangu could not read the status.')
    expect(nextHtml(undefined)).not.toContain('class="tag')
  })

  it('takes no date that is not a day, so a broken body shows no number', () => {
    const html = nextHtml({ exists: true, updatedAt: '<b>99</b>' } as never)
    expect(html).not.toContain('99')
    expect(html).toContain('Interview: orangu cannot read your answers.')
  })
})
