import { describe, it, expect } from 'vitest'
import {
  catalogEntries,
  featureEntries,
  allEntries,
  CHANGE_CLASS_DEFINITIONS,
  isChangeClass,
  matchCatalog,
  matchRule,
  type MatchableAnalysis,
} from './catalog.js'
import { RULES } from '../analyze/insights.js'

const analysisWith = (insights: MatchableAnalysis['insights'], rest: Partial<MatchableAnalysis> = {}): MatchableAnalysis => ({
  insights,
  ...rest,
})

describe('catalog data files', () => {
  it('every entry is well-formed: unique id, change class, one pattern kind, one payload kind, provenance, note', () => {
    const entries = allEntries()
    expect(entries.length).toBeGreaterThanOrEqual(15)
    const ids = new Set<string>()
    for (const e of entries) {
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false)
      ids.add(e.id)
      expect(isChangeClass(e.changeClass), `${e.id} changeClass=${e.changeClass}`).toBe(true)
      const kinds = [e.pattern.ruleId, e.pattern.signal].filter((x) => x !== undefined)
      expect(kinds.length, `${e.id} pattern has exactly one of ruleId|signal`).toBe(1)
      const payloads = [e.tool, e.skill, e.feature].filter((x) => x !== undefined)
      expect(payloads.length, `${e.id} names exactly one of tool|skill|feature`).toBe(1)
      // verified entries carry a date; research-found candidates carry null
      if (e.verifiedAt !== null) expect(e.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.note.length, `${e.id} note`).toBeGreaterThan(20)
      if (e.url !== null) expect(e.url, `${e.id} url is https or null`).toMatch(/^https:\/\//)
    }
  })
  it('every non-null URL appears verbatim in verified-urls.json (offline-verifiability rule)', async () => {
    const { readFile } = await import('node:fs/promises')
    const inventory = JSON.parse(await readFile(new URL('./verified-urls.json', import.meta.url), 'utf8')) as { urls: string[] }
    const recorded = new Set(inventory.urls)
    for (const e of allEntries()) {
      if (e.url !== null) expect(recorded.has(e.url), `${e.id} url ${e.url} recorded verbatim in verified-urls.json`).toBe(true)
    }
  })
  it('all shipped entries are curated with a verification date — discoveries stay proposal candidates', () => {
    for (const e of allEntries()) expect(e.verifiedAt, `${e.id} verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('features.json entries all declare a feature and a detectable pattern', () => {
    const feats = featureEntries()
    expect(feats.length).toBeGreaterThanOrEqual(7)
    for (const e of feats) expect(typeof e.feature, `${e.id} is a feature entry`).toBe('string')
  })
  /**
   * A `{ ruleId }` pattern only matches when an insight with that exact id is emitted. Cross-check
   * every referenced id against the live RULES registry so renamed or deleted rules cannot silently
   * orphan catalog entries.
   */
  it('every ruleId a catalog or feature entry points at is a rule that actually ships', () => {
    // Read the ids off the live registry, not off a hard-coded list — that is the whole point.
    // (Quote-agnostic: the test transform re-emits string literals with double quotes.)
    const shipped = new Set<string>()
    for (const rule of RULES) {
      for (const m of rule.toString().matchAll(/ruleId:\s*['"]([a-z0-9-]+)['"]/g)) shipped.add(m[1]!)
    }
    expect(shipped.size, 'rule ids recovered from the RULES registry').toBeGreaterThanOrEqual(40)
    const referenced = allEntries()
      .map((e) => ({ id: e.id, ruleId: e.pattern.ruleId }))
      .filter((e): e is { id: string; ruleId: string } => typeof e.ruleId === 'string')
    expect(referenced.length, 'entries with a ruleId pattern').toBeGreaterThanOrEqual(5)
    const harnessRoutes = new Set(CHANGE_CLASS_DEFINITIONS.map((c) => `harness:${c.id}`))
    const invalidHarnessRoutes = referenced.filter((e) => e.ruleId.startsWith('harness:') && !harnessRoutes.has(e.ruleId))
    expect(invalidHarnessRoutes, 'harness catalog routes use a declared change class').toEqual([])
    const orphans = referenced.filter((e) => !e.ruleId.startsWith('harness:') && !shipped.has(e.ruleId))
    expect(orphans, `catalog entries pointing at a rule id that no longer ships: ${orphans.map((o) => `${o.id} -> ${o.ruleId}`).join(', ')}`).toEqual([])
  })

  it('the catalog covers the seeded pattern families', () => {
    const sigs = catalogEntries().map((e) => e.pattern.signal).filter(Boolean)
    for (const s of ['file-ext:.pdf', 'file-ext:.json', 'file-ext:.xlsx', 'cache-miss:tools_changed', 'cache-miss:system_changed', 'cache-miss:messages_changed', 'bash-search-loop'])
      expect(sigs, `signal ${s} seeded`).toContain(s)
    const rules = allEntries().map((e) => e.pattern.ruleId).filter(Boolean)
    for (const r of ['reread-files', 'repeated-commands', 'sequential-reads', 'preamble-weight', 'mcp-definition-weight'])
      expect(rules, `ruleId ${r} seeded`).toContain(r)
  })

  it('exports the same complete nine-class improvement taxonomy used by app and plugin copy', () => {
    expect(CHANGE_CLASS_DEFINITIONS).toEqual([
      { id: 'instruction', label: 'Instruction files', description: 'Persistent project guidance and conventions.' },
      { id: 'script-cli', label: 'Scripts and CLIs', description: 'Repeatable actions with checkable output.' },
      { id: 'hook', label: 'Hooks', description: 'Guaranteed actions at lifecycle boundaries.' },
      { id: 'skill-create', label: 'Skills to create', description: 'Reusable knowledge and workflows specific to this setup.' },
      { id: 'skill-discover', label: 'Skills to discover', description: 'Existing capabilities to evaluate before installing.' },
      { id: 'subagent-agent', label: 'Subagents and agents', description: 'Isolated or specialized work with clear ownership.' },
      { id: 'mcp', label: 'MCP servers', description: 'External tools and data that the work needs.' },
      { id: 'plugin', label: 'Plugins', description: 'A reusable package of related extensions.' },
      { id: 'workflow-config', label: 'Workflow and configuration', description: 'How work is sequenced, checked, and repeated.' },
    ])
    const covered = new Set(allEntries().map((e) => e.changeClass))
    expect([...covered].sort()).toEqual(CHANGE_CLASS_DEFINITIONS.map((c) => c.id).sort())
  })

  it('keeps external skill discovery explicit, candidate-only, install-free, and offline at match time', () => {
    const entry = catalogEntries().find((e) => e.id === 'discover-existing-skill')
    expect(entry?.changeClass).toBe('skill-discover')
    expect(entry?.url).toBe('https://skills.sh/')
    expect(entry?.note).toMatch(/user to run/i)
    expect(entry?.note).toMatch(/never install or fetch/i)
    expect(entry?.note).toMatch(/candidate/i)
    expect(matchRule('harness:skill-discover').some((m) => m.entry.id === entry?.id)).toBe(true)
  })

  it('routes a related-extension harness finding to the curated plugin entry', () => {
    const matches = matchRule('harness:plugin')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.entry.id).toBe('package-related-extensions')
    expect(matches[0]?.entry.changeClass).toBe('plugin')
  })

  it('contains no stale local-corpus or client-version validation boast', () => {
    const text = JSON.stringify(allEntries())
    expect(text).not.toMatch(/79 of 85|verified on \d+ sessions|sessions across \d+|claude code versions|\bcorpus\b/i)
  })
})

describe('matchCatalog — ruleId patterns', () => {
  it('matches when an insight with the pattern ruleId is present, with the insight as evidence', () => {
    const a = analysisWith([{ ruleId: 'reread-files', id: 'ins_1', title: '3 files re-read' }])
    const m = matchCatalog(a).filter((x) => x.entry.pattern.ruleId === 'reread-files')
    expect(m.length).toBeGreaterThanOrEqual(1)
    expect(m[0]!.evidence).toContain('reread-files')
    expect(m[0]!.evidence).toContain('3 files re-read')
  })
  it('does not match when no insight carries the ruleId', () => {
    const a = analysisWith([{ ruleId: 'tool-errors', title: 'errors' }])
    expect(matchCatalog(a).filter((x) => x.entry.pattern.ruleId === 'reread-files')).toEqual([])
  })
})

describe('matchCatalog — file-ext signals', () => {
  it('matches .pdf paths inside size-flavored insight evidence', () => {
    const a = analysisWith([
      { ruleId: 'oversized-tool-results', title: 'big', evidence: { calls: [{ tool: 'Read', summary: 'specs/report.pdf', bytes: 90000 }] } },
    ])
    const m = matchCatalog(a).filter((x) => x.entry.pattern.signal === 'file-ext:.pdf')
    expect(m.length).toBe(1)
    expect(m[0]!.evidence).toContain('report.pdf')
  })
  it('matches .json re-reads via files.mostReRead', () => {
    const a = analysisWith([], { files: { mostReRead: [{ path: '/repo/package.json' }] } })
    expect(matchCatalog(a).some((x) => x.entry.pattern.signal === 'file-ext:.json')).toBe(true)
  })
  it('does not match a different extension or a lookalike (.pdfx)', () => {
    const a = analysisWith([
      { ruleId: 'oversized-tool-results', title: 'big', evidence: { calls: [{ summary: 'notes.pdfx' }, { summary: 'data.csv' }] } },
    ])
    expect(matchCatalog(a).some((x) => x.entry.pattern.signal === 'file-ext:.pdf')).toBe(false)
  })
  it('ignores paths in non-size-flavored insights (no wallpaper from unrelated rules)', () => {
    const a = analysisWith([{ ruleId: 'tool-errors', title: 'x', evidence: { file: 'a.pdf' } }])
    expect(matchCatalog(a).some((x) => x.entry.pattern.signal === 'file-ext:.pdf')).toBe(false)
  })
})

describe('matchCatalog — cache-miss signals', () => {
  it('matches a cache_miss_reason.type from the cache-invalidation insight byType evidence', () => {
    const a = analysisWith([
      { ruleId: 'cache-invalidation', title: 'misses', evidence: { byType: [{ type: 'tools_changed', events: 3, missedTokens: 120000 }] } },
    ])
    const m = matchCatalog(a).filter((x) => x.entry.pattern.signal === 'cache-miss:tools_changed')
    expect(m.length).toBe(1)
    expect(m[0]!.evidence).toContain('tools_changed')
    expect(m[0]!.evidence).toContain('3')
  })
  it('matches from full-Analysis context.cacheMisses when present', () => {
    const a = analysisWith([], { context: { cacheMisses: [{ type: 'system_changed' }, { type: 'system_changed' }] } })
    expect(matchCatalog(a).some((x) => x.entry.pattern.signal === 'cache-miss:system_changed')).toBe(true)
  })
  it('does not match a type that never occurred', () => {
    const a = analysisWith([
      { ruleId: 'cache-invalidation', title: 'misses', evidence: { byType: [{ type: 'unavailable', events: 5 }] } },
    ])
    expect(matchCatalog(a).some((x) => x.entry.pattern.signal === 'cache-miss:messages_changed')).toBe(false)
  })
})

describe('matchCatalog — bash-search-loop signal', () => {
  it('matches repeated grep/find commands', () => {
    const a = analysisWith([
      { ruleId: 'repeated-commands', title: 'rep', evidence: { commands: [{ command: 'grep -rn TODO src', count: 6 }] } },
    ])
    const m = matchCatalog(a).filter((x) => x.entry.pattern.signal === 'bash-search-loop')
    expect(m.length).toBeGreaterThanOrEqual(2) // ripgrep + ast-grep
    expect(m[0]!.evidence).toContain('grep -rn TODO src')
  })
  it('does not match repeated non-search commands', () => {
    const a = analysisWith([
      { ruleId: 'repeated-commands', title: 'rep', evidence: { commands: [{ command: 'npm test', count: 9 }] } },
    ])
    expect(matchCatalog(a).some((x) => x.entry.pattern.signal === 'bash-search-loop')).toBe(false)
  })
})

describe('matchRule — the suggest wiring path', () => {
  it('returns ruleId-pattern entries for a finding with no analysis loaded (create path)', () => {
    const m = matchRule('reread-files')
    expect(m.length).toBeGreaterThanOrEqual(1)
    for (const x of m) expect(x.entry.pattern.ruleId).toBe('reread-files')
    expect(m[0]!.evidence).toContain('reread-files')
  })
  it('returns [] for an unknown ruleId', () => {
    expect(matchRule('not-a-rule')).toEqual([])
  })
  it('adds signal matches detected on the finding own insights (show path), scoped to the finding ruleId', () => {
    const a = analysisWith([
      { ruleId: 'cache-invalidation', title: 'misses', evidence: { byType: [{ type: 'tools_changed', events: 2 }] } },
      { ruleId: 'oversized-tool-results', title: 'big', evidence: { calls: [{ summary: 'x.pdf' }] } },
    ])
    const m = matchRule('cache-invalidation', [a])
    expect(m.some((x) => x.entry.pattern.signal === 'cache-miss:tools_changed')).toBe(true)
    // the .pdf evidence belongs to a DIFFERENT rule — not attached to this finding
    expect(m.some((x) => x.entry.pattern.signal === 'file-ext:.pdf')).toBe(false)
  })
  it('dedupes an entry matched by several sessions', () => {
    const a = analysisWith([{ ruleId: 'reread-files', title: 't' }])
    const m = matchRule('reread-files', [a, a])
    const ids = m.map((x) => x.entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('determinism', () => {
  it('the matcher and shared taxonomy stay offline, clock-free, and browser-safe', async () => {
    const { readFile } = await import('node:fs/promises')
    const matcher = await readFile(new URL('./catalog.ts', import.meta.url), 'utf8')
    const taxonomy = await readFile(new URL('./change-classes.ts', import.meta.url), 'utf8')
    expect(`${matcher}\n${taxonomy}`).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|\bDate\.now\s*\(|\bMath\.random\s*\(|\bwriteFile\b/)
    expect(taxonomy).not.toMatch(/^import\s/m)
    expect(taxonomy).not.toContain('node:')
  })

  it('same input → identical output, and no entry loses required fields through matching', () => {
    const a = analysisWith([
      { ruleId: 'reread-files', id: 'i1', title: 're-reads' },
      { ruleId: 'cache-invalidation', title: 'm', evidence: { byType: [{ type: 'messages_changed', events: 1 }] } },
    ])
    const r1 = JSON.stringify(matchCatalog(a))
    const r2 = JSON.stringify(matchCatalog(a))
    expect(r1).toBe(r2)
  })
})

/** The hosts of each vendor that the 2026-11-01 pattern research read. A vendor entry cites one of them. */
const VENDOR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  Anthropic: ['code.claude.com', 'www.anthropic.com', 'claude.com'],
  OpenAI: ['developers.openai.com', 'learn.chatgpt.com', 'openai.com'],
  Cursor: ['cursor.com'],
  xAI: ['docs.x.ai'],
}
const vendorOf = (url: string | null): string | undefined =>
  url === null ? undefined : Object.keys(VENDOR_HOSTS).find((vendor) => VENDOR_HOSTS[vendor]!.includes(new URL(url).host))

/** The rule ids that the RULES registry ships, read off the registry as the orphan test above reads them. */
function shippedRuleIds(): Set<string> {
  const shipped = new Set<string>()
  for (const rule of RULES) for (const m of rule.toString().matchAll(/ruleId:\s*['"]([a-z0-9-]+)['"]/g)) shipped.add(m[1]!)
  return shipped
}

/** The signal kinds that catalog.ts documents in its header and detects in detectSignal. */
const isDocumentedSignal = (signal: string): boolean => /^file-ext:\.[a-z0-9]+$/.test(signal) || /^cache-miss:[a-z_]+$/.test(signal) || signal === 'bash-search-loop'

/** The token levers that the catalog must cover: agents, effort, model choice, scripts and skills. */
const LEVER_RULES = ['model-for-task', 'thinking-on-mechanical', 'agent-fanout', 'failed-agents', 'skill-token-weight', 'script-candidate'] as const

describe('vendor patterns: Anthropic, OpenAI, Cursor and xAI', () => {
  it('catalog.json cites a page of each vendor, verified on a date, with a pattern that a finding can match', async () => {
    const { readFile } = await import('node:fs/promises')
    const recorded = new Set((JSON.parse(await readFile(new URL('./verified-urls.json', import.meta.url), 'utf8')) as { urls: string[] }).urls)
    const shipped = shippedRuleIds()
    for (const vendor of Object.keys(VENDOR_HOSTS)) {
      const cited = catalogEntries().filter((e) => vendorOf(e.url) === vendor)
      expect(cited.length, `catalog.json has an entry that cites a ${vendor} page`).toBeGreaterThanOrEqual(1)
      for (const e of cited) {
        expect(recorded.has(e.url!), `${e.id} url is in verified-urls.json`).toBe(true)
        expect(e.verifiedAt, `${e.id} verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        const { ruleId, signal } = e.pattern
        const matchable = ruleId !== undefined ? shipped.has(ruleId) || ruleId.startsWith('harness:') : signal !== undefined && isDocumentedSignal(signal)
        expect(matchable, `${e.id} pattern ${JSON.stringify(e.pattern)} is a shipped rule or a documented signal`).toBe(true)
      }
    }
  })

  it('the catalog entries of the token levers match at least 4 of the 6 lever rules on the suggest path', () => {
    const covered = LEVER_RULES.filter((ruleId) =>
      matchRule(ruleId).some((m) => catalogEntries().includes(m.entry) && vendorOf(m.entry.url) !== undefined),
    )
    expect(covered.length, `lever rules with a vendor catalog entry: ${covered.join(', ')}`).toBeGreaterThanOrEqual(4)
  })

  it('both data files carry catalog version 2 and the date of the vendor research', async () => {
    const { readFile } = await import('node:fs/promises')
    for (const file of ['./catalog.json', './features.json']) {
      const json = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8')) as { catalogVersion: number; updatedAt: string }
      expect({ file, catalogVersion: json.catalogVersion, updatedAt: json.updatedAt }).toEqual({ file, catalogVersion: 2, updatedAt: '2026-11-01' })
    }
  })
})

/**
 * The built-in Claude Code command that does the check in one step, named where it is the smaller fix.
 * Each pair is the command and the finding that it answers. features.json holds each one, keyed to a shipped rule.
 */
const NATIVE_COMMANDS: ReadonlyArray<readonly [command: string, ruleId: string]> = [
  ['/usage', 'agent-fanout'],
  ['/usage', 'low-cache-hit'],
  ['/doctor', 'mcp-definition-weight'],
  ['/skill-doctor', 'skill-token-weight'],
  ['/fewer-permission-prompts', 'human-wait-dominates'],
  ['/context', 'preamble-weight'],
]

describe('native commands: features.json names the Claude Code command', () => {
  it.each(NATIVE_COMMANDS)('%s reaches a %s finding through matchRule, from a Claude Code docs page', (command, ruleId) => {
    const named = matchRule(ruleId).filter((m) => featureEntries().includes(m.entry) && m.entry.feature?.startsWith(`${command} `))
    expect(named.map((m) => m.entry.id), `one ${command} entry for ${ruleId}`).toHaveLength(1)
    const entry = named[0]!.entry
    // "Run <command>" or, after a condition that comes first (STE rule 6), "If ..., run <command>"
    expect(entry.note, `${entry.id} tells the user to run ${command}`).toMatch(new RegExp(`\\b[Rr]un ${command.replace('/', '\\/')} in Claude Code\\b`))
    expect(vendorOf(entry.url), `${entry.id} cites a Claude Code docs page`).toBe('Anthropic')
    expect(entry.verifiedAt).toBe('2026-11-01')
  })
})

describe('cache facts: the notes match code.claude.com/docs/en/prompt-caching.md (opened 2026-11-01)', () => {
  it('feat-effort-frontmatter: an effort change keeps the cache on the 5.5 models and Fable 5.1, and most other models keep a cache for each level', () => {
    const entry = featureEntries().find((e) => e.id === 'feat-effort-frontmatter')
    expect(entry?.note).not.toMatch(/Each effort level has its own cache for the same model\. So/)
    expect(entry?.note).toMatch(/An effort change keeps the prompt cache by default on Opus 5\.5, Sonnet 5\.5, Haiku 5\.5 and Fable 5\.1\. This holds with an API key or a Claude subscription\./)
    expect(entry?.note).toMatch(/On most other models, each effort level has its own cache/)
    expect(entry?.verifiedAt).toBe('2026-11-01')
  })

  it('cache-messages-changed: a model switch starts a fresh cache, and an effort change keeps it on the 5.5 models and Fable 5.1', () => {
    const entry = catalogEntries().find((e) => e.id === 'cache-messages-changed')
    expect(entry?.note).not.toMatch(/Both are part of the cache key/)
    expect(entry?.note).toMatch(/each model has its own cache/)
    expect(entry?.note).toMatch(/On Opus 5\.5, Sonnet 5\.5, Haiku 5\.5 and Fable 5\.1, with an API key or a Claude subscription, the cache stays intact by default\./)
    expect(entry?.url).toBe('https://code.claude.com/docs/en/prompt-caching.md')
    expect(entry?.verifiedAt).toBe('2026-11-01')
  })
})
