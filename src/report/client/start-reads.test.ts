/**
 * The reads of the start view (#start): which reads a render starts, and which reads never start on their own. A read
 * that analyzes every session starts only from its control (SPEC risk 13), and Sessions and agents reads only the
 * sessions that it lists. start-ui.test.ts draws each state of these reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { aggregate } from '../../analyze/aggregate.js'
import { analyzeSession } from '../../analyze/analyze.js'
import type { Analysis } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import type { DataSource, ReadWatch } from './data.js'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

/** The canonical fixture session, analyzed, under the id `id`: 2 turns, 1 subagent run and 2 findings. */
async function analysisOf(id = ID): Promise<Analysis> {
  const records = JSON.parse(JSON.stringify(buildCanonicalSession({ cwd: '/w/repo' }).toRecords()).split(ID).join(id)) as Record<string, unknown>[]
  return analyzeSession(await parseClaudeCodeSession({ records, noSidecar: true }), { version: 'test', now: 0 })
}

const A = await analysisOf()
const B = await analysisOf(OTHER)
/** The machine of 2 sessions, for the stub of the machine read. */
const MACHINE = aggregate([A, B], 'global', 0)

function row(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return { id: ID, projectSlug: 'demo', cwd: '/w/repo', title: 'Fix foo test', path: '/tmp/a.jsonl', source: 'claude-code', sizeBytes: 100, mtimeMs: 1_000, badge: 'ended', ageMs: 3 * 86_400_000, possiblyLive: false, tokens: 179_733, agentsTotal: 1, agentsRunning: 0, ...over }
}

function data(over: Partial<AppData> = {}): AppData {
  return {
    v: '1',
    mode: 'serve',
    version: 'test',
    generatedAt: 0,
    capabilities: { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: ID,
    session: A,
    sessions: [row()],
    roots: ['~/.claude'],
    aggregates: {},
    suggestions: [],
    ...over,
  }
}

describe('the reads of the start view', () => {
  /** A fresh module (its reads are module state) and a data source that records each read. */
  async function fresh() {
    vi.resetModules()
    const mod = await import('./start-reads.js')
    const session = vi.fn(async (id: string) => (id === ID ? A : B))
    const aggregate = vi.fn(async () => MACHINE)
    const harness = vi.fn(async () => null)
    const ds = { mode: 'serve', session, aggregate, harness, profile: async () => ({ exists: false, updatedAt: null }), subscribe: () => () => {} } as unknown as DataSource
    return { mod, ds, session, aggregate }
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('F1: starts no repository read and no machine read on its own, at any zoom', async () => {
    const { mod, ds, aggregate } = await fresh()
    const d = data({ sessions: [row({ id: 'r1', badge: 'live' }), row({ id: 'r2', badge: 'live' }), row({ id: ID })] })
    for (const zoom of [undefined, 'session', 'sessions', 'machine'] as const) mod.ensureStart(d, ds, { screen: 'start', ...(zoom ? { zoom } : {}) }, vi.fn())
    await flush()
    expect(aggregate).not.toHaveBeenCalled()
    expect(mod.machineRead(d)).toBe(false)
  })

  it('F2: reads each listed session through the session read, the running ones and the 20 newest, and no other', async () => {
    const { mod, ds, session } = await fresh()
    const many = Array.from({ length: 30 }, (_, i) => row({ id: `s${String(i).padStart(7, '0')}`, mtimeMs: 1_000 - i }))
    many.push(row({ id: 'live0001', badge: 'live', mtimeMs: 5_000 }))
    mod.ensureStart(data({ sessions: many }), ds, { screen: 'start', zoom: 'sessions' }, vi.fn())
    await flush()
    const ids = session.mock.calls.map(([id]) => id)
    expect(ids).toEqual(['live0001', ...many.slice(0, 20).map((r) => r.id)])
    // a second render reads nothing again
    mod.ensureStart(data({ sessions: many }), ds, { screen: 'start', zoom: 'sessions' }, vi.fn())
    await flush()
    expect(session.mock.calls).toHaveLength(ids.length)
  })

  it('keeps a machine read that paused at the poll limit as a pause, with no failure, because serve reads on', async () => {
    const { mod, ds } = await fresh()
    // the poll of data-remote.ts stops at its time limit, says so, and gives null
    const aggregate = vi.fn(async (_scope: string, _cwd?: string, watch?: ReadWatch) => {
      watch?.paused?.()
      return null
    })
    const d = data()
    mod.ensureStart(d, { ...ds, aggregate } as DataSource, { screen: 'start', zoom: 'machine' }, vi.fn())
    await mod.readMachine(d)
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(mod.startReadState().machine).toEqual({ asked: true, busy: false, paused: true })
    // the person asked, so the harness read of This machine may start (serve-ui.ts)
    expect(mod.machineRead(d)).toBe(true)
  })

  it('F2: reads no listed session at the other zooms', async () => {
    const { mod, ds, session } = await fresh()
    for (const zoom of ['session', 'machine'] as const) mod.ensureStart(data({ sessions: [row({ id: 'r1' }), row({ id: 'r2' })] }), ds, { screen: 'start', zoom }, vi.fn())
    await flush()
    expect(session).not.toHaveBeenCalled()
  })
})
