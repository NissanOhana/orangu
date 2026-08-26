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
import { buildHarnessReport } from './report.js'
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

const opts = (over: Partial<Parameters<typeof buildHarnessReport>[3]> = {}) => ({
  version: '0.2.0',
  now: 1_700_000_000_000,
  scope: { cwd: '/repo', roots: ['/root'], global: false, limit: 200, sessionsUnreadable: 0 },
  ...over,
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
  it('emits exactly the six top-level keys, with the schema version and the injected clock', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(Object.keys(r).sort()).toEqual(['crosswalk', 'generator', 'inventory', 'notes', 'schemaVersion', 'scope'])
    expect(r.schemaVersion).toBe(HARNESS_SCHEMA_VERSION)
    expect(r.schemaVersion).toBe('1')
    expect(r.generator).toEqual({ name: 'orangu', version: '0.2.0', generatedAt: 1_700_000_000_000 })
    expect(Object.keys(r.inventory).sort()).toEqual(['agents', 'claudeMd', 'mcpServers', 'plugins', 'settings', 'skills', 'totals', 'unreadable'])
    expect(Object.keys(r.crosswalk).sort()).toEqual([
      'agents',
      'claudeMd',
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
  it('notes that ~/.claude.json was not read, and leaves usageCounters off the payload', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts())
    expect(r.inventory.usageCounters).toBeUndefined()
    expect(r.notes.some((n) => n.includes('.claude.json'))).toBe(true)
  })

  it('notes sessions that could not be analyzed rather than failing the run', async () => {
    const { inv, analyses, agg } = await fixture()
    const r = buildHarnessReport(inv, analyses, agg, opts({ scope: { cwd: '/repo', roots: ['/root'], global: false, limit: 200, sessionsUnreadable: 2 } }))
    expect(r.notes.some((n) => n.includes('2') && n.toLowerCase().includes('session'))).toBe(true)
  })

  it('notes an empty harness instead of emitting a blank report', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orangu-hr-empty-'))
    const inv = await collectInventory({ cwd: home, roots: [], home })
    const r = buildHarnessReport(inv, [], aggregate([], 'test', 0), opts())
    expect(r.notes.some((n) => n.includes('no harness config'))).toBe(true)
    expect(r.scope.sessionsScanned).toBe(0)
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
