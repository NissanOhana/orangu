/**
 * Crosswalk tests. The session side is built with `SessionBuilder` → `parseClaudeCodeSession` →
 * `analyzeSession` (the real pipeline, synthetic input); the config side is a hand-built inventory.
 * Nothing here touches the filesystem, a clock or a network.
 */
import { describe, it, expect } from 'vitest'
import type { Analysis } from '../model/analysis.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { aggregate } from '../analyze/aggregate.js'
import { SessionBuilder, resetIds } from '../../test/fixtures/session-builder.js'
import { crosswalk } from './crosswalk.js'
import { HARNESS_ROW_CAP } from './types.js'
import type { HarnessAgentEntry, HarnessInventory, HarnessMcpServerEntry, HarnessSettingsFile, HarnessSkillEntry } from './types.js'

const emptyInventory = (over: Partial<HarnessInventory> = {}): HarnessInventory => ({
  claudeMd: [],
  settings: [],
  skills: [],
  agents: [],
  plugins: [],
  mcpServers: [],
  totals: { filesRead: 0, bytesRead: 0, claudeMdBytes: 0, claudeMdApproxTokens: 0, skills: 0, agents: 0, plugins: 0, mcpServers: 0, hookCommands: 0 },
  unreadable: [],
  ...over,
})

const skillEntry = (name: string): HarnessSkillEntry => ({
  name,
  origin: 'global',
  file: `~/.claude/skills/${name}/SKILL.md`,
  bytes: 400,
  approxTokens: 100,
  descriptionChars: 40,
  allowedTools: null,
  bodyLines: 10,
  hasReferences: false,
})

const agentEntry = (name: string): HarnessAgentEntry => ({
  name,
  origin: 'repo',
  file: `.claude/agents/${name}.md`,
  bytes: 400,
  approxTokens: 100,
  descriptionChars: 40,
  tools: null,
  disallowedTools: null,
})

const mcpEntry = (name: string): HarnessMcpServerEntry => ({ name, scope: 'global', transport: 'stdio', enabled: true })

const settingsEntry = (over: Partial<HarnessSettingsFile> = {}): HarnessSettingsFile => ({
  scope: 'global',
  file: '~/.claude/settings.json',
  keys: [],
  permissions: { allow: 0, deny: 0, ask: 0 },
  hooks: [],
  env: { count: 0, names: [] },
  statusLine: false,
  enabledPlugins: [],
  ...over,
})

/** one analysis from a builder, through the real parse+analyze path */
async function analyze(b: SessionBuilder): Promise<Analysis> {
  return analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }), { version: 't', now: 0 })
}

/** a session that invokes a skill via the Skill tool, calls an MCP tool, dispatches an agent and runs a hook */
function busySession(startAt = '2026-08-14T10:00:00.000Z'): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000001', startAt, effort: 'high' })
  b.userPrompt('do the thing')
  b.toolCall('Skill', { skill: 'used-skill' }, 'ok')
  b.toolCall('mcp__octocode__githubSearchCode', { q: 'x' }, 'ok')
  b.toolCall('mcp__octocode__githubGetFileContent', { p: 'y' }, 'ok')
  b.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 300 }])
  b.turnDuration(4000, 6)
  return b
}

describe('crosswalk: skills', () => {
  it('classifies an invoked skill used, an installed-but-never-invoked skill idle, and an unlisted one undeclared', async () => {
    resetIds()
    const a = await analyze(busySession())
    const inv = emptyInventory({ skills: [skillEntry('used-skill'), skillEntry('never-fired')] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))

    const used = x.skills.find((s) => s.name === 'used-skill')!
    expect(used.status).toBe('used')
    expect(used.installed).toBe(true)
    expect(used.invocations).toBe(1)
    expect(used.sessions).toBe(1)
    expect(used.viaTool + used.viaCommand).toBe(1)

    const idle = x.skills.find((s) => s.name === 'never-fired')!
    expect(idle.status).toBe('idle')
    expect(idle.invocations).toBe(0)
    expect(idle.origin).toBe('global')
  })

  it('credits a plugin-qualified invocation to the installed skill, as ONE row (not idle + undeclared)', async () => {
    // Claude Code reports the invocation as `<plugin>:<skill>`; the inventory holds the bare name.
    // Keying the row on the raw string split one skill into two contradictory rows.
    resetIds()
    const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-0000000000q1'.replace('q1', '11'), startAt: '2026-08-14T10:00:00.000Z' })
    b.userPrompt('go')
    b.toolCall('Skill', { skill: 'superpowers:brainstorming' }, 'ok')
    const a = await analyze(b)
    // the inventory records the marketplace-qualified key, as `collect.ts` reads it from installed_plugins.json
    const inv = emptyInventory({ skills: [{ ...skillEntry('brainstorming'), origin: 'plugin', plugin: 'superpowers@superpowers-marketplace' }] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))
    const rows = x.skills.filter((r) => r.name === 'brainstorming' || r.name === 'superpowers:brainstorming')
    expect(rows.length, 'one skill is one row').toBe(1)
    expect(rows[0]!.installed).toBe(true)
    expect(rows[0]!.invocations).toBe(1)
    expect(rows[0]!.status).toBe('used')
  })

  it('keeps a qualified invocation undeclared when no installed skill has that bare name', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000012', startAt: '2026-08-14T10:00:00.000Z' })
    b.userPrompt('go')
    b.toolCall('Skill', { skill: 'other-plugin:not-installed' }, 'ok')
    const a = await analyze(b)
    const x = crosswalk(emptyInventory({ skills: [skillEntry('brainstorming')] }), [a], aggregate([a], 'test', 0))
    const row = x.skills.find((s) => s.name === 'other-plugin:not-installed')!
    expect(row.status).toBe('undeclared')
    expect(x.skills.find((s) => s.name === 'brainstorming')!.status).toBe('idle')
  })

  it('marks a skill observed in sessions but absent from every config as undeclared', async () => {
    resetIds()
    const a = await analyze(busySession())
    const x = crosswalk(emptyInventory(), [a], aggregate([a], 'test', 0))
    const row = x.skills.find((s) => s.name === 'used-skill')!
    expect(row.status).toBe('undeclared')
    expect(row.installed).toBe(false)
    expect(row.invocations).toBe(1)
  })
})

describe('crosswalk: mcp servers', () => {
  it('joins configured servers against mcp__<server>__<tool> calls and counts distinct tools', async () => {
    resetIds()
    const a = await analyze(busySession())
    const inv = emptyInventory({ mcpServers: [mcpEntry('octocode'), mcpEntry('figma')] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))

    const oct = x.mcpServers.find((m) => m.name === 'octocode')!
    expect(oct.status).toBe('used')
    expect(oct.configured).toBe(true)
    expect(oct.toolCalls).toBe(2)
    expect(oct.distinctTools).toBe(2)
    expect(oct.sessions).toBe(1)

    expect(x.mcpServers.find((m) => m.name === 'figma')!.status).toBe('idle')
  })

  it('marks an mcp server whose tools were called but which no config declares as undeclared', async () => {
    resetIds()
    const a = await analyze(busySession())
    const x = crosswalk(emptyInventory(), [a], aggregate([a], 'test', 0))
    expect(x.mcpServers.find((m) => m.name === 'octocode')!.status).toBe('undeclared')
  })
})

describe('crosswalk: agents', () => {
  it('classifies a dispatched agent used and a defined-but-never-dispatched agent idle', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'cccccccc-0000-4000-8000-000000000001' })
    b.userPrompt('review it')
    const id = b.toolCall('Agent', { description: 'Review', prompt: 'go', subagent_type: 'code-reviewer' }, 'LGTM', {
      toolUseResult: { status: 'completed', agentId: 'agent0001', content: [{ type: 'text', text: 'LGTM' }], totalDurationMs: 10, totalTokens: 5, totalToolUseCount: 0, usage: { input_tokens: 5, output_tokens: 1 } },
    })
    expect(id).toBeTruthy()
    resetIds()
    const a = await analyze(b)
    const inv = emptyInventory({ agents: [agentEntry('code-reviewer'), agentEntry('unused-agent')] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))

    const used = x.agents.find((g) => g.name === 'code-reviewer')!
    expect(used.status).toBe('used')
    expect(used.defined).toBe(true)
    expect(used.dispatches).toBeGreaterThanOrEqual(1)
    expect(used.sessions).toBe(1)

    const idle = x.agents.find((g) => g.name === 'unused-agent')!
    expect(idle.status).toBe('idle')
    expect(idle.dispatches).toBe(0)
    expect(idle.models).toEqual([])
  })
})

describe('crosswalk: hooks', () => {
  it('joins a configured hook command against its runs, errors and timing', async () => {
    resetIds()
    const a = await analyze(busySession())
    const inv = emptyInventory({
      settings: [settingsEntry({ hooks: [{ event: 'Stop', matchers: 1, commands: 1, commandBasenames: ['notify.sh'] }, { event: 'PreToolUse', matchers: 1, commands: 1, commandBasenames: ['guard.sh'] }] })],
    })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))

    const run = x.hooks.find((h) => h.commandBasename === 'notify.sh')!
    expect(run.status).toBe('used')
    expect(run.configured).toBe(true)
    expect(run.runs).toBe(1)
    expect(run.errors).toBe(0)
    expect(run.totalMs).toBe(300)
    expect(run.meanMs).toBe(300)

    const idle = x.hooks.find((h) => h.commandBasename === 'guard.sh')!
    expect(idle.status).toBe('idle')
    expect(idle.runs).toBe(0)
    expect(idle.meanMs).toBe(0)
    expect(idle.event).toBe('PreToolUse')
  })

  it('meanMs is exactly total ms over total runs, pooled across sessions', async () => {
    // two sessions, 3 runs of the same hook, 300 + 300 + 900 ms → 1500 / 3 = 500
    resetIds()
    const one = new SessionBuilder({ sessionId: '11111111-0000-4000-8000-000000000001' })
    one.userPrompt('a')
    one.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 300 }])
    one.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 300 }])
    const a1 = await analyze(one)
    resetIds()
    const two = new SessionBuilder({ sessionId: '22222222-0000-4000-8000-000000000001' })
    two.userPrompt('b')
    two.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 900 }])
    const a2 = await analyze(two)

    const x = crosswalk(emptyInventory(), [a1, a2], aggregate([a1, a2], 'test', 0))
    const row = x.hooks.find((h) => h.commandBasename === 'notify.sh')!
    expect(row.runs).toBe(3)
    expect(row.totalMs).toBe(1500)
    expect(row.meanMs).toBe(500)
    expect(row.meanMs).toBe(Math.round(row.totalMs / row.runs))
  })
})

describe('crosswalk: models, effort, permissions', () => {
  it('compares the configured model and effort against what the sessions actually show', async () => {
    resetIds()
    const a = await analyze(busySession())
    const inv = emptyInventory({ settings: [settingsEntry({ model: 'claude-opus-5', effortLevel: 'low' })] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))

    expect(x.models.configured).toBe('claude-opus-5')
    expect(x.models.seen.length).toBeGreaterThan(0)
    expect(x.models.seen[0]!.requests).toBeGreaterThan(0)
    expect(x.models.matchesConfigured).toBe(true)

    expect(x.effort.configured).toBe('low')
    expect(x.effort.seen.map((e) => e.effort)).toContain('high')
    expect(x.effort.matchesConfigured).toBe(false)
  })

  // `model` in settings.json may carry a context-window tag that sessions do not report. The tag is
  // configuration metadata, not part of the model identity used for drift detection.
  it('ignores a context-window tag on the configured model', async () => {
    resetIds()
    const a = await analyze(busySession())
    const seen = crosswalk(emptyInventory(), [a], aggregate([a], 'test', 0)).models.seen[0]!.model
    const inv = emptyInventory({ settings: [settingsEntry({ model: `${seen}[1m]` })] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))
    expect(x.models.configured, 'the tag is preserved verbatim in the report').toBe(`${seen}[1m]`)
    expect(x.models.matchesConfigured, 'a [1m] tag is not model drift').toBe(true)
  })

  // Effort is a closed enum (low|medium|high|xhigh|max), so matching requires equality rather than
  // substring containment.
  it('reports effort drift when the configured level is a substring of the observed one', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: '66666666-0000-4000-8000-000000000001', effort: 'xhigh' })
    b.userPrompt('go')
    b.assistant([{ type: 'text', text: 'ok' }], { effort: 'xhigh' })
    const a = await analyze(b)
    const inv = emptyInventory({ settings: [settingsEntry({ effortLevel: 'high' })] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))
    expect(x.effort.seen.map((e) => e.effort)).toContain('xhigh')
    expect(x.effort.configured).toBe('high')
    expect(x.effort.matchesConfigured).toBe(false)
  })

  it('matches effort only on exact value, ignoring case and surrounding space', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: '65666666-0000-4000-8000-000000000001', effort: 'high' })
    b.userPrompt('go')
    b.assistant([{ type: 'text', text: 'ok' }], { effort: 'high' })
    const a = await analyze(b)
    const inv = emptyInventory({ settings: [settingsEntry({ effortLevel: 'High' })] })
    expect(crosswalk(inv, [a], aggregate([a], 'test', 0)).effort.matchesConfigured).toBe(true)
  })

  it('matches a configured model family alias but not a different model version', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: '64666666-0000-4000-8000-000000000001', model: 'claude-opus-5' })
    b.userPrompt('go')
    b.assistant([{ type: 'text', text: 'ok' }])
    const a = await analyze(b)
    const agg1 = aggregate([a], 'test', 0)
    // the documented short alias resolves to the family segment of the id
    expect(crosswalk(emptyInventory({ settings: [settingsEntry({ model: 'opus' })] }), [a], agg1).models.matchesConfigured).toBe(true)
    // a different family is drift
    expect(crosswalk(emptyInventory({ settings: [settingsEntry({ model: 'sonnet' })] }), [a], agg1).models.matchesConfigured).toBe(false)
    // a different VERSION of the same family is drift too — containment must not hide it
    expect(crosswalk(emptyInventory({ settings: [settingsEntry({ model: 'claude-opus-4-5' })] }), [a], agg1).models.matchesConfigured).toBe(false)
    expect(crosswalk(emptyInventory({ settings: [settingsEntry({ model: 'claude-opus-5' })] }), [a], agg1).models.matchesConfigured).toBe(true)
  })

  it('counts /effort slash commands and permission prompt events', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'dddddddd-0000-4000-8000-000000000001' })
    // the real shape a slash command takes in a transcript (parse.ts COMMAND_RE)
    b.userPrompt('<command-name>/effort</command-name>\n<command-args>max</command-args>')
    b.assistant([{ type: 'text', text: 'ok' }])
    b.userPrompt('<command-name>/effort</command-name>\n<command-args>high</command-args>')
    b.assistant([{ type: 'text', text: 'ok' }])
    const a = await analyze(b)
    const inv = emptyInventory({ settings: [settingsEntry({ permissions: { allow: 12, deny: 2, ask: 1, defaultMode: 'acceptEdits' } })] })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))

    expect(x.effort.slashEffortCommands).toBe(2)
    expect(x.permissions.allowRules).toBe(12)
    expect(x.permissions.denyRules).toBe(2)
    expect(x.permissions.askRules).toBe(1)
    expect(x.permissions.defaultMode).toBe('acceptEdits')
    expect(x.permissions.promptEvents).toBeGreaterThanOrEqual(0)
  })
})

describe('crosswalk: memory files and injected listings', () => {
  it('multiplies CLAUDE.md weight by how often the sessions re-read it', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'eeeeeeee-0000-4000-8000-000000000001', cwd: '/repo' })
    b.userPrompt('read it')
    for (let i = 0; i < 4; i++) b.toolCall('Read', { file_path: '/repo/CLAUDE.md' }, 'contents')
    const a = await analyze(b)
    const inv = emptyInventory({
      claudeMd: [{ scope: 'repo', file: '/repo/CLAUDE.md', bytes: 4000, approxTokens: 1000, lines: 120, headings: 9 }],
      totals: { ...emptyInventory().totals, claudeMdBytes: 4000, claudeMdApproxTokens: 1000 },
    })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))
    const row = x.claudeMd[0]!
    expect(row.bytes).toBe(4000)
    expect(row.reads).toBe(4)
    expect(row.sessions).toBe(1)
    expect(row.approxTokensCarried).toBe(4000)
  })

  // FileStat.path is cwd-stripped, so a repo CLAUDE.md may arrive as the bare string "CLAUDE.md".
  // The join must preserve scope instead of matching every inventory path with that suffix.
  it('never credits a global CLAUDE.md with reads of the repo CLAUDE.md', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: '77777777-0000-4000-8000-000000000001', cwd: '/repo' })
    b.userPrompt('read it')
    for (let i = 0; i < 40; i++) b.toolCall('Read', { file_path: '/repo/CLAUDE.md' }, 'contents')
    const a = await analyze(b)
    const inv = emptyInventory({
      claudeMd: [
        { scope: 'global', file: '~/.claude/CLAUDE.md', bytes: 40_000, approxTokens: 10_000, lines: 900, headings: 40 },
        { scope: 'repo', file: '/repo/CLAUDE.md', bytes: 4_000, approxTokens: 1_000, lines: 120, headings: 9 },
      ],
    })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0), { home: '/home/dev' })

    const globalRow = x.claudeMd.find((c) => c.file === '~/.claude/CLAUDE.md')!
    expect(globalRow.reads).toBe(0)
    expect(globalRow.sessions).toBe(0)
    expect(globalRow.approxTokensCarried).toBe(0)

    const repoRow = x.claudeMd.find((c) => c.file === '/repo/CLAUDE.md')!
    expect(repoRow.reads).toBe(40)
    expect(repoRow.sessions).toBe(1)
    expect(repoRow.approxTokensCarried).toBe(40_000)

    // the real row, not the phantom, is what the ranking puts first
    expect(x.claudeMd[0]!.file).toBe('/repo/CLAUDE.md')
  })

  it('matches a ~-relativized inventory path against an absolute session read when home is known', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: '88888888-0000-4000-8000-000000000001', cwd: '/repo' })
    b.userPrompt('read the global memory file')
    b.toolCall('Read', { file_path: '/home/dev/.claude/CLAUDE.md' }, 'contents')
    const a = await analyze(b)
    const inv = emptyInventory({
      claudeMd: [{ scope: 'global', file: '~/.claude/CLAUDE.md', bytes: 800, approxTokens: 200, lines: 20, headings: 3 }],
    })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0), { home: '/home/dev' })
    expect(x.claudeMd[0]!.reads).toBe(1)
    expect(x.claudeMd[0]!.approxTokensCarried).toBe(200)
  })

  it('reports injected listing weight per attachment type from parse.attachmentBytes', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'ffffffff-0000-4000-8000-000000000001' })
    b.userPrompt('hi')
    b.attachment('skill_listing', { content: 'x'.repeat(2000) })
    b.attachment('agent_listing', { content: 'y'.repeat(400) })
    const a = await analyze(b)
    const x = crosswalk(emptyInventory(), [a], aggregate([a], 'test', 0))
    const skillListing = x.injectedListings.find((l) => l.type === 'skill_listing')
    expect(skillListing).toBeDefined()
    expect(skillListing!.bytes).toBeGreaterThan(0)
    expect(skillListing!.sessions).toBe(1)
    expect(skillListing!.approxTokens).toBe(Math.ceil(skillListing!.bytes / 4))
    expect(skillListing!.approxTokensPerSession).toBe(Math.ceil(skillListing!.approxTokens / 1))
  })
})

describe('crosswalk: window and bounds', () => {
  it('derives the window from session startedAt, never from the clock', async () => {
    resetIds()
    const a1 = await analyze(busySession('2026-08-10T08:00:00.000Z'))
    resetIds()
    const a2 = await analyze(busySession('2026-08-14T10:00:00.000Z'))
    const x = crosswalk(emptyInventory(), [a1, a2], aggregate([a1, a2], 'test', 0))
    expect(x.window.firstStartedAt).toBe(Date.parse('2026-08-10T08:00:00.000Z'))
    expect(x.window.lastStartedAt).toBe(Date.parse('2026-08-14T10:00:00.000Z'))
  })

  it('caps every array at 50 rows after an explicit sort', async () => {
    resetIds()
    const a = await analyze(busySession())
    const many = Array.from({ length: 120 }, (_, i) => `skill-${String(i).padStart(3, '0')}`)
    const inv = emptyInventory({
      skills: many.map(skillEntry),
      agents: many.map(agentEntry),
      mcpServers: many.map(mcpEntry),
      claudeMd: many.map((n, i) => ({ scope: 'repo' as const, file: `/repo/${n}.md`, bytes: 100 + i, approxTokens: 25, lines: 3, headings: 1 })),
      settings: [settingsEntry({ hooks: many.map((n) => ({ event: 'Stop', matchers: 1, commands: 1, commandBasenames: [`${n}.sh`] })) })],
    })
    const x = crosswalk(inv, [a], aggregate([a], 'test', 0))
    expect(HARNESS_ROW_CAP).toBe(50)
    expect(x.skills).toHaveLength(50)
    expect(x.agents).toHaveLength(50)
    expect(x.mcpServers).toHaveLength(50)
    expect(x.hooks).toHaveLength(50)
    expect(x.claudeMd).toHaveLength(50)
    // observed rows outrank never-observed ones, so the used skill survives the cap
    expect(x.skills[0]!.name).toBe('used-skill')
  })

  // These arrays share the same comparator-then-slice path and must observe the same cap.
  it('caps injectedListings, models.seen and effort.seen at 50 as well', async () => {
    const analyses = []
    for (let i = 0; i < 60; i++) {
      resetIds()
      const b = new SessionBuilder({
        sessionId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001`,
        model: `claude-model-${String(i).padStart(3, '0')}`,
        effort: `effort-${String(i).padStart(3, '0')}`,
      })
      b.userPrompt('go')
      b.attachment(`listing_type_${String(i).padStart(3, '0')}`, { content: 'x'.repeat(100) })
      b.assistant([{ type: 'text', text: 'ok' }])
      analyses.push(await analyze(b))
    }
    const x = crosswalk(emptyInventory(), analyses, aggregate(analyses, 'test', 0))
    expect(x.injectedListings.length).toBeLessThanOrEqual(HARNESS_ROW_CAP)
    expect(x.models.seen.length).toBeLessThanOrEqual(HARNESS_ROW_CAP)
    expect(x.effort.seen.length).toBeLessThanOrEqual(HARNESS_ROW_CAP)
    expect(x.effort.seen.length).toBe(HARNESS_ROW_CAP)
  })

  it('is a pure function: two calls on the same inputs serialize identically', async () => {
    resetIds()
    const a = await analyze(busySession())
    const inv = emptyInventory({ skills: [skillEntry('used-skill'), skillEntry('never-fired')], mcpServers: [mcpEntry('octocode')] })
    const agg = aggregate([a], 'test', 0)
    expect(JSON.stringify(crosswalk(inv, [a], agg))).toBe(JSON.stringify(crosswalk(inv, [a], agg)))
  })
})
