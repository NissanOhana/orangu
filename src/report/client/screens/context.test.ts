import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import type { Analysis } from '../../../model/analysis.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { contextHeadline } from '../derive.js'
import { renderContext } from './context.js'

let markup = ''

beforeEach(() => {
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => ({
      content: { firstElementChild: {} as HTMLElement },
      set innerHTML(value: string) { markup = value },
    }),
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

async function context(mutate?: (a: Analysis) => void): Promise<Ctx> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const analysis = analyzeSession(session, { version: 'test', now: 0 })
  mutate?.(analysis)
  const data: AppData = {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: true },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions: [],
  }
  return { data, a: analysis, ds: {} as Ctx['ds'], state: { screen: 'context', s: analysis.session.id }, audience: 'dev', go: vi.fn() }
}

describe('renderContext (A5: a takeaway, then the evidence)', () => {
  it('leads with one true sentence built from measured facts', async () => {
    const ctx = await context()
    renderContext(ctx)
    const lead = contextHeadline(ctx.a!)
    expect(lead).toMatch(/^[A-Z].*\.$/)
    expect(lead).toContain('of tokens were cache reads')
    expect(markup).toContain(`<p class="ctx-lead">${lead}</p>`)
    expect(markup.indexOf('ctx-lead')).toBeLessThan(markup.indexOf('class="kpis"'))
  })

  it('drops the window clause when the session has no context window, and never renders NaN', async () => {
    const ctx = await context((a) => {
      a.context.contextWindow = undefined
    })
    renderContext(ctx)
    expect(contextHeadline(ctx.a!)).not.toContain('of the window')
    expect(markup).not.toContain('NaN')
    const clean = await context((a) => {
      a.summary.totalTokens = 0
      a.tokens.agents = 0
      a.context.contextWindow = undefined
    })
    expect(contextHeadline(clean.a!)).toBe('No token usage was recorded for this session.')
  })

  it('keeps the context curve and "Where the tokens went" open and folds the other three charts under one details', async () => {
    renderContext(await context())
    const fold = markup.indexOf('<details class="more-charts">')
    expect(fold).toBeGreaterThan(-1)
    expect(markup.indexOf('Context size over the session')).toBeLessThan(fold)
    expect(markup.indexOf('Where the tokens went')).toBeLessThan(fold)
    for (const title of ['Token composition per request', 'By model', 'Cumulative tokens over turns']) expect(markup.indexOf(title)).toBeGreaterThan(fold)
    expect(markup.match(/<details/g)?.length).toBe(1)
    // plain tile names, the numbers unchanged
    expect(markup).toContain('Context re-read')
    expect(markup).toContain('Fixed weight per request')
    expect(markup).not.toContain('Re-read multiplier')
    expect(markup).not.toContain('Boot baseline')
  })
})
