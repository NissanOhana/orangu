import { describe, it, expect } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeFixtureHome, appendTurn } from '../../test/fixtures/home.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const CLI = join(process.cwd(), 'dist', 'orangu.js')
const run = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe.skipIf(!existsSync(CLI))('orangu CLI (built)', () => {
  it('--version prints the version', () => {
    expect(run(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('--help lists commands incl. serve with its flags', () => {
    const h = run(['--help'])
    expect(h).toContain('orangu report')
    expect(h).toContain('orangu serve')
    for (const f of ['--port', '--open', '--include-text', '--no-include-text', '--max-live']) expect(h).toContain(f)
    // --include-text governs shareable output (report/watch and serve's export); --no-include-text is the viewer opt-out
    expect(h).toContain("in serve's exported HTML")
    expect(h).toContain('hide prompt/result previews in the loopback viewer')
    expect(h).not.toContain('--allow-claude')
    // Hard-assert the suggest-layer verbs here because suggest.e2e.test.ts skips when they are
    // missing, so this unconditional test is the guard that keeps the registry wired and documented
    for (const f of ['orangu estimate', 'orangu harness', 'orangu suggest', '--slim']) expect(h).toContain(f)
    expect(h).toContain('orangu feedback')
    expect(h).toContain('--context session|repo|global|report|app')
    expect(h.toLowerCase()).toContain('no network calls')
  })

  it('builds a report with every outbound Node network primitive blocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-cli-offline-'))
    const home = await makeFixtureHome(dir)
    const preload = join(dir, 'block-outbound.mjs')
    const attemptsPath = join(dir, 'outbound-attempts.txt')
    await writeFile(
      preload,
      `import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const attemptsPath = ${JSON.stringify(attemptsPath)}
const blocked = (name) => () => {
  appendFileSync(attemptsPath, name + '\\n')
  throw new Error('OUTBOUND_NETWORK:' + name)
}
globalThis.fetch = blocked('fetch')
for (const [owner, names] of [
  [http, ['get', 'request']],
  [https, ['get', 'request']],
  [http2, ['connect']],
  [net, ['connect', 'createConnection']],
  [tls, ['connect']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dgram, ['createSocket']],
  [childProcess, ['exec', 'execFile', 'fork', 'spawn']],
]) for (const name of names) owner[name] = blocked(name)
syncBuiltinESMExports()
`,
    )
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        CLI,
        'report',
        home.sessions[0]!.path,
        '--stdout',
        '--no-open',
        '--no-cache',
        '--quiet',
      ],
      { encoding: 'utf8' },
    )
    const attempts = existsSync(attemptsPath) ? readFileSync(attemptsPath, 'utf8') : ''
    expect(attempts, `caught or uncaught outbound attempts:\n${attempts}`).toBe('')
    expect(r.stderr, r.stderr).not.toContain('OUTBOUND_NETWORK:')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("default-src 'none'")
    expect(r.stdout).toContain('orangu-data')
  })

  it('writes report artifacts privately and rejects a symlink output target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-cli-private-report-'))
    const home = await makeFixtureHome(dir)
    const out = join(dir, 'report.html')
    run(['report', home.sessions[0]!.path, '--out', out, '--no-open', '--no-cache', '--quiet'])
    expect(readFileSync(out, 'utf8')).toContain('orangu-data')
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600)

    if (process.platform !== 'win32') {
      const outside = join(dir, 'outside.html')
      const linked = join(dir, 'linked-report.html')
      writeFileSync(outside, 'outside')
      symlinkSync(outside, linked)
      const rejected = spawnSync(
        'node',
        [CLI, 'report', home.sessions[0]!.path, '--out', linked, '--no-open', '--no-cache', '--quiet'],
        { encoding: 'utf8' },
      )
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toMatch(/symbolic link|changed during access/)
      expect(lstatSync(linked).isSymbolicLink()).toBe(true)
      expect(readFileSync(outside, 'utf8')).toBe('outside')
    }
  })

  it('redacts aggregate stdout and --out by default while preserving --no-redact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-cli-private-aggregate-'))
    const home = await makeFixtureHome(dir)
    const base = ['global', '--root', home.configDir, '--limit', '1', '--jobs', '1', '--no-cache', '--quiet']
    const secret = 'sk-ant-api03-FAKEFAKEFAKEFAKE'
    const secretPath = `/Users/test/Code/demo/private/${secret}.ts`
    const builder = new SessionBuilder({ sessionId: home.liveId })
    builder.userPrompt(`My key is ${secret}`)
    for (let i = 0; i < 3; i++) builder.toolCall('Read', { file_path: secretPath }, `read ${i}`)
    await writeFile(home.sessions[0]!.path, builder.toJsonl())

    const stdout = run([...base, '--json'])
    const defaultJson = JSON.parse(stdout) as {
      byProject: Array<{ key: string }>
      sessions: Array<{ project?: string }>
      topSessions: Array<{ project?: string }>
    }
    expect(stdout).not.toContain(secret)
    expect(stdout).toContain('‹anthropic-key›')
    expect(stdout).not.toContain('Users-test-Code')
    expect(defaultJson.byProject[0]?.key).toBe('demo')
    expect(defaultJson.sessions[0]?.project).toBe('demo')
    expect(defaultJson.topSessions[0]?.project).toBe('demo')

    const human = run(base)
    expect(human).not.toContain(secret)
    expect(human).not.toContain('Users-test-Code')
    expect(human).toContain('My key is ‹anthropic-key›')
    expect(human).toContain('private/‹anthropic-key›.ts')
    const strippedHuman = run([...base, '--strip-paths'])
    expect(strippedHuman).not.toContain(secret)
    expect(strippedHuman).toContain('private/‹anthropic-key›.ts')

    const out = join(dir, 'aggregate.json')
    expect(run([...base, '--out', out])).toBe('')
    const written = readFileSync(out, 'utf8')
    expect(written).not.toContain(secret)
    expect(written).toContain('‹anthropic-key›')
    expect(written).not.toContain('Users-test-Code')
    expect((JSON.parse(written) as typeof defaultJson).byProject[0]?.key).toBe('demo')
    expect(written.endsWith('\n')).toBe(false)
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600)

    const strippedStdout = run([...base, '--json', '--strip-paths'])
    const stripped = JSON.parse(strippedStdout) as {
      byProject: Array<{ key: string }>
      sessions: Array<{ project?: string }>
      topSessions: Array<{ project?: string }>
      topReReadFiles: Array<{ path: string }>
    }
    expect(strippedStdout).not.toContain(secret)
    expect(stripped.byProject[0]?.key).toBe('demo')
    expect(stripped.sessions[0]?.project).toBe('demo')
    expect(stripped.topSessions[0]?.project).toBe('demo')
    expect(stripped.topReReadFiles[0]?.path).toBe('private/‹anthropic-key›.ts')

    const strippedOut = join(dir, 'aggregate-stripped.json')
    expect(run([...base, '--out', strippedOut, '--strip-paths'])).toBe('')
    const strippedFileText = readFileSync(strippedOut, 'utf8')
    const strippedFile = JSON.parse(strippedFileText) as typeof stripped
    expect(strippedFileText).not.toContain(secret)
    expect(strippedFile.byProject[0]?.key).toBe('demo')
    expect(strippedFile.sessions[0]?.project).toBe('demo')
    expect(strippedFile.topSessions[0]?.project).toBe('demo')

    const rawHuman = run([...base, '--no-redact'])
    expect(rawHuman).toContain(secret)
    expect(rawHuman).toContain(`private/${secret}.ts`)
    const rawJson = run([...base, '--json', '--no-redact', '--strip-paths'])
    expect(rawJson).toContain(secret)
    expect(rawJson).toContain('-Users-test-Code-demo')
  })

  it('offers beta feedback only on human, non-quiet command paths', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-feedback-offer-')))
    const base = ['analyze', home.liveId, '--root', home.configDir, '--no-cache']
    const human = spawnSync('node', [CLI, ...base], { encoding: 'utf8' })
    expect(human.status, human.stderr).toBe(0)
    expect(human.stderr).toContain('orangu feedback --context session')

    const machine = spawnSync('node', [CLI, ...base, '--json'], { encoding: 'utf8' })
    expect(machine.status, machine.stderr).toBe(0)
    expect(() => JSON.parse(machine.stdout)).not.toThrow()
    expect(machine.stderr).not.toContain('orangu feedback')

    const quiet = spawnSync('node', [CLI, ...base, '--quiet'], { encoding: 'utf8' })
    expect(quiet.status, quiet.stderr).toBe(0)
    expect(quiet.stderr).not.toContain('orangu feedback')
  })

  // A9: after report/analyze the terminal names the next step (the top finding's improve command,
  // the same sg_ identity the report shows) before the beta offer; never under --quiet or --json.
  it('names the next step before the beta offer, and stays silent under --quiet and --json', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-next-step-')))
    const base = ['report', home.endedId, '--root', home.configDir, '--no-open', '--no-cache']
    const human = spawnSync('node', [CLI, ...base], { encoding: 'utf8' })
    expect(human.status, human.stderr).toBe(0)
    const next = human.stderr.indexOf('next step:')
    const offer = human.stderr.indexOf('orangu feedback --context report')
    expect(next).toBeGreaterThan(-1)
    expect(offer).toBeGreaterThan(next)
    expect(human.stderr).toContain('top finding:')
    expect(human.stderr).toMatch(/claude "\/orangu:improve sg_[0-9a-f]{12} --finding /)
    expect(human.stderr).toContain('/plugin install orangu')
    expect(human.stdout.trim().endsWith('.html')).toBe(true)

    const quiet = spawnSync('node', [CLI, ...base, '--quiet'], { encoding: 'utf8' })
    expect(quiet.status, quiet.stderr).toBe(0)
    expect(quiet.stderr).not.toContain('next step')

    const analyze = spawnSync('node', [CLI, 'analyze', home.endedId, '--root', home.configDir, '--no-cache'], { encoding: 'utf8' })
    expect(analyze.status, analyze.stderr).toBe(0)
    expect(analyze.stderr.indexOf('next step:')).toBeLessThan(analyze.stderr.indexOf('orangu feedback --context session'))
    const machine = spawnSync('node', [CLI, 'analyze', home.endedId, '--root', home.configDir, '--no-cache', '--json'], { encoding: 'utf8' })
    expect(machine.status, machine.stderr).toBe(0)
    expect(machine.stderr).not.toContain('next step')
    expect(machine.stdout).not.toContain('next step')

    expect(run(['list', '--root', home.configDir])).toContain('orangu harness')
  })

  // The CI-gate flags, end to end on the built binary. A gate that silently stops gating is the
  // failure mode here: `--max-cost` was renamed to `--max-tokens`, and because the arg parser ignores
  // unknown flags, every pipeline still passing `--max-cost 5` would have exited 0 forever.
  describe('CI gate flags', () => {
    const runExit = (args: string[]): { code: number; out: string; err: string } => {
      const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
      return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
    }
    let home: Awaited<ReturnType<typeof makeFixtureHome>>
    const args = (extra: string[]) => ['analyze', 'aaaaaaaa', '--root', home.configDir, '--quiet', ...extra]

    it('sets up a synthetic fixture home', async () => {
      home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-gate-')))
      expect(runExit(args(['--json'])).code).toBe(0)
    })

    it('--max-tokens fails the run when the session is over budget, and passes when it is not', () => {
      const over = runExit(args(['--json', '--max-tokens', '1']))
      expect(over.code).toBe(2)
      expect(over.err).toContain('--max-tokens')
      expect(runExit(args(['--json', '--max-tokens', '999999999'])).code).toBe(0)
    })

    it('the retired --max-cost fails loudly and names its replacement, instead of silently not gating', () => {
      const r = runExit(args(['--json', '--max-cost', '5']))
      expect(r.code, 'a removed gate flag must not exit 0').not.toBe(0)
      expect(r.err).toContain('--max-cost was removed')
      expect(r.err).toContain('--max-tokens')
    })
  })

  async function spawnServe(extra: string[]): Promise<{ child: import('node:child_process').ChildProcess; url: string }> {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-serve-')))
    const child = spawn('node', [CLI, 'serve', '--port', '0', '--no-open', '--root', home.configDir, ...extra], {
      env: { ...process.env, ORANGU_NO_CACHE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    const url = await new Promise<string>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('serve never printed its URL\n' + err)), 15_000)
      child.stderr.on('data', (c: Buffer) => {
        err += c.toString('utf8')
        const m = /http:\/\/127\.0\.0\.1:\d+\/_orangu\/[A-Za-z0-9_-]{43}/.exec(err)
        if (m) {
          clearTimeout(to)
          resolve(m[0])
        }
      })
      child.on('exit', () => reject(new Error('serve exited early\n' + err)))
    })
    return { child, url }
  }
  async function stopServe(child: import('node:child_process').ChildProcess): Promise<void> {
    const gone = new Promise((r) => child.on('exit', r))
    child.kill('SIGINT')
    await gone
  }

  it('serve binds 127.0.0.1, answers /api/sessions on a fixture root, keeps text by default, and dies on SIGINT', async () => {
    const { child, url } = await spawnServe([])
    try {
      const rows = (await (await fetch(url + '/api/sessions')).json()) as Array<{ badge: string }>
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(rows.every((r) => ['live', 'idle', 'ended'].includes(r.badge))).toBe(true)
      // loopback only: the operator's own transcript is shown to the operator by default
      const app = (await (await fetch(url + '/api/app')).json()) as { capabilities: { includeText: boolean } }
      expect(app.capabilities.includeText).toBe(true)
    } finally {
      await stopServe(child)
    }
  }, 30_000)

  it('serve --no-include-text opts out of transcript text', async () => {
    const { child, url } = await spawnServe(['--no-include-text'])
    try {
      const app = (await (await fetch(url + '/api/app')).json()) as { capabilities: { includeText: boolean } }
      expect(app.capabilities.includeText).toBe(false)
    } finally {
      await stopServe(child)
    }
  }, 30_000)

  it('serve keeps the Export HTML download redacted by default and un-redacts it only with --include-text', async () => {
    // the fixture's live session opens with this prompt (test/fixtures/home.ts); it must not leave the machine unasked
    const PROMPT_TAIL = 'wire the client'
    const dflt = await spawnServe([])
    try {
      const rows = (await (await fetch(dflt.url + '/api/sessions')).json()) as Array<{ id: string }>
      const id = rows.find((r) => r.id.startsWith('11111111'))!.id
      const res = await fetch(`${dflt.url}/export/${id}.html`)
      expect(res.headers.get('content-disposition')).toContain('attachment')
      const html = await res.text()
      expect(html).not.toContain(PROMPT_TAIL)
      // the viewer itself still keeps text by default
      const app = (await (await fetch(dflt.url + '/api/app')).json()) as { capabilities: { includeText: boolean } }
      expect(app.capabilities.includeText).toBe(true)
    } finally {
      await stopServe(dflt.child)
    }
    const opted = await spawnServe(['--include-text'])
    try {
      const rows = (await (await fetch(opted.url + '/api/sessions')).json()) as Array<{ id: string }>
      const id = rows.find((r) => r.id.startsWith('11111111'))!.id
      const html = await (await fetch(`${opted.url}/export/${id}.html`)).text()
      expect(html).toContain(PROMPT_TAIL)
      expect(html).not.toContain('sk-ant-api03-FAKEFAKEFAKEFAKE') // scrub stays on even when text is included
    } finally {
      await stopServe(opted.child)
    }
  }, 60_000)

  it('feedback uses an empty loopback app even when the configured session root is populated, and dies on SIGTERM', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-feedback-')))
    const child = spawn('node', [CLI, 'feedback', '--context', 'report', '--port', '0', '--no-open'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: home.configDir, ORANGU_NO_CACHE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    const url = await new Promise<string>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('feedback never printed its deep link\n' + err)), 15_000)
      child.stderr.on('data', (c: Buffer) => {
        err += c.toString('utf8')
        const m = /http:\/\/127\.0\.0\.1:\d+\/_orangu\/[A-Za-z0-9_-]{43}\/#feedback\?context=report/.exec(err)
        if (m) {
          clearTimeout(to)
          resolve(m[0])
        }
      })
      child.on('exit', () => reject(new Error('feedback exited early\n' + err)))
    })
    try {
      const base = url.slice(0, url.indexOf('/#'))
      expect(await (await fetch(base + '/api/sessions')).json()).toEqual([])
      const html = await (await fetch(base + '/')).text()
      expect(html).toContain('__ORANGU_SERVE__')
      expect(html).not.toContain(home.liveId)
    } finally {
      const gone = new Promise<number | null>((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      expect(await gone).toBe(0)
    }
    expect(err).toContain('no sessions attached')
    expect(err).toContain('stopped')
  }, 30_000)

  it('feedback rejects text positionals and invalid contexts before starting a server', () => {
    for (const args of [
      ['feedback', 'my private rant', '--no-open'],
      ['feedback', '--context', 'private-session-id', '--no-open'],
    ]) {
      const result = spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/usage: orangu feedback|--context must be one of/)
      expect(result.stderr).not.toContain('http://127.0.0.1:')
    }
  })

  it('watch tails a session and rewrites the HTML report when the transcript grows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-cli-watch-'))
    const home = await makeFixtureHome(dir)
    const out = join(dir, 'watch-report.html')
    const child = spawn('node', [CLI, 'watch', home.liveId, '--root', home.configDir, '--no-open', '--include-text', '--out', out], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8')
    })
    const gone = new Promise((r) => child.on('exit', r))
    try {
      await until(() => existsSync(out) && readFileSync(out, 'utf8').includes('orangu-data'), 15_000, 'the initial report\n' + err)
      if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600)
      const before = readFileSync(out, 'utf8')
      expect(before).not.toContain('WATCH-E2E-NEW-TURN')
      expect(before).toContain('"watch":true')
      await appendTurn(home.sessions[0]!.path, home.liveId, 'WATCH-E2E-NEW-TURN please')
      await until(() => readFileSync(out, 'utf8').includes('WATCH-E2E-NEW-TURN'), 15_000, 'the refreshed report\n' + err)
      if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600)
    } finally {
      child.kill('SIGINT')
      await gone
    }
  }, 45_000)
})
