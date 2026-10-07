import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { overviewScreenHtml, renderOverview } from './overview.js'
import { esc, ms } from '../format.js'
import { outcomeHeadline } from '../derive.js'
import { leadSentence, plainSentence } from '../strings.js'

let markup = ''

beforeEach(() => {
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => {
      const template = {
        content: { firstElementChild: {} as HTMLElement },
        set innerHTML(value: string) { markup = value },
      }
      return template
    },
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

async function context(options: { audience?: Ctx['audience']; mode?: AppData['mode']; dirtyRoute?: boolean } = {}): Promise<Ctx> {
  const audience = options.audience ?? 'dev'
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const analysis = analyzeSession(session, { version: 'test', now: 0 })
  const state = {
    screen: 'overview', s: analysis.session.id,
    ...(audience === 'plain' ? { audience: 'plain' as const } : {}),
    ...(options.dirtyRoute ? {
      scope: 'repo' as const, audience: 'dev' as const, theme: 'dark', tool: 'Read', cat: 'read', agent: 'agent-1',
      turn: 4, errorsOnly: true, filter: 'errors' as const,
    } : {}),
  }
  const data: AppData = {
    v: '1', mode: options.mode ?? 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: true },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions: [],
  }
  return { data, a: analysis, ds: {} as Ctx['ds'], state, audience, go: vi.fn() }
}

describe('renderOverview (A1: what happened · what matters · what next)', () => {
  // Rewritten with the Overview rewrite: the five "Follow the evidence" cards and the 6-tile KPI grid are
  // gone; "Where to look next" is three text links with the same hash hygiene the cards had.
  it('links the three next steps canonically, clearing aggregate and filter keys, and drops the card grid', async () => {
    const ctx = await context({ mode: 'serve', dirtyRoute: true })
    renderOverview(ctx)

    expect(markup).toContain('class="hero overview-hero"')
    expect(markup).toContain('class="overview-brand"')
    expect(markup.match(/class="herotitle"/g)?.length).toBe(1)
    expect(markup).not.toContain('class="kpis"')
    expect(markup).not.toContain('data-capability=')
    expect(markup).toContain('aria-label="Where to look next"')
    for (const screen of ['tools', 'suggest']) {
      expect(markup).toContain(`data-screen="${screen}"`)
      expect(markup).toContain(`href="#${screen}?s=${ctx.state.s}&amp;audience=dev&amp;theme=dark"`)
    }
    expect(markup).toContain('data-screen="timeline"')
    for (const stale of ['scope=', 'cat=', 'agent=', 'filter=']) expect(markup).not.toContain(stale)
    expect(markup).toContain(`${ctx.a!.summary.toolCalls} calls`)
    expect(markup).toContain(`${ctx.a!.insights.length} finding`)
  })

  it('puts ACTIVE time on the Time axis, wall and waiting in its note, and folds the signal chips into Quality', async () => {
    const ctx = await context()
    renderOverview(ctx)
    const s = ctx.a!.summary
    expect(markup).toContain(`<div class="aname">Time ↓</div><div class="aval">${ms(s.activeMs)}</div>`)
    expect(markup).toContain('waiting for you')
    expect(markup).not.toContain('NaN')
    expect(markup).toContain('<details class="signals"><summary>')
    expect(markup).toContain('class="sigchip"')
  })

  it('scopes the Quality verdict to the last run when earlier test runs failed, in both audiences', async () => {
    const mixed = async (audience: Ctx['audience']) => {
      const ctx = await context({ audience })
      const s = ctx.a!.summary
      s.ending = 'clean'
      s.outcomes.testRuns = 133
      s.outcomes.testRunsFailed = 8
      ctx.a!.quality.signals = [{ id: 'tests', label: 'Test runs', value: '133 (125 passed)', tone: 'good', detail: 'last run passed' }]
      return ctx
    }
    renderOverview(await mixed('dev'))
    expect(markup).toContain('<div class="aval">passing <span class="anote">(last run)</span></div>')
    expect(markup).toContain('8 of 133 test runs failed')
    renderOverview(await mixed('plain'))
    expect(markup).toContain('<div class="k">How it ended</div><div>The last check it ran passed. 8 of 133 test runs failed earlier.</div>')

    const green = await mixed('dev')
    green.a!.summary.outcomes.testRunsFailed = 0
    renderOverview(green)
    expect(markup).toContain('<div class="aval">passing</div>')
    expect(markup).not.toContain('(last run)')
  })

  it('hoists the top finding as an open card with its fix, share, evidence link and improve command', async () => {
    const ctx = await context()
    renderOverview(ctx)
    const top = ctx.a!.insights.find((i) => i.id === ctx.a!.summary.topInsightIds[0])!
    expect(markup).toContain('Top improvement')
    expect(markup).toContain('<details class="finding top" open>')
    expect(markup).toContain(top.title)
    // the savings pill explains itself: one sentence that names the rule and the figure
    expect(markup).toMatch(/title="Rule [\w-]+ (?:estimated|measured) a saving of ≈/)
    expect(markup).toContain('/orangu:improve sg_')
    expect(markup).toMatch(/See the [^<]+ →/)
    expect(markup).toContain('href="#timeline?')
  })

  it('renders the context sparkline from the Context chart, and a caption alone when there is no series', async () => {
    const ctx = await context()
    renderOverview(ctx)
    expect(markup).toContain('<div class="spark"><svg')
    expect(markup).toMatch(/peak \d+% of the window · \d+ compactions?/)
    ctx.a!.context.series = []
    renderOverview(ctx)
    expect(markup).not.toContain('<div class="spark">')
    expect(markup).not.toContain('<svg')
    expect(markup).toContain('peak ')
  })

  it('headlines the hero from the counted outcomes, never from the ending enum', async () => {
    const ctx = await context()
    renderOverview(ctx)
    const hero = /<div class="herotitle">([^<]*)<\/div>/.exec(markup)?.[1] ?? ''
    expect(hero).not.toContain('Cleanly')
    expect(hero.length).toBeGreaterThan(0)
    expect(hero).toContain(ctx.a!.summary.outcomes.testRuns ? 'test' : 'request')
  })

  // A3b: Plain mode removes panels (no axes, no chips, no sparkline) and keeps the same top-finding card
  // plus the three links: the public sample opens in Plain and navigates through them.
  it('Plain mode is the sentence, the "What happened here" card, the same top-finding card and the links', async () => {
    const ctx = await context({ audience: 'plain', mode: 'file' })
    renderOverview(ctx)

    expect(markup).toContain('What happened here')
    // The card adds only what the hero does not already say: the outcome headline and the narrative's
    // lead sentence render once (in the hero), never again as "What happened" / "What it produced" rows.
    const s = ctx.a!.summary
    expect(markup.split(esc(outcomeHeadline(s))).length - 1).toBe(1)
    expect(markup.split(esc(plainSentence(leadSentence(s.narrative), 'plain'))).length - 1).toBe(1)
    for (const row of ['Goal', 'How it ended', 'Tokens &amp; time']) expect(markup).toContain(`<div class="k">${row}</div>`)
    expect(markup).not.toContain('<div class="k">What happened</div>')
    expect(markup).not.toContain('What it produced')
    expect(markup).toContain('Top improvement')
    expect(markup).toContain('<details class="finding top" open>')
    expect(markup).toContain('<span class="rec sg-lead"><b>Improvement:</b> ')
    expect(markup).toContain('class="cmd"')
    expect(markup).not.toContain('class="triptych"')
    expect(markup).not.toContain('sigchip')
    expect(markup).not.toContain('class="spark"')
    for (const screen of ['timeline', 'tools', 'suggest']) {
      expect(markup).toContain(`data-screen="${screen}"`)
      expect(markup).toContain(`href="#${screen}?`)
      expect(markup).toContain(`s=${ctx.a!.session.id}&amp;audience=plain`)
    }
    // A3: one vocabulary; Plain mode keeps the word tokens and invents no nouns
    expect(markup).toContain('tokens')
    for (const invented of ['work units', 'exchanges', 'helpers']) expect(markup).not.toContain(invented)
  })

  it('gives every top finding its exact improve command and never renders an empty detail paragraph (A2)', async () => {
    const ctx = await context()
    for (const i of ctx.a!.insights) i.detail = ''
    expect(ctx.a!.summary.topInsightIds.length).toBeGreaterThan(0)
    renderOverview(ctx)
    expect(markup).toContain('class="cmd"')
    expect(markup).toContain('/orangu:improve sg_')
    expect(markup).toContain('Get an AI proposal')
    expect(markup).not.toContain('<p></p>')
    expect(markup).toContain('recoverable across')
    expect(markup).toMatch(/title="Rule [\w-]+ (?:estimated|measured) a saving of ≈/)
  })

  it('renders the recoverable line above the findings even when only one finding is a top finding', async () => {
    const ctx = await context()
    expect(ctx.a!.insights.length).toBeGreaterThan(1)
    ctx.a!.summary.topInsightIds = ctx.a!.summary.topInsightIds.slice(0, 1)
    renderOverview(ctx)
    expect(markup).not.toContain('More findings')
    expect(markup).toContain('recoverable across')
    expect(markup).toMatch(/class="recoverable"><a href="[^"]*#suggest/)
  })

  it('designs the clean-session state instead of an empty card', async () => {
    const ctx = await context()
    ctx.a!.insights = []
    ctx.a!.summary.topInsightIds = []
    renderOverview(ctx)
    expect(markup).toContain('<span class="muted">The rules found nothing to change in this session.</span>')
    expect(markup).toContain('Improvements · none')
    expect(markup).not.toContain('recoverable across')
  })
})

/**
 * The top card names the change in its summary, says where the copied command goes (a terminal: the
 * text is `claude "…"`, which starts Claude Code), and links to the 3 steps on the Improvements screen
 * through the hash writer, so the reader keeps their theme and audience.
 */
describe('renderOverview: the top improvement and the way to an AI proposal', () => {
  it('names the improvement in the top card summary and drops the body box that repeated it', async () => {
    const ctx = await context()
    renderOverview(ctx)
    const top = ctx.a!.insights.find((i) => i.id === ctx.a!.summary.topInsightIds[0])!
    const start = markup.indexOf('<details class="finding top" open>')
    const card = markup.slice(start, markup.indexOf('</details>', start))
    const summary = card.slice(0, card.indexOf('</summary>'))
    expect(top.improvement).not.toBe(top.recommendation)
    expect(summary).toContain(`<span class="rec sg-lead"><b>Improvement:</b> ${esc(top.improvement)}</span>`)
    expect(summary).not.toContain(esc(top.why!))
    expect(card).not.toContain('<b>Fix.</b>')
    expect(markup).toContain('<div class="eyebrow mb6">Top improvement</div>')
  })

  // The top card renders open; its reason waits closed behind Why, keyed by the sg_ id that its improve
  // command carries, so the Improvements card of the same finding shares its open state.
  it('puts a closed Why first in the open top card body, keyed by the sg_ id of its improve command', async () => {
    const ctx = await context()
    renderOverview(ctx)
    const top = ctx.a!.insights.find((i) => i.id === ctx.a!.summary.topInsightIds[0])!
    const start = markup.indexOf('<details class="finding top" open>')
    const body = markup.slice(markup.indexOf('<div class="fbody">', start) + '<div class="fbody">'.length).trimStart()
    const sid = /\/orangu:improve (sg_[0-9a-f]{12})/.exec(body)?.[1]
    expect(sid).toBeTruthy()
    expect(body.startsWith(`<details class="why" id="why-${sid}"><summary><span class="chev" aria-hidden="true">▸</span>Why</summary><p>${esc(top.why!)}</p>`)).toBe(true)
  })

  it('gives each More findings card its own Why id', async () => {
    const ctx = await context()
    expect(ctx.a!.summary.topInsightIds.length).toBeGreaterThan(1)
    renderOverview(ctx)
    const ids = [...markup.matchAll(/<details class="why" id="(why-[^"]+)">/g)].map((m) => m[1])
    expect(ids).toHaveLength(ctx.a!.summary.topInsightIds.length)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // /orangu:improve refuses evidence from another workspace, so the caption names the session folder
  it('says to paste the command in a terminal in the session folder and links the top card only to the 3 steps, keeping theme and audience', async () => {
    const ctx = await context({ mode: 'serve', dirtyRoute: true })
    expect(ctx.a!.summary.topInsightIds.length).toBeGreaterThan(1)
    expect(ctx.a!.session.cwd).toBeTruthy()
    renderOverview(ctx)
    expect(markup).toContain('<div class="eyebrow">Get an AI proposal</div>')
    const captions = markup.split(`<div class="small">Paste it in a terminal in ${esc(ctx.a!.session.cwd!)}. It starts Claude Code.`).length - 1
    expect(captions).toBe(ctx.a!.summary.topInsightIds.length)
    expect(markup).not.toContain('Paste it in a terminal. It starts Claude Code.')
    expect(markup.split('aria-label="copy the Claude Code command"').length - 1).toBe(ctx.a!.summary.topInsightIds.length)
    // data-to: the Improvements screen opens at the steps (#ai-steps), not at the Overview's scroll offset
    expect(markup).toContain(`<a href="#suggest?s=${ctx.state.s}&amp;audience=dev&amp;theme=dark" data-to="ai-steps">See the 3 steps →</a>`)
    expect(markup.split('See the 3 steps').length - 1).toBe(1)
    expect(markup).not.toContain('Draft a proposal')
  })

  // An improvement that holds two PLAIN_TERMS keys (strings.ts): Plain replaces them, Detailed keeps them.
  it.each([
    ['plain', 'Start a new session before the working memory fills and a memory refresh starts.', ['context window', 'compaction']],
    ['dev', 'Start a new session before the context window fills and a compaction starts.', ['working memory', 'memory refresh']],
  ] as const)('words the improvement line on the top card for the %s audience', async (audience, shown, hidden) => {
    const ctx = await context({ audience })
    const top = ctx.a!.insights.find((i) => i.id === ctx.a!.summary.topInsightIds[0])!
    top.improvement = 'Start a new session before the context window fills and a compaction starts.'
    renderOverview(ctx)
    const start = markup.indexOf('<details class="finding top" open>')
    expect(start).toBeGreaterThan(-1)
    const summary = markup.slice(start, markup.indexOf('</summary>', start))
    expect(/<span class="rec sg-lead">[\s\S]*?<\/span>/.exec(summary)?.[0]).toBe(`<span class="rec sg-lead"><b>Improvement:</b> ${shown}</span>`)
    for (const word of hidden) expect(summary).not.toContain(word)
  })

  it('keeps the improvement line, the session folder and the link to the 3 steps in Plain language', async () => {
    const ctx = await context({ audience: 'plain' })
    renderOverview(ctx)
    expect(markup).toContain('<span class="rec sg-lead"><b>Improvement:</b> ')
    expect(markup).toContain(`Paste it in a terminal in ${esc(ctx.a!.session.cwd!)}. It starts Claude Code.`)
    expect(markup).toContain('See the 3 steps →</a>')
    expect(markup).toContain('audience=plain')
  })
})

describe('renderOverview with no session to show', () => {
  // A saved scope report has no session picker at all: the session group is subtracted from its
  // sidebar, so #overview is reachable only by a typed hash and "pick one from the sidebar" points at
  // a control that is not on the page.
  it('does not send a scope report to a session picker it does not have', async () => {
    const ctx = await context()
    ctx.a = undefined
    ctx.data.session = undefined
    ctx.data.selectedId = undefined
    ctx.data.aggregates = { repo: { scope: 'repo orangu', sessionCount: 19, sessions: [], crossFindings: [], topReReadFiles: [], recurringErrors: [], topSessions: [] } as unknown as NonNullable<AppData['aggregates']['repo']> }
    renderOverview(ctx)
    expect(markup).toContain('No session selected.')
    expect(markup).toContain('This report covers a scope, not a session.')
    expect(markup).not.toContain('Pick a session from the sidebar.')
  })

  it('still names the picker in a served app, which has one', async () => {
    const ctx = await context({ mode: 'serve' })
    ctx.a = undefined
    ctx.data.session = undefined
    renderOverview(ctx)
    expect(markup).toContain('Pick a session from the sidebar.')
  })
})

/** The Overview as a string: the markup renderOverview wraps in the DOM, built with no DOM, for a node gate. */
describe('overviewScreenHtml', () => {
  it.each(['dev', 'plain'] as const)('is the markup that renderOverview draws (%s)', async (audience) => {
    const ctx = await context({ audience })
    renderOverview(ctx)
    expect(overviewScreenHtml(ctx).trim()).toBe(markup)
  })

  it('is the designed empty state when no session is selected', async () => {
    const ctx = await context({ mode: 'serve' })
    ctx.a = undefined
    renderOverview(ctx)
    expect(overviewScreenHtml(ctx).trim()).toBe(markup)
  })

  it('needs no document', async () => {
    const ctx = await context()
    vi.unstubAllGlobals()
    const html = overviewScreenHtml(ctx)
    expect(html).toContain('<details class="finding top" open>')
    expect(html).toContain('>Why</summary>')
  })
})
