import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeFixtureHome } from '../../../test/fixtures/home.js'
import { displayWidth, stripAnsi, type Caps, type ExitHookProcess } from '../tty.js'
import {
  cmdDashboard,
  dashboardChoices,
  dashboardFrame,
  dashboardPrecondition,
  gatherDashboardData,
  type DashboardData,
  type DashboardDeps,
} from './dashboard.js'

const NOW = 1_800_000_000_000
const tty: Caps = { tty: true, color: 2, animate: true, hyperlinks: false, columns: 80, unicode: true }

class FakeInput extends EventEmitter {
  isTTY = true
  setRawMode = vi.fn()
  setEncoding = vi.fn()
  resume = vi.fn()
  pause = vi.fn()
}

class FakeOutput extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  get text(): string {
    return this.chunks.join('')
  }
}

const noopProc: ExitHookProcess = {
  pid: 1,
  once: () => undefined,
  on: () => undefined,
  removeListener: () => undefined,
  kill: () => undefined,
}

function deps(cwd: string): DashboardDeps & {
  stdin: FakeInput
  stdout: FakeOutput
  stderr: FakeOutput
  showRepo: ReturnType<typeof vi.fn>
  showGlobal: ReturnType<typeof vi.fn>
  showSession: ReturnType<typeof vi.fn>
  browseSessions: ReturnType<typeof vi.fn>
} {
  const stdin = new FakeInput()
  const stdout = new FakeOutput()
  const stderr = new FakeOutput()
  return {
    showRepo: vi.fn(async () => undefined),
    showGlobal: vi.fn(async () => undefined),
    showSession: vi.fn(async () => undefined),
    browseSessions: vi.fn(async () => undefined),
    stdin,
    stdout,
    stderr,
    env: {},
    out: tty,
    err: tty,
    now: NOW,
    cwd: () => cwd,
    isAlive: () => false,
    proc: noopProc,
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orangu-dashboard-'))
  const cwd = '/Users/test/Code/demo'
  const home = await makeFixtureHome(root, { now: NOW, cwd })
  return { root, cwd, home }
}

describe('dashboardPrecondition', () => {
  const input = { isTTY: true, setRawMode: () => undefined }
  const output = { isTTY: true }

  it('uses the dashboard only for an untargeted interactive terminal', () => {
    expect(dashboardPrecondition(input, output, {}, {})).toBe(true)
    expect(dashboardPrecondition({ ...input, isTTY: false }, output, {}, {})).toBe(false)
    expect(dashboardPrecondition(input, output, { CI: '1' }, {})).toBe(false)
    for (const flag of ['json', 'plain', 'quiet', 'session', 's', 'global', 'cwd', 'max-tokens', 'fail-on-hook-errors']) {
      expect(dashboardPrecondition(input, output, {}, { [flag]: true }), flag).toBe(false)
    }
  })
})

describe('dashboard discovery and rendering', () => {
  it('shows repo/global counts and scrubbed open Claude sessions', async () => {
    const { root, cwd, home } = await fixture()
    const data = await gatherDashboardData({ root }, { now: NOW, cwd: () => cwd, isAlive: () => false })
    expect(data).toMatchObject({ repoName: 'demo', repoSessions: 3, globalSessions: 3, roots: 1, runningSessions: 2 })
    expect(data.live.map((row) => row.sessionId)).toEqual([home.liveId, home.idleId])
    expect(data.live[0]!.title).not.toContain('sk-ant-api03-FAKE')
  })

  it('keeps the orange mascot and every frame row inside narrow and wide terminals', () => {
    const data: DashboardData = {
      repoName: 'a-very-long-repository-name',
      repoSessions: 12,
      globalSessions: 300,
      roots: 4,
      runningSessions: 2,
      live: [
        {
          sessionId: '11111111-0000-4000-8000-00000000aaaa',
          path: '/p/a.jsonl',
          projectSlug: '-Users-me-demo',
          project: 'demo',
          title: 'Fix the permissions boundary and rerun every integration test ' + 'x'.repeat(80),
          sizeBytes: 100,
          mtimeMs: NOW - 10_000,
          running: true,
        },
      ],
    }
    const choices = dashboardChoices(data)
    for (const columns of [40, 80, 160]) {
      const caps = { ...tty, columns }
      const lines = dashboardFrame(caps, data, choices, { cursor: 3, start: 0, size: choices.length }, NOW)
      for (const line of lines) expect(displayWidth(line), stripAnsi(line)).toBeLessThanOrEqual(Math.min(columns, 80))
      expect(stripAnsi(lines.join('\n'))).toContain('Choose a report')
    }
    expect(dashboardFrame(tty, data, choices, { cursor: 0, start: 0, size: choices.length }, NOW).join('\n')).toContain('\x1b[38;5;209m')
  })
})

describe('cmdDashboard', () => {
  it('navigates to scope reports and direct live-session reports', async () => {
    const { root, cwd, home } = await fixture()

    const repo = deps(cwd)
    const repoRun = cmdDashboard({ root }, repo)
    await new Promise((resolve) => setTimeout(resolve, 25))
    repo.stdin.emit('data', '\r')
    await repoRun
    expect(repo.showRepo).toHaveBeenCalledOnce()
    expect(stripAnsi(repo.stdout.text)).toContain('.-"""-.')
    expect(stripAnsi(repo.stdout.text)).toContain('Repository report')
    expect(stripAnsi(repo.stdout.text)).toContain('Global report')
    expect(stripAnsi(repo.stdout.text)).toContain('Browse session reports')
    expect(repo.stdin.setRawMode).toHaveBeenLastCalledWith(false)

    const session = deps(cwd)
    const sessionRun = cmdDashboard({ root }, session)
    await new Promise((resolve) => setTimeout(resolve, 25))
    session.stdin.emit('data', '4')
    session.stdin.emit('data', '\r')
    await sessionRun
    expect(session.showSession).toHaveBeenCalledWith(home.liveId)
  })

  it('returns false without reading or waiting when a dashboard is not safe', async () => {
    const d = deps('/repo')
    d.stdin.isTTY = false
    await expect(cmdDashboard({}, d)).resolves.toBe(false)
    expect(d.stdin.setRawMode).not.toHaveBeenCalled()
    expect(d.stdout.text).toBe('')
    expect(d.showRepo).not.toHaveBeenCalled()
  })
})
