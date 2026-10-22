/**
 * The 0.11.0 command line is a published contract. A script, a CI job or a skill that ran on 0.11.0 still
 * runs: no verb, alias or flag that 0.11.0 shipped stops working. The lists below are literals from 0.11.0.
 * They are a floor, not a target: a new verb or flag can join CLI_VERBS or KNOWN_FLAGS, and a name that
 * leaves fails here. The help guards of the e2e suites are here too: a short first screen turned 2 suites
 * off with no failure when their guards read it.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KNOWN_FLAGS, parseArgs } from '../src/cli/args.js'
import { CLI_VERBS, EXTRA_COMMANDS } from '../src/cli/commands/index.js'
import { makeFixtureHome } from './fixtures/home.js'

/** the 19 names that 0.11.0 dispatches: 12 core verbs and aliases, then the 7 registered verbs */
const VERBS_0_11 = [
  'report', 'html', 'analyze', 'a', 'list', 'ls', 'pick', 'repo', 'global', 'all', 'watch', 'serve',
  'feedback', 'evidence', 'estimate', 'harness', 'suggest', 'ste', 'show-me',
] as const

/** the 67 flag names that 0.11.0 accepts (src/cli/args.ts), the retired max-cost included */
const FLAGS_0_11 = [
  'json', 'open', 'help', 'version', 'no-redact', 'redact', 'include-text', 'no-include-text', 'strip-paths', 'quiet',
  'watch', 'global', 'all', 'no-open', 'stdout', 'md', 'markdown', 'fail-on-hook-errors', 'follow', 'slim', 'list',
  'allow-claude', 'estimate', 'for-proposal', 'for-apply', 'verbose', 'no-color', 'plain', 'lines',
  'o', 'r', 'l', 's',
  'h', 'out', 'html', 'root', 'config', 'cwd', 'limit', 'no-cache', 'jobs', 'j', 'max-tokens', 'max-cost', 'port', 'p',
  'max-live', 'context', 'depth', 'scope', 'session', 'rule', 'insight', 'title', 'finding', 'suggestion', 'receipt',
  'show', 'effect', 'set', 'proposal', 'manifest', 'application', 'verification', 'cohort', 'render',
] as const

/** the 29 long flags that 0.11.0 parses with no value: `--<name> <word>` leaves the word a positional */
const BOOL_FLAGS_0_11: readonly string[] = FLAGS_0_11.slice(0, FLAGS_0_11.indexOf('lines') + 1)
/** the 4 short flags that 0.11.0 parses with the next word as their value. Every other short flag takes no value */
const SHORT_VALUE_FLAGS_0_11: readonly string[] = ['o', 'r', 'l', 's']

const ROOT = process.cwd()
const CLI = join(ROOT, 'dist', 'orangu.js')
const HOME = mkdtempSync(join(tmpdir(), 'orangu-compat-home-'))

/** the built CLI as a terminal outside Claude Code runs it, with a private orangu home */
function cli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ORANGU_HOME: HOME }
  delete env['CLAUDECODE']
  delete env['ORANGU_ALLOW_RAW']
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('the 0.11.0 names', () => {
  it('holds the 19 verbs and aliases, the 67 flags and the retired max-cost of 0.11.0', () => {
    expect(new Set(VERBS_0_11).size).toBe(19)
    expect(new Set(FLAGS_0_11).size).toBe(67)
    expect(VERBS_0_11.filter((name) => !CLI_VERBS.includes(name)), 'a 0.11.0 verb left CLI_VERBS').toEqual([])
    expect(FLAGS_0_11.filter((name) => !KNOWN_FLAGS.has(name)), 'a 0.11.0 flag left KNOWN_FLAGS').toEqual([])
  })

  it('parses each 0.11.0 flag as 0.11.0 did: with no value, or with the next word as its value', () => {
    expect(BOOL_FLAGS_0_11).toHaveLength(29)
    expect(BOOL_FLAGS_0_11.at(-1)).toBe('lines')
    for (const name of FLAGS_0_11) {
      const flag = (name.length === 1 ? '-' : '--') + name
      const parsed = parseArgs(['report', flag, 'word'])
      expect(parsed.command, flag).toBe('report')
      const takesNoValue = name.length === 1 ? !SHORT_VALUE_FLAGS_0_11.includes(name) : BOOL_FLAGS_0_11.includes(name)
      if (takesNoValue) {
        expect(parsed.flags[name], flag).toBe(true)
        expect(parsed.positionals, flag).toEqual(['word'])
      } else {
        expect(parsed.flags[name], flag).toBe('word')
        expect(parsed.positionals, flag).toEqual([])
      }
      // The = form gives every long flag its value, and a flag at the end of the line is true.
      if (name.length > 1) expect(parseArgs(['report', `${flag}=word`]).flags[name], `${flag}=word`).toBe('word')
      expect(parseArgs(['report', flag]).flags[name], `${flag} at the end`).toBe(true)
    }
  })

  it('CLI_VERBS has each name once, and only the names that main.ts and EXTRA_COMMANDS dispatch', () => {
    expect(new Set(CLI_VERBS).size).toBe(CLI_VERBS.length)
    const main = readFileSync(join(ROOT, 'src/cli/main.ts'), 'utf8')
    const cases = [...main.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]!)
    expect(cases.length).toBeGreaterThanOrEqual(12)
    expect([...CLI_VERBS].sort()).toEqual([...cases, ...Object.keys(EXTRA_COMMANDS)].sort())
  })
})

describe.skipIf(!existsSync(CLI))('the 0.11.0 names on the built CLI', () => {
  it('<name> --help exits 0 for each of the 19 names and prints the full reference', () => {
    const all = cli(['help', 'all'])
    expect(all.status, all.stderr).toBe(0)
    for (const name of VERBS_0_11) {
      const r = cli([name, '--help'])
      expect(r.status, `${name} --help: ${r.stderr}`).toBe(0)
      expect(r.stdout, `${name} --help`).toBe(all.stdout)
    }
  })

  it('the retired --max-cost still fails on a session verb and a scope verb, and names its replacement', () => {
    for (const name of ['report', 'analyze', 'global']) {
      const r = cli([name, '--max-cost', '5'])
      expect(r.status, name).toBe(1)
      expect(r.stderr, name).toContain('--max-cost was removed. Use --max-tokens <n>.')
    }
  })

  it('the aliases print the same bytes as their verbs: ls is list, a is analyze, html is report, all is global', async () => {
    const home = await makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-compat-')))
    const root = ['--root', home.configDir, '--no-cache', '--quiet']
    const list = cli(['list', '--json', ...root])
    expect(list.status, list.stderr).toBe(0)
    expect(cli(['ls', '--json', ...root]).stdout).toBe(list.stdout)
    // 2 analysis runs with --no-cache differ only in their 2 clock fields: generator.generatedAt (the
    // cache test sets it to 0 the same way, src/cache/cache.test.ts) and parse.parseMs. Every other byte is the same.
    const unclocked = (json: string) => json.replace(/"generatedAt":\d+/, '"generatedAt":0').replace(/"parseMs":\d+/, '"parseMs":0')
    const analyze = cli(['analyze', home.endedId, '--json', ...root])
    expect(analyze.status, analyze.stderr).toBe(0)
    expect(JSON.parse(analyze.stdout).session.id).toBe(home.endedId)
    expect(unclocked(analyze.stdout)).not.toBe(analyze.stdout)
    expect(unclocked(cli(['a', home.endedId, '--json', ...root]).stdout)).toBe(unclocked(analyze.stdout))
    // The report and the aggregate carry the same 2 clock fields in each place that they appear, and the report also
    // carries the age of each session row at the time of the run.
    const unclockedAll = (text: string) =>
      text.replace(/"generatedAt":\d+/g, '"generatedAt":0').replace(/"parseMs":\d+/g, '"parseMs":0').replace(/"ageMs":\d+/g, '"ageMs":0')
    const report = cli(['report', home.endedId, '--stdout', ...root])
    expect(report.status, report.stderr).toBe(0)
    expect(report.stdout).toContain('<html')
    expect(unclockedAll(cli(['html', home.endedId, '--stdout', ...root]).stdout)).toBe(unclockedAll(report.stdout))
    const global = cli(['global', '--json', ...root])
    expect(global.status, global.stderr).toBe(0)
    expect(JSON.parse(global.stdout).sessionCount).toBeGreaterThan(0)
    expect(unclockedAll(cli(['all', '--json', ...root]).stdout)).toBe(unclockedAll(global.stdout))
  })
})

/** Each `skipIf(...)` condition of a test file, and the body of each helper that the condition calls. */
function skipGuards(text: string): string[] {
  const guards: string[] = []
  for (const match of text.matchAll(/skipIf\(/g)) {
    const start = match.index + match[0].length
    let depth = 1
    let end = start
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === '(') depth++
      else if (text[end] === ')') depth--
    }
    const condition = text.slice(start, end - 1)
    guards.push(condition)
    for (const call of condition.matchAll(/\b([A-Za-z_$][\w$]*)\(/g)) {
      const body = new RegExp(`^(?:const|function) ${call[1]}\\b[\\s\\S]*?^\\}`, 'm').exec(text)
      if (body) guards.push(body[0])
    }
  }
  return guards
}

describe('the help guards of the e2e suites', () => {
  it('no skip guard reads the short screen, and the evidence and suggest suites read orangu help all', () => {
    const files = ['src', 'test'].flatMap((dir) =>
      readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.(test|spec)\.ts$/.test(file))
        .map((file) => join(dir, file)),
    )
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((file) => skipGuards(readFileSync(join(ROOT, file), 'utf8')).some((guard) => /['"](?:--help|-h)['"]/.test(guard)))
    expect(offenders, 'a skip guard that reads --help turns its suite off when the short screen drops a verb').toEqual([])
    for (const [file, verb] of [['src/cli/commands/evidence.e2e.test.ts', 'orangu evidence'], ['src/cli/commands/suggest.e2e.test.ts', 'orangu suggest']] as const) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      expect(text, file).not.toContain("'--help'")
      expect(skipGuards(text).join('\n'), file).toMatch(new RegExp(`\\[CLI, 'help', 'all'\\][^\\n]*\\.includes\\('${verb}'\\)`))
    }
  })
})
