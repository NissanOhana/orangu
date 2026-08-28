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
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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
      skillUsage: { 'fires-often': { usageCount: 4, lastUsedAt: 1000 } },
      pluginUsage: {},
    }),
    'utf8',
  )

  // the repo side
  const repo = await mkdtemp(join(tmpdir(), 'orangu-harness-repo-'))
  await mkdir(join(repo, '.claude', 'skills', 'repo-only-skill'), { recursive: true })
  await writeFile(join(repo, '.claude', 'skills', 'repo-only-skill', 'SKILL.md'), '---\nname: repo-only-skill\ndescription: repo scoped, idle\n---\nbody\n', 'utf8')
  await writeFile(join(repo, 'CLAUDE.md'), '# Repo rules\n\nbe careful\n\n## More\n', 'utf8')
  return { home, configDir, repo }
}

let fx: Fixture
const run = (args: string[], home: string) =>
  execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, ORANGU_NO_CACHE: '1', ORANGU_HOME: join(home, '.orangu'), ORANGU_CLAUDE_ROOTS: '', CLAUDE_CONFIG_DIR: '' },
  })

describe.skipIf(!existsSync(CLI))('orangu harness (built CLI)', () => {
  beforeAll(async () => {
    fx = await makeHarnessFixture()
  })

  it('emits the six top-level keys with the harness schema version', () => {
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    expect(Object.keys(r).sort()).toEqual(['crosswalk', 'generator', 'inventory', 'notes', 'schemaVersion', 'scope'])
    expect(r.schemaVersion).toBe('1')
    expect(r.scope.sessionsScanned).toBeGreaterThan(0)
  })

  it('classifies at least one idle row and joins the observed side', () => {
    const r = JSON.parse(run(['harness', '--json', '--global', '--cwd', fx.repo, '--quiet'], fx.home))
    const idle = r.crosswalk.skills.filter((s: { status: string }) => s.status === 'idle')
    expect(idle.length).toBeGreaterThanOrEqual(1)
    expect(idle.map((s: { name: string }) => s.name)).toContain('never-fires')
    expect(r.crosswalk.skills.find((s: { name: string }) => s.name === 'fires-often')?.status).toBe('used')
    expect(r.crosswalk.mcpServers.find((m: { name: string }) => m.name === 'figma')?.status).toBe('idle')
    expect(r.crosswalk.mcpServers.find((m: { name: string }) => m.name === 'octocode')?.status).toBe('undeclared')
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
  })

  it('prints a human report with the labelled lines and no crash', () => {
    const out = run(['harness', '--global', '--cwd', fx.repo, '--quiet'], fx.home)
    expect(out).toContain('harness ·')
    expect(out).toContain('inventory')
    expect(out).toContain('idle skills')
    expect(out).toContain('undeclared')
    expect(out).toContain('hooks (configured / runs / errors / mean ms)')
    // one count for "undeclared": the headline row lists hooks like the note below it counts them
    const headline = /undeclared\s+(\d+) observed but not in the config read/.exec(out)
    const note = /(\d+) rows? marked undeclared/.exec(out)
    expect(headline, 'headline undeclared count').not.toBeNull()
    expect(note, 'undeclared note').not.toBeNull()
    expect(headline![1]).toBe(note![1])
    expect(out).toContain('hook rogue-hook.sh')
    expect(out).toContain('add --json for the machine-readable inventory + crosswalk')
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
    expect(line![1]).toBe('3 skills · 1 agent · 0 plugins · 1 MCP server · 1 hook command')
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

  // the --out contract, mirroring cmdAggregate (src/cli/main.ts:262-267). This is the mechanism the skill
  // uses to materialise the digest without it entering context, so stdout MUST stay empty.
  it('--out writes the pretty JSON to the file and leaves stdout empty', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'orangu-harness-out-')), 'harness.json')
    const out = run(['harness', '--global', '--cwd', fx.repo, '--out', dest, '--quiet'], fx.home)
    expect(out).toBe('')
    expect(existsSync(dest)).toBe(true)
    const raw = readFileSync(dest, 'utf8')
    const r = JSON.parse(raw)
    expect(r.schemaVersion).toBe('1')
    expect(Object.keys(r).sort()).toEqual(['crosswalk', 'generator', 'inventory', 'notes', 'schemaVersion', 'scope'])
    expect(raw).toContain('\n  ') // pretty-printed with 2 spaces, like cmdAggregate
    expect(raw).not.toContain('$')
    if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600)
  })

  it('--out with -o writes the same file, and --out plus --json also prints to stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-harness-out2-'))
    const short = join(dir, 'short.json')
    expect(run(['harness', '--global', '--cwd', fx.repo, '-o', short, '--quiet'], fx.home)).toBe('')
    expect(JSON.parse(readFileSync(short, 'utf8')).schemaVersion).toBe('1')

    const both = join(dir, 'both.json')
    const printed = run(['harness', '--global', '--cwd', fx.repo, '--out', both, '--json', '--quiet'], fx.home)
    expect(JSON.parse(printed).schemaVersion).toBe('1')
    expect(JSON.parse(readFileSync(both, 'utf8')).schemaVersion).toBe('1')
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
