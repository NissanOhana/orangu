import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { aggregate } from '../analyze/aggregate.js'
import { analyzeSession } from '../analyze/analyze.js'
import { prepareAggregateForOutput } from '../cli/json-out.js'
import { renderAggregateReport, renderReport } from '../report/render.js'
import { SuggestionStore } from '../suggest/store.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { startServe, type ServeHandle } from './server.js'
import type { ServeOptions } from './types.js'

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
  vi.unstubAllEnvs()
})

/**
 * A home folder of its own for the run, so the scrub rewrites it to `~`, and no Claude folder of this machine is
 * read: each root of these tests is under the new home, and none of them exists.
 */
async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orangu-app-roots-home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  return home
}

/** The `/api/app` body of a server started with these options. */
async function appBody(extra: Partial<ServeOptions>): Promise<{ data: Record<string, unknown>; text: string }> {
  const storeHome = await mkdtemp(join(tmpdir(), 'orangu-app-roots-store-'))
  srv = await startServe({ open: false, includeText: false, noCache: true, version: 'test', ...extra }, { quiet: true, store: new SuggestionStore({ home: storeHome }) })
  const response = await fetch(srv.url + '/api/app')
  expect(response.status).toBe(200)
  const text = await response.text()
  return { data: JSON.parse(text) as Record<string, unknown>, text }
}

/** The AppData that a file report embeds in `#orangu-data`. */
function embedded(html: string): Record<string, unknown> {
  const start = html.indexOf('id="orangu-data">') + 'id="orangu-data">'.length
  return JSON.parse(html.slice(start, html.indexOf('</script>', start))) as Record<string, unknown>
}

async function fixtureAnalysis() {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  return analyzeSession(session, { version: 'test', now: 0 })
}

describe('AppData.roots', () => {
  it('serve: holds each root that serve reads, with the home as ~ and no raw home path', async () => {
    const home = await fakeHome()
    const { data, text } = await appBody({ roots: [join(home, '.claude'), join(home, '.config', 'claude')] })
    expect(data['mode']).toBe('serve')
    expect(data['roots']).toEqual(['~/.claude', '~/.config/claude'])
    expect(text).not.toContain(home)
  })

  it('serve: holds the config folder of serve when serve has no roots', async () => {
    const home = await fakeHome()
    const { data, text } = await appBody({ configDir: join(home, 'claude-config') })
    expect(data['roots']).toEqual(['~/claude-config'])
    expect(text).not.toContain(home)
  })

  it('serve: holds the default config folder when serve names no folder, also with an empty roots list', async () => {
    const home = await fakeHome()
    expect((await appBody({})).data['roots']).toEqual(['~/.claude'])
    await srv?.close()
    expect((await appBody({ roots: [] })).data['roots']).toEqual(['~/.claude'])
  })

  it('serve: keeps a root outside the home as it is', async () => {
    await fakeHome()
    const outside = await mkdtemp(join(tmpdir(), 'orangu-app-roots-outside-'))
    expect((await appBody({ roots: [outside] })).data['roots']).toEqual([outside])
  })

  it('file: neither the session report nor the aggregate report holds roots', async () => {
    const analysis = await fixtureAnalysis()
    const session = embedded(renderReport(analysis).html)
    expect(session['mode']).toBe('file')
    expect('roots' in session).toBe(false)
    const prepared = prepareAggregateForOutput(aggregate([analysis], 'repo demo', 1_700_000_000_000), {})
    const scope = embedded(renderAggregateReport(prepared, { scope: 'repo', scopeLabel: prepared.scope, includeText: false }).html)
    expect(scope['mode']).toBe('file')
    expect('roots' in scope).toBe(false)
  })
})
