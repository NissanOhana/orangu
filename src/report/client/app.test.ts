import { describe, expect, it, vi } from 'vitest'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { Analysis } from '../../model/analysis.js'
import type { AppData } from '../../model/app-data.js'
import type { SuggestionRecord } from '../../suggest/types.js'
import { cycleTheme, docTitle, refreshSuggestions, refreshSuggestionsOnConnection, renderWait, showLoader, screenSub, screenTitle, sesscardEyebrow, showMe, showMeCommand, themeName } from './app.js'
import { navFor, type RouteState } from './nav.js'

const record = (id: string): SuggestionRecord => ({ id, v: 2, status: 'new' }) as SuggestionRecord

describe('suggestion-updated refresh', () => {
  it('replaces visible records with persisted state and rerenders the suggestion screen', async () => {
    const data = { suggestions: [record('old')] } as AppData
    const rerender = vi.fn()
    await refreshSuggestions(data, { suggestions: vi.fn().mockResolvedValue([record('fresh')]) }, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['fresh'])
    expect(rerender).toHaveBeenCalledOnce()
  })

  it('keeps the last good state when a refresh fails', async () => {
    const data = { suggestions: [record('old')] } as AppData
    const rerender = vi.fn()
    await refreshSuggestions(data, { suggestions: vi.fn().mockRejectedValue(new Error('loopback unavailable')) }, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['old'])
    expect(rerender).not.toHaveBeenCalled()
  })

  it('replaces a stale bootstrap snapshot on first connect and every reconnect', async () => {
    const data = { suggestions: [record('bootstrap')] } as AppData
    const rerender = vi.fn()
    const suggestions = vi.fn()
      .mockResolvedValueOnce([record('between-bootstrap-and-stream')])
      .mockResolvedValueOnce([record('during-reconnect')])
    const ds = { suggestions }

    await refreshSuggestionsOnConnection({ type: 'connection', state: 'connected' }, data, ds, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['between-bootstrap-and-stream'])
    await refreshSuggestionsOnConnection({ type: 'connection', state: 'reconnecting' }, data, ds, true, rerender)
    expect(suggestions).toHaveBeenCalledOnce()
    await refreshSuggestionsOnConnection({ type: 'connection', state: 'connected' }, data, ds, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['during-reconnect'])
    expect(suggestions).toHaveBeenCalledTimes(2)
    expect(rerender).toHaveBeenCalledTimes(2)
  })
})

describe('light is the only default theme', () => {
  it('reads every value but dark as light, so a legacy hash cannot resurrect a third state', () => {
    expect(themeName('dark')).toBe('dark')
    expect(themeName('light')).toBe('light')
    expect(themeName(undefined)).toBe('light')
    expect(themeName('auto')).toBe('light')
  })

  it('cycles exactly two states and clears the key on the default so the light hash stays clean', () => {
    expect(cycleTheme(undefined)).toBe('dark')
    expect(cycleTheme('dark')).toBeUndefined()
    expect(cycleTheme(cycleTheme(undefined))).toBeUndefined()
    expect(cycleTheme('auto')).toBe('dark')
  })
})

/**
 * The one shell state with no session at all: a saved `orangu repo|global --html` file. Every label
 * that would otherwise name a session has to name the scope instead, or it names nothing true.
 */
const analysis = { session: { id: 'abc12345-6789', title: 'Ship the aggregate report' }, agents: { runs: [] } } as unknown as Analysis

function appData(over: Partial<AppData> = {}): AppData {
  return {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions: [],
    ...over,
  }
}

function aggReport(scope: 'repo' | 'global', label: string): AppData {
  const agg = { scope: label, sessionCount: 12 } as unknown as Aggregate
  return appData({ selectedId: undefined, session: undefined, aggregates: { [scope]: agg }, capabilities: { live: false, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false } })
}

describe('a report about a scope, not a session', () => {
  it('names the scope in the browser tab when there is no session to name', () => {
    expect(docTitle(aggReport('repo', 'repo orangu'), undefined, undefined)).toBe('orangu · repo orangu')
    expect(docTitle(aggReport('global', 'global'), undefined, undefined)).toBe('orangu · global')
  })

  it('still prefers the session title, then the short id, then the generic fallback', () => {
    expect(docTitle(appData(), analysis, analysis.session.id)).toBe('orangu · Ship the aggregate report')
    expect(docTitle(appData(), undefined, 'abc12345-6789')).toBe('orangu · abc12345')
    expect(docTitle(appData({ selectedId: undefined, session: undefined }), undefined, undefined)).toBe('orangu · report')
  })

  it('labels the sidebar card Scope when the file carries no session', () => {
    expect(sesscardEyebrow(aggReport('repo', 'repo orangu'))).toBe('Scope')
    expect(sesscardEyebrow(appData())).toBe('Session')
  })

  it('still says Session in serve, where the card holds the session picker', () => {
    // serve can bootstrap with session: undefined (an empty registry, or a first analysis that throws)
    // and never writes it back. The card renders the picker there, so Scope would name a scope the
    // served app is not about and does not show.
    expect(sesscardEyebrow(appData({ mode: 'serve', selectedId: undefined, session: undefined }))).toBe('Session')
  })

  it('gives the Suggest header the same scope its body defaulted to', () => {
    const sub = (data: AppData, scope?: 'repo' | 'global'): string =>
      screenSub({ data, state: { screen: 'suggest', ...(scope ? { scope } : {}) }, audience: 'dev' } as Parameters<typeof screenSub>[0])
    expect(sub(aggReport('repo', 'repo orangu'))).toBe('recurring patterns · one proposal per improvement · whole-harness review')
    expect(sub(aggReport('global', 'global'))).toBe('recurring patterns · one proposal per improvement · whole-harness review')
    expect(sub(appData())).toBe('this session · one proposal per improvement')
    expect(sub(appData(), 'repo')).toBe('recurring patterns · one proposal per improvement · whole-harness review')
  })
})

/**
 * The page head "Show me" control copies the show-me command for what the page shows: the scope on
 * Repo and Global and on a scoped Improvements screen, else the session, else the scope a saved file is
 * about. Copy only: nothing runs from the report.
 */
describe('the Show me command for each data shape', () => {
  const show = (d: AppData, state: RouteState, a?: Analysis): string => showMeCommand(d, state, a)
  const session = 'claude "/orangu:show-me abc12345-6789"'

  it('copies the session on a session screen of a session report', () => {
    for (const screen of ['overview', 'timeline', 'tools', 'context', 'coverage', 'harness']) expect(show(appData(), { screen }, analysis), screen).toBe(session)
  })

  it('copies the scope on Repo and Global, whatever the file carries', () => {
    expect(show(appData(), { screen: 'repo' }, analysis)).toBe('claude "/orangu:show-me --scope repo"')
    expect(show(appData(), { screen: 'global' }, analysis)).toBe('claude "/orangu:show-me --scope global"')
    expect(show(aggReport('repo', 'repo orangu'), { screen: 'global' })).toBe('claude "/orangu:show-me --scope global"')
  })

  it('copies the scope of a scoped Improvements screen, from the hash, else from the file', () => {
    expect(show(appData(), { screen: 'suggest', scope: 'repo' }, analysis)).toBe('claude "/orangu:show-me --scope repo"')
    expect(show(appData(), { screen: 'suggest', scope: 'global' }, analysis)).toBe('claude "/orangu:show-me --scope global"')
    expect(show(appData(), { screen: 'suggest', scope: 'session' }, analysis)).toBe(session)
    expect(show(appData(), { screen: 'suggest' }, analysis)).toBe(session)
    expect(show(aggReport('global', 'global'), { screen: 'suggest' })).toBe('claude "/orangu:show-me --scope global"')
  })

  // the sidebar links carry scope= onto every screen, so only the Improvements screen may read it
  it('ignores a scope the sidebar carried onto a session screen', () => {
    expect(show(appData(), { screen: 'overview', scope: 'repo' }, analysis)).toBe(session)
  })

  it('copies the scope a saved scope report is about on any other screen', () => {
    expect(show(aggReport('repo', 'repo orangu'), { screen: 'overview' })).toBe('claude "/orangu:show-me --scope repo"')
    expect(show(aggReport('global', 'global'), { screen: 'harness' })).toBe('claude "/orangu:show-me --scope global"')
  })

  it('has nothing to copy in a served app before its first analysis, so no control renders', () => {
    const served = appData({ mode: 'serve', selectedId: undefined, session: undefined })
    expect(show(served, { screen: 'overview' })).toBe('')
    expect(showMe(served, { screen: 'overview' })).toBe('')
  })

  // the id lands inside a command a reader pastes in a shell
  it('never copies a session id that carries shell characters', () => {
    const odd = { session: { id: 'x"; touch bad; "' } } as unknown as Analysis
    expect(show(appData(), { screen: 'overview' }, odd)).toBe('')
    expect(showMe(appData(), { screen: 'overview' }, odd)).toBe('')
  })

  it('renders a popover that the re-open seam keeps: the command bar, the paste line and the 2 install lines', () => {
    const withCwd = { session: { id: 'abc12345-6789', cwd: '~/Code/demo' } } as unknown as Analysis
    const html = showMe(appData(), { screen: 'overview' }, withCwd)
    expect(html).toContain('<details class="show-me" id="show-me"><summary class="btn btn-show">Show me</summary>')
    expect(html).toContain('Claude Code turns this evidence into a slide deck and a written report, as 2 offline HTML files.')
    expect(html).toContain('data-copy="claude &quot;/orangu:show-me abc12345-6789&quot;" aria-label="copy the show me command"')
    expect(html).toContain('aria-label="copy the marketplace command"')
    expect(html).toContain('aria-label="copy the install command"')
    expect(html).toContain('Paste it in a terminal in ~/Code/demo. It starts Claude Code. The files open in your browser.')
    expect(html).toContain('First time only, type these 2 lines in Claude Code:')
    expect(html).toContain('data-copy="/plugin marketplace add NissanOhana/orangu"')
    expect(html).toContain('data-copy="/plugin install orangu"')
    expect(showMe(aggReport('repo', 'repo orangu'), { screen: 'repo' })).toContain('Paste it in a terminal in this repository. It starts Claude Code.')
    expect(showMe(aggReport('global', 'global'), { screen: 'global' })).toContain('Paste it in a terminal. It starts Claude Code.')
  })
})

/** One noun names the screen: the sidebar item and the page title cannot drift apart. */
describe('the Improvements screen has one name', () => {
  it('uses the same noun in the sidebar and in the page title', () => {
    const item = navFor(appData(), { screen: 'suggest' }).find((g) => g.id === 'improve')!.items[0]!
    expect(item.label).toBe('Improvements')
    expect(screenTitle('suggest')).toBe(item.label)
  })
})

/**
 * A click and a live tick share one render seam, and they must not share one delay. The throttle
 * exists for the SSE stream; a person who clicked is owed the next frame, not the rest of a window
 * they never saw start.
 */
describe('a click is never throttled behind a live tick', () => {
  it('renders user navigation on the next frame however recently the last render painted', () => {
    expect(renderWait(true, 1_000, 1_000)).toBe(0)
    expect(renderWait(true, 1_000, 1_001)).toBe(0)
    expect(renderWait(true, 1_000, 1_599)).toBe(0)
  })

  it('keeps the whole floor for a data-driven re-render inside the window', () => {
    expect(renderWait(false, 1_000, 1_000)).toBe(600)
    expect(renderWait(false, 1_000, 1_200)).toBe(400)
    expect(renderWait(false, 1_000, 1_599)).toBe(1)
  })

  it('never delays a data-driven re-render once the window has passed', () => {
    expect(renderWait(false, 1_000, 1_600)).toBe(0)
    expect(renderWait(false, 1_000, 9_000)).toBe(0)
  })
})

/**
 * A blocked build paints no frames, so neither a timer nor a CSS delay can decide this after the
 * fact: the only frame the reader gets is the one yielded before the build, and the loader is
 * either in it or never seen. The decision therefore has to be a prediction, made before the build.
 */
describe('a loading state only where the reader would otherwise wait', () => {
  it('paints one for a screen that measured slow last time', () => {
    expect(showLoader(304)).toBe(true)
    expect(showLoader(81)).toBe(true)
  })

  it('paints none for a screen that measured fast, so a quick click never flashes', () => {
    expect(showLoader(80)).toBe(false)
    expect(showLoader(5)).toBe(false)
    expect(showLoader(0)).toBe(false)
  })

  it('treats a screen it has never built as slow, because a first visit is the worst freeze', () => {
    expect(showLoader(undefined)).toBe(true)
  })
})
