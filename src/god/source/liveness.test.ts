/**
 * The liveness rule: a PID in the last agents list, or a registry file newer than that list. When the agents list
 * fails, a PID counts only when ps in UTC shows its procStart. Fixtures are synthetic (test/fixtures/god): 3 sessions
 * in the agents list, 5 registry files (1 new session that the list does not show yet, 1 file that a crash left
 * behind), and a ps read in UTC where the PID of the crashed session runs a new process.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DirEntry, Host } from '../host.js'
import type { RegistryRow } from '../types.js'
import { liveSessions, parseAgents, readRegistry, type AgentsList } from './agents.js'
import { parsePs } from './cmux.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

/** the clock before the last `claude agents --json` ran: 2026-10-09 09:59:40 UTC */
const LISTED_AT = 1791539980000
const ID = (letter: string): string => `00000000-0000-4000-8000-00000000000${letter}`
const keep = (text: string): string => text
const refuse = async (): Promise<never> => {
  throw new Error('this test gives no such call')
}

/** The registry folder as the engine lists it: the 5 fixture files, with test-chosen mtimes. */
const MTIMES: Readonly<Record<string, number>> = {
  '41001.json': 1791539880000, // 09:58:00, before the list
  '41002.json': 1791539990000, // 09:59:50, after the list
  '41003.json': 1791536400000, // 09:00:00
  '41004.json': 1791539985000, // 09:59:45, after the list: a new session
  '41009.json': 1791495000000, // the day before: a crash left it
}

async function registryRows(mtimes: Readonly<Record<string, number>> = MTIMES): Promise<readonly RegistryRow[]> {
  const files = Object.fromEntries(Object.keys(mtimes).map((name) => [name, fixture(`registry/${name}`)]))
  const listing: DirEntry[] = Object.entries(mtimes).map(([name, mtimeMs]) => ({ name, kind: 'file', size: files[name]?.length ?? 0, mtimeMs, isLink: false }))
  const host: Host = {
    run: refuse,
    list: async () => listing,
    read: async (path) => files[path.slice(path.lastIndexOf('/') + 1)] ?? refuse(),
    stat: refuse,
    now: refuse,
  }
  const read = await readRegistry(host, '/Users/test', {}, keep)
  if (!read.ok) throw new Error(read.reason)
  return read.value.rows
}

function agentsList(): AgentsList {
  const parsed = parseAgents(fixture('agents.json'), keep)
  if (!parsed) throw new Error('the agents fixture does not parse')
  return { rows: parsed.rows, listedAt: LISTED_AT, parseErrors: parsed.parseErrors }
}

describe('liveSessions: the liveness rule', () => {
  it('a PID in the agents list and in a registry file is 1 row, with its status from the registry file', async () => {
    const live = liveSessions({ agents: agentsList(), registry: await registryRows() })
    expect(live.filter((row) => row.pid === 41002)).toEqual([
      {
        pid: 41002,
        sessionId: ID('b'),
        cwd: '/Users/test/code/alpha-wt/feature',
        name: 'alpha feature',
        kind: 'interactive',
        status: 'waiting',
        waitingFor: 'permission prompt',
        startedAt: 1791534600000,
        statusSince: 1791539990000,
        version: '2.1.295',
      },
    ])
    expect(live.find((row) => row.pid === 41001)).toMatchObject({ status: 'busy', statusSince: 1791539880000, version: '2.1.295' })
  })

  it('takes the name, the cwd and the session id from the agents list when both sources have the PID', async () => {
    const registry = (await registryRows()).map((row) => (row.pid === 41001 ? { ...row, name: 'renamed', cwd: '/Users/test/elsewhere' } : row))
    const live = liveSessions({ agents: agentsList(), registry })
    expect(live.find((row) => row.pid === 41001)).toMatchObject({ name: 'alpha main', cwd: '/Users/test/code/alpha', sessionId: ID('a') })
  })

  it('a registry file newer than the last list counts as live', async () => {
    const live = liveSessions({ agents: agentsList(), registry: await registryRows() })
    expect(live.find((row) => row.pid === 41004)).toEqual({
      pid: 41004,
      sessionId: ID('d'),
      cwd: '/Users/test/code/gamma',
      name: 'gamma',
      kind: 'interactive',
      status: 'idle',
      startedAt: 1791539970000,
      statusSince: 1791539985000,
      version: '2.1.295',
    })
  })

  it('a registry file older than the last list, with a PID that the list does not show, is not live', async () => {
    const live = liveSessions({ agents: agentsList(), registry: await registryRows() })
    expect(live.map((row) => row.pid)).toEqual([41001, 41002, 41003, 41004])
  })

  it('a PID in the list with no registry file is live with the list facts only', () => {
    const live = liveSessions({ agents: agentsList(), registry: [] })
    expect(live.map((row) => row.pid)).toEqual([41001, 41002, 41003])
    expect(live.every((row) => !('statusSince' in row) && !('version' in row))).toBe(true)
  })

  it('when the agents list fails, a PID counts only when ps in UTC shows its procStart: a stale file with a reused PID fails', async () => {
    const ps = parsePs(fixture('ps.txt'))
    const live = liveSessions({ registry: await registryRows(), procStarts: ps.rows })
    expect(live.map((row) => row.pid)).toEqual([41001, 41002, 41003, 41004])
    expect(live.find((row) => row.pid === 41002)).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt', name: 'alpha feature' })
  })

  it('compares procStart as written: 1 space in place of 2, a local time or no procStart fails', async () => {
    const registry = (await registryRows()).filter((row) => row.pid === 41001 || row.pid === 41003)
    const noProcStart = registry.map((row) => {
      if (row.pid !== 41003) return row
      const { procStart: _dropped, ...rest } = row
      return rest
    })
    expect(liveSessions({ registry, procStarts: [{ pid: 41001, lstart: 'Fri Oct 9 08:00:00 2026' }] })).toEqual([])
    expect(liveSessions({ registry, procStarts: [{ pid: 41001, lstart: 'Fri Oct  9 11:00:00 2026' }] })).toEqual([])
    expect(liveSessions({ registry: noProcStart, procStarts: [{ pid: 41003, lstart: 'Fri Oct  9 09:00:00 2026' }] })).toEqual([])
    expect(liveSessions({ registry, procStarts: [{ pid: 41001, lstart: 'Fri Oct  9 08:00:00 2026' }] }).map((row) => row.pid)).toEqual([41001])
  })

  it('keeps a session whose registry status is shell on the board as busy when the agents list fails', async () => {
    const registry = await registryRows({ '41005.json': 1791537660000 })
    const live = liveSessions({ registry, procStarts: [{ pid: 41005, lstart: 'Fri Oct  9 09:20:00 2026' }] })
    expect(live).toEqual([
      {
        pid: 41005,
        sessionId: '00000000-0000-4000-8000-000000000010',
        cwd: '/Users/test/code/epsilon',
        name: 'epsilon shell',
        kind: 'interactive',
        status: 'busy',
        startedAt: 1791537600000,
        statusSince: 1791537660000,
        version: '2.1.295',
      },
    ])
  })

  it('with no agents list and no ps read, no PID counts', async () => {
    expect(liveSessions({ registry: await registryRows() })).toEqual([])
  })

  it('gives 1 row per session id: when 2 live PIDs share an id, the newer process stays', () => {
    const list: AgentsList = {
      listedAt: LISTED_AT,
      parseErrors: 0,
      rows: [
        { pid: 500, sessionId: ID('f'), cwd: '/w', name: 'old', kind: 'interactive', status: 'idle', startedAt: 100 },
        { pid: 300, sessionId: ID('f'), cwd: '/w', name: 'new', kind: 'interactive', status: 'busy', startedAt: 200 },
      ],
    }
    expect(liveSessions({ agents: list, registry: [] })).toEqual([{ pid: 300, sessionId: ID('f'), cwd: '/w', name: 'new', kind: 'interactive', status: 'busy', startedAt: 200 }])
  })
})
