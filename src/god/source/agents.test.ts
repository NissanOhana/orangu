/**
 * The live session list: `claude agents --json` and the registry files. liveness.test.ts holds the rule that merges
 * them. Fixtures are synthetic (test/fixtures/god): 3 sessions in the agents list and 5 registry files.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DirEntry, Host, RunOptions, RunResult } from '../host.js'
import type { RegistryRow } from '../types.js'
import { parseAgents, readAgents, readRegistry, registryFolder, type RegistryCache } from './agents.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const HOME = '/Users/test'
const FOLDER = '/Users/test/.claude/sessions'
/** the clock before the last `claude agents --json` ran: 2026-10-09 09:59:40 UTC */
const LISTED_AT = 1791539980000
const ID = (letter: string): string => `00000000-0000-4000-8000-00000000000${letter}`
const keep = (text: string): string => text

const refuse = async (): Promise<never> => {
  throw new Error('this test gives no such call')
}
const result = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** The registry folder as the engine lists it: the 5 fixture files, with test-chosen mtimes. */
const MTIMES: Readonly<Record<string, number>> = {
  '41001.json': 1791539880000, // 09:58:00, before the list
  '41002.json': 1791539990000, // 09:59:50, after the list
  '41003.json': 1791536400000, // 09:00:00
  '41004.json': 1791539985000, // 09:59:45, after the list: a new session
  '41009.json': 1791495000000, // the day before: a crash left it
}
const FILES: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(MTIMES).map((name) => [name, fixture(`registry/${name}`)]))
const fileEntry = (name: string, mtimeMs = MTIMES[name] ?? 0, body = FILES[name] ?? ''): DirEntry => ({ name, kind: 'file', size: body.length, mtimeMs, isLink: false })
const LISTING: readonly DirEntry[] = Object.keys(MTIMES).map((name) => fileEntry(name))

/** A host over the registry folder that records each read and fails the test on a read of a `.key` file. */
function registryHost(listing: readonly DirEntry[], files: Readonly<Record<string, string>> = FILES): { host: Host; reads: string[] } {
  const reads: string[] = []
  const host: Host = {
    run: refuse,
    list: async (path) => {
      if (path !== FOLDER) throw new Error('no such folder')
      return listing
    },
    read: async (path) => {
      reads.push(path.slice(FOLDER.length + 1))
      if (path.endsWith('.key')) throw new Error('a .key file must never be read')
      const body = files[path.slice(FOLDER.length + 1)]
      if (body === undefined) throw new Error('the file is gone')
      return body
    },
    stat: refuse,
    now: refuse,
  }
  return { host, reads }
}

async function registryRows(): Promise<readonly RegistryRow[]> {
  const read = await readRegistry(registryHost(LISTING).host, HOME, {}, keep)
  if (!read.ok) throw new Error(read.reason)
  return read.value.rows
}

describe('parseAgents: claude agents --json', () => {
  it('reads each row, and leaves waitingFor out of a row that does not wait', () => {
    const parsed = parseAgents(fixture('agents.json'), keep)
    expect(parsed?.parseErrors).toBe(0)
    expect(parsed?.rows.map((row) => row.pid)).toEqual([41001, 41002, 41003])
    expect(parsed?.rows[0]).toEqual({
      pid: 41001,
      sessionId: ID('a'),
      cwd: '/Users/test/code/alpha',
      name: 'alpha main',
      kind: 'interactive',
      status: 'busy',
      startedAt: 1791532800000,
    })
    expect(parsed?.rows.every((row) => !('waitingFor' in row))).toBe(true)
  })

  it('keeps waitingFor only while the status is waiting', () => {
    const rows = [
      { pid: 7, sessionId: ID('1'), cwd: '/w', name: 'n', kind: 'interactive', status: 'waiting', waitingFor: 'input needed' },
      { pid: 8, sessionId: ID('2'), cwd: '/w', name: 'n', kind: 'interactive', status: 'idle', waitingFor: 'input needed' },
    ]
    const parsed = parseAgents(JSON.stringify(rows), keep)
    expect(parsed?.rows.map((row) => row.waitingFor)).toEqual(['input needed', undefined])
    expect(parsed?.rows[1] && 'waitingFor' in parsed.rows[1]).toBe(false)
  })

  it('counts a row with an unknown status, a bad PID, no cwd or an unsafe session id as a parse error, with no row', () => {
    const good = { pid: 7, sessionId: ID('1'), cwd: '/w', name: 'n', kind: 'interactive', status: 'idle' }
    const rows = [
      good,
      { ...good, status: 'sleeping' },
      { ...good, pid: 0 },
      { ...good, pid: 7.5 },
      { ...good, pid: '7' },
      { ...good, cwd: undefined },
      { ...good, sessionId: '../../etc/x' },
      { ...good, sessionId: '' },
      'not a row',
      null,
    ]
    const parsed = parseAgents(JSON.stringify(rows), keep)
    expect(parsed?.rows).toHaveLength(1)
    expect(parsed?.parseErrors).toBe(9)
  })

  it('fills an absent, empty or blank name with the first 8 characters of the session id, and takes an absent kind as empty text', () => {
    const rows = [
      { pid: 7, sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', cwd: '/w', status: 'busy' },
      { pid: 8, sessionId: 'e5f6a7b8-0000-4000-8000-000000000002', cwd: '/w', name: '', kind: 'interactive', status: 'idle' },
      { pid: 9, sessionId: 'c9d0e1f2-0000-4000-8000-000000000003', cwd: '/w', name: '  ', kind: 'interactive', status: 'idle' },
    ]
    const parsed = parseAgents(JSON.stringify(rows), keep)
    expect(parsed?.rows).toEqual([
      { pid: 7, sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', cwd: '/w', name: 'a1b2c3d4', kind: '', status: 'busy' },
      { pid: 8, sessionId: 'e5f6a7b8-0000-4000-8000-000000000002', cwd: '/w', name: 'e5f6a7b8', kind: 'interactive', status: 'idle' },
      { pid: 9, sessionId: 'c9d0e1f2-0000-4000-8000-000000000003', cwd: '/w', name: 'c9d0e1f2', kind: 'interactive', status: 'idle' },
    ])
  })

  it('fills a name that the cleaner empties, so a flag line on another row always has a name to show', () => {
    const row = { pid: 7, sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', cwd: '/w', name: 'x', kind: 'interactive', status: 'busy' }
    expect(parseAgents(JSON.stringify([row]), () => '')?.rows[0]?.name).toBe('a1b2c3d4')
  })

  it('fills an empty name in a registry file too', async () => {
    const files = { ...FILES, '41003.json': FILES['41003.json']?.replace('"name": "beta docs"', '"name": ""') ?? '' }
    const read = await readRegistry(registryHost(LISTING, files).host, HOME, {}, keep)
    expect(read.ok && read.value.rows.find((row) => row.pid === 41003)?.name).toBe('00000000')
  })

  it('cleans the name and the waiting reason with the cleaner it gets, and keeps the cwd as on disk', () => {
    const row = { pid: 7, sessionId: ID('1'), cwd: '/Users/test/w', name: 'n', kind: 'interactive', status: 'waiting', waitingFor: 'dialog open' }
    const parsed = parseAgents(JSON.stringify([row]), (text) => `[${text}]`)
    expect(parsed?.rows[0]).toMatchObject({ name: '[n]', waitingFor: '[dialog open]', cwd: '/Users/test/w', kind: 'interactive' })
  })

  it('gives no list when the output is not a JSON list', () => {
    expect(parseAgents('{"agents":[]}', keep)).toBeUndefined()
    expect(parseAgents('not json', keep)).toBeUndefined()
    expect(parseAgents('', keep)).toBeUndefined()
  })
})

describe('readAgents: 1 run of claude agents --json', () => {
  it('runs the command by argv and stamps the list with the clock before the run', async () => {
    const events: string[] = []
    const calls: { argv: readonly string[]; options?: RunOptions }[] = []
    const host: Host = {
      run: async (argv, options) => {
        events.push('run')
        calls.push({ argv, ...(options ? { options } : {}) })
        return result(fixture('agents.json'))
      },
      list: refuse,
      read: refuse,
      stat: refuse,
      now: async () => {
        events.push('now')
        return LISTED_AT
      },
    }
    const read = await readAgents(host, keep)
    expect(events).toEqual(['now', 'run'])
    expect(calls).toEqual([{ argv: ['claude', 'agents', '--json'] }])
    expect(read.ok && read.value.listedAt).toBe(LISTED_AT)
    expect(read.ok && read.value.rows.map((row) => row.sessionId)).toEqual([ID('a'), ID('b'), ID('c')])
  })

  it('turns a failed run, an exit code, a bad output and a failed clock into a source failure, never a throw', async () => {
    const hostWith = (run: Host['run'], now: Host['now'] = async () => LISTED_AT): Host => ({ run, list: refuse, read: refuse, stat: refuse, now })
    const cases: Host[] = [
      hostWith(async () => {
        throw new Error('spawn claude ENOENT')
      }),
      hostWith(async () => result('', 1)),
      hostWith(async () => result('{"partial":')),
      hostWith(async () => result(fixture('agents.json')), refuse),
    ]
    for (const host of cases) {
      const read = await readAgents(host, keep)
      expect(read.ok).toBe(false)
      if (!read.ok) {
        expect(read.status).toBe('off')
        expect(read.reason).toMatch(/^The .+\.$/)
        expect(read.reason).not.toMatch(/ENOENT|partial/)
      }
    }
  })
})

describe('readRegistry: the files <home>/.claude/sessions/<pid>.json', () => {
  it('reads only the <pid>.json files: never a .key file, a link, a folder or a temp file', async () => {
    const listing: DirEntry[] = [
      ...LISTING,
      { name: `41001.${'0'.repeat(64)}.key`, kind: 'file', size: 32, mtimeMs: LISTED_AT, isLink: false },
      { name: '41005.json', kind: 'file', size: 10, mtimeMs: LISTED_AT, isLink: true },
      { name: '41006.json', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: '41001.json.tmp', kind: 'file', size: 10, mtimeMs: LISTED_AT, isLink: false },
      { name: 'notes.json', kind: 'file', size: 10, mtimeMs: LISTED_AT, isLink: false },
    ]
    const { host, reads } = registryHost(listing)
    const read = await readRegistry(host, HOME, {}, keep)
    expect(reads.sort()).toEqual(['41001.json', '41002.json', '41003.json', '41004.json', '41009.json'])
    expect(read.ok && read.value.rows.map((row) => row.pid)).toEqual([41001, 41002, 41003, 41004, 41009])
    expect(read.ok && read.value.parseErrors).toBe(0)
  })

  it('reads again only the files whose size or mtime changed', async () => {
    const first = registryHost(LISTING)
    const one = await readRegistry(first.host, HOME, {}, keep)
    if (!one.ok) throw new Error(one.reason)
    expect(one.value.filesRead).toBe(5)

    const same = registryHost(LISTING)
    const two = await readRegistry(same.host, HOME, one.value.cache, keep)
    expect(same.reads).toEqual([])
    expect(two.ok && two.value.rows).toEqual(one.value.rows)
    expect(two.ok && two.value.filesRead).toBe(0)

    const changed = LISTING.map((entry) => (entry.name === '41002.json' ? { ...entry, mtimeMs: entry.mtimeMs + 1000 } : entry.name === '41003.json' ? { ...entry, size: entry.size + 1 } : entry))
    const third = registryHost(changed)
    const three = await readRegistry(third.host, HOME, one.value.cache, keep)
    expect(third.reads.sort()).toEqual(['41002.json', '41003.json'])
    expect(three.ok && three.value.rows.find((row) => row.pid === 41002)?.fileMtimeMs).toBe(1791539990000 + 1000)
  })

  it('drops a file that the listing no longer shows', async () => {
    const first = await readRegistry(registryHost(LISTING).host, HOME, {}, keep)
    if (!first.ok) throw new Error(first.reason)
    const gone = LISTING.filter((entry) => entry.name !== '41009.json')
    const next = await readRegistry(registryHost(gone).host, HOME, first.value.cache, keep)
    expect(next.ok && next.value.rows.map((row) => row.pid)).toEqual([41001, 41002, 41003, 41004])
    expect(next.ok && Object.keys(next.value.cache).sort()).toEqual(['41001.json', '41002.json', '41003.json', '41004.json'])
  })

  it('counts a file that does not parse, or that names another PID, as a parse error, and reads it again on the next tick', async () => {
    const files = { ...FILES, '41001.json': '{"pid": 41001, "sess', '41003.json': FILES['41003.json']?.replace('"pid": 41003', '"pid": 41077') ?? '' }
    const first = registryHost(LISTING, files)
    const one = await readRegistry(first.host, HOME, {}, keep)
    expect(one.ok && one.value.parseErrors).toBe(2)
    expect(one.ok && one.value.rows.map((row) => row.pid)).toEqual([41002, 41004, 41009])
    if (!one.ok) throw new Error(one.reason)
    const second = registryHost(LISTING)
    const two = await readRegistry(second.host, HOME, one.value.cache, keep)
    expect(second.reads.sort()).toEqual(['41001.json', '41003.json'])
    expect(two.ok && two.value.parseErrors).toBe(0)
  })

  it('skips a file that goes away between the list and the read: no row and no parse error', async () => {
    const files = { ...FILES }
    delete (files as Record<string, string>)['41009.json']
    const read = await readRegistry(registryHost(LISTING, files).host, HOME, {}, keep)
    expect(read.ok && read.value.rows.map((row) => row.pid)).toEqual([41001, 41002, 41003, 41004])
    expect(read.ok && read.value.parseErrors).toBe(0)
  })

  it('takes fileMtimeMs from the listing, keeps procStart as the file writes it, and leaves out what the file does not have', async () => {
    const rows = await registryRows()
    expect(rows.find((row) => row.pid === 41002)).toEqual({
      pid: 41002,
      sessionId: ID('b'),
      cwd: '/Users/test/code/alpha-wt/feature',
      name: 'alpha feature',
      kind: 'interactive',
      status: 'waiting',
      waitingFor: 'permission prompt',
      startedAt: 1791534600000,
      statusUpdatedAt: 1791539990000,
      procStart: 'Fri Oct  9 08:30:00 2026',
      version: '2.1.295',
      fileMtimeMs: 1791539990000,
    })
    expect(rows.find((row) => row.pid === 41001)).not.toHaveProperty('waitingFor')
  })

  it('turns a registry folder that cannot be listed into a source failure', async () => {
    const host: Host = { run: refuse, list: refuse, read: refuse, stat: refuse, now: refuse }
    const read = await readRegistry(host, HOME, {}, keep)
    expect(read).toEqual({ ok: false, status: 'off', reason: expect.stringMatching(/^The .+\.$/) })
  })

  it('names the registry folder under the home folder', () => {
    expect(registryFolder(HOME)).toBe(FOLDER)
  })

  it('keeps the plain registry cache JSON data', async () => {
    const read = await readRegistry(registryHost(LISTING).host, HOME, {}, keep)
    const cache: RegistryCache = read.ok ? read.value.cache : {}
    expect(JSON.parse(JSON.stringify(cache))).toEqual(cache)
  })
})
