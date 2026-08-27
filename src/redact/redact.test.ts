import { describe, it, expect } from 'vitest'
import { scrubStr, redactAnalysis, redactValue } from './redact.js'
import type { Analysis } from '../model/analysis.js'

describe('scrubStr', () => {
  it('masks anthropic keys, github tokens, jwts, db urls, emails', () => {
    expect(scrubStr('key sk-ant-api03-AbC123_def-456ghi789')).toContain('‹anthropic-key›')
    expect(scrubStr('ghp_1234567890abcdef1234567890abcdef1234')).toContain('‹github-token›')
    expect(scrubStr('postgres://user:pw@host:5432/db')).toContain('‹db-url›')
    expect(scrubStr('contact a.b+c@dept.example.com now')).toContain('‹email›')
    expect(scrubStr('nothing to see here')).toBe('nothing to see here')
  })
})

describe('redactAnalysis', () => {
  const MARKER = 'private-purple-ferret-9073'
  const mk = (): Analysis =>
    ({
      schemaVersion: '1',
      session: { id: 'x', path: '/Users/me/secret/proj/a.jsonl', cwd: '/Users/me/secret/proj' },
      summary: { narrative: 'reached out to boss@corp.example.com' },
      turns: [{ promptPreview: 'token=abcdef123456' }],
    }) as unknown as Analysis

  it('scrubs by default and counts', () => {
    const { analysis, report } = redactAnalysis(mk())
    expect(report.applied).toBeGreaterThan(0)
    expect((analysis.summary as { narrative: string }).narrative).not.toContain('boss@corp.example.com')
  })
  it('can strip text and paths', () => {
    const { analysis } = redactAnalysis(mk(), { stripText: true, stripPaths: true })
    expect(analysis.turns[0]!.promptPreview).toBe('')
    expect(analysis.session.path).toBe('proj/a.jsonl')
  })

  const GENERATED = 'rule-authored-copy-4412'
  const full = (): Analysis =>
    ({
      schemaVersion: '2',
      generator: { name: 'orangu', version: 'test', generatedAt: 0, modelCatalogUpdatedAt: '2026-01-01' },
      session: {
        id: 'session-id',
        title: MARKER,
        source: 'claude-code',
        path: '/tmp/session.jsonl',
        subagentPaths: [],
        gitBranches: [MARKER],
        clientVersions: ['2.1.0'],
        entrypoints: ['cli'],
        permissionModes: ['default'],
        models: [{ id: 'claude-test', displayName: 'Claude Test', family: 'claude', estimatedMatch: false }],
        effortLevels: ['high'],
        live: false,
      },
      summary: { narrative: GENERATED, outcomes: { prLinks: [{ label: MARKER, url: `https://example.test/${MARKER}`, turnIndex: 0 }] } },
      turns: [{ commandName: MARKER, promptPreview: MARKER, kind: 'human', agents: [], models: ['claude-test'], activity: 'Bash×1' }],
      tools: {
        byName: [{ name: 'Bash', category: 'exec' }],
        errorGroups: [{ name: 'Bash', signature: GENERATED, sampleHint: MARKER }],
        calls: [{ toolUseId: 'tool-1', name: 'Bash', category: 'exec', summary: MARKER, errorHint: MARKER }],
      },
      agents: {
        runs: [{ agentId: 'agent-1', name: MARKER, agentType: 'code-reviewer', description: MARKER, spawnDepth: 0, teamName: MARKER, taskKind: MARKER, status: 'completed', hasTranscript: true }],
        byType: [{ agentType: 'code-reviewer' }],
        byModel: [{ model: 'claude-test' }],
      },
      skills: { invocations: [{ name: 'orangu-improve', via: 'command', turnIndex: 0, args: MARKER }], byName: [{ name: 'orangu-improve' }] },
      hooks: { byCommand: [{ command: MARKER, hookEvent: 'Stop' }], events: [{ hookEvent: 'Stop' }] },
      context: { series: [{ messageUuid: 'message-1', model: 'claude-test' }], cacheMisses: [], compactions: [{ trigger: 'auto' }] },
      tokens: { byModel: [{ model: 'claude-test', displayName: 'Claude Test' }], byToolCategory: [{ category: 'exec' }] },
      time: { longestTurns: [{ preview: MARKER }] },
      files: { files: [{ path: '/tmp/file.ts' }], mostReRead: [] },
      quality: {
        signals: [{ id: 'tests', label: GENERATED, value: 'none', tone: 'unknown', detail: GENERATED }],
        testRuns: [{ turnIndex: 0, command: MARKER, ok: false }],
        buildRuns: [{ turnIndex: 0, command: MARKER, ok: false }],
        gitCommits: [{ turnIndex: 0, ok: true, message: MARKER }],
        userCorrections: [{ turnIndex: 0, preview: MARKER }],
      },
      insights: [{ id: 'insight-1', ruleId: 'rule-1', severity: 'low', axis: 'quality', title: GENERATED, detail: MARKER, recommendation: GENERATED, evidence: { command: MARKER, template: MARKER, sample: MARKER, failedAgent: { agentId: 'agent-1', agentType: 'code-reviewer', name: MARKER, status: 'failed', toolErrors: 1, tokens: 10 } }, turnIndexes: [], personas: ['anyone'] }],
      events: [{ kind: 'interrupt', turnIndex: 0, label: GENERATED, detail: MARKER }],
      parse: {
        recordCounts: { user: 1, [MARKER]: 2 },
        unknownRecordTypes: { [MARKER]: 2 },
        unknownBlockTypes: { [MARKER]: 3 },
        attachmentTypes: { [MARKER]: 4 },
        attachmentBytes: { [MARKER]: 400 },
        systemSubtypes: { [MARKER]: 5 },
        warnings: [{ code: 'bad_line', message: MARKER, count: 1 }],
      },
    }) as unknown as Analysis

  it('strips every transcript-authored Analysis string while preserving structural identifiers', () => {
    const a = full()
    const stripped = redactAnalysis(a, { stripText: true, home: '' }).analysis
    const json = JSON.stringify(stripped)
    expect(json).not.toContain(MARKER)
    expect(stripped.session.gitBranches).toEqual([])
    expect(stripped.parse.recordCounts).toEqual({ user: 1 })
    expect(stripped.parse.unknownRecordTypes).toEqual({ '‹stripped›': 2 })
    expect(stripped.parse.unknownBlockTypes).toEqual({ '‹stripped›': 3 })
    expect(stripped.parse.attachmentTypes).toEqual({ '‹stripped›': 4 })
    expect(stripped.parse.attachmentBytes).toEqual({ '‹stripped›': 400 })
    expect(stripped.parse.systemSubtypes).toEqual({ '‹stripped›': 5 })
    expect(stripped.tools.calls[0]!.name).toBe('Bash')
    expect(stripped.tools.byName[0]!.name).toBe('Bash')
    expect(stripped.skills.invocations[0]!.name).toBe('orangu-improve')
    expect(stripped.skills.byName[0]!.name).toBe('orangu-improve')
    expect(stripped.agents.runs[0]!.agentType).toBe('code-reviewer')
    expect(stripped.agents.byType[0]!.agentType).toBe('code-reviewer')
    expect(stripped.agents.runs[0]!.status).toBe('completed')
    expect(stripped.session.source).toBe('claude-code')

    const included = redactAnalysis(a, { stripText: false, home: '' }).analysis
    expect(JSON.stringify(included)).toContain(MARKER)
    expect(included.tools.calls[0]!.name).toBe('Bash')
    expect(included.skills.invocations[0]!.name).toBe('orangu-improve')
  })

  it('blanks only the quoted session title inside summary.narrative under stripText', () => {
    const a = full()
    const tail = 'the human made 3 requests over 2m; the agent was busy for 1m of that. It made 4 tool calls.'
    a.summary.narrative = `In “${MARKER} with a ”stray” quote”, ${tail}`
    const out = redactAnalysis(a, { stripText: true, home: '' }).analysis
    expect(out.summary.narrative).toBe(`In this session, ${tail}`)
    expect(out.summary.narrative).not.toContain(MARKER)
    // without stripText the title stays quoted verbatim
    expect(redactAnalysis(a, { stripText: false, home: '' }).analysis.summary.narrative).toContain(`In “${MARKER}`)
    // an analyzer narrative with no title ("In this session, …") is passed through unchanged
    a.summary.narrative = `In this session, ${tail}`
    expect(redactAnalysis(a, { stripText: true, home: '' }).analysis.summary.narrative).toBe(`In this session, ${tail}`)
  })

  it('keeps rule-generated copy under stripText while transcript-authored strings are still blanked', () => {
    const out = redactAnalysis(full(), { stripText: true, home: '' }).analysis
    // orangu's own rules wrote these: they survive
    expect(out.insights[0]!.title).toBe(GENERATED)
    // Insight.detail interpolates raw commands/previews (insights.ts) and is therefore not rescued.
    expect(out.insights[0]!.detail).toBe('')
    expect(out.insights[0]!.recommendation).toBe(GENERATED)
    expect(out.summary.narrative).toBe(GENERATED)
    expect(out.quality.signals[0]!.label).toBe(GENERATED)
    expect(out.quality.signals[0]!.detail).toBe(GENERATED)
    expect(out.events[0]!.label).toBe(GENERATED)
    expect(out.tools.errorGroups[0]!.signature).toBe(GENERATED)
    // the transcript wrote these: they are gone
    expect(out.session.title).toBe('')
    expect(out.turns[0]!.promptPreview).toBe('')
    expect(out.turns[0]!.commandName).toBe('')
    expect(out.tools.calls[0]!.summary).toBe('')
    expect(out.tools.calls[0]!.errorHint).toBe('')
    expect(out.tools.errorGroups[0]!.sampleHint).toBe('')
    expect(out.agents.runs[0]!.description).toBe('')
    expect(out.quality.gitCommits[0]!.message).toBe('')
    expect(out.events[0]!.detail).toBe('')
    expect((out.insights[0]!.evidence as { command: string }).command).toBe('')
    expect(JSON.stringify(out)).not.toContain(MARKER)
  })

  it('keeps event labels only for kinds the adapter labels from a fixed string', () => {
    const a = full()
    a.events = [
      { kind: 'interrupt', turnIndex: 0, label: GENERATED },
      // parse.ts passes cronKind / the system subtype / the attachment type through as these labels
      { kind: 'scheduled_fire', turnIndex: 0, label: MARKER },
      { kind: 'api_error', turnIndex: 0, label: MARKER },
      { kind: 'other', turnIndex: 0, label: MARKER },
    ]
    const out = redactAnalysis(a, { stripText: true, home: '' }).analysis
    expect(out.events.map((e) => e.label)).toEqual([GENERATED, '', '', ''])
    expect(redactAnalysis(a, { stripText: false, home: '' }).analysis.events[1]!.label).toBe(MARKER)
  })

  it('still scrubs a secret planted in generated copy', () => {
    const a = full()
    a.insights[0]!.title = 'see sk-ant-api03-FAKEFAKEFAKEFAKEFAKE for details'
    const out = redactAnalysis(a, { stripText: true, home: '' }).analysis
    expect(out.insights[0]!.title).toContain('‹anthropic-key›')
    expect(JSON.stringify(out)).not.toContain('sk-ant-api03-FAKEFAKEFAKEFAKEFAKE')
  })

  it('rewrites the home-directory prefix to ~ by default', () => {
    const a = {
      session: { id: 'x', path: '/home/tester/proj/a.jsonl', cwd: '/home/tester/proj' },
      summary: { narrative: 'read /home/tester/proj/src/x.ts and /home/tester2/other.ts' },
    } as unknown as Analysis
    const { analysis } = redactAnalysis(a, { home: '/home/tester' })
    expect(analysis.session.path).toBe('~/proj/a.jsonl')
    expect(analysis.session.cwd).toBe('~/proj')
    expect(analysis.summary.narrative).toContain('~/proj/src/x.ts')
    // a sibling directory sharing the prefix is untouched
    expect(analysis.summary.narrative).toContain('/home/tester2/other.ts')
  })

  it.skipIf(!process.env['HOME'])('detects the home directory from the environment when not given', () => {
    const home = process.env['HOME']!
    const a = { session: { id: 'x', path: `${home}/Code/demo/s.jsonl`, cwd: `${home}/Code/demo` } } as unknown as Analysis
    const { analysis } = redactAnalysis(a)
    expect(analysis.session.path).toBe('~/Code/demo/s.jsonl')
    expect(analysis.session.cwd).toBe('~/Code/demo')
  })

  it('keeps home paths intact when scrub is off or home is empty', () => {
    const a = { session: { id: 'x', path: '/home/tester/a.jsonl' } } as unknown as Analysis
    expect(redactAnalysis(a, { scrub: false, home: '/home/tester' }).analysis.session.path).toBe('/home/tester/a.jsonl')
    expect(redactAnalysis(a, { home: '' }).analysis.session.path).toBe('/home/tester/a.jsonl')
  })
})

describe('redactValue', () => {
  it('rewrites the home prefix to ~ on arbitrary shapes', () => {
    const row = { title: 'ping boss@corp.example.com', path: '/home/tester/proj/a.jsonl' }
    const out = redactValue(row, { home: '/home/tester' })
    expect(out.path).toBe('~/proj/a.jsonl')
    expect(out.title).toContain('‹email›')
  })
})
