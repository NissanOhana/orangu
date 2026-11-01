/**
 * Door 1, bare `orangu`, with every seam faked except discovery: the brief, the app server, the browser handoff,
 * ctrl-c and the process exit. The counts row reads a fixture Claude root, never a real transcript.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeFixtureHome } from '../../test/fixtures/home.js'
import { claudeRoots } from '../discover/discover.js'
import type { ServeDeps } from '../serve/server.js'
import type { ServeOptions } from '../serve/types.js'
import { cmdBare, TARGETED_BARE_FLAGS, type BareDeps } from './door.js'
import { MASCOT_WIDE } from './mascot-ascii.js'
import { stripAnsi, type Caps } from './tty.js'

const NOW = 1_800_000_000_000
const TTY: Caps = { tty: true, color: 0, animate: false, hyperlinks: false, columns: 80, unicode: true }
const APP_URL = `http://127.0.0.1:53211/_orangu/${'A'.repeat(43)}`

class FakeOutput {
  isTTY = true
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  get text(): string {
    return stripAnsi(this.chunks.join(''))
  }
}

interface Calls {
  brief: Array<{ hint: boolean }>
  serve: Array<{ opts: ServeOptions; deps: ServeDeps }>
  /** what the browser opener got: the path of a redirect page, never the URL */
  opened: string[]
  /** the redirect page and its content, as the opener saw them */
  pages: Array<{ path: string; text: string; mode: number; folderMode: number }>
  closed: number
  exit: number[]
}

/**
 * The deps of a terminal: every seam faked, ctrl-c through `interrupt()`. Each terminal has its own orangu home, so a
 * redirect page never lands in the real one. `env` adds to that home, and never replaces it.
 */
function terminal(over: Partial<BareDeps> = {}): { deps: BareDeps; calls: Calls; stdout: FakeOutput; stderr: FakeOutput; home: string; interrupt(): void } {
  const stdout = new FakeOutput()
  const stderr = new FakeOutput()
  const calls: Calls = { brief: [], serve: [], opened: [], pages: [], closed: 0, exit: [] }
  const home = mkdtempSync(join(tmpdir(), 'orangu-door-home-'))
  let stop: (() => void) | undefined
  const { env, ...rest } = over
  const deps: BareDeps = {
    brief: async (o) => {
      calls.brief.push(o)
      stdout.write('  BRIEF\n')
    },
    stdin: { isTTY: true, setRawMode: () => undefined },
    stdout,
    stderr,
    env: { ORANGU_HOME: home, ...env },
    out: TTY,
    startServe: async (opts, serveDeps) => {
      calls.serve.push({ opts, deps: serveDeps })
      return {
        url: APP_URL,
        close: async () => {
          calls.closed++
        },
      }
    },
    openInBrowser: (target) => {
      calls.opened.push(target)
      calls.pages.push({ path: target, text: readFileSync(target, 'utf8'), mode: statSync(target).mode & 0o777, folderMode: statSync(dirname(target)).mode & 0o777 })
    },
    onInterrupt: (fn) => {
      stop = fn
    },
    // the process exit hook of the page: a test process runs many apps, so it keeps no listener
    onExit: () => undefined,
    exit: (code) => {
      calls.exit.push(code)
    },
    now: NOW,
    isAlive: () => false,
    ...rest,
  }
  return {
    deps,
    calls,
    stdout,
    stderr,
    home,
    interrupt: () => {
      if (!stop) throw new Error('bare orangu listens for no ctrl-c yet')
      stop()
    },
  }
}

/** A fixture Claude root of 3 sessions: 1 live, 1 idle and 1 ended at NOW. */
async function fixtureRoot(): Promise<string> {
  return (await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-door-')), { now: NOW })).configDir
}

/** Run bare orangu on a terminal until its app rows print, then press ctrl-c. */
async function runApp(flags: Record<string, string | boolean>, t = terminal()): Promise<ReturnType<typeof terminal>> {
  const run = cmdBare(flags, t.deps)
  await vi.waitFor(() => expect(t.stdout.text).toContain('Press ctrl-c to stop the app.'), { timeout: 10_000 })
  t.interrupt()
  await run
  return t
}

describe('bare orangu: the brief or the app', () => {
  // the 12 inputs that keep the latest-session brief today (docs/USAGE.md, the list under the app paragraph)
  const BRIEF_INPUTS: Array<[string, { flags?: Record<string, string | boolean>; env?: NodeJS.ProcessEnv; pipe?: true }]> = [
    ['a pipe', { pipe: true }],
    ['CI', { env: { CI: '1' } }],
    ['TERM=dumb', { env: { TERM: 'dumb' } }],
    ['ORANGU_NO_ANIMATION=1', { env: { ORANGU_NO_ANIMATION: '1' } }],
    ['--plain', { flags: { plain: true } }],
    ['--quiet', { flags: { quiet: true } }],
    ['--session', { flags: { session: 'aaaaaaaa' } }],
    ['-s', { flags: { s: 'aaaaaaaa' } }],
    ['--global', { flags: { global: true } }],
    ['--cwd', { flags: { cwd: '/w/repo' } }],
    ['--max-tokens', { flags: { 'max-tokens': '1000' } }],
    ['--fail-on-hook-errors', { flags: { 'fail-on-hook-errors': true } }],
  ]

  it('names the 6 flags that target 1 session or 1 scope', () => {
    expect([...TARGETED_BARE_FLAGS]).toEqual(['session', 's', 'global', 'cwd', 'max-tokens', 'fail-on-hook-errors'])
    expect(BRIEF_INPUTS).toHaveLength(12)
  })

  // a fixture root on every input: an app that starts by mistake reads no real transcript
  let root = ''
  beforeAll(async () => {
    root = await fixtureRoot()
  })

  it.each(BRIEF_INPUTS)('%s keeps the brief and starts no app', async (_label, input) => {
    // an app that starts by mistake stops at once, so the test fails on its assertions and does not wait
    const t = terminal({ env: input.env ?? {}, onInterrupt: (stop) => stop() })
    if (input.pipe) t.stdout.isTTY = false
    const flags = input.flags ?? {}
    await cmdBare({ root, ...flags }, t.deps)
    // the brief as today: its closing hint stays, except under --quiet
    expect(t.calls.brief).toEqual([{ hint: flags['quiet'] !== true }])
    expect(t.calls.serve).toEqual([])
    expect(t.calls.opened).toEqual([])
    expect(t.stdout.text).toBe('  BRIEF\n')
  })

  it('a terminal with none of them prints the mascot and the brief, then starts the app', async () => {
    const t = await runApp({ root: await fixtureRoot() })
    expect(t.calls.brief).toEqual([{ hint: false }])
    expect(t.calls.serve).toHaveLength(1)
    const shown = t.stdout.text
    expect(shown.indexOf(MASCOT_WIDE[1]!), 'the mascot comes first').toBeGreaterThanOrEqual(0)
    expect(shown.indexOf(MASCOT_WIDE[1]!)).toBeLessThan(shown.indexOf('  BRIEF'))
    expect(shown.indexOf('  BRIEF')).toBeLessThan(shown.indexOf(`\n  app ${APP_URL}\n`))
    expect(shown).toContain('\n      3 sessions on this machine · 2 running now\n')
    expect(shown.trimEnd().split('\n').at(-1)).toBe('  Press ctrl-c to stop the app.')
  })
})

describe('bare orangu: the app that it starts', () => {
  const ENV_KEYS = ['ORANGU_CLAUDE_ROOTS', 'CLAUDE_CONFIG_DIR', 'HOME'] as const
  let saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    saved = {}
  })

  it('reads every configured root, as serve --global does, not the 1 root of serve', async () => {
    const [first, second] = [await fixtureRoot(), await fixtureRoot()]
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    process.env['ORANGU_CLAUDE_ROOTS'] = first
    process.env['CLAUDE_CONFIG_DIR'] = second
    process.env['HOME'] = await mkdtemp(join(tmpdir(), 'orangu-door-user-'))
    const every = await claudeRoots()
    expect(every.slice(0, 2)).toEqual([first, second])
    const t = await runApp({})
    expect(t.calls.serve[0]!.opts.roots).toEqual(every)
    expect(t.calls.serve[0]!.opts.configDir).toBeUndefined()
    expect(t.stdout.text).toContain('\n      6 sessions on this machine · 4 running now\n')
    // --root names the roots: each one of a list
    const listed = await runApp({ root: `${first},${second}` })
    expect(listed.calls.serve[0]!.opts.roots).toEqual([first, second])
  })

  it('turns the request log off, and --verbose turns it on', async () => {
    const root = await fixtureRoot()
    expect((await runApp({ root })).calls.serve[0]!.deps.quiet).toBe(true)
    expect((await runApp({ root, verbose: true })).calls.serve[0]!.deps.quiet).toBe(false)
  })

  it('opens the app in the browser on a terminal, as serve does, and --no-open keeps it closed', async () => {
    const root = await fixtureRoot()
    const opened = await runApp({ root })
    expect(opened.calls.serve[0]!.opts.open).toBe(true)
    expect(opened.calls.opened).toHaveLength(1)
    const closed = await runApp({ root, 'no-open': true })
    expect(closed.calls.serve[0]!.opts.open).toBe(false)
    expect(closed.calls.opened).toEqual([])
    expect(closed.stdout.text).toContain(`\n  app ${APP_URL}\n`)
  })

  it('hands the browser opener a private redirect page, never the URL, and removes the page on ctrl-c', async () => {
    const t = await runApp({ root: await fixtureRoot() })
    const [page] = t.calls.pages
    // `ps` shows the argv of the opener to every local account: it holds a path with no capability in it
    expect(t.calls.opened).toEqual([page!.path])
    expect(dirname(page!.path)).toBe(join(t.home, 'open'))
    expect(basename(page!.path)).toMatch(/^[0-9a-f]{32}\.html$/)
    expect(page!.text).toContain(`<meta http-equiv="refresh" content="0;url=${APP_URL}">`)
    expect(page).toMatchObject({ mode: 0o600, folderMode: 0o700 })
    expect(existsSync(page!.path), 'the page is gone after ctrl-c').toBe(false)
  })

  it('opens no browser and writes no page in an SSH session, and still prints the URL', async () => {
    const t = await runApp({ root: await fixtureRoot() }, terminal({ env: { SSH_CONNECTION: '10.0.0.1 51234 10.0.0.2 22' } }))
    expect(t.calls.opened).toEqual([])
    expect(existsSync(join(t.home, 'open'))).toBe(false)
    expect(t.stdout.text).toContain(`\n  app ${APP_URL}\n`)
  })

  it('runs the app and says why when orangu cannot write the page, with no browser', async () => {
    const t = terminal()
    // a file in the place of the folder of the pages
    writeFileSync(join(t.home, 'open'), '')
    await runApp({ root: await fixtureRoot() }, t)
    expect(t.calls.opened).toEqual([])
    expect(t.stderr.text).toMatch(/^ {2}orangu opened no browser: .+\. Open the app URL by hand\.$/m)
    expect(t.stdout.text).toContain(`\n  app ${APP_URL}\n`)
    expect(t.calls.exit).toEqual([0])
  })

  it('shows transcript text on this machine as serve does: --no-include-text hides it, and the export stays redacted', async () => {
    const root = await fixtureRoot()
    const shown = (await runApp({ root })).calls.serve[0]!.opts
    expect(shown.includeText).toBe(true)
    expect(shown.exportIncludeText).toBe(false)
    expect((await runApp({ root, 'no-include-text': true })).calls.serve[0]!.opts.includeText).toBe(false)
    expect((await runApp({ root, 'include-text': true })).calls.serve[0]!.opts.exportIncludeText).toBe(true)
  })

  it('takes the serve flags --port, --max-live and --no-cache', async () => {
    const root = await fixtureRoot()
    const opts = (await runApp({ root, port: '8080', 'max-live': '3', 'no-cache': true })).calls.serve[0]!.opts
    expect(opts).toMatchObject({ port: 8080, maxLive: 3, noCache: true })
  })

  it('refuses a bad --port before the mascot and the brief', async () => {
    const t = terminal()
    await expect(cmdBare({ root: await fixtureRoot(), port: 'abc' }, t.deps)).rejects.toThrow('--port must be an integer 0–65535, got "abc"')
    expect(t.calls.brief).toEqual([])
    expect(t.stdout.text).toBe('')
  })

  it('keeps the brief and says why when the app does not start', async () => {
    const t = terminal({
      startServe: async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:8080')
      },
    })
    await expect(cmdBare({ root: await fixtureRoot(), port: '8080' }, t.deps)).rejects.toThrow('the app did not start: listen EADDRINUSE: address already in use 127.0.0.1:8080')
    expect(t.stdout.text).toContain('  BRIEF\n')
    expect(t.stdout.text).not.toContain('  app ')
    expect(t.calls.exit).toEqual([])
    // no app, so no page and no opener
    expect(t.calls.opened).toEqual([])
    expect(existsSync(join(t.home, 'open'))).toBe(false)
  })

  it('stops the app on ctrl-c and exits 0', async () => {
    const t = await runApp({ root: await fixtureRoot() })
    expect(t.calls.closed).toBe(1)
    expect(t.calls.exit).toEqual([0])
    expect(t.stderr.text).toBe('\n  The app stopped.\n')
  })

  it('removes the page when the app does not close cleanly on ctrl-c', async () => {
    const t = terminal({
      startServe: async () => ({
        url: APP_URL,
        close: async () => {
          throw new Error('close failed')
        },
      }),
    })
    const run = cmdBare({ root: await fixtureRoot() }, t.deps)
    await vi.waitFor(() => expect(t.stdout.text).toContain('Press ctrl-c to stop the app.'), { timeout: 10_000 })
    t.interrupt()
    await expect(run).rejects.toThrow('close failed')
    expect(existsSync(t.calls.pages[0]!.path)).toBe(false)
  })
})

describe('the terminal menu', () => {
  it('is gone: no dashboard module, and no source calls the menu command', () => {
    const src = fileURLToPath(new URL('../', import.meta.url))
    expect(existsSync(join(src, 'cli/commands/dashboard.ts'))).toBe(false)
    expect(existsSync(join(src, 'cli/commands/dashboard.test.ts'))).toBe(false)
    const name = ['cmd', 'Dashboard'].join('')
    const hits = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => readFileSync(join(src, file), 'utf8').includes(name))
    expect(hits).toEqual([])
  })
})
