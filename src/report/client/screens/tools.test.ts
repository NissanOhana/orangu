import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import type { ToolStat } from '../../../model/analysis.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { renderTools } from './tools.js'

let markup = ''

beforeEach(() => {
  const root = { querySelectorAll: () => [], querySelector: () => null } as unknown as HTMLElement
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => ({
      content: { firstElementChild: root },
      set innerHTML(value: string) { markup = value },
    }),
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

/** A synthetic ToolStat: 62 calls whose mean (29 s) sits far above p95 (186 ms) because one call hit a 30-minute timeout. */
function stat(over: Partial<ToolStat> = {}): ToolStat {
  return {
    name: 'Bash', category: 'exec', count: 62, errors: 1, unresolved: 0,
    totalMs: 1_798_000, avgMs: 29_000, p95Ms: 186, maxMs: 1_800_000,
    resultBytesTotal: 40_000, resultBytesMax: 8_000, inputBytesTotal: 6_000,
    parallelShare: 0, mainCount: 62, agentCount: 0,
    ...over,
  }
}

async function context(audience: Ctx['audience'], byName: ToolStat[]): Promise<Ctx> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const analysis = analyzeSession(session, { version: 'test', now: 0 })
  analysis.tools.byName = byName
  const data: AppData = {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: true },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions: [],
  }
  const state = { screen: 'tools', s: analysis.session.id, ...(audience === 'plain' ? { audience: 'plain' as const } : {}) }
  return { data, a: analysis, ds: {} as Ctx['ds'], state, audience, go: vi.fn() }
}

describe('renderTools: the Avg cell when the mean exceeds p95', () => {
  const WHY = 'one or more calls far above the rest; p95 is the typical worst case'

  it('marks the outlier row with a visible note and an explanatory title, and leaves ordinary rows bare', async () => {
    const ordinary = stat({ name: 'Read', category: 'read', count: 10, errors: 0, totalMs: 1_200, avgMs: 120, p95Ms: 300, maxMs: 310, mainCount: 10 })
    renderTools(await context('dev', [stat(), ordinary]))
    expect(markup).toContain(`<td class="num" title="${WHY}">29s<span class="outlier">outlier</span></td>`)
    expect(markup).toContain('<td class="num p95col">186ms</td>')
    expect(markup).toContain('<td class="num">120ms</td>')
    expect(markup.match(/class="outlier"/g)?.length).toBe(1)
    expect(markup).toContain('data-tool="Read"')
  })

  it('an average that equals p95 is not an outlier', async () => {
    renderTools(await context('dev', [stat({ count: 1, errors: 0, totalMs: 500, avgMs: 500, p95Ms: 500, maxMs: 500, mainCount: 1 })]))
    expect(markup).not.toContain('outlier')
    expect(markup).toContain('<td class="num">500ms</td>')
  })

  it('Plain audience keeps the note but explains it without naming p95', async () => {
    renderTools(await context('plain', [stat()]))
    expect(markup).toContain('<td class="num" title="one or more calls far above the rest">29s<span class="outlier">outlier</span></td>')
    expect(markup).not.toContain('p95 is the typical worst case')
  })
})
