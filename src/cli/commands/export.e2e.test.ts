/**
 * `orangu export` end to end, against the BUILT CLI (dist/orangu.js). It skips when dist is missing, as the other e2e
 * tests do. Hermetic: HOME, ORANGU_HOME and the root variables point at a temp tree, as harness.e2e.test.ts does, so
 * no real transcript, store or profile is read.
 *
 * The fixture plants a secret and a unique word in each place a prompt reaches (the first prompt, a correction, a
 * command, a tool error, an edit), and a second secret and word in a free-text answer of the profile.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBuilder, resetIds } from '../../../test/fixtures/session-builder.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')
const SECRET = 'sk-ant-api03-EXPORTMARKER9073'
const PROMPT_WORD = 'zebraexportprompt4417'
const PROFILE_SECRET = 'sk-ant-api03-PRIVATEPURPLEFERRET9073'
const PROFILE_WORD = 'quokkaexportprofile5531'
/** a hook that the shell runs with an assignment in front: the value is no secret word, so the scrub cannot see it */
const HOOK_VALUE = 'zebrahooktopic5512'
const HOOK = `NTFY_TOPIC=${HOOK_VALUE} ~/.claude/hooks/ntfy.sh`
/** a quoted assignment value with a space: a split on whitespace takes its second word for the program */
const BEARER = 'zebrabearer7734'
const AUTH_HOOK = `AUTH="Bearer ${BEARER}" ~/.claude/hooks/post.sh`
/** a package runner after a flag, with a secret topic in a URL: the topic must never name the row */
const TOPICS = ['zebratopic8845', 'zebratopic8846']
const NPX_HOOKS = [`npx -y ntfy-notify https://ntfy.sh/${TOPICS[0]}`, `npx -y ntfy-notify https://ntfy.sh/${TOPICS[1]}.sh`]
/** a value in the code span of a "do not" rule, which the analyzer keeps as the command target */
const RULE_TOKEN = 'zebraruletoken6623'
const SLUG = '-Users-test-Code-demo'
const IDS = ['eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000002']
const SECTIONS = ['summary', 'index', 'profile', 'evidence', 'harness', 'lessons']

/**
 * A session that puts the secret and the word in a prompt, a correction, 4 failing commands and an edit. It also loads a
 * CLAUDE.md rule with a value in its code span, breaks that rule, and runs the hook that starts with an assignment.
 */
function transcript(id: string, startAt: string): string {
  resetIds()
  const b = new SessionBuilder({ sessionId: id, startAt })
  b.attachment('instructions', { files: [{ path: '/Users/test/Code/demo/CLAUDE.md', type: 'Project', content: `# Rules\n- Never run \`deploy --token ${RULE_TOKEN}\` by hand.\n` }] })
  b.userPrompt(`My key is ${SECRET}. Fix the ${PROMPT_WORD} parser.`)
  b.tick(1_000)
  b.toolCall('Bash', { command: `deploy --token ${RULE_TOKEN}` }, 'ok', { usage: { input_tokens: 5, output_tokens: 20 } })
  for (let i = 0; i < 4; i++) {
    b.toolCall('Bash', { command: `npm test -- ${PROMPT_WORD} --token ${SECRET}` }, `FAIL ${PROMPT_WORD}: token ${SECRET} was refused`, {
      isError: true,
      usage: { input_tokens: 10, cache_read_input_tokens: 4_000, output_tokens: 40 },
    })
  }
  b.userPrompt(`No, that is wrong. The ${PROMPT_WORD} parser is still broken.`)
  b.tick(1_000)
  b.toolCall('Edit', { file_path: '/Users/test/Code/demo/src/parser.ts', old_string: 'a', new_string: `b // ${PROMPT_WORD}` }, 'ok', { usage: { input_tokens: 5, output_tokens: 20 } })
  b.stopHookSummary([{ command: HOOK, durationMs: 40 }])
  b.turnDuration(9_000, 12)
  return b.toJsonl()
}

const PROFILE = {
  v: 1,
  updatedAt: '2026-10-30',
  role: 'write-code',
  work: ['features'],
  priority: 'tokens',
  models: 'ask',
  repeats: `Run the tests first. ${PROFILE_WORD} uses ${PROFILE_SECRET} in the demo.`,
  never: 'Never propose a new model.',
}

let home = ''
let oranguHome = ''
let repo = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'orangu-export-home-'))
  const projects = join(home, '.claude', 'projects', SLUG)
  await mkdir(projects, { recursive: true })
  await writeFile(join(projects, `${IDS[0]}.jsonl`), transcript(IDS[0]!, '2026-08-14T10:00:00.000Z'))
  await writeFile(join(projects, `${IDS[1]}.jsonl`), transcript(IDS[1]!, '2026-08-15T10:00:00.000Z'))
  // the same hook, declared, and a second hook that never runs: a declared hook makes a row even with no run
  const declared = [HOOK, AUTH_HOOK, ...NPX_HOOKS].map((command) => ({ type: 'command', command }))
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: declared }] } }))
  oranguHome = join(home, '.orangu')
  await mkdir(oranguHome, { recursive: true, mode: 0o700 })
  await writeFile(join(oranguHome, 'profile.json'), JSON.stringify(PROFILE))
  repo = await mkdtemp(join(tmpdir(), 'orangu-export-repo-'))
})

/** The built CLI in the fixture: ORANGU_CLAUDE_MANAGED_DIRS is empty, so no managed policy of this machine reads. */
function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, HOME: home, ORANGU_HOME: oranguHome, ORANGU_NO_CACHE: '1', ORANGU_CLAUDE_ROOTS: '', CLAUDE_CONFIG_DIR: '', ORANGU_CLAUDE_MANAGED_DIRS: '' }
  const run = spawnSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** The run directories under the export base. */
const runs = (): string[] => (existsSync(join(oranguHome, 'export')) ? readdirSync(join(oranguHome, 'export')).sort() : [])

interface ExportRun {
  dir: string
  export: { path: string; bytes: number; approxTokens: number }
}

function exportJson(): ExportRun {
  const run = cli(['export', '--json'])
  expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
  return JSON.parse(run.stdout) as ExportRun
}

describe.skipIf(!existsSync(CLI))('orangu export (built CLI)', () => {
  it('writes orangu-export.json at 0600 in a new 0700 run directory under the orangu home, and prints the paths', () => {
    const first = exportJson()
    const second = exportJson()
    expect(first.dir).not.toBe(second.dir)
    for (const run of [first, second]) {
      expect(Object.keys(run)).toEqual(['dir', 'export'])
      expect(run.dir.startsWith(join(realpathSync(oranguHome), 'export') + '/')).toBe(true)
      expect(run.dir).toMatch(/\/global-[A-Za-z0-9]{6}$/)
      expect(run.export.path).toBe(join(run.dir, 'orangu-export.json'))
      expect(readdirSync(run.dir)).toEqual(['orangu-export.json'])
      expect(run.export.bytes).toBe(statSync(run.export.path).size)
      expect(run.export.approxTokens).toBe(Math.ceil(run.export.bytes / 4))
      if (process.platform !== 'win32') {
        expect((statSync(run.dir).mode & 0o777).toString(8)).toBe('700')
        expect((statSync(run.export.path).mode & 0o777).toString(8)).toBe('600')
      }
      const file = JSON.parse(readFileSync(run.export.path, 'utf8'))
      expect(Object.keys(file)).toEqual(SECTIONS)
      expect(file.summary).toEqual({ v: 1, version: expect.any(String), scope: 'global', roots: 1, found: 2, sessions: 2, unreadable: 0, asOf: expect.stringMatching(/^2026-08-15T10:00:/), redacted: true, text: false })
      expect(file.evidence.source).toMatchObject({ kind: 'aggregate', scope: 'global', sessions: 2 })
      expect(file.evidence.findings.length).toBeGreaterThan(0)
      expect(file.harness.schemaVersion).toBe('4')
      expect(file.lessons).toEqual({ v: 1, scope: 'all', maxBytes: 16_384, omitted: 0, lessons: [] })
    }
    // the text form prints the same 2 paths, each on its own row
    const text = cli(['export'])
    expect(text.status).toBe(0)
    const dir = runs().at(-1)
    expect(text.stdout).toMatch(/^ {2}dir {6}\S+\/export\/global-[A-Za-z0-9]{6}\n {2}export {3}\S+\/orangu-export\.json · [\d,]+ bytes · about [\d,]+ tokens\n$/)
    expect(dir).toBeDefined()
    expect(text.stderr).toBe('  analyzing 2 sessions\n')
  })

  it('refuses --include-text and --no-redact with exit 1, before it reads or writes', () => {
    const before = runs()
    for (const flag of ['--include-text', '--no-redact']) {
      const run = cli(['export', flag])
      expect(run.status, flag).toBe(1)
      expect(run.stdout, flag).toBe('')
      expect(run.stderr, flag).toContain(`${flag} is not a flag of orangu export. The export leaves this machine when you upload it, so it always redacts and never holds prompt text.`)
    }
    const other = cli(['export', '--limit', '3'])
    expect(other.status).toBe(1)
    expect(other.stderr).toContain('--limit is not a flag of orangu export.')
    const positional = cli(['export', 'latest'])
    expect(positional.status).toBe(1)
    expect(positional.stderr).toContain('orangu export takes no session. It reads every session on this machine.')
    expect(runs()).toEqual(before)
  })

  it('holds no planted secret and no prompt word, and the profile word only in the profile', () => {
    const text = readFileSync(exportJson().export.path, 'utf8')
    for (const planted of [SECRET, PROMPT_WORD, PROFILE_SECRET, HOOK_VALUE, 'NTFY_TOPIC', BEARER, ...TOPICS, RULE_TOKEN]) expect(text, planted).not.toContain(planted)
    const file = JSON.parse(text)
    expect(file.profile.repeats).toBe(`Run the tests first. ${PROFILE_WORD} uses ‹anthropic-key› in the demo.`)
    for (const section of SECTIONS.filter((s) => s !== 'profile')) expect(JSON.stringify(file[section]), section).not.toContain(PROFILE_WORD)
    // each hook keeps the name of its script, and the broken rule keeps only its program word
    expect(file.harness.crosswalk.hooks).toEqual([
      { event: 'Stop', commandBasename: 'ntfy.sh', configured: true, runs: 2, errors: 0, totalMs: 80, meanMs: 40, status: 'used' },
      { event: 'Stop', commandBasename: 'npx', configured: true, runs: 0, errors: 0, totalMs: 0, meanMs: 0, status: 'idle' },
      { event: 'Stop', commandBasename: 'post.sh', configured: true, runs: 0, errors: 0, totalMs: 0, meanMs: 0, status: 'idle' },
    ])
    expect(file.harness.enforcement.broken.map((row: { target: unknown }) => row.target)).toEqual([{ kind: 'command', name: 'deploy' }])
  })

  it('takes --strip-paths: each path keeps only its last part', () => {
    const plain = JSON.parse(readFileSync(exportJson().export.path, 'utf8'))
    expect(plain.harness.enforcement.broken[0].file).toBe('/Users/test/Code/demo/CLAUDE.md')
    const run = cli(['export', '--json', '--strip-paths'])
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
    const stripped = JSON.parse(readFileSync((JSON.parse(run.stdout) as ExportRun).export.path, 'utf8'))
    expect(stripped.harness.enforcement.broken[0].file).toBe('CLAUDE.md')
    expect(stripped.summary).toEqual(plain.summary)
  })

  it('gives the same bytes on 2 runs, and no field holds the clock of the run', () => {
    const t0 = Date.now()
    const first = readFileSync(exportJson().export.path)
    const second = readFileSync(exportJson().export.path)
    const t1 = Date.now()
    expect(second.equals(first)).toBe(true)
    // the clock reaches no field: no number near the time of the runs (ms or s), and no string with the date of today
    const day = 86_400_000
    const today = new Date(t1).toISOString().slice(0, 10)
    const near = (n: number): boolean => (n >= t0 - day && n <= t1 + day) || (n >= (t0 - day) / 1000 && n <= (t1 + day) / 1000)
    const found: string[] = []
    const walk = (value: unknown, at: string): void => {
      if (typeof value === 'number' && near(value)) found.push(`${at}=${value}`)
      else if (typeof value === 'string' && value.includes(today)) found.push(`${at}=${value}`)
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`)
    }
    walk(JSON.parse(first.toString('utf8')), '')
    expect(found).toEqual([])
  })

  it('is in the full help', () => {
    expect(cli(['help', 'all']).stdout).toContain('  orangu export ')
  })
})
