/**
 * Golden fixture corpus. Every fixture is fully synthetic (SessionBuilder) and
 * deterministic: the pipeline resets the id counter, analyzes with version 'golden' / now 0,
 * and masks the two clock fields, so the serialized Analysis is byte-stable across runs.
 *
 * Shared by scripts/golden-update.ts (writes test/golden/) and test/golden.test.ts (compares).
 */
import { SessionBuilder, buildCanonicalSession, fakeToolUseId, resetIds } from './session-builder.js'
import { parseClaudeCodeSession, type ParseInput } from '../../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../../src/analyze/analyze.js'
import { aggregate, type Aggregate } from '../../src/analyze/aggregate.js'
import type { Analysis } from '../../src/model/analysis.js'

function agentsHeavy(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', startAt: '2026-08-15T09:00:00.000Z' })
  b.userPrompt('Fan out: review, test, docs — in parallel')
  b.tick(1000)
  // a parallel tool_use group: three Agent calls in ONE assistant message (one provider message id)
  const ids = [fakeToolUseId(), fakeToolUseId(), fakeToolUseId()]
  b.assistant(
    ids.map((id, i) => ({ type: 'tool_use' as const, id, name: 'Agent', input: { description: `task ${i}`, prompt: `do task ${i}`, subagent_type: 'general-purpose' } })),
    { usage: { input_tokens: 10, cache_read_input_tokens: 8000, output_tokens: 200 } },
  )
  ids.forEach((id, i) => {
    const agentId = `par${i}0000000000000`.slice(0, 16)
    b.sidechain(agentId)
    b.tick(200)
    b.userPrompt(`do task ${i}`)
    b.tick(500)
    b.assistant([{ type: 'text', text: `working on ${i}` }], { model: 'claude-sonnet-5', usage: { input_tokens: 900 + i, output_tokens: 40 } })
    b.toolCall('Read', { file_path: `/Users/test/Code/demo/src/f${i}.ts` }, 'content', { durationMs: 100, usage: { input_tokens: 950 + i, output_tokens: 30 } })
    b.assistant([{ type: 'text', text: `done ${i}` }], { model: 'claude-sonnet-5', usage: { input_tokens: 1000 + i, output_tokens: 25 } })
    b.sidechain('', false)
    b.tick(150)
    b.toolResult(id, `done ${i}`, {
      toolUseResult: { status: 'completed', agentId, content: [{ type: 'text', text: `done ${i}` }], totalDurationMs: 950, totalTokens: 2000 + i, totalToolUseCount: 1 },
    })
  })
  // four sequential agents, one per specialty
  for (let i = 0; i < 4; i++) {
    const agentId = `seq${i}000000000000`.slice(0, 16)
    const tid = b.toolCall('Agent', { description: `seq ${i}`, prompt: `sequential task ${i}`, subagent_type: i % 2 ? 'code-reviewer' : 'test-writer', name: i === 3 ? 'teammate-rev' : undefined }, 'ok', {
      durationMs: 300,
      usage: { input_tokens: 5, cache_read_input_tokens: 8200 + i, output_tokens: 60 },
      toolUseResult: { status: 'completed', agentId, content: [{ type: 'text', text: 'ok' }], totalDurationMs: 1200 + i, totalTokens: 3000 + i, totalToolUseCount: 2 },
    })
    void tid
    b.sidechain(agentId)
    b.tick(100)
    b.userPrompt(`sequential task ${i}`)
    b.tick(400)
    b.assistant([{ type: 'text', text: `seq ${i} done` }], { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 700 + i, output_tokens: 35 } })
    b.sidechain('', false)
    b.tick(100)
  }
  // a teammate-style link: a tool result carrying name/team but no agentId
  const tmId = fakeToolUseId()
  b.assistant([{ type: 'tool_use', id: tmId, name: 'Agent', input: { description: 'teammate review', prompt: 'review as teammate', name: 'teammate-rev', team_name: 'core' } }], {
    usage: { input_tokens: 4, cache_read_input_tokens: 8600, output_tokens: 45 },
  })
  b.tick(600)
  b.toolResult(tmId, 'teammate says fine', {
    toolUseResult: { status: 'completed', name: 'teammate-rev', team_name: 'core', content: [{ type: 'text', text: 'fine' }], totalDurationMs: 580, totalTokens: 1500, totalToolUseCount: 0 },
  })
  // an orphan sidechain agent: transcript records with no spawning tool call (workflow-style)
  b.sidechain('orphanworkflow00')
  b.tick(100)
  b.userPrompt('background chore')
  b.tick(300)
  b.assistant([{ type: 'text', text: 'chore done' }], { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 400, output_tokens: 20 } })
  b.sidechain('', false)
  b.tick(100)
  b.assistant([{ type: 'text', text: 'All eight helpers finished.' }], { usage: { input_tokens: 3, cache_read_input_tokens: 8800, output_tokens: 50 } })
  b.turnDuration(9000, 30)
  return b
}

function compactions(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'cccccccc-0000-4000-8000-000000000003', startAt: '2026-08-16T14:00:00.000Z' })
  b.userPrompt('Long refactor session')
  for (let i = 0; i < 6; i++) {
    b.tick(2000)
    b.assistant([{ type: 'text', text: `step ${i}` }], { usage: { input_tokens: 5, cache_read_input_tokens: 30_000 + i * 25_000, cache_creation_input_tokens: 20_000, output_tokens: 300 } })
  }
  b.tick(500)
  b.system('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 165_000, postTokens: 22_000, durationMs: 1800 } })
  b.compactSummary('Summary of the first stretch of the refactor: moved modules, renamed types.')
  b.userPrompt('Continue the refactor')
  for (let i = 0; i < 5; i++) {
    b.tick(2500)
    b.assistant([{ type: 'text', text: `later step ${i}` }], { usage: { input_tokens: 4, cache_read_input_tokens: 24_000 + i * 30_000, cache_creation_input_tokens: 18_000, output_tokens: 250 } })
  }
  b.tick(400)
  b.system('compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 172_000, postTokens: 19_000, durationMs: 1500 } })
  b.compactSummary('Second summary: tests updated, API stable.')
  b.userPrompt('Wrap up')
  b.tick(1200)
  b.assistant([{ type: 'text', text: 'Refactor complete.' }], { usage: { input_tokens: 3, cache_read_input_tokens: 21_000, output_tokens: 90 } })
  b.turnDuration(4000, 3)
  return b
}

function errorsAndInterrupts(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'dddddddd-0000-4000-8000-000000000004', startAt: '2026-08-17T08:30:00.000Z' })
  b.userPrompt('Run the flaky suite')
  b.tick(800)
  b.toolCall('Bash', { command: 'npm test', description: 'Run tests' }, 'Error: ETIMEDOUT connecting to db', { durationMs: 30_000, isError: true, usage: { input_tokens: 4, cache_read_input_tokens: 9000, output_tokens: 70 } })
  b.toolCall('Bash', { command: 'npm test', description: 'Run tests again' }, 'Error: ETIMEDOUT connecting to db', { durationMs: 30_000, isError: true, usage: { input_tokens: 3, cache_read_input_tokens: 9200, output_tokens: 65 } })
  b.system('api_error', { level: 'error' })
  b.tick(2000)
  b.assistant([{ type: 'text', text: 'The suite keeps timing out on the db connection.' }], { usage: { input_tokens: 3, cache_read_input_tokens: 9400, output_tokens: 55 } })
  b.turnDuration(65_000, 7)
  // an interrupted turn
  b.tick(30_000)
  b.userPrompt('Try mocking the db instead')
  b.tick(600)
  b.assistant([{ type: 'text', text: 'Starting the mock…' }], { usage: { input_tokens: 3, cache_read_input_tokens: 9600, output_tokens: 40 } })
  b.tick(900)
  b.userPrompt('[Request interrupted by user]')
  b.tick(5_000)
  b.userPrompt('Actually, just skip that test for now')
  b.tick(700)
  const eid = b.toolCall('Edit', { file_path: '/Users/test/Code/demo/src/db.test.ts', old_string: 'it(', new_string: 'it.skip(' }, 'The file has been updated.', {
    durationMs: 80,
    usage: { input_tokens: 2, cache_read_input_tokens: 9800, output_tokens: 45 },
    toolUseResult: { filePath: '/Users/test/Code/demo/src/db.test.ts', oldString: 'it(', newString: 'it.skip(', replaceAll: false },
  })
  void eid
  b.assistant([{ type: 'text', text: 'Skipped the flaky test.' }], { usage: { input_tokens: 2, cache_read_input_tokens: 9900, output_tokens: 30 } })
  b.turnDuration(2_000, 4)
  return b
}

function hooksAndSkills(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'eeeeeeee-0000-4000-8000-000000000005', startAt: '2026-08-18T11:00:00.000Z' })
  b.attachmentHook('SessionStart:startup', 'SessionStart', 'env ready')
  // skill via command
  b.userPrompt('<command-name>/deploy</command-name><command-message>deploy</command-message><command-args>staging</command-args>')
  b.tick(900)
  b.assistant([{ type: 'text', text: 'Deploying to staging.' }], { usage: { input_tokens: 5, cache_read_input_tokens: 7000, output_tokens: 60 } })
  b.toolCall('Bash', { command: './scripts/deploy.sh staging', description: 'Deploy' }, 'deployed rev abc123', { durationMs: 8000, usage: { input_tokens: 3, cache_read_input_tokens: 7100, output_tokens: 40 } })
  b.system('stop_hook_summary', {
    hookCount: 2,
    hookInfos: [{ command: 'notify.sh', durationMs: 200 }],
    hookErrors: [{ command: 'lint-gate.sh' }],
    hookAdditionalContext: [],
    preventedContinuation: false,
    stopReason: '',
    hasOutput: false,
  })
  b.turnDuration(10_000, 5)
  // skill via tool
  b.tick(20_000)
  b.userPrompt('Use the changelog skill to draft notes')
  b.tick(700)
  b.toolCall('Skill', { skill: 'changelog', args: 'v0.2' }, 'Loaded skill changelog', { durationMs: 300, usage: { input_tokens: 4, cache_read_input_tokens: 7300, output_tokens: 50 } })
  b.assistant([{ type: 'text', text: 'Draft written.' }], { usage: { input_tokens: 3, cache_read_input_tokens: 7400, output_tokens: 80 } })
  b.turnDuration(3_000, 4)
  return b
}

function livePartial(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'ffffffff-0000-4000-8000-000000000006', startAt: '2026-08-19T16:45:00.000Z' })
  // the redaction fixture: a planted secret + an email in the prompt text
  b.userPrompt('My key is sk-ant-api03-FAKEFAKEFAKEFAKE and my mail is dev@example.com — wire the client')
  b.tick(1100)
  b.assistant([{ type: 'text', text: 'Wiring the client now (redacting your key).' }], { usage: { input_tokens: 6, cache_read_input_tokens: 5000, output_tokens: 70 } })
  b.toolCall('Write', { file_path: '/Users/test/Code/demo/src/client.ts', content: 'export const client = 1' }, 'File created', {
    durationMs: 90,
    usage: { input_tokens: 3, cache_read_input_tokens: 5100, output_tokens: 45 },
    toolUseResult: { type: 'create', filePath: '/Users/test/Code/demo/src/client.ts', content: 'export const client = 1' },
  })
  b.assistant([{ type: 'text', text: 'Still working…' }], { usage: { input_tokens: 2, cache_read_input_tokens: 5200, output_tokens: 20 } })
  return b
}

function singlePrompt(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'abababab-0000-4000-8000-000000000007', startAt: '2026-08-20T10:15:00.000Z' })
  b.userPrompt('What does this repo do?')
  b.tick(1400)
  b.assistant([{ type: 'text', text: 'It is a deterministic session analyzer for Claude Code transcripts.' }], { usage: { input_tokens: 12, cache_creation_input_tokens: 4000, output_tokens: 140 } })
  b.turnDuration(1_500, 2)
  return b
}

export const GOLDEN_FIXTURES: Array<{ name: string; build: () => SessionBuilder; parseExtra?: Partial<ParseInput> }> = [
  { name: 'canonical', build: buildCanonicalSession },
  { name: 'agents-heavy', build: agentsHeavy },
  { name: 'compactions', build: compactions },
  { name: 'errors-and-interrupts', build: errorsAndInterrupts },
  { name: 'hooks-and-skills', build: hooksAndSkills },
  // trailing partial last line → possiblyLive (the tail/serve fixture)
  { name: 'live-partial', build: livePartial, parseExtra: { trailingPartial: true } },
  { name: 'single-prompt', build: singlePrompt },
]

/** The exact pipeline both the update script and the golden test run. */
export async function goldenAnalysis(fx: { name: string; build: () => SessionBuilder; parseExtra?: Partial<ParseInput> }): Promise<Analysis> {
  resetIds()
  const b = fx.build()
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true, ...(fx.parseExtra ?? {}) })
  const a = analyzeSession(s, { version: 'golden', now: 0 })
  a.generator.generatedAt = 0
  a.parse.parseMs = 0
  return a
}

export async function goldenCorpus(): Promise<{ files: Array<{ name: string; json: string }>; aggregateJson: string }> {
  const analyses: Analysis[] = []
  const files: Array<{ name: string; json: string }> = []
  for (const fx of GOLDEN_FIXTURES) {
    const a = await goldenAnalysis(fx)
    analyses.push(a)
    files.push({ name: fx.name, json: JSON.stringify(a, null, 2) + '\n' })
  }
  const agg: Aggregate = aggregate(analyses, 'golden', 0)
  return { files, aggregateJson: JSON.stringify(agg, null, 2) + '\n' }
}
