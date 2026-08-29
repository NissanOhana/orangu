/**
 * The aggregate seam answers every remote capability from the file. These are the assertions that
 * make the "no loading state" claim true rather than assumed: if either ensure* ever returned true,
 * a saved report would sit on a placeholder forever, because nothing can resolve a fetch it never made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppData } from '../../model/app-data.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { Ctx } from './app.js'
import { aggUi } from './agg-ui.js'
import { megaReview } from './mega-review.js'

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

function fileData(scope: 'repo' | 'global', sessionCount: number, label: string = scope): AppData {
  const agg = { scope: label, sessionCount, sessions: [], crossFindings: [], topReReadFiles: [], recurringErrors: [], topSessions: [] } as unknown as Aggregate
  return {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: undefined, session: undefined, sessions: [], aggregates: { [scope]: agg }, suggestions: [],
  }
}

describe('the aggregate report seam', () => {
  it('never kicks a fetch, so no screen can land in a loading state', () => {
    const ds = {} as Parameters<typeof aggUi.ensureAggregate>[1]
    const onLoaded = vi.fn()
    expect(aggUi.ensureAggregate(fileData('repo', 3), ds, { screen: 'repo' }, onLoaded)).toBe(false)
    expect(aggUi.ensureHarness(ds, onLoaded)).toBe(false)
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('names the scope label the aggregate carries and its session count, never a session id', () => {
    // the label is the aggregate's own scope string, already redacted by the CLI before it was embedded
    expect(aggUi.pickerHtml(fileData('repo', 103, 'repo orangu'), undefined)).toBe('<div class="sid">repo orangu · 103 sessions</div>')
    expect(aggUi.pickerHtml(fileData('global', 1, 'global'), undefined)).toBe('<div class="sid">global · 1 sessions</div>')
  })

  it('escapes a scope label rather than trusting a project name to be markup-free', () => {
    expect(aggUi.pickerHtml(fileData('repo', 2, 'repo <b>x</b>'), undefined)).toBe('<div class="sid">repo &lt;b&gt;x&lt;/b&gt; · 2 sessions</div>')
  })

  it('shows the designed empty state for the harness, which has no file form, and no Overview card', () => {
    aggUi.harnessView({ data: fileData('repo', 19, 'repo orangu') } as Ctx)
    expect(markup).toContain('Across-session views need orangu serve')
    expect(markup).toContain('compare your Claude Code config with what your sessions used')
    // the file the reader is holding carries no session at all, so the hint may not claim one
    expect(markup).toContain('This report carries one scope, not a session.')
    expect(markup).not.toContain('carries one session')
    expect(aggUi.harnessCard({} as Parameters<typeof aggUi.harnessCard>[0], vi.fn(), '#harness')).toBe('')
  })

  it('renders the whole-harness block through the same shared module the served app uses', () => {
    expect(aggUi.megaReview('repo')).toBe(megaReview('repo'))
    expect(aggUi.megaReview('global')).toBe(megaReview('global'))
  })
})
