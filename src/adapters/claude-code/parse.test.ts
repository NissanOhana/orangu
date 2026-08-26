import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from './parse.js'
import { buildCanonicalSession, SessionBuilder } from '../../../test/fixtures/session-builder.js'

async function canonical() {
  const b = buildCanonicalSession()
  return parseClaudeCodeSession({ records: b.toRecords(), path: '/tmp/x/' + b.sessionId + '.jsonl', noSidecar: true })
}

describe('parseClaudeCodeSession (canonical fixture)', () => {
  it('segments turns on human prompts only (tool_result carriers and sidechain prompts do not start turns)', async () => {
    const s = await canonical()
    expect(s.turns.length).toBe(2)
    expect(s.turns[0]!.promptPreview).toBe('Fix the failing test in src/foo.ts')
    expect(s.turns[1]!.promptPreview).toBe('Now review the diff with a subagent')
  })

  it('pairs tool_use with tool_result, computes duration, bytes, and errors', async () => {
    const s = await canonical()
    const main = s.toolCalls.filter((c) => !c.agentId)
    expect(main.map((c) => c.name)).toEqual(['Read', 'Bash', 'Edit', 'Bash', 'Agent'])
    const failing = main[1]!
    expect(failing.isError).toBe(true)
    expect(failing.durationMs).toBe(4200)
    expect(failing.resultBytes).toBeGreaterThan(0)
    expect(failing.inputSummary).toBe('Bash Run tests')
    expect(main.every((c) => !c.unresolved)).toBe(true)
  })

  it('dedupes usage per provider message id and sums per turn', async () => {
    const s = await canonical()
    const t1 = s.turns[0]!
    // 6 counted assistant messages in turn 1: 40+60+55+80+50+30 output tokens
    expect(t1.usage.output).toBe(40 + 60 + 55 + 80 + 50 + 30)
    expect(t1.usage.cacheWrite).toBe(12_000 + 300 + 200 + 400 + 150 + 100)
    expect(s.usageEvents.filter((u) => !u.agentId).length).toBe(6 + 2)
  })

  it('links the Agent tool call to the sidechain agent run and aggregates its usage from the transcript', async () => {
    const s = await canonical()
    expect(s.agents.length).toBe(1)
    const a = s.agents[0]!
    expect(a.agentId).toBe('a1b2c3d4e5f60718')
    expect(a.agentType).toBe('code-reviewer')
    expect(a.model).toBe('claude-sonnet-5')
    expect(a.usage.output).toBe(200 + 150 + 60)
    expect(a.toolCallCount).toBe(1)
    expect(a.reportedTotalTokens).toBe(16_010)
    const agentCall = s.toolCalls.find((c) => c.name === 'Agent')!
    expect(agentCall.spawnedAgentId).toBe(a.agentId)
    expect(s.turns[1]!.agentIds).toEqual([a.agentId])
  })

  it('collects hooks, turn durations, human gaps, first-response latency, and title', async () => {
    const s = await canonical()
    expect(s.hooks.some((h) => h.hookEvent === 'SessionStart')).toBe(true)
    expect(s.hooks.some((h) => h.command === 'afplay done.mp3' && h.durationMs === 300)).toBe(true)
    expect(s.turns[0]!.reportedDurationMs).toBe(11_000)
    expect(s.turns[0]!.firstResponseMs).toBe(1500)
    expect(s.turns[1]!.humanGapMs).toBeGreaterThanOrEqual(120_000)
    expect(s.meta.title).toBe('Fix foo test')
    expect(s.meta.models.sort()).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(s.meta.effortLevels).toEqual(['high'])
  })

  it('reports counts and never throws on unknown record/block types', async () => {
    const b = new SessionBuilder()
    b.userPrompt('hi')
    b.push({ type: 'brand-new-record', foo: 1 })
    b.assistant([{ type: 'text', text: 'ok' }, { type: 'mystery_block' } as never])
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.parseReport.unknownRecordTypes['brand-new-record']).toBe(1)
    expect(s.parseReport.unknownBlockTypes['mystery_block']).toBe(1)
    expect(s.turns.length).toBe(1)
  })

  it('detects slash commands, compaction summaries, interruptions and API errors', async () => {
    const b = new SessionBuilder()
    b.userPrompt('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 12</command-args>')
    b.assistant([{ type: 'text', text: 'Reviewing' }])
    b.compactSummary('This session is being continued from a previous conversation...')
    b.userPrompt('[Request interrupted by user]')
    b.push({ ...b.toRecords()[1]!, uuid: 'err-1', type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } })
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.skills.map((k) => k.name)).toEqual(['/review'])
    expect(s.turns[0]!.isCommand).toBe(true)
    expect(s.compactions.length).toBe(1)
    expect(s.events.some((e) => e.kind === 'interrupt')).toBe(true)
    expect(s.events.some((e) => e.kind === 'api_error')).toBe(true)
    // synthetic error record must not count toward usage
    expect(s.usageEvents.every((u) => u.model !== '<synthetic>')).toBe(true)
  })

  it('handles string content, missing usage, missing timestamps without crashing', async () => {
    const recs = [
      { type: 'user', message: { role: 'user', content: 'plain string prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: 'plain string answer' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'orphan' }] } },
    ]
    const s = await parseClaudeCodeSession({ records: recs, noSidecar: true })
    expect(s.turns.length).toBe(1)
    expect(s.messages.length).toBe(3)
    expect(s.parseReport.warnings.find((w) => w.code === 'orphan_tool_result')?.count).toBe(1)
  })
})

describe('classifyPrompt / turn kinds', () => {
  it('starts turns only for human, command, peer and scheduled prompts; attaches notifications and local outputs', async () => {
    const b = new SessionBuilder()
    b.userPrompt('do the thing')
    b.assistant([{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'bg', prompt: 'x', run_in_background: true } }])
    b.toolResult('toolu_a', 'started')
    b.assistant([{ type: 'text', text: 'waiting' }])
    // injected notification (new-style origin field)
    b.push({ ...b.toRecords()[0]!, uuid: 'n1', message: { role: 'user', content: '<task-notification><task-id>x</task-id></task-notification>' }, origin: { kind: 'task-notification' }, promptSource: 'system' })
    b.assistant([{ type: 'text', text: 'done' }])
    // slash command (old style, no origin)
    b.userPrompt('<command-name>/compact</command-name>\n<command-message>compact</command-message>')
    b.push({ ...b.toRecords()[0]!, uuid: 'lo', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } })
    // peer message
    b.push({ ...b.toRecords()[0]!, uuid: 'p1', message: { role: 'user', content: 'Another Claude session sent a message: <teammate-message teammate_id="lead">go</teammate-message>' } })
    b.assistant([{ type: 'text', text: 'ok' }])
    // scheduled wake
    b.push({ ...b.toRecords()[0]!, uuid: 's1', isMeta: true, promptSource: 'system', message: { role: 'user', content: '# Autonomous loop check\nYou are being invoked on a timer' } })
    b.assistant([{ type: 'text', text: 'tick' }])
    // meta reminder only
    b.push({ ...b.toRecords()[0]!, uuid: 'm1', isMeta: true, message: { role: 'user', content: '<system-reminder>The user named this session "x"</system-reminder>' } })
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.turns.map((t) => t.kind)).toEqual(['human', 'command', 'peer', 'scheduled'])
    expect(s.turns[0]!.autoContinuations).toBe(1)
    expect(s.turns[1]!.autoContinuations).toBe(1)
    const kinds = s.messages.filter((m) => m.role === 'user' && !m.isToolResultCarrier).map((m) => m.promptKind)
    expect(kinds).toEqual(['human', 'notification', 'command', 'local_output', 'peer', 'scheduled', 'meta'])
  })
})

describe('additional adapter signals', () => {
  it('carries cache_miss_reason onto the counted usage event, deduped across chunks', async () => {
    const b = new SessionBuilder()
    b.userPrompt('go')
    // two chunks of one API response: diagnostics on the first (no stop_reason), usage counted from the second
    b.assistant([{ type: 'thinking', thinking: '' }], {
      messageId: 'msg_sharedchunks000000001',
      stopReason: null as unknown as string,
      diagnostics: { cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 133_306 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    b.assistant([{ type: 'text', text: 'done' }], {
      messageId: 'msg_sharedchunks000000001',
      stopReason: 'end_turn',
      usage: { input_tokens: 5, cache_creation_input_tokens: 133_306, output_tokens: 50 },
    })
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    const counted = s.usageEvents.filter((u) => !u.hiddenIteration)
    expect(counted).toHaveLength(1)
    expect(counted[0]!.cacheMissReason).toEqual({ type: 'tools_changed', missedInputTokens: 133_306 })
    expect(s.messages.filter((m) => m.cacheMissReason).length).toBe(1)
  })
  it('parses thinking tokens from usage.output_tokens_details', async () => {
    const b = new SessionBuilder()
    b.userPrompt('go')
    b.assistant([{ type: 'text', text: 'hi' }], { usage: { input_tokens: 2, output_tokens: 900, output_tokens_details: { thinking_tokens: 640 } } })
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.usageEvents[0]!.thinkingTokens).toBe(640)
  })
  it('marks a Read truncated when toolUseResult.file.truncatedByTokenCap is set', async () => {
    const b = new SessionBuilder()
    b.userPrompt('read the big file')
    b.toolCall('Read', { file_path: '/p/big.json' }, 'part of the file…', {
      toolUseResult: { type: 'text', file: { filePath: '/p/big.json', content: 'part', numLines: 400, truncatedByTokenCap: true } },
    })
    b.toolCall('Read', { file_path: '/p/ok.ts' }, 'all of it', {
      toolUseResult: { type: 'text', file: { filePath: '/p/ok.ts', content: 'all', numLines: 3 } },
    })
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.toolCalls[0]!.truncated).toBe(true)
    expect(s.toolCalls[1]!.truncated).toBeUndefined()
  })
  it('counts queue operations by kind and collects deferred tool names + attachment bytes', async () => {
    const b = new SessionBuilder()
    b.attachment('deferred_tools_delta', { addedNames: ['mcp__foo__click', 'WebFetch'], readdedNames: ['mcp__foo__type'], removedNames: [], addedLines: [] })
    b.userPrompt('go')
    b.queueOp('enqueue', 'next thing')
    b.queueOp('enqueue', 'another')
    b.queueOp('dequeue')
    b.queueOp('remove', 'another')
    b.assistant([{ type: 'text', text: 'ok' }])
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.meta.queueOperations).toEqual({ enqueue: 2, dequeue: 1, remove: 1 })
    expect(s.meta.deferredToolNames).toEqual(['WebFetch', 'mcp__foo__click', 'mcp__foo__type'])
    expect(s.parseReport.attachmentBytes!['deferred_tools_delta']).toBeGreaterThan(0)
  })
  it('classifies enqueues by content: notification envelopes vs human prompts (additive split)', async () => {
    const b = new SessionBuilder()
    b.userPrompt('go')
    b.queueOp('enqueue', '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>')
    b.queueOp('enqueue', '  <system-notification>build finished</system-notification>')
    b.queueOp('enqueue', 'fix the hamburger menu on mobile please')
    b.queueOp('enqueue', '<agent-message from="synthetic-agent"> PR #7 PASS') // agent message, not a task/system notification → human side
    b.queueOp('dequeue')
    b.assistant([{ type: 'text', text: 'ok' }])
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.meta.queueOperations).toEqual({ enqueue: 4, dequeue: 1 })
    expect(s.meta.enqueueKinds).toEqual({ human: 2, notification: 2 })
    const labels = s.events.filter((e) => e.label.startsWith('queued')).map((e) => e.label)
    expect(labels).toEqual(['queued notification', 'queued notification', 'queued message', 'queued message'])
  })
  it('sets no enqueueKinds when there are no enqueues', async () => {
    const b = new SessionBuilder()
    b.userPrompt('go')
    b.queueOp('dequeue')
    b.assistant([{ type: 'text', text: 'ok' }])
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    expect(s.meta.enqueueKinds).toBeUndefined()
  })
})
