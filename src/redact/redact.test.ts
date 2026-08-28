import { describe, it, expect } from 'vitest'
import { scrubStr, redactAnalysis, redactValue, encodedProjectLeaf } from './redact.js'
import type { Analysis } from '../model/analysis.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { renderReport } from '../report/render.js'
import { renderAnalysisJson } from '../cli/json-out.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'

describe('scrubStr', () => {
  it('masks anthropic keys, github tokens, jwts, db urls, emails', () => {
    expect(scrubStr('key sk-ant-api03-AbC123_def-456ghi789')).toContain('‹anthropic-key›')
    expect(scrubStr('ghp_1234567890abcdef1234567890abcdef1234')).toContain('‹github-token›')
    expect(scrubStr('postgres://user:pw@host:5432/db')).toContain('‹db-url›')
    expect(scrubStr('contact a.b+c@dept.example.com now')).toContain('‹email›')
    expect(scrubStr('nothing to see here')).toBe('nothing to see here')
  })
})

describe('redactValue count maps', () => {
  it('preserves prototype-like keys as own numeric properties', () => {
    const hostile = Object.fromEntries([
      ['constructor', 1],
      ['toString', 2],
      ['__proto__', 3],
    ]) as Record<string, number>
    const value = {
      recordCounts: hostile,
      unknownRecordTypes: hostile,
      unknownBlockTypes: hostile,
      attachmentTypes: hostile,
      attachmentBytes: hostile,
      systemSubtypes: hostile,
      queueOperations: hostile,
    }

    const redacted = redactValue(value, { scrub: false })
    for (const counts of Object.values(redacted)) {
      expect(Object.hasOwn(counts, '__proto__')).toBe(true)
      expect(counts['constructor']).toBe(1)
      expect(counts['toString']).toBe(2)
      expect(counts['__proto__']).toBe(3)
      expect(Object.getPrototypeOf(counts)).toBe(Object.prototype)
    }
    expect(JSON.stringify(redacted)).toContain('"__proto__":3')
  })

  it('sums recordCounts keys that collide after scrubbing', () => {
    const redacted = redactValue(
      { recordCounts: { 'first@example.com': 2, 'second@example.com': 3 } },
      { scrub: true },
    )
    expect(redacted.recordCounts).toEqual({ '‹email›': 5 })
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
    // one segment, never two: the second-to-last segment of a home path is the username
    expect(analysis.session.path).toBe('a.jsonl')
    expect(analysis.session.cwd).toBe('proj')
  })

  // --strip-paths is the pre-share mitigation docs/PRIVACY.md names; the shipped report carries the
  // session path, every subagent path and the encoded project slug, all of which embed the username.
  const HOME_SLUG = '-Users-test-Code-secretproj'
  const withSubagents = (): Analysis =>
    ({
      session: {
        id: 'x',
        path: `/Users/test/.claude/projects/${HOME_SLUG}/dc000000-0000-4000-8000-0000000000d7.jsonl`,
        cwd: '/Users/test/Code/secretproj',
        projectSlug: HOME_SLUG,
        subagentPaths: [
          `/Users/test/.claude/projects/${HOME_SLUG}/dc000000-0000-4000-8000-0000000000d7/subagents/agent-a50314159.jsonl`,
          `/Users/test/.claude/projects/${HOME_SLUG}/dc000000-0000-4000-8000-0000000000d7/subagents/agent-b7c2d0e11.jsonl`,
        ],
      },
    }) as unknown as Analysis

  it('stripPaths reduces subagentPaths, session.path and projectSlug to one username-free segment each', () => {
    const { analysis } = redactAnalysis(withSubagents(), { stripPaths: true, home: '' })
    const json = JSON.stringify(analysis)
    expect(json).not.toContain('-Users-')
    expect(json).not.toContain('-home-')
    expect(json).not.toContain('test')
    expect(analysis.session.path).toBe('dc000000-0000-4000-8000-0000000000d7.jsonl')
    expect(analysis.session.subagentPaths).toEqual(['agent-a50314159.jsonl', 'agent-b7c2d0e11.jsonl'])
    for (const p of analysis.session.subagentPaths) expect(p.split('/').length).toBe(1)
    expect(analysis.session.projectSlug).toBe('secretproj')
    expect(analysis.session.cwd).toBe('secretproj')
  })

  it('by default the encoded home slug inside a path becomes ~ and projectSlug drops to its leaf', () => {
    const { analysis } = redactAnalysis(withSubagents(), { home: '/Users/test' })
    const json = JSON.stringify(analysis)
    expect(json).not.toContain('test')
    expect(analysis.session.path).toBe('~/.claude/projects/~-Code-secretproj/dc000000-0000-4000-8000-0000000000d7.jsonl')
    expect(analysis.session.subagentPaths[0]).toBe('~/.claude/projects/~-Code-secretproj/dc000000-0000-4000-8000-0000000000d7/subagents/agent-a50314159.jsonl')
    expect(analysis.session.projectSlug).toBe('secretproj')
    // a sibling home sharing the prefix is a different user and stays
    const sibling = redactValue({ path: '/x/-Users-test2-Code-a/s.jsonl' }, { home: '/Users/test' })
    expect(sibling.path).toBe('/x/-Users-test2-Code-a/s.jsonl')
    // scrub off keeps everything
    expect(redactAnalysis(withSubagents(), { scrub: false, home: '/Users/test' }).analysis.session.projectSlug).toBe(HOME_SLUG)
  })

  it('aggregate project identities (byProject keys, sessions[].project) drop to the same leaf', () => {
    const agg = { byProject: [{ key: HOME_SLUG, count: 1, tokens: 5 }], sessions: [{ id: 'a', project: HOME_SLUG }], byModel: [{ key: 'claude-x', count: 1 }] }
    const out = redactValue(agg, { home: '' })
    expect(out.byProject[0]).toEqual({ key: 'secretproj', count: 1, tokens: 5 })
    expect(out.sessions[0]!.project).toBe('secretproj')
    expect(out.byModel[0]!.key).toBe('claude-x')
    expect(redactValue(agg, { home: '', stripPaths: true }).byProject[0]!.key).toBe('secretproj')
    expect(redactValue({ project: '/Users/me/Code/plain' }, { home: '', stripPaths: true }).project).toBe('plain')
    expect(encodedProjectLeaf('-Users-me-Code-‹anthropic-key›')).toBe('‹anthropic-key›')
    expect(encodedProjectLeaf('plain')).toBe('plain')
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
      // commandName is a slash-command identifier (kept, like a tool name); the marker lives in the preview
      turns: [{ commandName: '/login', promptPreview: MARKER, kind: 'human', agents: [], models: ['claude-test'], activity: 'Bash×1' }],
      tools: {
        byName: [{ name: 'Bash', category: 'exec' }],
        errorGroups: [{ name: 'Bash', signature: MARKER, sampleHint: MARKER }],
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
    // the error signature is the lower-cased raw hint (src/analyze/tools.ts), never rule copy
    expect(out.tools.errorGroups[0]!.signature).toBe('')
    // the transcript wrote these: they are gone
    expect(out.session.title).toBe('')
    expect(out.turns[0]!.promptPreview).toBe('')
    // a slash-command NAME is an identifier Coverage already publishes; args stay in the stripped preview
    expect(out.turns[0]!.commandName).toBe('/login')
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

  it('scrubs a secret-bearing basename after stripping a path', () => {
    const secret = 'sk-ant-api03-abc123def456ghi789'
    const path = `/home/tester/private/${secret}.jsonl`
    const out = redactValue({ path }, { stripPaths: true, home: '' })
    expect(out.path).toBe('‹anthropic-key›.jsonl')
    expect(out.path).not.toContain(secret)
    expect(redactValue({ path }, { scrub: false, stripPaths: true, home: '' }).path).toContain(secret)
  })
})

describe('tool error signatures never carry a secret out of the process', () => {
  const secret = 'sk-ant-api03-abc123def456ghi789'
  const password = 'password authentication failed for user acme_prod at db.acme-internal.example'
  async function analysis() {
    const b = new SessionBuilder()
    b.userPrompt('deploy')
    for (let i = 0; i < 3; i++) {
      b.tick(100)
      b.toolCall('Bash', { command: 'psql' }, `error: key ${secret} rejected; ${password}`, { isError: true, durationMs: 50 })
    }
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    return analyzeSession(s, { version: 'test', now: 0 })
  }

  it('errorSignature masks the key before its digits are normalized away', async () => {
    const a = await analysis()
    expect(a.tools.errorGroups.length).toBe(1)
    expect(a.tools.errorGroups[0]!.count).toBe(3)
    expect(a.tools.errorGroups[0]!.signature).toContain('‹anthropic-key›')
    expect(a.tools.errorGroups[0]!.signature).not.toContain('abc123def456ghi789')
  })

  it('the default report and analyze --json strip the signature with the other transcript text', async () => {
    const a = await analysis()
    const { html } = renderReport(a, { redact: { scrub: true, stripText: true } })
    expect(html).not.toContain(secret)
    expect(html).not.toContain('abc123def456ghi789')
    expect(html).not.toContain('acme_prod')
    expect(html).not.toContain('acme-internal')
    const json = JSON.parse(renderAnalysisJson(a, {})) as Analysis
    expect(json.tools.errorGroups[0]!.signature).toBe('')
    expect(json.tools.errorGroups[0]!.sampleHint).toBe('')
    expect(JSON.stringify(json)).not.toContain('acme_prod')
    // --include-text keeps the (masked) signature so the Recurring errors card stays useful
    const kept = JSON.parse(renderAnalysisJson(a, { 'include-text': true })) as Analysis
    expect(kept.tools.errorGroups[0]!.signature).toContain('rejected')
    expect(kept.tools.errorGroups[0]!.signature).toContain('‹anthropic-key›')
    expect(JSON.stringify(kept)).not.toContain('abc123def456ghi789')
  })
})

describe('scrubStr gaps found in the 0.7.0 QA pass', () => {
  it('interpolates the key name instead of printing a literal $1', () => {
    const out = scrubStr('login with password=Hunter2Hunter2! please')
    expect(out).toContain('password=‹redacted›')
    expect(out).not.toContain('$1')
    expect(out).not.toContain('Hunter2')
  })
  it('masks env-style names that embed a secret word (AWS_SECRET_ACCESS_KEY=..., GITHUB_TOKEN=...)', () => {
    const aws = scrubStr('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    expect(aws).toContain('AWS_SECRET_ACCESS_KEY=‹redacted›')
    expect(aws).not.toContain('wJalrXUtnFEMI')
    const gh = scrubStr('export GITHUB_TOKEN="abcdefghijklmnop"')
    expect(gh).toContain('GITHUB_TOKEN=‹redacted›')
    expect(gh).not.toContain('abcdefghijklmnop')
  })
  it('masks npm granular access tokens', () => {
    const out = scrubStr('//registry.npmjs.org/:_authToken=npm' + '_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).toContain('‹npm-token›')
    expect(out).not.toContain('npm_abcdefghij')
  })
  it('masks PEM private-key blocks, including a block cut off by a preview', () => {
    const full = scrubStr('-----BEGIN RSA PRIVATE KEY' + '-----\nMIIEowIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----')
    expect(full).toContain('‹private-key›')
    expect(full).not.toContain('MIIEow')
    const cut = scrubStr('cert: -----BEGIN OPENSSH PRIVATE KEY' + '----- b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAA…')
    expect(cut).toContain('‹private-key›')
    expect(cut).not.toContain('b3BlbnNz')
  })
})

describe('scrubStr masks the hosted-service tokens the repo hygiene check already knows', () => {
  it('gitlab, hugging face, sendgrid, digitalocean', () => {
    expect(scrubStr('glpat' + '-abcdefghijklmnopqrstuv')).toBe('‹gitlab-token›')
    expect(scrubStr('hf' + '_abcdefghijklmnopqrstuvwxyzABCDEFGH')).toBe('‹huggingface-token›')
    expect(scrubStr('SG.' + 'abcdefghijklmnopqrstuv' + '.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK')).toBe('‹sendgrid-key›')
    expect(scrubStr('dop_' + 'v1_' + 'a'.repeat(64))).toBe('‹digitalocean-token›')
  })
  it('an already masked value is not masked twice by the key=value rule', () => {
    expect(scrubStr('//registry.npmjs.org/:_authToken=npm' + '_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('//registry.npmjs.org/:_authToken=‹npm-token›')
  })
  it('does not mask ordinary prose that merely contains the keyword', () => {
    expect(scrubStr('total tokens: 1234567 across 3 turns')).toBe('total tokens: 1234567 across 3 turns')
    expect(scrubStr('the author: someone wrote this')).toBe('the author: someone wrote this')
  })
})
