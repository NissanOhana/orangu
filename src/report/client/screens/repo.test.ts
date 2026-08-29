/**
 * The Repo and Global screens as a saved aggregate report renders them: mode 'file', no Analysis at
 * all. Nothing writes such a file yet, so these are the first tests that exercise the shape, and the
 * hero's "Review <scope> improvements" is the single next action on the screen (AC18, AC23).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import { aggregate } from '../../../analyze/aggregate.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { aggregateLead, renderRepo } from './repo.js'
import { renderGlobal } from './global.js'

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

/** A saved aggregate report: aggregates present, `session` and `selectedId` absent, mode 'file'. */
async function fileContext(scope: 'repo' | 'global'): Promise<Ctx> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const g = aggregate([analyzeSession(session, { version: 'test', now: 0 })], scope, 0)
  const data: AppData = {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: undefined, session: undefined, sessions: [], aggregates: { [scope]: g }, suggestions: [],
  }
  return { data, ds: {} as Ctx['ds'], state: { screen: scope }, audience: 'dev', go: vi.fn() }
}

describe('the aggregate hero action', () => {
  it.each(['repo', 'global'] as const)('is the primary CTA on %s, not a small outline button', (scope) => {
    const lead = aggregateLead(scope)
    expect(lead).toContain(`<a class="btn-primary" href="#suggest?scope=${scope}">`)
    expect(lead).toContain(`Review ${scope} improvements`)
    expect(lead).not.toContain('class="btn"')
    expect(lead).not.toContain('class="btn-sm"')
  })
})

describe('Repo and Global with an aggregate and no Analysis', () => {
  it.each([
    ['repo', renderRepo],
    ['global', renderGlobal],
  ] as const)('renders the KPI strip and the evidence blocks with no session loaded (%s)', async (scope, render) => {
    const ctx = await fileContext(scope)
    expect(() => render(ctx)).not.toThrow()
    for (const label of ['Sessions', 'Total tokens', 'Per session', 'Per human turn', 'Recurring findings', 'Most re-read files', 'Heaviest sessions'])
      expect(markup, label).toContain(label)
    expect(markup).toContain('every figure is a token count reported by the API')
    expect(markup, 'a missing Analysis leaked into the markup').not.toContain('undefined')
    expect(markup, 'a missing Analysis leaked into the markup').not.toContain('NaN')
  })

  it('offers no cross-session link a saved file cannot follow, and names the CLI instead', async () => {
    renderRepo(await fileContext('repo'))
    expect(markup).toContain('title="open with: orangu report ')
    expect(markup).not.toContain('href="#overview?s=')
  })
})
