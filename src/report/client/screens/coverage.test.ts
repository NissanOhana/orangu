import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import { STRIPPED_KEY, type AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { renderCoverage } from './coverage.js'

let markup = ''

beforeEach(() => {
  const stubEl = { addEventListener: () => {}, set innerHTML(_v: string) {}, textContent: '', value: '', checked: false }
  vi.stubGlobal('document', {
    createElement: () => ({
      content: { firstElementChild: { querySelector: () => stubEl } },
      set innerHTML(value: string) { markup = value },
    }),
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

async function context(unknownRecordTypes: Record<string, number>): Promise<Ctx> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const analysis = analyzeSession(session, { version: 'test', now: 0 })
  analysis.parse.unknownRecordTypes = unknownRecordTypes
  const data: AppData = {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions: [],
  }
  return { data, a: analysis, ds: {} as Ctx['ds'], state: { screen: 'coverage', s: analysis.session.id }, audience: 'dev', go: vi.fn() }
}

describe('renderCoverage under redaction', () => {
  it('never lists the redaction placeholder as a record type', async () => {
    renderCoverage(await context({ [STRIPPED_KEY]: 14 }))
    expect(markup).not.toContain(STRIPPED_KEY)
    expect(markup).not.toContain('×14')
    expect(markup).toContain('0 unrecognized record types (+14 records with redacted type names)')
    expect(markup).toContain('14 unrecognized records were counted; their type names are hidden by redaction')
    expect(markup).not.toContain('14 record type names')
  })
  it('lists real unknown types and adds the hidden-count note beside them', async () => {
    renderCoverage(await context({ foo: 2, [STRIPPED_KEY]: 14 }))
    expect(markup).toContain('1 unrecognized record type (+14 records with redacted type names).')
    expect(markup).toContain('foo ×2')
    expect(markup).not.toContain(STRIPPED_KEY)
    expect(markup).toContain('hidden by redaction')
  })
  it('renders no note and no card when nothing is unknown', async () => {
    renderCoverage(await context({}))
    expect(markup).not.toContain('hidden by redaction')
    expect(markup).not.toContain('Unrecognized records')
  })
})
