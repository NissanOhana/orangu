/**
 * The cmux tab map: `cmux capabilities` once at start, `cmux tree --all --json`, `ps` in UTC, and the map from a
 * PID to its TTY to the cmux workspace and surface. Fixtures are synthetic (test/fixtures/god): a tree with 2
 * windows, 3 workspaces, a browser surface and a plain shell, and a ps read of 5 PIDs.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Host, RunOptions, RunResult } from '../host.js'
import { mapTabs, parseCmuxTree, parsePs, readCmuxCapabilities, readCmuxTree, readPs, type CmuxSurface } from './cmux.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const keep = (text: string): string => text

const refuse = async (): Promise<never> => {
  throw new Error('this test gives no such call')
}
const result = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** A host whose run answers with the given function and records each call. */
function runHost(answer: (argv: readonly string[], options?: RunOptions) => Promise<RunResult>): { host: Host; calls: { argv: readonly string[]; options?: RunOptions }[] } {
  const calls: { argv: readonly string[]; options?: RunOptions }[] = []
  const host: Host = {
    run: async (argv, options) => {
      calls.push({ argv, ...(options ? { options } : {}) })
      return answer(argv, options)
    },
    list: refuse,
    read: refuse,
    stat: refuse,
    now: refuse,
  }
  return { host, calls }
}

const fails = async (): Promise<RunResult> => {
  throw new Error('spawn cmux ENOENT')
}

const CAPABILITIES = JSON.stringify({
  access_mode: 'standard',
  methods: ['surface.read_text', 'surface.send_key', 'surface.send_text', 'system.capabilities', 'system.tree'],
  protocol: 'cmux-socket',
  socket_path: '/tmp/cmux-test.sock',
  version: 2,
})

describe('readCmuxCapabilities: cmux capabilities, once at start', () => {
  it('reads the method list and the version', async () => {
    const { host, calls } = runHost(async () => result(CAPABILITIES))
    const read = await readCmuxCapabilities(host)
    expect(calls).toEqual([{ argv: ['cmux', 'capabilities'] }])
    expect(read).toEqual({ ok: true, value: { version: 2, methods: ['surface.read_text', 'surface.send_key', 'surface.send_text', 'system.capabilities', 'system.tree'] } })
  })

  it('a cmux that does not start is missing; an exit code or a bad output is off', async () => {
    const missing = await readCmuxCapabilities(runHost(fails).host)
    expect(missing).toEqual({ ok: false, status: 'missing', reason: expect.stringMatching(/^The .+\.$/) })
    for (const answer of [async () => result('', 1), async () => result('not json'), async () => result('{"methods":"system.tree"}')]) {
      const read = await readCmuxCapabilities(runHost(answer).host)
      expect(read).toEqual({ ok: false, status: 'off', reason: expect.stringMatching(/^The .+\.$/) })
    }
  })
})

describe('parseCmuxTree and readCmuxTree: cmux tree --all --json', () => {
  it('lists each terminal surface that has a TTY, across the 2 windows, and leaves out a browser surface', () => {
    const tree = parseCmuxTree(fixture('cmux-tree.json'), keep)
    expect(tree?.parseErrors).toBe(0)
    expect(tree?.surfaces).toEqual([
      { tty: 'ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'alpha', surfaceTitle: 'alpha main' },
      { tty: 'ttys007', workspaceRef: 'workspace:2', surfaceRef: 'surface:3', workspaceTitle: 'beta', surfaceTitle: 'beta docs' },
      { tty: 'ttys004', workspaceRef: 'workspace:3', surfaceRef: 'surface:4', workspaceTitle: 'alpha feature', surfaceTitle: 'Claude Code' },
      { tty: 'ttys005', workspaceRef: 'workspace:3', surfaceRef: 'surface:5', workspaceTitle: 'alpha feature', surfaceTitle: 'zsh' },
    ])
  })

  it('cleans each title with the cleaner it gets, and leaves out an empty surface title', () => {
    const raw = JSON.parse(fixture('cmux-tree.json')) as { windows: { workspaces: { panes: { surfaces: { title: string }[] }[] }[] }[] }
    const first = raw.windows[0]?.workspaces[0]?.panes[0]?.surfaces[0]
    if (first) first.title = ''
    const tree = parseCmuxTree(JSON.stringify(raw), (text) => `[${text}]`)
    expect(tree?.surfaces[0]).toEqual({ tty: 'ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: '[alpha]' })
    expect(tree?.surfaces[1]).toMatchObject({ workspaceTitle: '[beta]', surfaceTitle: '[beta docs]' })
  })

  it('counts a broken node as a parse error and reads the rest', () => {
    const raw = JSON.parse(fixture('cmux-tree.json')) as { windows: unknown[] }
    raw.windows.push('not a window', { ref: 'window:3', workspaces: [{ ref: 7, title: 'x', panes: [] }, null] })
    const tree = parseCmuxTree(JSON.stringify(raw), keep)
    expect(tree?.surfaces).toHaveLength(4)
    expect(tree?.parseErrors).toBe(3)
  })

  it('gives no tree when the output has no windows list', () => {
    expect(parseCmuxTree('{"windows": {}}', keep)).toBeUndefined()
    expect(parseCmuxTree('[]', keep)).toBeUndefined()
    expect(parseCmuxTree('not json', keep)).toBeUndefined()
  })

  it('runs cmux tree --all --json, and a failure is off, never missing', async () => {
    const { host, calls } = runHost(async () => result(fixture('cmux-tree.json')))
    const read = await readCmuxTree(host, keep)
    expect(calls).toEqual([{ argv: ['cmux', 'tree', '--all', '--json'] }])
    expect(read.ok && read.value.surfaces).toHaveLength(4)
    for (const answer of [fails, async () => result('', 1), async () => result('{"windows":')]) {
      const failed = await readCmuxTree(runHost(answer).host, keep)
      expect(failed).toEqual({ ok: false, status: 'off', reason: expect.stringMatching(/^The .+\.$/) })
    }
  })
})

describe('parsePs and readPs: ps -o pid=,tty=,lstart= in UTC', () => {
  it('reads the PID, the TTY and the start time of each line, and trims only the padding', () => {
    const ps = parsePs(fixture('ps.txt'))
    expect(ps.parseErrors).toBe(0)
    expect(ps.rows).toEqual([
      { pid: 41001, tty: 'ttys001', lstart: 'Fri Oct  9 08:00:00 2026' },
      { pid: 41002, tty: 'ttys004', lstart: 'Fri Oct  9 08:30:00 2026' },
      { pid: 41003, tty: 'ttys007', lstart: 'Fri Oct  9 09:00:00 2026' },
      { pid: 41004, tty: 'ttys012', lstart: 'Fri Oct  9 09:59:30 2026' },
      { pid: 41009, lstart: 'Fri Oct  9 09:40:12 2026' },
    ])
  })

  it('counts a line that does not parse and reads the rest', () => {
    const ps = parsePs(`${fixture('ps.txt')}garbage\n  12 ttys002\n`)
    expect(ps.rows).toHaveLength(5)
    expect(ps.parseErrors).toBe(2)
  })

  it('runs ps once for all the PIDs, with TZ set to UTC', async () => {
    const { host, calls } = runHost(async () => result(fixture('ps.txt')))
    const read = await readPs(host, [41001, 41002, 41003, 41004, 41009])
    expect(calls).toEqual([{ argv: ['ps', '-o', 'pid=,tty=,lstart=', '-p', '41001,41002,41003,41004,41009'], options: { env: { TZ: 'UTC' } } }])
    expect(read.ok && read.value.rows).toHaveLength(5)
  })

  it('runs no ps for an empty PID list, and reads no PID that is not a positive whole number', async () => {
    const { host, calls } = runHost(async () => result(''))
    expect(await readPs(host, [])).toEqual({ ok: true, value: { rows: [], parseErrors: 0 } })
    expect(await readPs(host, [0, -4, 1.5])).toEqual({ ok: true, value: { rows: [], parseErrors: 0 } })
    expect(calls).toEqual([])
  })

  it('reads exit 1 with no output as no running PID, not as a failure', async () => {
    const read = await readPs(runHost(async () => result('', 1)).host, [41009])
    expect(read).toEqual({ ok: true, value: { rows: [], parseErrors: 0 } })
  })

  it('a failed run or another exit code is off', async () => {
    for (const answer of [fails, async () => result('', 2)]) {
      const read = await readPs(runHost(answer).host, [41001])
      expect(read).toEqual({ ok: false, status: 'off', reason: expect.stringMatching(/^The .+\.$/) })
    }
  })
})

describe('mapTabs: PID to TTY to the cmux workspace and surface', () => {
  const surfaces = (): readonly CmuxSurface[] => parseCmuxTree(fixture('cmux-tree.json'), keep)?.surfaces ?? []

  it('a cmux tree with 2 windows maps each TTY', () => {
    const tabs = mapTabs(parsePs(fixture('ps.txt')).rows, surfaces())
    expect(tabs).toEqual([
      { pid: 41001, tty: 'ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'alpha', surfaceTitle: 'alpha main' },
      { pid: 41002, tty: 'ttys004', workspaceRef: 'workspace:3', surfaceRef: 'surface:4', workspaceTitle: 'alpha feature', surfaceTitle: 'Claude Code' },
      { pid: 41003, tty: 'ttys007', workspaceRef: 'workspace:2', surfaceRef: 'surface:3', workspaceTitle: 'beta', surfaceTitle: 'beta docs' },
    ])
  })

  it('gives no tab to a PID with no TTY, or with a TTY that no surface shows', () => {
    const tabs = mapTabs(parsePs(fixture('ps.txt')).rows, surfaces())
    expect(tabs.map((tab) => tab.pid)).not.toContain(41004)
    expect(tabs.map((tab) => tab.pid)).not.toContain(41009)
  })

  it('gives no tab when 2 surfaces show the same TTY: a key must never go to the wrong tab', () => {
    const twice = [...surfaces(), { tty: 'ttys001', workspaceRef: 'workspace:9', surfaceRef: 'surface:9', workspaceTitle: 'copy' }]
    const tabs = mapTabs([{ pid: 41001, tty: 'ttys001', lstart: 'Fri Oct  9 08:00:00 2026' }], twice)
    expect(tabs).toEqual([])
  })

  it('gives no tab when 2 PIDs share 1 TTY: the tab cannot tell which session a key reaches', () => {
    const ps = [
      { pid: 41001, tty: 'ttys001', lstart: 'Fri Oct  9 08:00:00 2026' },
      { pid: 41007, tty: 'ttys001', lstart: 'Fri Oct  9 09:10:00 2026' },
      { pid: 41003, tty: 'ttys007', lstart: 'Fri Oct  9 09:00:00 2026' },
    ]
    expect(mapTabs(ps, surfaces()).map((tab) => tab.pid)).toEqual([41003])
  })

  it('matches a surface TTY written with its /dev/ folder', () => {
    const devPath = [{ tty: '/dev/ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'alpha' }]
    const tabs = mapTabs([{ pid: 41001, tty: 'ttys001', lstart: 'Fri Oct  9 08:00:00 2026' }], devPath)
    expect(tabs).toEqual([{ pid: 41001, tty: 'ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'alpha' }])
  })
})
