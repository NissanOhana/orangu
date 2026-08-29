/**
 * The Repo and Global screens as a saved aggregate report renders them: mode 'file', no Analysis at
 * all. Nothing writes such a file yet, so these are the first tests that exercise the shape, and the
 * hero's "Review <scope> improvements" is the single next action on the screen (AC18, AC23).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import { aggregate, type Aggregate } from '../../../analyze/aggregate.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { aggregateEmpty, aggregateLead, renderRepo } from './repo.js'
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
    const lead = aggregateLead(scope, { screen: scope })
    expect(lead).toContain(`<a class="btn-primary" href="#suggest?scope=${scope}">`)
    expect(lead).toContain(`Review ${scope} improvements`)
    expect(lead).not.toContain('class="btn"')
    expect(lead).not.toContain('class="btn-sm"')
  })

  // The hash is the only carrier of the theme now that nothing follows the system colour scheme, so a
  // literal href on the screen's one promoted click repaints a dark reader light. Every other link on
  // the page is built by the hash writer; this one has to be too, or the sidebar and the hero disagree.
  it.each(['repo', 'global'] as const)('carries the view the reader is already in, so a dark report stays dark (%s)', (scope) => {
    const lead = aggregateLead(scope, { screen: scope, s: 'sid-1', theme: 'dark', audience: 'plain' })
    expect(lead).toContain(`href="#suggest?s=sid-1&amp;scope=${scope}&amp;audience=plain&amp;theme=dark"`)
  })

  // cleanHash's whole job: the target screen starts on its own scope, not on the filter the reader left.
  it('clears the filter keys of the screen it leaves', () => {
    const lead = aggregateLead('repo', { screen: 'global', scope: 'global', tool: 'Read', errorsOnly: true, theme: 'dark' })
    expect(lead).toContain('href="#suggest?scope=repo&amp;theme=dark"')
  })
})

/** The two shapes the reused empty state has to tell apart: a file about a session, a file about a scope. */
function emptyStateData(carries: 'session' | 'scope'): AppData {
  const agg = { scope: 'repo orangu', sessionCount: 19, sessions: [], crossFindings: [], topReReadFiles: [], recurringErrors: [], topSessions: [] } as unknown as Aggregate
  return {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: carries === 'scope', kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: undefined,
    session: carries === 'session' ? ({} as AppData['session']) : undefined,
    sessions: [], aggregates: carries === 'scope' ? { repo: agg } : {}, suggestions: [],
  }
}

describe('the across-session empty state', () => {
  // A saved scope report reaches this state in one click (the scope it does not carry, and Harness),
  // where "carries one session" is a claim about a file that has none.
  it.each(['global', 'harness'] as const)('says what a scope report actually carries (%s)', (screen) => {
    const empty = aggregateEmpty(screen, emptyStateData('scope'))
    expect(empty).toContain('This report carries one scope, not a session.')
    expect(empty).not.toContain('carries one session')
    expect(empty).toContain('Across-session views need orangu serve')
  })

  it.each(['repo', 'global', 'harness'] as const)('keeps the session sentence in a report that does carry one (%s)', (screen) => {
    const empty = aggregateEmpty(screen, emptyStateData('session'))
    expect(empty).toContain('This single-file report carries one session.')
  })

  it('keeps the per-screen reason for reaching for the local viewer', () => {
    expect(aggregateEmpty('harness', emptyStateData('scope'))).toContain('compare your Claude Code config with what your sessions used')
    expect(aggregateEmpty('global', emptyStateData('scope'))).toContain('analyse everything on this machine')
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
