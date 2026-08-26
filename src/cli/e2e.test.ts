import { describe, it, expect } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeFixtureHome, appendTurn } from '../../test/fixtures/home.js'

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
    for (const f of ['--port', '--open', '--include-text', '--max-live']) expect(h).toContain(f)
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

  it('serve binds 127.0.0.1, answers /api/sessions on a fixture root, and dies on SIGINT', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-serve-')))
    const child = spawn('node', [CLI, 'serve', '--port', '0', '--no-open', '--root', home.configDir], {
      env: { ...process.env, ORANGU_NO_CACHE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    const url = await new Promise<string>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('serve never printed its URL\n' + err)), 15_000)
      child.stderr.on('data', (c: Buffer) => {
        err += c.toString('utf8')
        const m = /http:\/\/127\.0\.0\.1:\d+/.exec(err)
        if (m) {
          clearTimeout(to)
          resolve(m[0])
        }
      })
      child.on('exit', () => reject(new Error('serve exited early\n' + err)))
    })
    try {
      const rows = (await (await fetch(url + '/api/sessions')).json()) as Array<{ badge: string }>
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(rows.every((r) => ['live', 'idle', 'ended'].includes(r.badge))).toBe(true)
    } finally {
      const gone = new Promise((r) => child.on('exit', r))
      child.kill('SIGINT')
      await gone
    }
  }, 30_000)

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
        const m = /http:\/\/127\.0\.0\.1:\d+\/#feedback\?context=report/.exec(err)
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
      const before = readFileSync(out, 'utf8')
      expect(before).not.toContain('WATCH-E2E-NEW-TURN')
      await appendTurn(home.sessions[0]!.path, home.liveId, 'WATCH-E2E-NEW-TURN please')
      await until(() => readFileSync(out, 'utf8').includes('WATCH-E2E-NEW-TURN'), 15_000, 'the refreshed report\n' + err)
    } finally {
      child.kill('SIGINT')
      await gone
    }
  }, 45_000)
})
