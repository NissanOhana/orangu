/**
 * orangu-export.json v1 from the pure builder. The evidence is the real projection of a synthetic aggregate, and the
 * harness is the real report with synthetic rows. The byte checks read the file text, not the measure of the builder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGGREGATE_SCHEMA_VERSION, aggregate } from '../analyze/aggregate.js'
import { ANALYZER_RULE_IDS } from '../analyze/rule-ids.js'
import { buildHarnessReport } from '../harness/report.js'
import type { HarnessInventory, HarnessReport } from '../harness/types.js'
import { projectEvidence, type EvidenceBundle } from '../suggest/evidence.js'
import type { LessonRead } from '../suggest/lessons.js'
import type { ProfileV1 } from '../suggest/profile.js'
import { checkText } from '../ste/index.js'
import { buildExport, EXPORT_MAX_BYTES, type ExportInput } from './build.js'

const SECRET = 'sk-ant-api03-PRIVATEPURPLEFERRET9073'
const PROFILE_WORD = 'quokkaexportword5531'
const PROMPT_WORD = 'zebraexportword7719'
const SESSION_IDS = [0, 1, 2, 3, 4].map((i) => `aaaaaaaa-0000-4000-8000-00000000000${i}`)
const SECTIONS = ['summary', 'index', 'profile', 'evidence', 'harness', 'lessons']

/** The real projection of a global aggregate with `count` cross findings, each rule text part `chars` long. */
function evidence(count: number, chars: number): EvidenceBundle {
  const text = (ruleId: string, part: string): string => `${part} of ${ruleId}. ${'Read the evidence of each session. '.repeat(Math.ceil(chars / 34))}`.slice(0, chars)
  const crossFindings = ANALYZER_RULE_IDS.slice(0, count).map((ruleId, i) => ({
    ruleId,
    title: `In one session: ${ruleId} shows ${i + 2} times`,
    exampleTitle: `${ruleId} shows ${i + 2} times`,
    recommendation: text(ruleId, 'The rule text'),
    improvement: text(ruleId, 'The improvement'),
    why: text(ruleId, 'The reason'),
    method: text(ruleId, 'The method'),
    sessions: 5 - (i % 5),
    totalSavingsTokens: 1_000 * (count - i),
    totalSavingsMs: 0,
    boundedSavingsTokens: 1_000 * (count - i),
    boundedSavingsMs: 0,
    axis: 'tokens',
    severity: 'medium',
    exampleSessionIds: SESSION_IDS.slice(0, 5 - (i % 5)),
  }))
  const agg = { schemaVersion: AGGREGATE_SCHEMA_VERSION, generatedAt: 0, scope: 'global', sessionCount: 5, totals: {}, averages: {}, sessions: SESSION_IDS.map((id) => ({ id })), topSessions: [], byWeek: [], crossFindings }
  return projectEvidence(agg, { scope: 'global', limit: 50 })
}

const EMPTY_INVENTORY: HarnessInventory = {
  claudeMd: [],
  memoryIndexes: [],
  settings: [],
  skills: [],
  agents: [],
  plugins: [],
  mcpServers: [],
  totals: { filesRead: 0, bytesRead: 0, claudeMdBytes: 0, claudeMdApproxTokens: 0, skills: 0, agents: 0, plugins: 0, mcpServers: 0, hookCommands: 0 },
  unreadable: [],
}

/** The real harness report, with `rows` synthetic rows in each array, heaviest first, and planted text in each text field. */
function harness(rows: number): HarnessReport {
  const report = buildHarnessReport(EMPTY_INVENTORY, [], aggregate([], 'global', 0), { version: 't', now: 0, scope: { cwd: '/repo', roots: ['/root'], global: true, limit: 500 }, sessions: [] })
  const ids = Array.from({ length: rows }, (_, i) => String(i).padStart(3, '0'))
  const weight = (i: number): number => rows - i
  const share = { sessions: 1, injections: 2, bytes: 400, approxTokens: 100 }
  const ref = { sessionId: SESSION_IDS[0]!, turnIndex: 1, at: 1_786_000_000_000, preview: `${PROMPT_WORD} again` }
  Object.assign(report.crosswalk, {
    skills: ids.map((id, i) => ({ name: `skill-${id}`, origin: 'global', installed: true, invocations: weight(i), sessions: 1, viaTool: weight(i), viaCommand: 0, status: 'used' })),
    mcpServers: ids.map((id, i) => ({ name: `server-${id}`, configured: true, toolCalls: weight(i), distinctTools: 1, sessions: 1, status: 'used' })),
    agents: ids.map((id, i) => ({ name: `agent-${id}`, defined: true, dispatches: weight(i), sessions: 1, models: ['claude-opus-5'], status: 'used' })),
    hooks: ids.map((id, i) => ({ event: 'Stop', commandBasename: `hook-${id}.sh`, configured: true, runs: weight(i), errors: 0, totalMs: 10, meanMs: 10, status: 'used' })),
    claudeMd: ids.map((id, i) => ({ file: `~/Code/p${id}/CLAUDE.md`, bytes: 400, approxTokens: 100, reads: 1, sessions: 1, approxTokensCarried: 100 * weight(i) })),
    injectedListings: ids.map((id) => ({ type: `listing-${id}`, main: share, subagent: share, approxTokensPerInjection: 50, approxTokensPerMainSession: 100 })),
  })
  Object.assign(report.enforcement, {
    broken: ids.map((id, i) => ({
      file: `~/Code/p${id}/CLAUDE.md`,
      files: 1,
      line: 3,
      text: `Never run rmtool ${id} in this repo.`,
      target: { kind: 'command', name: `rmtool-${id}` },
      sessionsInContext: 2,
      sessionsBroken: 1,
      calls: weight(i),
      agentCalls: 0,
      blocked: 0,
      examples: [`rmtool --force ${id}`],
      exampleSessionIds: [SESSION_IDS[0]],
      lastBrokenAt: 1_786_000_000_000,
    })),
    notes: ids.map((id, i) => ({ file: `~/.claude/projects/p/memory/feedback_${id}.md`, kind: 'memory', trigger: ref, writtenAt: 1_786_000_000_000, writtenBy: SESSION_IDS[0], writes: 1, sessionsAfter: 2, complaintsAfter: 2, matchingComplaints: weight(i), sharedWords: [PROMPT_WORD], examples: [ref] })),
    memory: ids.map((id) => ({ file: `~/.claude/projects/p${id}/memory/MEMORY.md`, lines: 210, bytes: 9_000, chars: 9_000, linesPastLimit: 10, firstLinePastLimit: 201, sessionsLoaded: 1, sessionsCut: 1, maxLinesCut: 10 })),
    complaints: [{ word: PROMPT_WORD, prompts: 2, sessions: 2, inInstructions: false, examples: [ref] }],
  })
  return report
}

function lessons(count: number): LessonRead {
  return {
    v: 1,
    scope: 'all',
    maxBytes: null,
    omitted: 0,
    lessons: Array.from({ length: count }, (_, i) => ({
      id: `sg_${String(i).padStart(12, '0')}`,
      scope: 'repo' as const,
      ruleId: 'reread-files',
      status: 'rejected' as const,
      reasonCode: 'not-wanted' as const,
      verdict: null,
      verdictTrusted: false,
      confoundedBy: [],
      baseline: 0,
      later: 0,
      checks: [],
      decidedAt: 1_800_000_000_000 - i,
    })),
  }
}

const PROFILE: ProfileV1 = {
  v: 1,
  updatedAt: '2026-11-01',
  role: 'write-code',
  work: ['features', 'fixes'],
  process: 'orchestrator',
  priority: 'tokens',
  models: 'ask',
  audience: 'local',
  repeats: `Run the tests first. ${PROFILE_WORD} uses ${SECRET} in the demo.`,
  never: 'Never propose a new model.',
  answers: [{ q: 'Which role fits your work best?', a: 'I write and ship code.', how: 'option' }],
}

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    version: '0.0.0-test',
    roots: 2,
    found: 7,
    sessions: 5,
    unreadable: 1,
    asOf: Date.UTC(2026, 7, 19, 16, 45, 1, 100),
    profile: PROFILE,
    evidence: evidence(3, 200),
    harness: harness(2),
    lessons: lessons(2),
    home: '/Users/test',
    ...over,
  }
}

/** Each section line of the file text, as written: the key and the value text. */
function sectionLines(text: string): Array<{ key: string; value: string }> {
  const lines = text.split('\n')
  expect(lines[0]).toBe('{')
  expect(lines.slice(-2)).toEqual(['}', ''])
  return lines.slice(1, -2).map((line, i, all) => {
    const comma = i < all.length - 1
    expect(line.endsWith(','), `line ${i + 2} ends with a comma`).toBe(comma)
    const match = /^"([a-z]+)":(.+)$/.exec(comma ? line.slice(0, -1) : line)
    expect(match, `line ${i + 2}`).not.toBeNull()
    return { key: match![1]!, value: match![2]! }
  })
}

const bytes = (text: string): number => Buffer.byteLength(text)

afterEach(() => {
  vi.useRealTimers()
})

describe('orangu-export.json v1', () => {
  it('writes 6 sections in a fixed order, 1 on each line, with the summary first', () => {
    const { text } = buildExport(input())
    expect(sectionLines(text).map((s) => s.key)).toEqual(SECTIONS)
    const file = JSON.parse(text)
    expect(Object.keys(file)).toEqual(SECTIONS)
    expect(file.summary).toEqual({ v: 1, version: '0.0.0-test', scope: 'global', roots: 2, found: 7, sessions: 5, unreadable: 1, asOf: '2026-08-19T16:45:01.100Z', redacted: true, text: false })
    expect(file.evidence).toEqual(input().evidence)
    expect(file.lessons).toEqual({ ...lessons(2), maxBytes: 16_384 })
    expect(buildExport(input({ asOf: null })).text).toContain('"asOf":null')
  })

  it('names each other section in the index with its size as the file holds it', () => {
    const { text, index } = buildExport(input())
    const file = JSON.parse(text)
    expect(file.index).toEqual(index)
    const lines = sectionLines(text)
    expect(index.map((entry) => entry.section)).toEqual(['summary', 'profile', 'evidence', 'harness', 'lessons'])
    for (const entry of index) expect(entry.bytes, entry.section).toBe(bytes(lines.find((line) => line.key === entry.section)!.value))
    // nothing was cut, so no entry says what a cut left out
    expect(index.filter((entry) => entry.cut !== undefined)).toEqual([])
  })

  it('keeps every cap on an oversize input, and each cut section says what it left out', () => {
    const big = input({ evidence: evidence(ANALYZER_RULE_IDS.length, 1_900), harness: harness(50), lessons: lessons(120) })
    const { text, index } = buildExport(big)
    expect(bytes(text)).toBeLessThanOrEqual(EXPORT_MAX_BYTES)
    const lines = new Map(sectionLines(text).map((line) => [line.key, line.value]))
    expect(bytes(lines.get('summary')!)).toBeLessThanOrEqual(4_096)
    expect(bytes(lines.get('profile')!)).toBeLessThanOrEqual(16_384)
    expect(bytes(lines.get('lessons')!)).toBeLessThanOrEqual(16_384)
    const file = JSON.parse(text)
    const note = (section: string): string | undefined => index.find((entry) => entry.section === section)?.cut

    // the evidence keeps the top findings, in their order, and only the catalog matches of those findings
    const kept = file.evidence.findings.map((f: { suggestionId: string }) => f.suggestionId)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept).toEqual(big.evidence.findings.slice(0, kept.length).map((f) => f.suggestionId))
    expect(file.evidence.selectedFindings).toBe(kept.length)
    expect(file.evidence.truncated).toBe(true)
    expect(file.evidence.catalogMatches.every((m: { suggestionId: string }) => kept.includes(m.suggestionId))).toBe(true)
    expect(file.evidence.catalogMatches).toEqual(big.evidence.catalogMatches.filter((m) => kept.includes(m.suggestionId)))
    expect(note('evidence')).toBe(`${big.evidence.totalFindings - kept.length} findings did not fit, with their catalog matches.`)

    // the harness keeps the heaviest rows of each array, and counts the rows that each array lost
    const arrays: Array<[string, string]> = [
      ['crosswalk', 'skills'],
      ['crosswalk', 'mcpServers'],
      ['crosswalk', 'agents'],
      ['crosswalk', 'hooks'],
      ['crosswalk', 'claudeMd'],
      ['crosswalk', 'injectedListings'],
      ['enforcement', 'broken'],
      ['enforcement', 'notes'],
      ['enforcement', 'memory'],
    ]
    const name = (row: Record<string, unknown>): unknown => row['name'] ?? row['file'] ?? row['type'] ?? row['commandBasename']
    const omitted: Record<string, number> = {}
    for (const [part, key] of arrays) {
      const rows: Array<Record<string, unknown>> = file.harness[part][key]
      const all = (big.harness[part as 'crosswalk'] as unknown as Record<string, Array<Record<string, unknown>>>)[key]!
      expect(rows.length, key).toBeGreaterThan(0)
      expect(rows.map(name), key).toEqual(all.slice(0, rows.length).map(name))
      if (rows.length < all.length) omitted[key] = all.length - rows.length
    }
    const total = Object.values(omitted).reduce((sum, n) => sum + n, 0)
    expect(total).toBeGreaterThan(0)
    expect(index.find((entry) => entry.section === 'harness')?.omitted).toEqual(omitted)
    expect(note('harness')).toBe(`${total} rows did not fit. Each array keeps its heaviest rows.`)

    // the lessons keep the newest that fit, and count the rest
    expect(file.lessons.lessons).toEqual(lessons(120).lessons.slice(0, file.lessons.lessons.length))
    expect(file.lessons.omitted).toBe(120 - file.lessons.lessons.length)
    expect(file.lessons.omitted).toBeGreaterThan(0)
    expect(note('lessons')).toBe(`${file.lessons.omitted} older lessons did not fit.`)
  })

  it('shares the rest between the evidence and the harness: each keeps at least 40,000 B, and the evidence takes the room that the harness leaves', () => {
    const both = buildExport(input({ evidence: evidence(ANALYZER_RULE_IDS.length, 1_900), harness: harness(50), lessons: lessons(120) }))
    const sizes = new Map(both.index.map((entry) => [entry.section, entry.bytes]))
    expect(sizes.get('evidence')).toBeGreaterThan(40_000)
    expect(sizes.get('harness')).toBeGreaterThan(40_000)
    const small = JSON.parse(buildExport(input({ evidence: evidence(ANALYZER_RULE_IDS.length, 1_900), harness: harness(2), lessons: lessons(120) })).text)
    expect(small.evidence.findings.length).toBeGreaterThan(JSON.parse(both.text).evidence.findings.length)
  })

  it('keeps the words of the profile, and scrubs a secret from them', () => {
    const { text } = buildExport(input())
    expect(text).not.toContain(SECRET)
    const file = JSON.parse(text)
    expect(file.profile.repeats).toBe(`Run the tests first. ${PROFILE_WORD} uses ‹anthropic-key› in the demo.`)
    expect(file.profile.never).toBe('Never propose a new model.')
    for (const section of SECTIONS.filter((s) => s !== 'profile')) expect(JSON.stringify(file[section]), section).not.toContain(PROFILE_WORD)
  })

  it('leaves out the answers of a profile that does not fit, then the whole profile', () => {
    // words with spaces: a long run with no space is a blob that the scrub masks
    const answers = Array.from({ length: 12 }, (_, i) => ({ q: `Question ${i}?`, a: 'Run the tests again. '.repeat(75), how: 'own' as const }))
    const long = buildExport(input({ profile: { ...PROFILE, answers } }))
    expect(JSON.parse(long.text).profile).toEqual({ ...PROFILE, repeats: `Run the tests first. ${PROFILE_WORD} uses ‹anthropic-key› in the demo.`, answers: undefined })
    expect(long.index.find((entry) => entry.section === 'profile')?.cut).toBe('The answers did not fit, so the profile has only its keyed values.')
    const huge = buildExport(input({ profile: { ...PROFILE, repeats: 'Keep the old model. '.repeat(1_000) } }))
    expect(JSON.parse(huge.text).profile).toBeNull()
    expect(huge.index.find((entry) => entry.section === 'profile')?.cut).toBe('The profile did not fit.')
    expect(buildExport(input({ profile: null })).text).toContain('"profile":null')
  })

  it('keeps no rule text, no prompt word and no clock of the harness', () => {
    const { text } = buildExport(input({ harness: harness(3) }))
    expect(text).not.toContain(PROMPT_WORD)
    expect(text).not.toContain('Never run rmtool')
    expect(text).not.toContain('rmtool --force')
    const h = JSON.parse(text).harness
    expect(Object.keys(h)).toEqual(['schemaVersion', 'crosswalk', 'enforcement'])
    expect(Object.keys(h.enforcement)).toEqual(['counts', 'broken', 'notes', 'memory'])
    expect(Object.keys(h.enforcement.broken[0])).not.toContain('text')
    expect(Object.keys(h.enforcement.broken[0])).not.toContain('examples')
    expect(h.enforcement.broken[0].target).toEqual({ kind: 'command', name: 'rmtool-000' })
    expect(Object.keys(h.enforcement.notes[0])).not.toContain('sharedWords')
    expect(h.enforcement.notes[0].trigger).toEqual({ sessionId: SESSION_IDS[0], turnIndex: 1, at: 1_786_000_000_000 })
    expect(h.enforcement.notes[0].examples).toEqual([{ sessionId: SESSION_IDS[0], turnIndex: 1, at: 1_786_000_000_000 }])
  })

  it('writes each cut sentence in STE, as orangu composes it with real counts', () => {
    // the gate of the source literals cannot see a sentence that the builder joins at run time
    const answers = Array.from({ length: 12 }, (_, i) => ({ q: `Question ${i}?`, a: 'Run the tests again. '.repeat(75), how: 'own' as const }))
    const notes = [
      ...buildExport(input({ evidence: evidence(ANALYZER_RULE_IDS.length, 1_900), harness: harness(50), lessons: lessons(120), profile: { ...PROFILE, answers } })).index,
      ...buildExport(input({ lessons: null, profile: { ...PROFILE, repeats: 'Keep the old model. '.repeat(1_000) } })).index,
    ].flatMap((entry) => (entry.cut !== undefined ? [entry.cut] : []))
    expect(notes).toHaveLength(6)
    for (const note of notes) expect(checkText(note).findings, note).toEqual([])
  })

  it('drops a hook name that holds an assignment, and keeps only the program word and a plain subcommand of a command target', () => {
    const h = harness(1)
    const hook = { event: 'Stop', configured: true, runs: 2, errors: 0, totalMs: 10, meanMs: 5, status: 'used' as const }
    h.crosswalk.hooks = [{ ...hook, commandBasename: 'NTFY_TOPIC=quokkahooktopic7' }, { ...hook, commandBasename: 'ntfy.sh' }]
    const broken = h.enforcement.broken[0]!
    const targets = [
      { kind: 'command', name: 'deploy --token quokkaruletoken8' },
      { kind: 'command', name: 'deploy quokkaRuleToken9' },
      { kind: 'command', name: 'deploy abc123def456' },
      { kind: 'command', name: 'git push --force' },
      { kind: 'command', name: 'npm run build' },
      { kind: 'command', name: 'db:push' },
      { kind: 'flag', name: '--no-verify' },
      { kind: 'tool', name: 'WebFetch' },
      { kind: 'mcp-server', name: 'octocode' },
    ] as const
    h.enforcement.broken = targets.map((target) => ({ ...broken, target }))
    const { text } = buildExport(input({ harness: h }))
    for (const planted of ['quokkahooktopic7', 'quokkaruletoken8', 'quokkaRuleToken9', 'abc123def456', 'NTFY_TOPIC']) expect(text, planted).not.toContain(planted)
    const out = JSON.parse(text).harness
    expect(out.crosswalk.hooks).toEqual([hook, { ...hook, commandBasename: 'ntfy.sh' }])
    expect(out.enforcement.broken.map((row: { target: unknown }) => row.target)).toEqual([
      { kind: 'command', name: 'deploy' },
      { kind: 'command', name: 'deploy' },
      { kind: 'command', name: 'deploy' },
      { kind: 'command', name: 'git push' },
      { kind: 'command', name: 'npm run' },
      { kind: 'command', name: 'db:push' },
      { kind: 'flag', name: '--no-verify' },
      { kind: 'tool', name: 'WebFetch' },
      { kind: 'mcp-server', name: 'octocode' },
    ])
  })

  it('says when the suggestion store did not read, and keeps the other sections', () => {
    const { text, index } = buildExport(input({ lessons: null }))
    expect(JSON.parse(text).lessons).toBeNull()
    expect(index.find((entry) => entry.section === 'lessons')?.cut).toBe('orangu could not read the suggestion store, so the export has no lessons.')
  })

  it('reads no clock: 2 builds at 2 system times give the same bytes', () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1) })
    const first = buildExport(input()).text
    vi.setSystemTime(Date.UTC(2031, 5, 6, 7, 8, 9))
    expect(buildExport(input()).text).toBe(first)
  })
})
