import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { renderOverview } from './overview.js'

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

describe('renderOverview capabilities', () => {
  it('uses the large shared mascot and canonical links for every available serve/developer view', async () => {
    const ctx = await context({ mode: 'serve', dirtyRoute: true })
    renderOverview(ctx)

    expect(markup).toContain('class="hero overview-hero"')
    expect(markup).toContain('width="96" height="96"')
    for (const screen of ['timeline', 'tools', 'agents', 'context', 'suggest']) {
      expect(markup).toContain(`data-capability="${screen}"`)
      expect(markup).toContain(`href="#${screen}?s=${ctx.state.s}&amp;audience=dev&amp;theme=dark"`)
    }
    for (const stale of ['scope=', 'tool=', 'cat=', 'agent=', 'turn=', 'err=', 'filter=']) expect(markup).not.toContain(stale)
    expect(markup).toContain(`${ctx.a!.summary.turns} turns`)
    expect(markup).toContain(`${ctx.a!.summary.toolCalls} calls`)
    expect(markup).toContain(`${ctx.a!.agents.runs.length} runs`)
    expect(markup).toContain('aria-label="Explore this run"')
    expect(markup).toContain('Evidence is traceable; optional proposals stay reviewable.')
  })

  it('matches the existing file/plain navigation policy and preserves the audience in links', async () => {
    const ctx = await context({ audience: 'plain', mode: 'file' })
    renderOverview(ctx)

    expect(markup).not.toContain('data-capability="agents"')
    expect(markup).not.toContain('data-capability="context"')
    for (const screen of ['timeline', 'tools', 'suggest']) {
      expect(markup).toContain(`data-capability="${screen}"`)
      expect(markup).toContain(`href="#${screen}?s=${ctx.a!.session.id}&amp;audience=plain"`)
    }
    expect(markup).toContain('steps')
    expect(markup).toContain('exchanges')
  })

  it('omits the Agents entry when the selected analysis has no agent runs', async () => {
    const ctx = await context()
    ctx.a!.agents.runs = []
    ctx.a!.summary.agents = 0
    renderOverview(ctx)

    expect(markup).not.toContain('data-capability="agents"')
    expect(markup).toContain('data-capability="context"')
  })
})
