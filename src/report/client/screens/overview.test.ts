import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { renderOverview } from './overview.js'
import { ms } from '../format.js'

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

  it('hoists the top finding as an open card with its fix, share, evidence link and improve command', async () => {
    const ctx = await context()
    renderOverview(ctx)
    const top = ctx.a!.insights.find((i) => i.id === ctx.a!.summary.topInsightIds[0])!
    expect(markup).toContain('The one thing to improve')
    expect(markup).toContain('<details class="finding top" open>')
    expect(markup).toContain(top.title)
    expect(markup).toContain('title="≈')
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
  it('Plain mode is the sentence, the "What happened here" table, the same top-finding card and the links', async () => {
    const ctx = await context({ audience: 'plain', mode: 'file' })
    renderOverview(ctx)

    expect(markup).toContain('What happened here')
    expect(markup).toContain('The one thing to improve')
    expect(markup).toContain('<details class="finding top" open>')
    expect(markup).toContain('<b>Fix.</b> ')
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
    expect(markup).toContain('Draft a proposal')
    expect(markup).not.toContain('<p></p>')
    expect(markup).toContain('recoverable across')
    expect(markup).toContain('title="≈')
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
    expect(markup).toContain('Nothing stood out. This session ran clean.')
    expect(markup).toContain('Suggestions · nothing to improve')
    expect(markup).not.toContain('recoverable across')
  })
})
