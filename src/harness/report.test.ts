/**
 * Report assembly tests: the shape, the reproducibility promise, and the money rule.
 * The fixture is a synthetic temp tree plus a `SessionBuilder` session — never the real ~/.claude.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Analysis } from '../model/analysis.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { aggregate } from '../analyze/aggregate.js'
import { SessionBuilder, resetIds } from '../../test/fixtures/session-builder.js'
import { collectInventory } from './collect.js'
import { buildHarnessReport, sizeLabel } from './report.js'
import { HARNESS_SCHEMA_VERSION } from './types.js'
import type { HarnessInventory, HarnessReport } from './types.js'

/** a synthetic harness: a repo .claude/ with a skill, a global root with settings + an agent */
async function fixture(): Promise<{ inv: HarnessInventory; analyses: Analysis[]; agg: ReturnType<typeof aggregate> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'orangu-hr-repo-'))
  const root = await mkdtemp(join(tmpdir(), 'orangu-hr-root-'))
  const home = await mkdtemp(join(tmpdir(), 'orangu-hr-home-'))
  await mkdir(join(cwd, '.claude', 'skills', 'idle-skill'), { recursive: true })
  await writeFile(join(cwd, '.claude', 'skills', 'idle-skill', 'SKILL.md'), '---\nname: idle-skill\ndescription: never fires\n---\nbody\n', 'utf8')
  await writeFile(join(cwd, 'CLAUDE.md'), '# Repo\n\nrules\n', 'utf8')
  await mkdir(join(root, 'agents'), { recursive: true })
  await writeFile(join(root, 'agents', 'idle-agent.md'), '---\nname: idle-agent\ndescription: never dispatched\n---\nbody\n', 'utf8')
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({ model: 'claude-opus-5', effortLevel: 'high', permissions: { allow: ['Read'], defaultMode: 'default' }, env: { TOKEN_NAME: 'never-read' } }),
    'utf8',
  )
  const inv = await collectInventory({ cwd, roots: [root], home })

  resetIds()
  const b = new SessionBuilder({ sessionId: 'aaaa1111-0000-4000-8000-000000000001', cwd })
  b.userPrompt('work')
  b.toolCall('Skill', { skill: 'fired-skill' }, 'ok')
  b.toolCall('mcp__octocode__githubSearchCode', { q: 'x' }, 'ok')
  b.turnDuration(2000, 4)
  const a = analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }), { version: 't', now: 0 })
  return { inv, analyses: [a], agg: aggregate([a], 'test', 0) }
}

const DAY = 86_400_000
const NOW = 1_700_000_000_000

const opts = (over: Partial<Parameters<typeof buildHarnessReport>[3]> = {}) => ({
  version: '0.2.0',
  now: NOW,
  scope: { cwd: '/repo', roots: ['/root'], global: false, limit: 200, sessionsUnreadable: 0 },
  sessions: [],
  ...over,
})

/** a discovered transcript `ageDays` old, synthesized: retention reads only path, size and mtime */
const ref = (ageDays: number, sizeBytes = 1024, name = `s${ageDays}`) => ({
  path: `/root/projects/-repo/${name}.jsonl`,
  sizeBytes,
  mtimeMs: NOW - ageDays * DAY,
})

/** every key name anywhere in the object graph */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(k)
      allKeys(x, out)
    }
  }
  return out
}

describe('buildHarnessReport: shape', () => {
  it('emits exactly the seven top-level keys, with the schema version and the injected clock', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(Object.keys(r).sort()).toEqual(['crosswalk', 'generator', 'inventory', 'notes', 'retention', 'schemaVersion', 'scope'])
    expect(r.schemaVersion).toBe(HARNESS_SCHEMA_VERSION)
    expect(r.schemaVersion).toBe('2')
    expect(r.generator).toEqual({ name: 'orangu', version: '0.2.0', generatedAt: 1_700_000_000_000 })
    expect(Object.keys(r.inventory).sort()).toEqual(['agents', 'claudeMd', 'mcpServers', 'plugins', 'settings', 'skills', 'totals', 'unreadable'])
    expect(Object.keys(r.crosswalk).sort()).toEqual([
      'agents',
      'claudeMd',
      'counts',
      'effort',
      'hooks',
      'injectedListings',
      'mcpServers',
      'models',
      'permissions',
      'skills',
      'window',
    ])
  })

  it('reports the scanned scope with ~-relativized paths and the session counts', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts({ scope: { cwd: '/home/dev/repo', roots: ['/home/dev/.claude'], global: true, limit: 500, sessionsUnreadable: 3, home: '/home/dev' } }))
    expect(Object.keys(r.scope).sort()).toEqual(['cwd', 'global', 'limit', 'roots', 'sessionsScanned', 'sessionsUnreadable'])
    expect(r.scope.cwd).toBe('~/repo')
    expect(r.scope.roots).toEqual(['~/.claude'])
    expect(r.scope.global).toBe(true)
    expect(r.scope.limit).toBe(500)
    expect(r.scope.sessionsScanned).toBe(1)
    expect(r.scope.sessionsUnreadable).toBe(3)
  })

  // An empty fallback disables homeRegExp, so callers that omit scope.home must still use the process
  // home when relativizing paths in shareable output.
  it('relativizes the home prefix even when the caller passes no scope.home', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, {
      version: 't',
      now: 0,
      scope: { cwd: join(homedir(), 'Code', 'app'), roots: [join(homedir(), '.claude')], global: false, limit: 200 },
      sessions: [],
    })
    expect(r.scope.cwd).toBe('~/Code/app')
    expect(r.scope.roots).toEqual(['~/.claude'])
    expect(JSON.stringify(r.scope)).not.toContain(homedir())
  })

  it('classifies the fixture: an installed-but-unfired skill is idle, an observed-but-unlisted one undeclared', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(r.crosswalk.skills.find((s) => s.name === 'idle-skill')!.status).toBe('idle')
    expect(r.crosswalk.skills.find((s) => s.name === 'fired-skill')!.status).toBe('undeclared')
    expect(r.crosswalk.agents.find((a) => a.name === 'idle-agent')!.status).toBe('idle')
    expect(r.crosswalk.mcpServers.find((m) => m.name === 'octocode')!.status).toBe('undeclared')
  })
})

describe('buildHarnessReport: notes instead of throwing', () => {
  it('asserts no model or effort drift over an empty population', async () => {
    const { inv, agg } = await fixture()
    // the fixture's global settings configure claude-opus-5 / high; with no sessions nothing can disagree with them
    const r = buildHarnessReport(inv, [], agg, opts())
    expect(r.notes.some((n) => n.includes('does not appear among'))).toBe(false)
    expect(r.notes).toContain('no sessions in scope, so every crosswalk row is config-only and nothing can be classified used')
  })

  it('names the managed sources it cannot read when an undeclared row is on the screen and no managed file was found', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(r.crosswalk.counts.mcpServers.undeclared + r.crosswalk.counts.skills.undeclared).toBeGreaterThan(0)
    expect(r.notes.some((n) => /^\d+ rows? (?:is|are) marked undeclared\. The sessions used (?:it|them), but the config that orangu read does not declare (?:it|them)\. The cause is a source outside this scope, or drift$/.test(n))).toBe(true)
    expect(r.notes).toContain('managed settings can also arrive by MDM, a macOS configuration profile, or the claude.ai console. This inventory does not include a policy that arrives that way, because orangu reads only the managed files on disk')
    const withManaged = buildHarnessReport(
      { ...inv, settings: [...inv.settings, { scope: 'managed', file: '/Library/Application Support/ClaudeCode/managed-settings.json', keys: [], permissions: { allow: 0, deny: 0, ask: 0 }, hooks: [], env: { count: 0, names: [] }, statusLine: false, enabledPlugins: [] }] },
      analyses,
      agg,
      opts(),
    )
    expect(withManaged.notes.some((n) => n.includes('MDM'))).toBe(false)
  })

  it('notes analyses that come from an engine without the primary-transcript split and are left out of injected listings', async () => {
    const { inv, analyses, agg } = await fixture()
    delete analyses[0]!.parse.primaryAttachmentTypes
    delete analyses[0]!.parse.primaryAttachmentBytes
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(r.notes).toContain('1 session was read from a cache written by an older orangu. That version did not separate the main transcript from its subagent files, so the injected listings leave it out. Re-run with --no-cache to rebuild it')
    const fresh = buildHarnessReport(inv, (await fixture()).analyses, agg, opts())
    expect(fresh.notes.some((n) => n.includes('older orangu'))).toBe(false)
  })

  it('notes when managed policy makes every other hook declaration inert', async () => {
    const { inv, analyses, agg } = await fixture()
    inv.settings.push({
      scope: 'managed',
      file: '/Library/Application Support/ClaudeCode/managed-settings.json',
      keys: ['allowManagedHooksOnly'],
      permissions: { allow: 0, deny: 0, ask: 0 },
      hooks: [],
      env: { count: 0, names: [] },
      statusLine: false,
      enabledPlugins: [],
      allowManagedHooksOnly: true,
    })
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(r.notes).toContain('managed settings set allowManagedHooksOnly, so hook commands from user, project, local and plugin settings do not run. Only managed hooks, and hooks from plugins that managed enabledPlugins force-enables, can be used')
    const plain = buildHarnessReport({ ...inv, settings: inv.settings.filter((s) => s.scope !== 'managed') }, analyses, agg, opts())
    expect(plain.notes.some((n) => n.includes('allowManagedHooksOnly'))).toBe(false)
  })

  it('notes that ~/.claude.json was not read, and leaves usageCounters off the payload', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(r.inventory.usageCounters).toBeUndefined()
    expect(r.notes).toContain('orangu did not read ~/.claude.json, so the report omits the client-side usage counters. orangu classifies declared vs used from session evidence only')
  })

  it('notes sessions that could not be analyzed rather than failing the run', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts({ scope: { cwd: '/repo', roots: ['/root'], global: false, limit: 200, sessionsUnreadable: 2 } }))
    expect(r.notes.some((n) => n.includes('2') && n.toLowerCase().includes('session'))).toBe(true)
    expect(r.notes).toContain('2 sessions could not be analyzed and are not reflected in the crosswalk')
  })

  it('agrees the verb with the count when exactly one session could not be analyzed', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts({ scope: { cwd: '/repo', roots: ['/root'], global: false, limit: 200, sessionsUnreadable: 1 } }))
    expect(r.notes).toContain('1 session could not be analyzed and is not reflected in the crosswalk')
    expect(r.notes.some((n) => /1 sessions?\b.*\bare not reflected/.test(n))).toBe(false)
  })

  it('notes an empty harness instead of emitting a blank report', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orangu-hr-empty-'))
    const inv = await collectInventory({ cwd: home, roots: [], home })
    const r = buildHarnessReport(inv, [], aggregate([], 'test', 0), opts())
    expect(r.notes).toContain('orangu found no harness config under the scanned roots. It found nothing to compare')
    expect(r.scope.sessionsScanned).toBe(0)
  })
})

describe('buildHarnessReport: retention', () => {
  it('measures the sessions it was handed, splitting Desktop/Cowork out of the sweepable bucket', async () => {
    const { inv, analyses, agg } = await fixture()
    const desktop = {
      path: '/base/Library/Application Support/Claude/local-agent-mode-sessions/a/b/local_1/.claude/projects/-repo/d.jsonl',
      sizeBytes: 4096,
      mtimeMs: NOW - 400 * DAY,
    }
    const r = buildHarnessReport(inv, analyses, agg, opts({ sessions: [ref(2), ref(26, 2048), desktop] }))
    // the fixture's settings.json sets no cleanup key, so the window is the built-in default
    expect(r.retention.effectiveDays).toBe(30)
    expect(r.retention.isDefault).toBe(true)
    expect(r.retention.sweepable).toEqual({ sessions: 2, bytes: 1024 + 2048 })
    expect(r.retention.exempt.sessions).toBe(1)
    expect(r.retention.oldestSweepableDays).toBe(26)
    expect(r.retention.expiringSoon).toEqual({ sessions: 1, bytes: 2048, windowDays: 7 })
  })

  it('adds one note when a transcript is inside the window, and none when nothing is', async () => {
    const { inv, analyses, agg } = await fixture()
    const quiet = buildHarnessReport(inv, analyses, agg, opts({ sessions: [ref(1)] }))
    expect(quiet.notes.some((note) => note.includes('cleanupPeriodDays'))).toBe(false)

    const soon = buildHarnessReport(inv, analyses, agg, opts({ sessions: [ref(28, 2048)] }))
    expect(soon.notes).toContain('1 session (2.0 KB) is within 7 days of the cleanupPeriodDays cutoff at 30 days, after which Claude Code deletes the transcript')
    expect(soon.notes.filter((note) => note.includes('cleanupPeriodDays'))).toHaveLength(1)
  })

  it('scales the size label past a megabyte instead of printing six figures of KB', () => {
    expect(sizeLabel(2048)).toBe('2.0 KB')
    expect(sizeLabel(1024 * 1024)).toBe('1.0 MB')
    expect(sizeLabel(785_893_012)).toBe('749.5 MB')
  })

  it('never emits a window Claude Code would reject', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts({ sessions: [ref(3)] }))
    expect(r.retention.effectiveDays).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(r.retention)).not.toContain('"effectiveDays":0')
  })
})

describe('buildHarnessReport: reproducible', () => {
  it('serializes byte-identically across two invocations on the same fixture', async () => {
    const { inv, analyses, agg } = await fixture()
    const one = JSON.stringify(buildHarnessReport(inv, analyses, agg, opts()))
    const two = JSON.stringify(buildHarnessReport(inv, analyses, agg, opts()))
    expect(one).toBe(two)
  })

  it('orders every crosswalk array by its explicit comparator, not by insertion', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    const nonIncreasing = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1]! >= v)
    expect(nonIncreasing(r.crosswalk.skills.map((s) => s.invocations))).toBe(true)
    expect(nonIncreasing(r.crosswalk.mcpServers.map((m) => m.toolCalls))).toBe(true)
    expect(nonIncreasing(r.crosswalk.agents.map((a) => a.dispatches))).toBe(true)
    expect(nonIncreasing(r.crosswalk.hooks.map((h) => h.runs))).toBe(true)
    expect(nonIncreasing(r.crosswalk.claudeMd.map((c) => c.approxTokensCarried))).toBe(true)
    // inventory keeps its own stable, name-ascending order
    const names = r.inventory.skills.map((s) => s.name)
    expect(names).toEqual([...names].sort())
  })

  it('never reads the clock: generatedAt is exactly the injected now', async () => {
    const { inv, analyses, agg } = await fixture()
    expect(buildHarnessReport(inv, analyses, agg, opts({ now: 0 })).generator.generatedAt).toBe(0)
    expect(buildHarnessReport(inv, analyses, agg, opts({ now: 42 })).generator.generatedAt).toBe(42)
  })
})

describe('buildHarnessReport: no currency data', () => {
  it('the serialized report contains no "$" and no key matching /usd/i', async () => {
    const { inv, analyses, agg } = await fixture()
    const r: HarnessReport = buildHarnessReport(inv, analyses, agg, opts())
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain('$')
    expect(allKeys(r).filter((k) => /usd/i.test(k))).toEqual([])
    expect(allKeys(r).filter((k) => /price|dollar|savings|cost/i.test(k))).toEqual([])
  })

  // Assert the no-currency contract end to end, including the report's inputs.
  it('carries no money, and neither does the Analysis or the Aggregate it was built from', async () => {
    const { inv, analyses, agg } = await fixture()
    for (const [label, obj] of [['aggregate', agg], ['analysis', analyses[0]], ['harness report', buildHarnessReport(inv, analyses, agg, opts())]] as const) {
      const serialized = JSON.stringify(obj)
      expect(serialized.includes('Usd'), `${label} leaks Usd`).toBe(false)
      expect(serialized.includes('usd'), `${label} leaks usd`).toBe(false)
      expect(serialized.includes('$'), `${label} leaks $`).toBe(false)
    }
  })
})
