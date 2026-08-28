import { describe, it, expect } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
// report / analyze / bare orangu persist the top finding as a suggestion record: every spawn below
// inherits this hermetic ORANGU_HOME so the suite never writes into the developer's real ~/.orangu
process.env['ORANGU_HOME'] = mkdtempSync(join(tmpdir(), 'orangu-cli-home-'))
const run = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
/** any CSI/OSC escape, carriage return (spinner frame) or BEL */
const ESCAPES = /[\x1b\r\x07]/
const stripEscapes = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

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
    expect(h).toContain("serve's exported HTML")
    expect(h).toContain('hide previews in the loopback viewer')
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

  it('repo honours --root: only the named config dir is scanned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-cli-repo-root-'))
    const cwd = join(dir, 'project')
    await mkdir(cwd, { recursive: true })
    const home = await makeFixtureHome(dir, { cwd })
    const out = JSON.parse(run(['repo', cwd, '--root', home.configDir, '--json', '--quiet', '--no-cache', '--jobs', '1'])) as {
      sessionCount: number
      sessions: Array<{ id: string }>
    }
    expect(out.sessionCount).toBe(home.sessions.length)
    expect(new Set(out.sessions.map((s) => s.id))).toEqual(new Set(home.sessions.map((s) => s.id)))
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
    // sessions[].title is the first prompt: transcript text, stripped by default like `analyze --json`
    expect(stdout).not.toContain('My key is')
    expect(defaultJson.byProject[0]?.key).toBe('demo')
    expect(defaultJson.sessions[0]?.project).toBe('demo')
    expect(defaultJson.topSessions[0]?.project).toBe('demo')

    const human = run(base)
    expect(human).not.toContain(secret)
    expect(human).not.toContain('Users-test-Code')
    expect(human).not.toContain('My key is')
    expect(human).toContain('private/‹anthropic-key›.ts')
    // --include-text brings the title back, still scrubbed
    const humanWithText = run([...base, '--include-text'])
    expect(humanWithText).not.toContain(secret)
    expect(humanWithText).toContain('My key is ‹anthropic-key›')
    const strippedHuman = run([...base, '--strip-paths'])
    expect(strippedHuman).not.toContain(secret)
    expect(strippedHuman).toContain('‹anthropic-key›.ts')
    expect(strippedHuman).not.toContain('private/‹anthropic-key›.ts')

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
    expect(stripped.topReReadFiles[0]?.path).toBe('‹anthropic-key›.ts')

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

  // A9 (F4): after report/analyze the terminal names the next step as the SHORT improve command,
  // because the record is persisted through the suggestion store at report time; never a base64
  // payload; never under --quiet or --json. Replaces the assertions that pinned the payload line
  // (stated cause: the owner's "no base64 in the terminal, ever").
  it('persists the top finding and prints the short improve command; silent under --quiet and --json', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-next-step-')))
    const oranguHome = await mkdtemp(join(tmpdir(), 'orangu-cli-next-step-home-'))
    const env = { ...process.env, ORANGU_HOME: oranguHome }
    const base = ['report', home.endedId, '--root', home.configDir, '--no-open', '--no-cache']
    const human = spawnSync('node', [CLI, ...base], { encoding: 'utf8', env })
    expect(human.status, human.stderr).toBe(0)
    // stdout is the path and nothing else
    expect(human.stdout.trim().endsWith('.html')).toBe(true)
    expect(human.stdout.trim().split('\n')).toHaveLength(1)
    const lines = human.stderr.split('\n').filter(Boolean)
    expect(lines[0]).toMatch(/^  ✓ analyzed \d+\.\d MB in \d+(\.\d)?m?s( · \d+ redactions?)?$/)
    expect(lines[1]).toBe('  report   ' + human.stdout.trim())
    const finding = lines.findIndex((l) => l.startsWith('  finding  '))
    const next = lines.findIndex((l) => l.startsWith('  next     '))
    const beta = lines.findIndex((l) => l === '  beta     orangu feedback --context report')
    expect(finding).toBeGreaterThan(1)
    expect(next).toBe(finding + 1)
    expect(beta).toBe(lines.length - 1)
    expect(lines[next]).toMatch(/^  next {5}claude "\/orangu:improve sg_[0-9a-f]{12}"$/)
    expect(human.stderr).not.toContain(' --finding ')
    expect(human.stderr).not.toMatch(/[A-Za-z0-9_-]{80,}/)
    expect(human.stderr).toContain('  plugin   /plugin marketplace add NissanOhana/orangu')
    expect(human.stderr).toContain('/plugin install orangu')
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80)
    // a pipe: no escapes at all, no spinner frame
    expect(human.stdout + human.stderr).not.toMatch(ESCAPES)
    // the record exists in the store, once, under the id the command names
    const id = /sg_[0-9a-f]{12}/.exec(lines[next]!)![0]
    const storeFile = join(oranguHome, 'suggestions.jsonl')
    const records = () => readFileSync(storeFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; sessionIds: string[]; source: string })
    expect(records()).toHaveLength(1)
    expect(records()[0]).toMatchObject({ id, sessionIds: [home.endedId], source: 'report' })
    // running it again appends nothing
    const again = spawnSync('node', [CLI, ...base], { encoding: 'utf8', env })
    expect(again.status, again.stderr).toBe(0)
    expect(records()).toHaveLength(1)

    const quiet = spawnSync('node', [CLI, ...base, '--quiet'], { encoding: 'utf8', env })
    expect(quiet.status, quiet.stderr).toBe(0)
    expect(quiet.stderr).toBe('')
    expect(quiet.stdout.trim().endsWith('.html')).toBe(true)

    const analyze = spawnSync('node', [CLI, 'analyze', home.endedId, '--root', home.configDir, '--no-cache'], { encoding: 'utf8', env })
    expect(analyze.status, analyze.stderr).toBe(0)
    expect(analyze.stderr).toMatch(/^  ✓ analyzed /)
    expect(analyze.stderr.indexOf('  next     claude "/orangu:improve sg_')).toBeLessThan(analyze.stderr.indexOf('orangu feedback --context session'))
    expect(analyze.stderr).not.toContain(' --finding ')
    expect(analyze.stdout).toContain('  quality  ')
    expect(analyze.stdout).toContain('  findings')
    for (const l of (analyze.stdout + analyze.stderr).split('\n')) expect(l.length, l).toBeLessThanOrEqual(80)
    expect(records()).toHaveLength(1)
    const machine = spawnSync('node', [CLI, 'analyze', home.endedId, '--root', home.configDir, '--no-cache', '--json'], { encoding: 'utf8', env })
    expect(machine.status, machine.stderr).toBe(0)
    expect(machine.stderr).toBe('')
    expect(machine.stdout).not.toContain('next ')

    expect(run(['list', '--root', home.configDir])).toContain('orangu harness')
  })

  // The store is written on the user's machine; when it cannot be, the footer says so and falls back
  // to the self-contained long form (the single line allowed past 80 columns), still exiting 0.
  it('falls back to the long form, and says why, when the store is unwritable', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-store-ro-')))
    // the store repairs the mode of a directory it owns, so a chmod'd dir is not unwritable; a
    // regular file where the home directory should be is, on every platform
    const notADir = join(await mkdtemp(join(tmpdir(), 'orangu-cli-store-ro-home-')), 'orangu-home')
    writeFileSync(notADir, 'not a directory')
    const r = spawnSync('node', [CLI, 'report', home.endedId, '--root', home.configDir, '--no-open', '--no-cache'], { encoding: 'utf8', env: { ...process.env, ORANGU_HOME: notADir } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toMatch(/^  store {4}unavailable: .+; long form follows$/m)
    expect(r.stderr).toMatch(/^  next {5}claude "\/orangu:improve sg_[0-9a-f]{12} --finding [A-Za-z0-9_-]+"$/m)
    const wide = r.stderr.split('\n').filter((l) => l.length > 80)
    expect(wide).toHaveLength(1)
    expect(wide[0]).toContain(' --finding ')
  })

  // --json and --quiet are machine contracts: no colour, no spinner frame, no link, whatever the
  // environment claims; the human path honours NO_COLOR and stays plain on a pipe.
  it('keeps --json and --quiet byte-clean under FORCE_COLOR and a linking terminal', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-byte-clean-')))
    const loud = { ...process.env, FORCE_COLOR: '3', FORCE_HYPERLINK: '1', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' }
    delete (loud as Record<string, string | undefined>)['NO_COLOR']
    const root = ['--root', home.configDir, '--no-cache']
    for (const args of [
      ['report', home.endedId, ...root, '--no-open', '--json'],
      ['analyze', home.endedId, ...root, '--json'],
      ['list', ...root, '--json'],
      ['report', home.endedId, ...root, '--no-open', '--quiet'],
      ['analyze', home.endedId, ...root, '--quiet'],
      [...root, '--quiet'],
    ]) {
      const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: loud })
      expect(r.status, args.join(' ') + '\n' + r.stderr).toBe(0)
      expect(r.stdout + r.stderr, args.join(' ')).not.toMatch(ESCAPES)
      if (args.includes('--quiet')) expect(r.stderr, args.join(' ')).toBe('')
    }
    // FORCE_COLOR paints the human path even on a pipe; NO_COLOR wins over it
    const painted = spawnSync('node', [CLI, 'analyze', home.endedId, ...root], { encoding: 'utf8', env: loud })
    expect(painted.stdout).toContain('\x1b[')
    expect(painted.stderr).not.toContain('\r')
    for (const l of stripEscapes(painted.stdout + painted.stderr).split('\n')) expect(l.length, l).toBeLessThanOrEqual(80)
    const plain = spawnSync('node', [CLI, 'analyze', home.endedId, ...root], { encoding: 'utf8', env: { ...loud, NO_COLOR: '1' } })
    expect(plain.stdout + plain.stderr).not.toMatch(ESCAPES)
    const noColor = spawnSync('node', [CLI, 'analyze', home.endedId, ...root, '--no-color'], { encoding: 'utf8', env: loud })
    expect(noColor.stdout + noColor.stderr).not.toMatch(ESCAPES)
    // --verbose is the only way to see the cache diagnostic, on stderr
    const verbose = spawnSync('node', [CLI, 'analyze', home.endedId, '--root', home.configDir, '--verbose'], { encoding: 'utf8' })
    expect(verbose.stderr).toMatch(/^  cache {4}\d+ hits, \d+ miss/m)
    expect(painted.stderr).not.toContain('cache')
  })

  // A8: `orangu` with no verb runs the loop on the latest session; --help stays the help screen.
  it('--session / -s select a session like the positional; disagreement and selector-less verbs fail', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-session-flag-')))
    const root = ['--root', home.configDir, '--no-cache', '--json']
    const summary = (stdout: string) => {
      const a = JSON.parse(stdout) as { session: { id: string }; summary: unknown }
      return { id: a.session.id, summary: a.summary }
    }
    const positional = summary(run(['analyze', home.endedId, ...root]))
    expect(positional.id).toBe(home.endedId)
    expect(summary(run(['analyze', '--session', home.endedId, ...root]))).toEqual(positional)
    expect(summary(run(['analyze', '-s', home.endedId, ...root]))).toEqual(positional)
    expect(summary(run(['analyze', home.endedId, '--session', home.endedId, ...root]))).toEqual(positional)
    // report and watch share selectSession: the report path carries the id the flag named
    expect(run(['report', '--session', home.endedId.slice(0, 8), '--root', home.configDir, '--no-cache', '--no-open', '--quiet']).trim()).toMatch(/orangu-aaaaaaaa\.html$/)

    const conflict = spawnSync('node', [CLI, 'analyze', home.idleId, '--session', home.endedId, ...root], { encoding: 'utf8' })
    expect(conflict.status).toBe(1)
    expect(conflict.stderr).toMatch(/name different sessions; give one/)
    const bare = spawnSync('node', [CLI, 'analyze', '-s', ...root], { encoding: 'utf8' })
    expect(bare.status).toBe(1)
    expect(bare.stderr).toMatch(/--session needs a session selector/)
    const list = spawnSync('node', [CLI, 'list', '--session', home.endedId, '--root', home.configDir], { encoding: 'utf8' })
    expect(list.status).toBe(1)
    expect(list.stderr).toMatch(/--session selects one session/)
    const comma = spawnSync('node', [CLI, 'analyze', '--session', `${home.endedId},${home.idleId}`, ...root], { encoding: 'utf8' })
    expect(comma.status).toBe(1)
    expect(comma.stderr).toMatch(/comma lists belong to estimate and suggest/)
  })

  it('current resolves the surrounding Claude Code session and fails cleanly outside one', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-current-')), { cwd: '/Users/test/Code/demo' })
    const root = ['--root', home.configDir, '--no-cache']
    // the suite itself may run inside Claude Code: start from an environment without its variables
    const outside = { ...process.env } as Record<string, string | undefined>
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_PROJECT_DIR']) delete outside[k]
    const id = (stdout: string) => (JSON.parse(stdout) as { session: { id: string } }).session.id

    const named = spawnSync('node', [CLI, 'analyze', 'current', ...root, '--json'], { encoding: 'utf8', env: { ...outside, CLAUDE_CODE_SESSION_ID: home.endedId } })
    expect(named.status, named.stderr).toBe(0)
    expect(id(named.stdout)).toBe(home.endedId)
    expect(named.stderr).toBe('')
    const viaFlag = spawnSync('node', [CLI, 'report', '--session', 'current', ...root, '--no-open', '--quiet'], { encoding: 'utf8', env: { ...outside, CLAUDE_CODE_SESSION_ID: home.idleId } })
    expect(viaFlag.status, viaFlag.stderr).toBe(0)
    expect(viaFlag.stdout.trim()).toMatch(/orangu-22222222\.html$/)

    const guessed = spawnSync('node', [CLI, 'analyze', 'current', ...root, '--json'], { encoding: 'utf8', env: { ...outside, CLAUDECODE: '1', CLAUDE_PROJECT_DIR: '/Users/test/Code/demo' } })
    expect(guessed.status, guessed.stderr).toBe(0)
    expect(id(guessed.stdout)).toBe(home.liveId)
    expect(guessed.stderr).toMatch(/current: guessed 11111111 from cwd/)
    expect(guessed.stdout + guessed.stderr).not.toMatch(ESCAPES)

    const absent = spawnSync('node', [CLI, 'analyze', 'current', ...root, '--json'], { encoding: 'utf8', env: { ...outside, CLAUDE_CODE_SESSION_ID: '99999999-0000-4000-8000-000000000099' } })
    expect(absent.status).toBe(1)
    expect(absent.stderr).toMatch(/has no transcript yet/)
    const none = spawnSync('node', [CLI, 'analyze', 'current', ...root], { encoding: 'utf8', env: outside })
    expect(none.status).toBe(1)
    expect(none.stderr).toMatch(/^error: current: not inside a Claude Code session; use latest, an id, or orangu pick/m)
    expect(none.stderr).not.toMatch(/^\s+at /m)

    // the other selector readers: evidence and estimate
    const evidence = spawnSync('node', [CLI, 'evidence', 'current', ...root, '--estimate'], { encoding: 'utf8', env: { ...outside, CLAUDE_CODE_SESSION_ID: home.endedId } })
    expect(evidence.status, evidence.stderr).toBe(0)
    expect((JSON.parse(evidence.stdout) as { sessions?: number; bytes?: number }).bytes).toBeGreaterThan(0)
    const estimate = spawnSync('node', [CLI, 'estimate', '--session', 'current', '--json'], {
      encoding: 'utf8',
      env: { ...outside, CLAUDE_CONFIG_DIR: home.configDir, CLAUDE_CODE_SESSION_ID: home.endedId },
    })
    expect(estimate.status, estimate.stderr).toBe(0)
    expect((JSON.parse(estimate.stdout) as { sessions: number }).sessions).toBe(1)
  })

  it('bare orangu analyzes the latest session and prints the sentence and the next command; --help is unchanged', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-cli-bare-')))
    const bare = spawnSync('node', [CLI, '--root', home.configDir, '--no-cache'], { encoding: 'utf8' })
    expect(bare.status, bare.stderr).toBe(0)
    expect(bare.stdout).toMatch(/^ {8}latest · [0-9a-f]{8} · \d+ turns/m)
    // the latest fixture session's title carries a planted key: scrubbed like `analyze --json`, kept with --no-redact
    expect(bare.stdout).not.toContain('sk-ant-api03-FAKEFAKEFAKEFAKE')
    expect(bare.stdout).toContain('My key is ‹anthropic-key›')
    const raw = spawnSync('node', [CLI, '--root', home.configDir, '--no-cache', '--no-redact'], { encoding: 'utf8' })
    expect(raw.stdout).toContain('sk-ant-api03-FAKEFAKEFAKEFAKE')
    const human = spawnSync('node', [CLI, 'analyze', home.liveId, '--root', home.configDir, '--no-cache'], { encoding: 'utf8' })
    expect(human.stdout).not.toContain('sk-ant-api03-FAKEFAKEFAKEFAKE')
    expect(human.stdout).toContain('My key is ‹anthropic-key›')
    expect(bare.stdout).toMatch(/^  finding {2}/m)
    expect(bare.stdout).toMatch(/^  next {5}claude "\/orangu:improve sg_[0-9a-f]{12}"$|ran clean/m)
    expect(bare.stdout).not.toContain(' --finding ')
    expect(bare.stdout + bare.stderr).not.toMatch(ESCAPES)
    for (const l of bare.stdout.split('\n')) expect(l.length, l).toBeLessThanOrEqual(80)
    expect(bare.stdout).not.toContain('usage')
    expect(bare.stdout).toContain('orangu --help for every command')
    // the sentence is the report's outcome headline, never a canned line
    expect(bare.stdout).toMatch(/commit|test run|file|request|Stopped by you|nothing committed/)
    // the trailing hint is a diagnostic: --quiet silences it and keeps the answer itself
    const quiet = spawnSync('node', [CLI, '--root', home.configDir, '--no-cache', '--quiet'], { encoding: 'utf8' })
    expect(quiet.status, quiet.stderr).toBe(0)
    expect(quiet.stderr).not.toContain('orangu --help for every command')
    expect(quiet.stdout).toMatch(/^ {8}latest · /m)
    expect(quiet.stdout).toMatch(/^  finding {2}/m)
    expect(quiet.stderr).toBe('')

    const help = run(['--help'])
    expect(help).toContain('usage')
    expect(help).toMatch(/usage\n  orangu {2,}analyze the latest session; print the next step\n  orangu report/)
    expect(help).not.toContain('top finding')
    expect(help).not.toContain('        latest ·')
    expect(run(['help'])).toBe(help)
    // --json with no verb has nothing to serialise: it keeps printing help
    expect(run(['--json'])).toBe(help)

    const empty = await mkdtemp(join(tmpdir(), 'orangu-cli-bare-empty-'))
    const none = spawnSync('node', [CLI, '--root', empty, '--no-cache'], { encoding: 'utf8' })
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('No sessions found')
    expect(none.stderr).not.toContain('at ')
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

    // `report` is a session verb too: the gate documented for CI fires on it, and the retired flag
    // fails on EVERY verb (it is checked once, before dispatch), never exit 0 by accident.
    it('report honours --max-tokens and rejects --max-cost like analyze does', async () => {
      const out = join(await mkdtemp(join(tmpdir(), 'orangu-cli-gate-report-')), 'r.html')
      const report = (extra: string[]) => ['report', 'aaaaaaaa', '--root', home.configDir, '--quiet', '--no-open', '-o', out, ...extra]
      const over = runExit(report(['--max-tokens', '1']))
      expect(over.code).toBe(2)
      expect(over.err).toContain('--max-tokens')
      expect(runExit(report(['--max-tokens', '999999999'])).code).toBe(0)
      const retired = runExit(report(['--max-cost', '5']))
      expect(retired.code).toBe(1)
      expect(retired.err).toContain('--max-cost was removed')
      expect(runExit(['global', '--root', home.configDir, '--quiet', '--limit', '1', '--max-cost', '5']).err).toContain('--max-cost was removed')
    })

    it('a session gate on an aggregate verb fails instead of silently passing', () => {
      const r = runExit(['global', '--root', home.configDir, '--quiet', '--limit', '1', '--max-tokens', '1'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('--max-tokens gates one session')
    })

    it('an unknown flag fails the run (a typo in a CI flag is not a no-op)', () => {
      const r = runExit(args(['--json', '--max-tokns', '1']))
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown flag --max-tokns')
      expect(r.err).toContain('orangu --help')
      expect(runExit(args(['--json', '-x'])).err).toContain('unknown flag -x')
    })

    // --help promises "(default: stripped)" for analyze output too: previews and Insight.detail
    // (transcript-derived copy) leave `analyze --json` only with --include-text, exactly like the report.
    it('analyze --json strips prompt previews and insight detail unless --include-text', () => {
      const previews = (out: string): string[] => {
        const a = JSON.parse(out) as { turns: Array<{ kind: string; promptPreview: string }>; insights: Array<{ detail: string }> }
        return [...a.turns.filter((t) => t.kind === 'human').map((t) => t.promptPreview), ...a.insights.map((i) => i.detail)]
      }
      const stripped = previews(runExit(args(['--json'])).out)
      expect(stripped.length).toBeGreaterThan(0)
      expect(stripped.every((p) => p === '')).toBe(true)
      const kept = previews(runExit(args(['--json', '--include-text'])).out)
      expect(kept.some((p) => p.length > 0)).toBe(true)
      expect(kept.length).toBe(stripped.length)
    })

    it('a not-found suggestion id is a one-line error, not a Node stack trace', () => {
      const r = runExit(['suggest', '--show', 'sg_000000000000', '--root', home.configDir])
      expect(r.code).toBe(1)
      expect(r.err).toContain('not found')
      expect(r.err).not.toMatch(/^\s+at /m)
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
