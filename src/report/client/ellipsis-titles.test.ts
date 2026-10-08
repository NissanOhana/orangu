/**
 * An element that CSS can cut with an ellipsis carries its whole text in a title, so a pointer shows the rest.
 * One case for each builder of such an element: the agent lane label (`.swimrow .alabel`), the label of a
 * proportion row (charts.ts), the Timeline row text (`.tprompt`) and call summary (`.evline .ew`), the tool name
 * and the summary of a raw call (`.rawrow .rt`, `.rawrow .rp`), `.ellip` and `.sigline` on Repo, the Live feed
 * (`.feedrow .fw`), and the serve-only fleet card (`.fleetcard .proj`, `.fleetcard .fl`), fleet feed and session
 * picker (`.picklist .proj`). The browser test checks every cut element of both samples, and the serve-only ones
 * are here. Each text is hostile: the title goes through esc, as the text does. The whole text of an element is its
 * words, with a space where one element ends and the next begins, as in the browser test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../analyze/analyze.js'
import { aggregate } from '../../analyze/aggregate.js'
import type { AgentStat, Analysis } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import type { Ctx } from './app.js'
import { proportionRows } from './charts.js'
import { renderCoverage } from './screens/coverage.js'
import { laneHtml, renderLive } from './screens/live.js'
import { renderRepo } from './screens/repo.js'
import { renderTimeline } from './screens/timeline.js'

const HOSTILE = `<img src=x onerror=alert(1)> "quoted" & 'single'`

const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

interface Cell { title: string | undefined; text: string }

/** The title and the whole text of each `<tag class="cls" …>…</tag>` in the markup (the class first, as the builders write it). */
function cells(html: string, tag: string, cls: string): Cell[] {
  const out: Cell[] = []
  for (const m of html.matchAll(new RegExp(`<${tag} class="${cls}"([^>]*)>`, 'g'))) {
    const from = m.index! + m[0].length
    // the element ends where its own close tag brings the depth back to 0: a nested tag of the same name does not end it
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g')
    tags.lastIndex = from
    let depth = 1
    let to = html.length
    for (let t = tags.exec(html); t; t = tags.exec(html)) {
      depth += t[1] ? -1 : 1
      if (!depth) {
        to = t.index
        break
      }
    }
    const title = /\btitle="([^"]*)"/.exec(m[1]!)?.[1]
    out.push({ title: title === undefined ? undefined : unescape(title), text: unescape(html.slice(from, to).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() })
  }
  return out
}

/** Each element's title equals its whole text, and the markup never carries the hostile text as markup. */
function expectTitleIsText(html: string, found: Cell[], where: string): void {
  expect(found.length, `${where}: elements`).toBeGreaterThan(0)
  expect(found.map((c) => c.title), where).toEqual(found.map((c) => c.text))
  expect(html, `${where}: the hostile text is markup`).not.toContain('<img src=x')
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

/** document.createElement as h() and innerHTML use it: every markup string the screen writes lands in `writes`. */
function captureMarkup(): string[] {
  const writes: string[] = []
  const node = { addEventListener: () => {}, set innerHTML(value: string) { writes.push(value) }, textContent: '', value: '', checked: false, querySelectorAll: () => [], querySelector: (): unknown => node }
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => ({ content: { firstElementChild: node }, set innerHTML(value: string) { writes.push(value) } }),
  })
  return writes
}

function sessionRow(over: Partial<SessionSummaryRow>): SessionSummaryRow {
  return { id: 'abc12345-6789', projectSlug: 'demo', path: '/tmp/abc.jsonl', source: 'claude-code', sizeBytes: 1, mtimeMs: 0, badge: 'live', ageMs: 1000, possiblyLive: true, ...over }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an element that an ellipsis can cut carries its whole text in a title', () => {
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

  it('the Timeline row text (its kind and the whole prompt) and each call summary', async () => {
    const a = await analysis()
    a.turns.find((t) => t.kind === 'human')!.promptPreview = HOSTILE
    a.tools.calls[0]!.summary = HOSTILE
    const writes = captureMarkup()
    renderTimeline({ data: fileData({ selectedId: a.session.id, session: a }), a, ds: {} as Ctx['ds'], state: { screen: 'timeline', s: a.session.id }, audience: 'dev', go: vi.fn() })
    const html = writes.join('')
    const rows = cells(html, 'span', 'tprompt')
    expectTitleIsText(html, rows, 'Timeline rows')
    expect(rows.map((c) => c.title)).toContain(`human ${HOSTILE}`)
    const calls = cells(html, 'span', 'ew')
    expectTitleIsText(html, calls, 'Timeline calls')
    expect(calls.map((c) => c.title)).toContain(HOSTILE)
  })

  it('the tool name and the summary of each raw call on Coverage', async () => {
    const a = await analysis()
    a.tools.calls[0]!.name = HOSTILE
    a.tools.calls[0]!.summary = HOSTILE
    const writes = captureMarkup()
    renderCoverage({ data: fileData({ selectedId: a.session.id, session: a }), a, ds: {} as Ctx['ds'], state: { screen: 'coverage', s: a.session.id }, audience: 'dev', go: vi.fn() })
    const list = writes.find((w) => w.includes('class="rawrow"')) ?? ''
    const names = cells(list, 'span', 'rt')
    expectTitleIsText(list, names, 'raw call names')
    expect(names).toHaveLength(a.tools.calls.length)
    expect(names[0]!.title).toBe(HOSTILE)
    const summaries = cells(list, 'span', 'rp')
    expectTitleIsText(list, summaries, 'raw call summaries')
    expect(summaries).toHaveLength(a.tools.calls.length)
    expect(summaries[0]!.title!.startsWith(HOSTILE)).toBe(true)
  })

  it('the re-read paths, the error signatures and the session titles on Repo', async () => {
    const g = aggregate([await analysis()], 'repo', 0)
    g.topReReadFiles = [{ path: HOSTILE, sessions: 2, totalReads: 9 }, { path: 'src/report/client/screens/a-long-folder-name/agents.test.ts', sessions: 3, totalReads: 12 }]
    g.recurringErrors = [{ signature: HOSTILE, tool: 'Bash', sessions: 2, total: 3 }]
    g.topSessions[0]!.title = HOSTILE
    const writes = captureMarkup()
    renderRepo({ data: fileData({ capabilities: { live: false, aggregates: true, kickoffRun: false, exportHtml: true, includeText: true }, aggregates: { repo: g } }), ds: {} as Ctx['ds'], state: { screen: 'repo' }, audience: 'dev', go: vi.fn() })
    const markup = writes.join('')
    const paths = cells(markup, 'span', 'mono grow ellip')
    expectTitleIsText(markup, paths, 're-read paths')
    expect(paths.map((c) => c.title)).toEqual([HOSTILE, 'src/report/client/screens/a-long-folder-name/agents.test.ts'])
    const signatures = cells(markup, 'span', 'sigline')
    expectTitleIsText(markup, signatures, 'error signatures')
    expect(signatures.map((c) => c.title)).toEqual([HOSTILE])
    const titles = cells(markup, 'td', 'ellip')
    expectTitleIsText(markup, titles, 'session titles')
    expect(titles[0]!.title).toBe(HOSTILE)
  })

  it('each event of the Live feed', async () => {
    const a = await analysis()
    for (const c of a.tools.calls) c.summary = HOSTILE
    const writes = captureMarkup()
    vi.stubGlobal('location', { hash: '' })
    const data = fileData({ capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: true, watch: true }, sessions: [sessionRow({})] })
    renderLive({ data, a, ds: {} as Ctx['ds'], state: { screen: 'live' }, audience: 'dev', go: vi.fn() } as unknown as Ctx)
    const html = writes.join('')
    const events = cells(html, 'span', 'fw')
    expectTitleIsText(html, events, 'Live feed')
    expect(events.map((c) => c.title)).toContain(HOSTILE)
  })

  it('serve only: the fleet card project and last event, the fleet feed and the session picker', async () => {
    // fleetView reaches the shell through window.__ORANGU_FLEET__, which serve-ui sets when it loads
    const win: Record<string, unknown> = {}
    vi.stubGlobal('window', win)
    const { serveUi } = await import('./serve-ui.js')
    const fleetView = win['__ORANGU_FLEET__'] as (ctx: Ctx, live: SessionSummaryRow[]) => HTMLElement
    const rows = [
      sessionRow({ id: 'aaaaaaaa-1', projectSlug: HOSTILE, mtimeMs: 2, lastEvent: { name: 'Bash', category: 'exec', summary: HOSTILE }, lastEvents: [{ ts: 1, name: 'Bash', category: 'exec', summary: HOSTILE }] } as Partial<SessionSummaryRow>),
      sessionRow({ id: 'bbbbbbbb-2', projectSlug: 'a-project-slug-that-is-long-enough-to-cut', mtimeMs: 1 }),
    ]
    const writes = captureMarkup()
    fleetView({ data: fileData({ mode: 'serve', sessions: rows }), ds: {} as Ctx['ds'], state: { screen: 'live' }, audience: 'dev', go: vi.fn() } as unknown as Ctx, rows)
    const fleet = writes.join('')
    const projects = cells(fleet, 'span', 'proj')
    expectTitleIsText(fleet, projects, 'fleet card projects')
    expect(projects.map((c) => c.title)).toContain(HOSTILE)
    const last = cells(fleet, 'div', 'fl')
    expectTitleIsText(fleet, last, 'fleet card last events')
    expect(last.map((c) => c.title)).toContain(`last: Bash · ${HOSTILE}`)
    const feed = cells(fleet, 'span', 'fw')
    expectTitleIsText(fleet, feed, 'fleet feed')
    expect(feed.map((c) => c.title)).toEqual([HOSTILE])

    const picker = serveUi.pickerHtml(fileData({ mode: 'serve', sessions: rows }), rows[0])
    const options = cells(picker, 'span', 'proj')
    expectTitleIsText(picker, options, 'session picker')
    expect(options.map((c) => c.title)).toEqual([HOSTILE, 'a-project-slug-that-is-long-enough-to-cut'])
  })
})
