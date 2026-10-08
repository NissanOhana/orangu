/**
 * A label cell that CSS can cut with an ellipsis carries its whole text in a title, so a pointer shows the rest.
 * One case for each rule in styles.css (or charts.ts) that cuts a label with no other way to read it: the agent
 * lane label (`.swimrow .alabel`, Agents and Live), the label of a proportion row (charts.ts, Agents and
 * Context), the tool name of a raw call (`.rawrow .rt`, Coverage) and `.ellip` (the re-read paths and the
 * session titles, Repo and Global). Each label here is hostile: the title goes through esc, as the text does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../analyze/analyze.js'
import { aggregate } from '../../analyze/aggregate.js'
import type { AgentStat, Analysis } from '../../model/analysis.js'
import type { AppData } from '../../model/app-data.js'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import type { Ctx } from './app.js'
import { proportionRows } from './charts.js'
import { renderCoverage } from './screens/coverage.js'
import { laneHtml } from './screens/live.js'
import { renderRepo } from './screens/repo.js'

const HOSTILE = `<img src=x onerror=alert(1)> "quoted" & 'single'`

const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** The title and the shown text of each `<tag class="cls" …>…</tag>` in the markup (the class first, as the builders write it). */
function cells(html: string, tag: string, cls: string): Array<{ title: string | undefined; text: string }> {
  return [...html.matchAll(new RegExp(`<${tag} class="${cls}"([^>]*)>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => {
    const title = /\btitle="([^"]*)"/.exec(m[1]!)?.[1]
    return { title: title === undefined ? undefined : unescape(title), text: unescape(m[2]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() }
  })
}

/** Each cell's title equals its text, and the markup never carries the hostile text as markup. */
function expectTitleIsText(html: string, found: Array<{ title: string | undefined; text: string }>, where: string): void {
  expect(found.length, `${where}: cells`).toBeGreaterThan(0)
  expect(found.map((c) => c.title), where).toEqual(found.map((c) => c.text))
  expect(html, `${where}: the hostile text is markup`).not.toContain('<img')
}

async function analysis(): Promise<Analysis> {
  return analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 'test', now: 0 })
}

function fileData(over: Partial<AppData>): AppData {
  return {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: true },
    selectedId: undefined, session: undefined, sessions: [], aggregates: {}, suggestions: [], ...over,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a label cell that an ellipsis can cut carries its whole text in a title', () => {
  it('the agent lane label: the depth marks, the agent and its model', () => {
    const run = { agentId: 'agent-0001-long-id', agentType: HOSTILE, model: 'claude-opus-5-5', spawnDepth: 2, messageCount: 0, toolCallCount: 0, toolErrors: 0, totalTokens: 0, hasTranscript: true } as unknown as AgentStat
    const html = laneHtml(run, 0, 1)
    const found = cells(html, 'div', 'alabel')
    expectTitleIsText(html, found, 'lane')
    expect(found[0]!.title).toBe(`· · ${HOSTILE} claude-opus-5-5`)
    // no model and no type: the id prefix alone, with no trailing space in the title
    const bare = cells(laneHtml({ ...run, agentType: undefined, model: undefined, spawnDepth: 0 }, 0, 1), 'div', 'alabel')
    expect(bare).toEqual([{ title: 'agent-0001', text: 'agent-0001' }])
  })

  it('the label of a proportion row, with its muted part', () => {
    const html = proportionRows(
      [
        { label: HOSTILE, value: 2, color: 'var(--cat-agent)', sub: '×3' },
        { label: 'Claude Opus 5', value: 1, color: 'var(--cat-edit)', sub: '' },
      ],
      String,
    )
    const found = cells(html, 'div', 'small')
    expectTitleIsText(html, found, 'proportion rows')
    expect(found.map((c) => c.title)).toEqual([`${HOSTILE} ×3`, 'Claude Opus 5'])
  })

  it('the tool name of each raw call on Coverage', async () => {
    const a = await analysis()
    a.tools.calls[0]!.name = HOSTILE
    let list = ''
    const stubEl = { addEventListener: () => {}, set innerHTML(value: string) { list = value }, textContent: '', value: '', checked: false }
    vi.stubGlobal('document', { createElement: () => ({ content: { firstElementChild: { querySelector: () => stubEl } }, set innerHTML(_v: string) {} }) })
    renderCoverage({ data: fileData({ selectedId: a.session.id, session: a }), a, ds: {} as Ctx['ds'], state: { screen: 'coverage', s: a.session.id }, audience: 'dev', go: vi.fn() })
    const found = cells(list, 'span', 'rt')
    expectTitleIsText(list, found, 'raw calls')
    expect(found).toHaveLength(a.tools.calls.length)
    expect(found[0]!.title).toBe(HOSTILE)
  })

  it('the re-read paths and the session titles on Repo', async () => {
    const g = aggregate([await analysis()], 'repo', 0)
    g.topReReadFiles = [{ path: HOSTILE, sessions: 2, totalReads: 9 }, { path: 'src/report/client/screens/a-long-folder-name/agents.test.ts', sessions: 3, totalReads: 12 }]
    g.topSessions[0]!.title = HOSTILE
    let markup = ''
    vi.stubGlobal('document', { createElement: () => ({ content: { firstElementChild: {} }, set innerHTML(value: string) { markup = value } }) })
    renderRepo({ data: fileData({ capabilities: { live: false, aggregates: true, kickoffRun: false, exportHtml: true, includeText: true }, aggregates: { repo: g } }), ds: {} as Ctx['ds'], state: { screen: 'repo' }, audience: 'dev', go: vi.fn() })
    const paths = cells(markup, 'span', 'mono grow ellip')
    expectTitleIsText(markup, paths, 're-read paths')
    expect(paths.map((c) => c.title)).toEqual([HOSTILE, 'src/report/client/screens/a-long-folder-name/agents.test.ts'])
    const titles = cells(markup, 'td', 'ellip')
    expectTitleIsText(markup, titles, 'session titles')
    expect(titles[0]!.title).toBe(HOSTILE)
  })
})
