/**
 * `orangu harness` end to end, against the BUILT CLI.
 *
 * Hermetic by construction: the child process runs with HOME pointed at a temp dir, so `claudeRoots()`
 * and the `~/.claude.json` probe can only ever see the synthetic tree this test writes. No real transcript
 * or real ~/.claude is touched, and `test/fixtures/home.ts` is used, not edited:
 * the harness config below is written inline on top of `makeFixtureHome`.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../../../test/fixtures/home.js'
import { SessionBuilder, resetIds } from '../../../test/fixtures/session-builder.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')

interface Fixture {
  home: string
  configDir: string
  repo: string
}

const DAY_SECONDS = 86_400

/** a fake $HOME containing .claude/ (sessions + global config) and .claude.json, plus a separate repo dir */
async function makeHarnessFixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'orangu-harness-home-'))
  const configDir = join(home, '.claude')
  await mkdir(configDir, { recursive: true })
  await makeFixtureHome(configDir)

  // one more session, written inline: it fires a skill and calls an MCP tool, so the crosswalk has
  // something to classify `used` next to the idle rows
  resetIds()
  const b = new SessionBuilder({ sessionId: '99999999-0000-4000-8000-00000000cccc', cwd: '/Users/test/Code/demo' })
  b.userPrompt('use the skill')
  b.toolCall('Skill', { skill: 'fires-often' }, 'ok')
  b.toolCall('mcp__octocode__githubSearchCode', { q: 'x' }, 'ok')
  // a hook that ran but is in no config the collector reads: an `undeclared` hook row
  b.stopHookSummary([{ command: '/opt/tools/rogue-hook.sh --quiet', durationMs: 12 }])
  // an OBSERVED command with a secret in its arguments: the transcript side of the basename boundary
  b.attachmentHook('PreToolUse:Bash', 'PreToolUse', 'ok', { command: '/opt/tools/observed.sh --token sk-ant-observedplanted0000', durationMs: 3 })
  // an env assignment whose NAME the scrubber does not recognise: the basename rule alone must keep it out
  b.attachmentHook('PostToolUse:Edit', 'PostToolUse', 'ok', { command: 'env SLACK_WEBHOOK=T01.B02.xoxbobservedenvleak0000 /opt/tools/envhook.sh', durationMs: 2 })
  b.turnDuration(3000, 5)
  await writeFile(join(configDir, 'projects', '-Users-test-Code-demo', '99999999-0000-4000-8000-00000000cccc.jsonl'), b.toJsonl())

  // global config: a model + effort that the sessions will NOT match (drift), a hook, an idle skill
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({
      model: 'claude-opus-5',
      effortLevel: 'max',
      permissions: { allow: ['Read', 'Bash(ls:*)'], deny: ['Bash(rm:*)'], defaultMode: 'default' },
      env: { SOME_TOKEN_NAME: 'sk-ant-plantedsecretvalue00000' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/tools/notify.sh --token sk-ant-alsoplanted0000' }] }] },
    }),
    'utf8',
  )
  await mkdir(join(configDir, 'skills', 'fires-often'), { recursive: true })
  await writeFile(join(configDir, 'skills', 'fires-often', 'SKILL.md'), '---\nname: fires-often\ndescription: this one is invoked by a session\n---\nbody\n', 'utf8')
  await mkdir(join(configDir, 'skills', 'never-fires'), { recursive: true })
  await writeFile(join(configDir, 'skills', 'never-fires', 'SKILL.md'), '---\nname: never-fires\ndescription: installed but idle\n---\nbody\n', 'utf8')
  await mkdir(join(configDir, 'agents'), { recursive: true })
  await writeFile(join(configDir, 'agents', 'idle-agent.md'), '---\nname: idle-agent\ndescription: defined, never dispatched\ntools: Read\n---\nbody\n', 'utf8')
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'planted@example.com' },
      mcpServers: { figma: { type: 'stdio', command: '/usr/local/bin/figma-mcp' } },
      // a server declared under ANOTHER project: only a global scan reads this entry
      projects: { '/Users/test/Code/elsewhere': { mcpServers: { octocode: { type: 'stdio', command: '/usr/local/bin/octocode-mcp' } } } },
      skillUsage: { 'fires-often': { usageCount: 4, lastUsedAt: 1000 } },
      pluginUsage: {},
    }),
    'utf8',
  )

  // Age one transcript so it sits inside the expiring window of the default 30-day cleanup, and one
  // Cowork/Desktop session, which Claude Code keeps at any age: retention must not count it as at-risk.
  const aged = join(configDir, 'projects', '-Users-test-Code-demo', '99999999-0000-4000-8000-00000000cccc.jsonl')
  const agedSeconds = Math.floor(Date.now() / 1000) - 28 * DAY_SECONDS
  await utimes(aged, agedSeconds, agedSeconds)

  const coworkClaude = join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions', 'ws', 'proj', 'local_1', '.claude')
  await mkdir(join(coworkClaude, 'projects', '-Users-test-Code-demo'), { recursive: true })
  resetIds()
  const cw = new SessionBuilder({ sessionId: '99999999-0000-4000-8000-00000000dddd', cwd: '/Users/test/Code/demo' })
  cw.userPrompt('desktop work')
  cw.turnDuration(1000, 1)
  await writeFile(join(coworkClaude, 'projects', '-Users-test-Code-demo', '99999999-0000-4000-8000-00000000dddd.jsonl'), cw.toJsonl())

  // the repo side
  const repo = await mkdtemp(join(tmpdir(), 'orangu-harness-repo-'))
  await mkdir(join(repo, '.claude', 'skills', 'repo-only-skill'), { recursive: true })
  await writeFile(join(repo, '.claude', 'skills', 'repo-only-skill', 'SKILL.md'), '---\nname: repo-only-skill\ndescription: repo scoped, idle\n---\nbody\n', 'utf8')
  await writeFile(join(repo, 'CLAUDE.md'), '# Repo rules\n\nbe careful\n\n## More\n', 'utf8')
  return { home, configDir, repo }
}

let fx: Fixture
// ORANGU_CLAUDE_MANAGED_DIRS is set EMPTY so the machine's real managed policy, if any, never enters a fixture run
const run = (args: string[], home: string, extraEnv: Record<string, string> = {}) =>
  execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, ORANGU_NO_CACHE: '1', ORANGU_HOME: join(home, '.orangu'), ORANGU_CLAUDE_ROOTS: '', CLAUDE_CONFIG_DIR: '', ORANGU_CLAUDE_MANAGED_DIRS: '', ...extraEnv },
  })

describe.skipIf(!existsSync(CLI))('orangu harness (built CLI)', () => {
  beforeAll(async () => {
    fx = await makeHarnessFixture()
  })

  it('emits the seven top-level keys with the harness schema version', () => {
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    expect(Object.keys(r).sort()).toEqual(['crosswalk', 'generator', 'inventory', 'notes', 'retention', 'schemaVersion', 'scope'])
    // 2: listing rows name their population (main vs subagent) and hook rows may be event-only
    expect(r.schemaVersion).toBe('2')
    expect(r.scope.sessionsScanned).toBeGreaterThan(0)
  })

  it('classifies at least one idle row and joins the observed side', () => {
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    const idle = r.crosswalk.skills.filter((s: { status: string }) => s.status === 'idle')
    expect(idle.length).toBeGreaterThanOrEqual(1)
    expect(idle.map((s: { name: string }) => s.name)).toContain('never-fires')
    expect(r.crosswalk.skills.find((s: { name: string }) => s.name === 'fires-often')?.status).toBe('used')
    expect(r.crosswalk.mcpServers.find((m: { name: string }) => m.name === 'figma')?.status).toBe('idle')
    // declared under another project entry: the global scan reads every entry, so it is used, not undeclared
    expect(r.crosswalk.mcpServers.find((m: { name: string }) => m.name === 'octocode')?.status).toBe('used')
    // a repo scan of the project the sessions ran in reads only that project's entry, so the same server stays undeclared
    const repo = JSON.parse(run(['harness', '--json', '--cwd', '/Users/test/Code/demo', '--root', fx.configDir, '--quiet'], fx.home))
    expect(repo.crosswalk.mcpServers.find((m: { name: string }) => m.name === 'octocode')?.status).toBe('undeclared')
    expect(r.crosswalk.agents.find((a: { name: string }) => a.name === 'idle-agent')?.status).toBe('idle')
  })

  // Number('abc') is NaN, which serializes as `null` while HarnessScope.limit is declared `number`.
  // Invalid input must therefore fall back before the payload is serialized.
  it('falls back to the scope default when --limit is not a number', () => {
    const g = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--limit', 'abc', '--quiet'], fx.home))
    expect(g.scope.limit).toBe(500)
    expect(Number.isFinite(g.scope.limit)).toBe(true)

    const r = JSON.parse(run(['harness', '--json', '--cwd', fx.repo, '--root', fx.configDir, '--limit', 'abc', '--quiet'], fx.home))
    expect(r.scope.limit).toBe(200)
    expect(Number.isFinite(r.scope.limit)).toBe(true)
  })

  it('honours a real --limit for both the scan and the reported scope', () => {
    const one = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--limit', '1', '--quiet'], fx.home))
    expect(one.scope.limit).toBe(1)
    expect(one.scope.sessionsScanned).toBeLessThanOrEqual(1)
  })

  it('reads managed policy from ORANGU_CLAUDE_MANAGED_DIRS and names what the declared side covers', async () => {
    const managed = await mkdtemp(join(tmpdir(), 'orangu-managed-'))
    await writeFile(
      join(managed, 'managed-settings.json'),
      JSON.stringify({ allowManagedHooksOnly: true, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/opt/policy/audit.sh --org' }] }] } }),
      'utf8',
    )
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home, { ORANGU_CLAUDE_MANAGED_DIRS: managed }))
    expect(r.inventory.settings.some((s: { scope: string }) => s.scope === 'managed')).toBe(true)
    expect(r.crosswalk.hooks.find((h: { commandBasename?: string }) => h.commandBasename === 'audit.sh')?.status).toBe('idle')
    expect(r.notes.some((n: string) => n.includes('allowManagedHooksOnly'))).toBe(true)
    const human = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home, { ORANGU_CLAUDE_MANAGED_DIRS: managed })
    expect(human).toContain('declared side:')
    expect(human).toContain('1 project entry in ~/.claude.json')
    // without the override nothing managed is read, and the printout still says what was covered
    const none = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    expect(none.inventory.settings.some((s: { scope: string }) => s.scope === 'managed')).toBe(false)
  })

  it('puts no money on either surface', () => {
    const json = run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    expect(json).not.toContain('$')
    expect(json.toLowerCase()).not.toContain('usd')
    const human = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    expect(human).not.toContain('$')
    expect(human.toLowerCase()).not.toContain('usd')
  })

  it('never lets a planted secret or an unallowlisted key reach the output', () => {
    const json = run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    expect(json).not.toContain('plantedsecretvalue')
    expect(json).not.toContain('alsoplanted')
    expect(json).not.toContain('oauthAccount')
    expect(json).not.toContain('planted@example.com')
    // the NAME is kept; only the value is out of reach
    expect(json).toContain('SOME_TOKEN_NAME')
    expect(json).toContain('notify.sh')
    // the observed side keeps the same boundary: basename in, arguments out
    expect(json).not.toContain('observedplanted')
    expect(json).toContain('observed.sh')
    expect(json).not.toContain('xoxbobservedenvleak')
    expect(json).not.toContain('SLACK_WEBHOOK')
    expect(json).toContain('envhook.sh')
  })

  it('prints a human report with the labelled lines and no crash', () => {
    const out = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    expect(out).toContain('harness ·')
    expect(out).toContain('inventory')
    expect(out).toContain('idle skills')
    expect(out).toContain('undeclared')
    expect(out).toMatch(/^ {2}hooks\s+\d+ configured · [\d,]+ runs · \d+ errors · [\d,]+ ms mean$/m)
    // one count for "undeclared": the headline row lists hooks like the note below it counts them
    const headline = /undeclared\s+(\d+) observed but not in the config read/.exec(out)
    const note = /(\d+) rows? marked undeclared/.exec(out)
    expect(headline, 'headline undeclared count').not.toBeNull()
    expect(note, 'undeclared note').not.toBeNull()
    expect(headline![1]).toBe(note![1])
    expect(out).toContain('hook rogue-hook.sh')
    expect(out).toContain('add --json for the machine-readable inventory and declared-vs-used rows')
  })

  // the agents line counts one population per clause: dispatched and never are both over the DEFINED agents
  // (crosswalk status used / idle); agent types the sessions ran without any declaration are named apart
  it('counts dispatched and never over the defined agents, and names undeclared agent types apart', () => {
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    const agents = r.crosswalk.agents as Array<{ status: string; dispatches: number }>
    const used = agents.filter((a) => a.status === 'used').length
    const idle = agents.filter((a) => a.status === 'idle').length
    const undeclared = agents.filter((a) => a.status === 'undeclared').length
    const defined = r.inventory.totals.agents as number
    expect(defined).toBe(1)
    expect(used + idle).toBe(defined)
    const out = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    const line = /^ {2}agents\s+(.*)$/m.exec(out)
    expect(line, 'agents line').not.toBeNull()
    expect(line![1]).toBe(`${used} of ${defined} dispatched · ${idle} never${undeclared ? ` · ${undeclared} undeclared` : ''}`)
    // the old mixed-population form ("21 defined / 24 dispatched / 17 never") is gone
    expect(out).not.toMatch(/defined \//)
  })

  it('pluralises the inventory counts', () => {
    const out = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    const line = /^ {2}inventory\s+(.*)$/m.exec(out)
    expect(line, 'inventory line').not.toBeNull()
    expect(line![1]).toBe('3 skills · 1 agent · 0 plugins · 2 MCP servers · 1 hook command')
    expect(out).not.toMatch(/\b1 (?:skills|agents|plugins|hook commands)\b/)
  })

  // Zero-state guards: a population that is empty, or a scan with no sessions, must not read as
  // "none: every installed skill fired": that sentence claims evidence the run never had
  it('says what is missing instead of "every skill fired" when nothing is installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orangu-harness-noskills-'))
    const configDir = join(home, '.claude')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }), 'utf8')
    const repo = await mkdtemp(join(tmpdir(), 'orangu-harness-noskills-repo-'))
    const out = run(['harness', '--cwd', repo, '--root', configDir, '--quiet'], home)
    expect(out).toContain('0 sessions scanned')
    expect(out).toMatch(/^ {2}idle skills\s+no skills installed$/m)
    expect(out).toMatch(/^ {2}idle MCP\s+no MCP servers configured$/m)
    expect(out).toMatch(/^ {2}agents\s+none defined$/m)
    expect(out).not.toContain('every installed skill fired')
    expect(out).not.toContain('every configured server was called')
  })

  it('says nothing can be classified when the scope holds no sessions, even with skills installed', () => {
    const out = run(['harness', '--global', '--cwd', fx.repo, '--limit', '0', '--quiet'], fx.home)
    expect(out).toContain('0 sessions scanned')
    expect(out).toMatch(/^ {2}idle skills\s+no sessions in scope: nothing can be classified$/m)
    expect(out).toMatch(/^ {2}idle MCP\s+no sessions in scope: nothing can be classified$/m)
    expect(out).toMatch(/^ {2}agents\s+no sessions in scope: nothing can be classified$/m)
    expect(out).not.toContain('never fired')
    expect(out).not.toContain('every installed skill fired')
    // the idle name lists are suppressed too: with no sessions every declared row is idle by construction
    expect(out).not.toContain('never-fires')
  })

  it('prints the designed empty state when there is no config at all', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'orangu-harness-bare-'))
    const emptyRepo = await mkdtemp(join(tmpdir(), 'orangu-harness-bare-repo-'))
    const out = run(['harness', '--cwd', emptyRepo, '--root', join(bare, '.claude'), '--quiet'], bare)
    expect(out).toContain('no harness config found under')
    expect(out).toContain('Nothing to cross-reference')
    expect(out).not.toContain('$')
  })

  // Retention: Claude Code deletes the very transcripts every row above is computed from. The block is
  // measured, not advisory, and the Cowork/Desktop session must never be counted as at-risk.
  it('--json carries a measured retention block that leaves Desktop/Cowork sessions out of the sweep', () => {
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    const t = r.retention
    expect(Object.keys(t).sort()).toEqual(['effectiveDays', 'expiringSoon', 'exempt', 'isDefault', 'oldestSweepableDays', 'pastCutoff', 'sweepable'].sort())
    expect(t.effectiveDays).toBe(30)
    expect(t.isDefault).toBe(true)
    expect(t.sweepable.sessions).toBeGreaterThan(0)
    expect(t.sweepable.bytes).toBeGreaterThan(0)
    expect(t.exempt).toEqual({ sessions: 1, bytes: expect.any(Number) })
    expect(t.expiringSoon.windowDays).toBe(7)
    expect(t.expiringSoon.sessions).toBe(1)
    expect(t.pastCutoff).toEqual({ sessions: 0, bytes: 0 })
    expect(t.oldestSweepableDays).toBe(28)
    // the value Claude Code rejects must never appear as a window anywhere in the payload
    expect(JSON.stringify(t)).not.toContain('"effectiveDays":0')
  })

  it('prints the retention block and names the setting without recommending a value', () => {
    const out = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    expect(out).toMatch(/^ {2}retention\s+30-day window · \d+ sessions? \([\d.]+ KB\) in reach of the sweep · oldest 28 days$/m)
    expect(out).toContain("sizes count primary transcripts only; each session's subagent and tool-result files are swept with it")
    expect(out).toContain("cleanupPeriodDays is unset, so the window is Claude Code's default of 30 days")
    expect(out).toMatch(/^ {4}1 session \([\d.]+ KB\) is within 7 days of the cutoff$/m)
    expect(out).toMatch(/^ {4}1 Desktop\/Cowork session \([\d.]+ KB\) is kept at any age by default$/m)
    // the shared formatter scales: a corpus-sized bucket must not print as six figures of KB
    expect(out).not.toMatch(/\d{6,}\.\d KB/)
    expect(out).toContain('cleanupPeriodDays sets the window, minimum 1.')
    expect(out).toContain('leaves plaintext transcripts on disk for longer')
    // measured only: the surface never tells the user which number to pick, and never offers the rejected 0
    expect(out).not.toMatch(/\brecommend|\bshould set\b|cleanupPeriodDays[^\n]*\b0\b/)
    // notes wrap to the 80-column layout; re-join a wrapped note's continuation lines before matching it
    const flat = out.replace(/\n {6,}(?=\S)/g, ' ')
    const note = /(\d+) sessions? \([\d.]+ KB\) (?:is|are) within 7 days of the cleanupPeriodDays cutoff at 30 days/.exec(flat)
    expect(note, 'retention note').not.toBeNull()
    expect(note![1]).toBe('1')
  })

  // `isDefault` means "no USABLE value", not "no value". A rejected setting IS set, and saying it is unset
  // right above "1 settings file set cleanupPeriodDays below the minimum of 1" is a contradiction.
  it('does not call a rejected cleanupPeriodDays unset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orangu-harness-badcleanup-'))
    const configDir = join(home, '.claude')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5', cleanupPeriodDays: 0 }), 'utf8')
    const repo = await mkdtemp(join(tmpdir(), 'orangu-harness-badcleanup-repo-'))
    const out = run(['harness', '--cwd', repo, '--root', configDir, '--quiet'], home)
    expect(out).toContain("no settings file set a usable cleanupPeriodDays, so Claude Code's default of 30 days applies")
    expect(out).not.toContain('cleanupPeriodDays is unset')
    expect(out).toContain('1 settings file set cleanupPeriodDays below the minimum of 1 or not to a whole number, and was ignored')
    // the rejected value is never echoed back as if it were a window
    expect(out).not.toMatch(/^ {2}retention\s+0-day window/m)

    const r = JSON.parse(run(['harness', '--json', '--cwd', repo, '--root', configDir, '--quiet'], home))
    expect(r.retention.effectiveDays).toBe(30)
    expect(r.retention.invalidConfigured).toBe(1)
    expect(r.retention.source).toBeUndefined()
  })

  // The line the reviewer caught: a session past the window is NOT "within 7 days of the cutoff". It is
  // reported apart, as measurement rather than alarm, so the two lines cannot contradict each other.
  it('reports a session past the cutoff apart from the expiring ones', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orangu-harness-past-'))
    const configDir = join(home, '.claude')
    const project = join(configDir, 'projects', '-Users-test-Code-old')
    await mkdir(project, { recursive: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }), 'utf8')
    resetIds()
    const b = new SessionBuilder({ sessionId: '99999999-0000-4000-8000-00000000eeee', cwd: '/Users/test/Code/old' })
    b.userPrompt('long ago')
    b.turnDuration(1000, 1)
    const stale = join(project, '99999999-0000-4000-8000-00000000eeee.jsonl')
    await writeFile(stale, b.toJsonl())
    const old = Math.floor(Date.now() / 1000) - 400 * DAY_SECONDS
    await utimes(stale, old, old)

    const repo = await mkdtemp(join(tmpdir(), 'orangu-harness-past-repo-'))
    // --global so the scan is not restricted to the project that owns `repo`
    const args = ['harness', '--global', '--cwd', repo, '--root', configDir, '--quiet']
    const r = JSON.parse(run([...args, '--json'], home))
    expect(r.retention.oldestSweepableDays).toBe(400)
    expect(r.retention.expiringSoon.sessions).toBe(0)
    expect(r.retention.pastCutoff.sessions).toBe(1)

    const out = run(args, home)
    expect(out).toMatch(/^ {4}1 session \([\d.]+ KB\) is already past the cutoff and still on disk$/m)
    expect(out).not.toContain('within 7 days of the cutoff')
  })

  // the --out contract, mirroring cmdAggregate (src/cli/main.ts:262-267). This is the mechanism the skill
  // uses to materialise the digest without it entering context, so stdout MUST stay empty.
  it('--out writes the pretty JSON to the file and leaves stdout empty', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'orangu-harness-out-')), 'harness.json')
    const out = run(['harness', '--global', '--cwd', fx.repo, '--out', dest, '--quiet'], fx.home)
    expect(out).toBe('')
    expect(existsSync(dest)).toBe(true)
    const raw = readFileSync(dest, 'utf8')
    const r = JSON.parse(raw)
    expect(r.schemaVersion).toBe('2')
    expect(Object.keys(r).sort()).toEqual(['crosswalk', 'generator', 'inventory', 'notes', 'retention', 'schemaVersion', 'scope'])
    expect(raw).toContain('\n  ') // pretty-printed with 2 spaces, like cmdAggregate
    expect(raw).not.toContain('$')
    if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600)
  })

  it('--out with -o writes the same file, and --out plus --json also prints to stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-harness-out2-'))
    const short = join(dir, 'short.json')
    expect(run(['harness', '--global', '--cwd', fx.repo, '-o', short, '--quiet'], fx.home)).toBe('')
    expect(JSON.parse(readFileSync(short, 'utf8')).schemaVersion).toBe('2')

    const both = join(dir, 'both.json')
    const printed = run(['harness', '--global', '--cwd', fx.repo, '--out', both, '--json', '--quiet'], fx.home)
    expect(JSON.parse(printed).schemaVersion).toBe('2')
    expect(JSON.parse(readFileSync(both, 'utf8')).schemaVersion).toBe('2')
  })

  it('orangu estimate harness sizes the report in tokens, with no currency figure', () => {
    const est = JSON.parse(run(['estimate', 'harness', '--global', '--cwd', fx.repo, '--json'], fx.home))
    expect(Object.keys(est).sort()).toEqual(['approxTokens', 'bytes', 'files', 'overThreshold', 'sessions'])
    expect(est.bytes).toBeGreaterThan(0)
    expect(est.approxTokens).toBe(Math.ceil(est.bytes / 4))
    expect(est.files).toBeGreaterThan(0)
    expect(JSON.stringify(est)).not.toContain('$')

    const human = run(['estimate', 'harness', '--global', '--cwd', fx.repo], fx.home)
    expect(human).toContain('estimate (harness)')
    expect(human).toContain('≈ tokens')
    expect(human).not.toContain('$')
    expect(human).not.toContain('list price')
  })
})
