import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import { aggregate } from '../../../analyze/aggregate.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { renderGlobal } from './global.js'
import { renderRepo } from './repo.js'

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

async function context(scope: 'repo' | 'global', includeText = false): Promise<Ctx> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const analysis = analyzeSession(session, { version: 'test', now: 0 })
  const g = aggregate([analysis], scope, 0)
  // two sessions' worth of recurring errors, as the default redaction leaves them: signatures stripped
  g.recurringErrors = [
    { signature: '', tool: 'Bash', sessions: 6, total: 27 },
    { signature: '', tool: 'Bash', sessions: 5, total: 51 },
    { signature: 'ENOENT: no such file', tool: 'Read', sessions: 2, total: 3 },
  ]
  const data: AppData = {
    v: '1', mode: 'serve', version: 'test', generatedAt: 0,
    capabilities: { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: { [scope]: g }, suggestions: [],
  }
  return { data, a: analysis, ds: {} as Ctx['ds'], state: { screen: scope, s: analysis.session.id }, audience: 'dev', go: vi.fn() }
}

describe('renderGlobal (M4: the evidence blocks Repo renders, from the same Aggregate)', () => {
  it('renders recurring findings, re-read files, recurring errors and the heaviest sessions after the rollups', async () => {
    renderGlobal(await context('global'))
    for (const section of ['Weekly tokens', 'Tokens by model', 'Tokens by project', 'Recurring findings', 'Most re-read files', 'Recurring errors', 'Heaviest sessions'])
      expect(markup, section).toContain(section)
    expect(markup.indexOf('Tokens by project')).toBeLessThan(markup.indexOf('Recurring findings'))
    expect(markup).toContain('<table class="grid"><thead><tr><th>Session</th><th>Title</th>')
    expect(markup).toContain('every figure is a token count reported by the API')
  })

  it('folds the stripped error signatures per tool on both aggregate screens and keeps the ones that survived (M1)', async () => {
    for (const [scope, render] of [['global', renderGlobal], ['repo', renderRepo]] as const) {
      render(await context(scope))
      expect(markup, scope).toContain('<b>Bash</b> · 78 errors across 2 recurring signatures</span><span class="mono small muted">6+ sessions</span>')
      expect(markup, scope).toContain('text hidden; re-run with <span class="mono">--include-text</span>')
      expect(markup, scope).toContain('<span class="sigline">ENOENT: no such file</span>')
      expect(markup, scope).toContain('2 sessions</span><span class="mono125">×3</span>')
      expect(markup, scope).not.toContain('not included')
    }
  })

  it('agrees every noun with its count (L3): never "1 sessions" or "1 sources"', async () => {
    renderGlobal(await context('global'))
    expect(markup).toContain('1 source</div>')
    expect(markup).toContain('1 session</span>')
    expect(markup).toContain('>1 session · every figure')
    expect(markup).not.toMatch(/\b1 sessions\b/)
    expect(markup).not.toMatch(/\b1 sources\b/)
  })
})
