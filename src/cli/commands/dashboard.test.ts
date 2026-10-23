import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFixtureHome } from '../../../test/fixtures/home.js'
import { countingQueueReads, memoryQueueStore } from '../../../test/fixtures/suggestion-queue.js'
import { NOW as QUEUE_NOW, WORKSPACE, appliedOf, sg } from '../../../test/fixtures/suggestion-records.js'
import { QUEUE_CHECK_BYTES } from '../../suggest/queue-read.js'
import { SuggestionStore } from '../../suggest/store.js'
import { MASCOT_MINI, MASCOT_STACKED, MASCOT_WIDE } from '../mascot-ascii.js'
import type { PickRow } from '../summary.js'
import { displayWidth, stripAnsi, type Caps, type ExitHookProcess } from '../tty.js'
import { cmdSuggest } from './suggest.js'
import { QUEUE_APP_ROW } from './suggest-reads.js'
import {
  cmdDashboard,
  dashboardChoices,
  dashboardChromeLines,
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
  showQueue: ReturnType<typeof vi.fn>
} {
  const stdin = new FakeInput()
  const stdout = new FakeOutput()
  const stderr = new FakeOutput()
  return {
    showRepo: vi.fn(async () => undefined),
    showGlobal: vi.fn(async () => undefined),
    showSession: vi.fn(async () => undefined),
    browseSessions: vi.fn(async () => undefined),
    showQueue: vi.fn(async () => undefined),
    // no record is open, so the dashboard shows the choices of a new user
    queue: countingQueueReads(memoryQueueStore()).reads,
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
    const data = await gatherDashboardData({ root }, { now: NOW, cwd: () => cwd, isAlive: () => false, queue: countingQueueReads(memoryQueueStore()).reads })
    expect(data).toMatchObject({ repoName: 'demo', repoSessions: 3, globalSessions: 3, roots: 1, runningSessions: 2, queue: { due: 0, open: 0 } })
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
      queue: { due: 0, open: 0 },
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
    // the art is the frame's leading block, up to the blank line before "Choose a report"
    const artOf = (lines: string[]): string[] => lines.slice(0, lines.indexOf('')).map(stripAnsi)
    for (const [columns, tier] of [[40, MASCOT_MINI], [80, MASCOT_WIDE], [160, MASCOT_WIDE]] as const) {
      const caps = { ...tty, columns }
      const lines = dashboardFrame(caps, data, choices, { cursor: 3, start: 0, size: choices.length }, NOW)
      for (const line of lines) expect(displayWidth(line), stripAnsi(line)).toBeLessThanOrEqual(Math.min(columns, 80))
      expect(stripAnsi(lines.join('\n'))).toContain('Choose a report')
      const art = artOf(lines)
      expect(art.length, `${columns}: art rows`).toBe(tier.length)
      // every row of the tier is present whole: nothing was cut, and no truncation ellipsis appears
      for (const row of tier) expect(art.join('\n'), `${columns}: ${row}`).toContain(row)
      expect(art.join('\n'), `${columns}: ellipsis in the art`).not.toContain('…')
    }
    // 42-67 columns keeps the wordmark and drops the face
    expect(artOf(dashboardFrame({ ...tty, columns: 60 }, data, choices, { cursor: 0, start: 0, size: choices.length }, NOW))).toHaveLength(
      MASCOT_STACKED.length,
    )
    expect(dashboardFrame(tty, data, choices, { cursor: 0, start: 0, size: choices.length }, NOW).join('\n')).toContain('\x1b[38;5;209m')
  })

  it('derives the chrome-line budget from the tier the same caps render', () => {
    expect(dashboardChromeLines({ ...tty, columns: 160 }), 'WIDE').toBe(14)
    expect(dashboardChromeLines({ ...tty, columns: 80 }), 'WIDE').toBe(14)
    expect(dashboardChromeLines({ ...tty, columns: 68 }), 'WIDE').toBe(14)
    expect(dashboardChromeLines({ ...tty, columns: 67 }), 'STACKED').toBe(13)
    expect(dashboardChromeLines({ ...tty, columns: 42 }), 'STACKED').toBe(13)
    expect(dashboardChromeLines({ ...tty, columns: 40 }), 'MINI').toBe(15)
    // the budget is exactly what the frame spends outside the choice rows
    const data: DashboardData = { repoName: 'demo', repoSessions: 1, globalSessions: 1, roots: 1, runningSessions: 0, live: [], queue: { due: 0, open: 0 } }
    const choices = dashboardChoices(data)
    for (const columns of [40, 60, 80]) {
      const caps = { ...tty, columns }
      const lines = dashboardFrame(caps, data, choices, { cursor: 0, start: 0, size: choices.length }, NOW)
      expect(lines.length - choices.length, `${columns}: frame rows minus choices`).toBe(dashboardChromeLines(caps))
    }
  })
})

describe('dashboardChoices: the IMPROVE choice', () => {
  const live: PickRow = {
    sessionId: '11111111-0000-4000-8000-00000000aaaa',
    path: '/p/a.jsonl',
    projectSlug: '-Users-me-demo',
    project: 'demo',
    title: 'Fix the login test',
    sizeBytes: 100,
    mtimeMs: NOW - 10_000,
    running: true,
  }
  const base: DashboardData = { repoName: 'demo', repoSessions: 2, globalSessions: 5, roots: 1, runningSessions: 1, live: [live], queue: { due: 0, open: 0 } }
  /** the choices of a workspace with nothing open, in their order */
  const others = [{ kind: 'repo' }, { kind: 'global' }, { kind: 'browse' }, { kind: 'session', row: live }]
  const cases: Array<[string, DashboardData['queue'], unknown[]]> = [
    ['1 or more open items', { due: 1, open: 2 }, [{ kind: 'improve' }, ...others]],
    ['a store that cannot be read', 'store-error', [{ kind: 'improve' }, ...others]],
    ['nothing open', { due: 0, open: 0 }, others],
  ]

  it.each(cases)('with %s', (_label, queue, expected) => {
    expect(dashboardChoices({ ...base, queue })).toEqual(expected)
  })

  it('leaves a space after each of the 5 tags at 40, 60 and 80 columns, and prints the counts', () => {
    const data: DashboardData = { ...base, queue: { due: 2, open: 3 } }
    const choices = dashboardChoices(data)
    const frame = (columns: number): string[] => dashboardFrame({ ...tty, columns }, data, choices, { cursor: 0, start: 0, size: choices.length }, NOW).map(stripAnsi)
    for (const columns of [40, 60, 80]) {
      const lines = frame(columns)
      for (const tag of ['IMPROVE', 'REPO', 'GLOBAL', 'SESSION', 'LIVE']) {
        // the tag starts after the indent, the cursor and the live mark
        const row = lines.find((line) => line.slice(6).startsWith(tag))
        expect(row, `${columns}: ${tag}`).toBeDefined()
        expect(row![6 + tag.length], `${columns}: ${tag}`).toBe(' ')
        expect(displayWidth(row!), `${columns}: ${tag}`).toBeLessThanOrEqual(Math.min(columns, 80))
      }
    }
    expect(frame(80)).toContain('  >   IMPROVE Improvements · 2 due · 3 open')
    const unreadable: DashboardData = { ...base, queue: 'store-error' }
    const unreadableFrame = dashboardFrame(tty, unreadable, dashboardChoices(unreadable), { cursor: 0, start: 0, size: 5 }, NOW).map(stripAnsi)
    expect(unreadableFrame).toContain('  >   IMPROVE Improvements · the store could not be read')
  })

  it('no source file holds the text of an IMPROVE row with nothing open', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const text = ['Improvements', 'nothing open'].join(' · ')
    const hits = ['src', 'scripts'].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.(ts|tsx|mjs|js|css|html)$/.test(file))
        .filter((file) => readFileSync(join(root, dir, file), 'utf8').includes(text))
        .map((file) => `${dir}/${file}`),
    )
    expect(hits).toEqual([])
  })
})

describe('the IMPROVE count', () => {
  const saved = process.env['ORANGU_HOME']
  afterEach(() => {
    if (saved === undefined) delete process.env['ORANGU_HOME']
    else process.env['ORANGU_HOME'] = saved
    vi.restoreAllMocks()
  })

  /** A private orangu home whose store holds 1 applied record of WORKSPACE, which the full check finds due. */
  function storeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'orangu-dashboard-store-'))
    writeFileSync(join(home, 'suggestions.jsonl'), `${JSON.stringify(appliedOf(sg(1)))}\n`, { mode: 0o600 })
    process.env['ORANGU_HOME'] = home
    return home
  }

  it('reads no transcript, so an applied item with no cache entry is open and not due, and the printout calls the loader', async () => {
    const { root } = await fixture()
    const home = storeHome()
    const { loads, reads } = countingQueueReads(new SuggestionStore({ home }))
    const data = await gatherDashboardData({ root }, { now: QUEUE_NOW, cwd: () => WORKSPACE, isAlive: () => false, queue: reads })
    expect(loads).toEqual([])
    expect(data.queue).toEqual({ due: 0, open: 1 })
    // The printout runs the full check on the same store: the read of `orangu suggest --queue --cwd <dir>`.
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    await cmdSuggest([], { queue: true, cwd: WORKSPACE }, { read: reads.deps({ now: QUEUE_NOW, budgetBytes: QUEUE_CHECK_BYTES }) })
    expect(loads.length).toBeGreaterThan(0)
    expect(out.join('')).toContain(`claude "/orangu:improve --verify ${sg(1)}"`)
    expect(out.join('')).toContain(QUEUE_APP_ROW)
  })

  it('puts IMPROVE first when the store cannot be read', async () => {
    const { root } = await fixture()
    const { loads, reads } = countingQueueReads({
      all: async () => {
        throw new Error('EACCES: permission denied, open')
      },
      lines: async () => [],
    })
    const data = await gatherDashboardData({ root }, { now: QUEUE_NOW, cwd: () => WORKSPACE, isAlive: () => false, queue: reads })
    expect(data.queue).toBe('store-error')
    expect(dashboardChoices(data)[0]).toEqual({ kind: 'improve' })
    expect(loads).toEqual([])
  })
})

/**
 * Wait for the frame instead of sleeping: FakeOutput.write appends synchronously and select
 * registers its key listener before it writes the first frame, so seeing the frame proves the
 * listener is attached. A fixed 25 ms sleep raced discovery under full-suite load.
 */
async function firstFrame(out: FakeOutput): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (stripAnsi(out.text).includes('Choose a report')) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the dashboard never rendered its first frame')
}

describe('cmdDashboard', () => {
  it('navigates to scope reports and direct live-session reports', async () => {
    const { root, cwd, home } = await fixture()

    const repo = deps(cwd)
    const repoRun = cmdDashboard({ root }, repo)
    await firstFrame(repo.stdout)
    repo.stdin.emit('data', '\r')
    await repoRun
    expect(repo.showRepo).toHaveBeenCalledOnce()
    expect(stripAnsi(repo.stdout.text)).toContain("'-...............-'")
    expect(stripAnsi(repo.stdout.text)).toContain('Repository report')
    expect(stripAnsi(repo.stdout.text)).toContain('Global report')
    expect(stripAnsi(repo.stdout.text)).toContain('Browse session reports')
    expect(repo.stdin.setRawMode).toHaveBeenLastCalledWith(false)

    const session = deps(cwd)
    const sessionRun = cmdDashboard({ root }, session)
    await firstFrame(session.stdout)
    session.stdin.emit('data', '4')
    session.stdin.emit('data', '\r')
    await sessionRun
    expect(session.showSession).toHaveBeenCalledWith(home.liveId)
  })

  it('asks both scope reports for their HTML: choosing one is an explicit request to see it', async () => {
    const { root, cwd } = await fixture()

    const repo = deps(cwd)
    const repoRun = cmdDashboard({ root }, repo)
    await firstFrame(repo.stdout)
    repo.stdin.emit('data', '\r')
    await repoRun
    expect(repo.showRepo).toHaveBeenCalledWith({ open: true })

    const global = deps(cwd)
    const globalRun = cmdDashboard({ root }, global)
    await firstFrame(global.stdout)
    global.stdin.emit('data', '2')
    global.stdin.emit('data', '\r')
    await globalRun
    expect(global.showGlobal).toHaveBeenCalledWith({ open: true })
    expect(global.showRepo).not.toHaveBeenCalled()
  })

  it('draws IMPROVE first with no transcript read before the first frame, and Enter prints the queue', async () => {
    const { root } = await fixture()
    const home = mkdtempSync(join(tmpdir(), 'orangu-dashboard-store-'))
    writeFileSync(join(home, 'suggestions.jsonl'), `${JSON.stringify(appliedOf(sg(1)))}\n`, { mode: 0o600 })
    const { loads, reads } = countingQueueReads(new SuggestionStore({ home }))
    const d = { ...deps(WORKSPACE), now: QUEUE_NOW, queue: reads }
    const run = cmdDashboard({ root }, d)
    await firstFrame(d.stdout)
    expect(loads).toEqual([])
    const frame = stripAnsi(d.stdout.text)
    expect(frame).toContain('IMPROVE Improvements · 0 due · 1 open')
    expect(frame.indexOf('IMPROVE')).toBeLessThan(frame.indexOf('REPO'))
    d.stdin.emit('data', '\r')
    await run
    expect(d.showQueue).toHaveBeenCalledOnce()
    expect(d.showRepo).not.toHaveBeenCalled()
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
