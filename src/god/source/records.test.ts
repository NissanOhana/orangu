/**
 * The record reducer of orangu god: each fact of TranscriptFacts from a synthetic SessionBuilder session, the
 * facts that a later record changes (an open question, an agent, an error at the end), the title that the report
 * gives, the head records that give the title only, and the control strip and the redaction of every text field.
 * The control characters are built from their code points, so this file spells no escape sequence.
 */
import { describe, expect, it } from 'vitest'
import { buildCanonicalSession, fakeToolUseId, SessionBuilder } from '../../../test/fixtures/session-builder.js'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { redactValue } from '../../redact/redact.js'
import type { TranscriptFacts } from '../types.js'
import { emptyRecordState, readRecords, reduceRecords, transcriptFacts } from './records.js'
import type { TranscriptRecord } from './transcript.js'

const HOME = '/Users/test'
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKE'
const MASKED_KEY = '‹anthropic-key›'
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI = String.fromCharCode(0x9b)
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const START = '2026-10-09T10:00:00.000Z'

/** A time of the test day, from its clock part. */
const T = (clock: string): number => Date.parse(`2026-10-09T${clock}Z`)
const builder = (options: { gitBranch?: string; model?: string } = {}): SessionBuilder => new SessionBuilder({ startAt: START, cwd: '/Users/test/Code/demo', ...options })
const reduce = (b: SessionBuilder): TranscriptFacts => reduceRecords(b.toRecords(), { home: HOME })
const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })
const notice = (toolUseId: string, end: string): string => `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n${end}\n<summary>The task ended.</summary>\n</task-notification>`

/** A task notification as Claude Code writes it when a background task ends while the session is idle. */
function notification(b: SessionBuilder, toolUseId: string): void {
  b.push({
    type: 'user',
    uuid: `notice-${toolUseId}`,
    parentUuid: null,
    isSidechain: false,
    sessionId: b.sessionId,
    timestamp: b.now(),
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: { role: 'user', content: notice(toolUseId, '<status>completed</status>') },
  })
}

/** A task notification as Claude Code queues it while a turn runs. */
function queuedNotification(b: SessionBuilder, toolUseId: string, end: string): void {
  b.attachment('queued_command', { prompt: notice(toolUseId, end), commandMode: 'task-notification' })
}

/** Every string value in a value, in any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** The paths of every field that holds undefined: the contract leaves an absent field out. */
function undefinedFields(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedFields(item, `${path}[${index}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => undefinedFields(item, `${path}.${key}`))
  return []
}

describe('reduceRecords: each fact from a session', () => {
  it('reads the title, the prompt, the reply, the activity, the context, the mode, the branch, the links, the files, the turn end and the history', () => {
    const b = builder({ gitBranch: 'feat/parser', model: 'claude-opus-5' })
    b.meta('permission-mode', { permissionMode: 'default' })
    b.meta('ai-title', { aiTitle: 'Fix the parser' })
    b.userPrompt('Fix the parser test.')
    b.tick(1000)
    b.assistant([text('I read the test first.')], { usage: { input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, output_tokens: 40 } })
    const editId = b.toolCall('Edit', { file_path: '/Users/test/Code/demo/src/parse.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.')
    b.assistant([text('The test passes now.')], { usage: { input_tokens: 2, cache_read_input_tokens: 21_000, cache_creation_input_tokens: 300, output_tokens: 30 } })
    b.turnDuration(5_000, 6)
    const link = { prNumber: 42, prUrl: 'https://github.com/acme/demo/pull/42', prRepository: 'acme/demo', timestamp: b.now() }
    b.meta('pr-link', link)
    b.meta('pr-link', link)
    b.meta('permission-mode', { permissionMode: 'acceptEdits' })

    expect(reduce(b)).toStrictEqual({
      title: 'Fix the parser',
      lastPrompt: 'Fix the parser test.',
      lastReply: 'The test passes now.',
      activity: { toolUseId: editId, tool: 'Edit', text: 'Edit src/parse.ts', isOpen: false, at: T('10:00:01.000') },
      context: { tokens: 21_302, window: 1_000_000, model: 'claude-opus-5', isEstimated: false },
      permissionMode: 'acceptEdits',
      branch: 'feat/parser',
      prLinks: [{ url: 'https://github.com/acme/demo/pull/42', number: 42 }],
      filesTouched: [{ path: '~/Code/demo/src/parse.ts', tool: 'Edit', at: T('10:00:01.000') }],
      lastTurnEndedAt: T('10:00:01.800'),
      history: [{ prompt: 'Fix the parser test.', promptAt: T('10:00:00.000'), reply: 'The test passes now.', replyAt: T('10:00:01.800'), endedAt: T('10:00:01.800') }],
      agents: [],
      parseErrors: 0,
    })
  })

  it('gives empty lists and no other field for no records', () => {
    expect(reduceRecords([], { home: HOME })).toStrictEqual({ prLinks: [], filesTouched: [], history: [], agents: [], parseErrors: 0 })
  })

  it('reads only the main chain: a sidechain prompt, reply or model is not a fact of the session', () => {
    const facts = reduceRecords(buildCanonicalSession().toRecords(), { home: HOME })
    expect(facts.title).toBe('Fix foo test')
    expect(facts.lastPrompt).toBe('Now review the diff with a subagent')
    expect(facts.lastReply).toBe('The reviewer says LGTM.')
    expect(facts.context).toStrictEqual({ tokens: 2 + 13_650 + 80, window: 1_000_000, model: 'claude-opus-5', isEstimated: false })
    expect(facts.agents).toStrictEqual([
      { toolUseId: facts.agents[0]!.toolUseId, kind: 'subagent', text: 'Agent Review diff (code-reviewer)', agentType: 'code-reviewer', isRunning: false, startedAt: Date.parse('2026-08-14T10:02:10.910Z'), endedAt: Date.parse('2026-08-14T10:02:13.460Z') },
    ])
    expect(facts.history.map((turn) => turn.prompt)).toEqual(['Fix the failing test in src/foo.ts', 'Now review the diff with a subagent'])
  })

  it('reads a prompt whose content is a list of blocks as its text blocks joined by a newline', () => {
    const b = builder()
    b.push({ type: 'user', uuid: 'blocks-1', parentUuid: null, isSidechain: false, sessionId: b.sessionId, timestamp: b.now(), message: { role: 'user', content: [text('Look at this.'), { type: 'image', source: {} }, text('Then fix it.')] } })
    expect(reduce(b).lastPrompt).toBe('Look at this.\nThen fix it.')
  })

  it('skips a call whose tool use id is not 1 to 128 letters, digits, _ or -, and counts it as a parse error', () => {
    const b = builder()
    const ask = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }] }] }
    for (const id of [`toolu_1${ESC}[2J`, 'toolu 2', 'x'.repeat(129), '']) {
      b.assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input: ask }])
      b.assistant([{ type: 'tool_use', id, name: 'Agent', input: { description: 'Review', prompt: 'x' } }])
    }
    b.push({ type: 'assistant', uuid: 'no-id', parentUuid: null, isSidechain: false, sessionId: b.sessionId, timestamp: b.now(), message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } })
    const skipped = reduce(b)
    expect(skipped.parseErrors).toBe(9)
    expect(['openQuestion' in skipped, 'activity' in skipped, skipped.agents]).toEqual([false, false, []])
    const longest = 'a'.repeat(128)
    b.assistant([{ type: 'tool_use', id: longest, name: 'AskUserQuestion', input: ask }])
    expect([reduce(b).openQuestion?.toolUseId, reduce(b).activity?.toolUseId]).toEqual([longest, longest])
  })

  it('counts each record that is not an object, beside the lines that the reader could not parse', () => {
    const records = [42, null, 'x', [], ...builder().userPrompt('Go.').toRecords()]
    expect(reduceRecords(records, { home: HOME, parseErrors: 2 }).parseErrors).toBe(6)
  })

  it('leaves out each absent field, never as undefined', () => {
    const b = builder()
    b.userPrompt('Go.')
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }] }] } }])
    for (const facts of [reduce(b), reduceRecords(buildCanonicalSession().toRecords(), { home: HOME })]) expect(undefinedFields(facts)).toEqual([])
  })
})

describe('reduceRecords: the title is the report title', () => {
  it('takes the custom title, then the AI title, then the first human prompt, else the first turn, as the report does', async () => {
    const long = `Rename the reader ${'and every caller of it '.repeat(10)}in one pass.`
    const sessions = [
      builder().meta('custom-title', { customTitle: 'Custom' }).meta('ai-title', { aiTitle: 'AI' }).userPrompt('First.'),
      builder().meta('ai-title', { aiTitle: 'AI' }).userPrompt('First.'),
      builder().userPrompt('First human prompt.').userPrompt('Second.'),
      builder().userPrompt(long),
      builder().userPrompt('<command-name>/model</command-name>').userPrompt('The human prompt after a command.'),
      builder().userPrompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>'),
      builder().userPrompt('Another Claude session sent a message: check the build'),
      builder().userPrompt(`Use ${KEY} in /Users/test/Code/demo.`),
      builder().meta('mode', { mode: 'normal' }),
    ]
    const titles: Array<string | undefined> = []
    for (const b of sessions) {
      const report = await parseClaudeCodeSession({ records: b.toRecords(), path: `/tmp/god/${b.sessionId}.jsonl`, noSidecar: true })
      const expected = report.meta.title === undefined ? undefined : redactValue(report.meta.title, { home: HOME })
      expect(reduce(b).title).toBe(expected)
      titles.push(expected)
    }
    expect(titles).toEqual([
      'Custom',
      'AI',
      'First human prompt.',
      expect.stringMatching(/^Rename the reader and every caller .*…$/),
      'The human prompt after a command.',
      '/review src/a.ts',
      'Another Claude session sent a message: check the build',
      `Use ${MASKED_KEY} in ~/Code/demo.`,
      undefined,
    ])
  })

  it('takes the first prompt from the head records when the tail has no title record, and keeps it on a later read', () => {
    const b = builder()
    b.userPrompt('The first prompt of the session.')
    b.assistant([text('Done.')])
    b.userPrompt('The second prompt.')
    b.assistant([text('Done again.')])
    const records = b.toRecords()
    expect(reduceRecords(records.slice(2), { home: HOME }).title).toBe('The second prompt.')
    const first = readRecords(emptyRecordState(HOME), records.slice(2), { headRecords: records.slice(0, 2) })
    const both = transcriptFacts(first)
    expect(both.title).toBe('The first prompt of the session.')
    expect(both.lastPrompt).toBe('The second prompt.')
    expect(both.history.map((turn) => turn.prompt)).toEqual(['The second prompt.'])
    const later = readRecords(first, builder().userPrompt('The third prompt.').toRecords(), {})
    expect(transcriptFacts(later).title).toBe('The first prompt of the session.')
  })

  it('keeps the title records of the tail over the ones of the head', () => {
    const head = builder().meta('custom-title', { customTitle: 'Old name' }).userPrompt('First.').toRecords()
    const tail = builder().meta('custom-title', { customTitle: 'New name' }).toRecords()
    expect(reduceRecords(tail, { home: HOME, headRecords: head }).title).toBe('New name')
    const aiTail = builder().meta('ai-title', { aiTitle: 'AI name' }).toRecords()
    expect(reduceRecords(aiTail, { home: HOME, headRecords: head }).title).toBe('Old name')
  })

  it('reads the head records for the title order only: a head tool use is never open, and a head prompt is no last prompt', () => {
    const head = builder({ gitBranch: 'old-branch' })
    head.meta('permission-mode', { permissionMode: 'plan' })
    head.userPrompt('The first prompt of the session.')
    head.assistant([text('An old reply.')])
    head.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }] }] } }])
    head.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'Agent', input: { description: 'Old task', prompt: 'x' } }])
    head.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'Edit', input: { file_path: '/Users/test/Code/demo/old.ts' } }])
    head.meta('pr-link', { prNumber: 3, prUrl: 'https://github.com/acme/demo/pull/3' })
    head.system('api_error', { error: { message: 'Overloaded' } })
    head.turnDuration(1_000, 4)
    expect(reduceRecords([], { home: HOME, headRecords: head.toRecords() })).toStrictEqual({
      title: 'The first prompt of the session.',
      prLinks: [],
      filesTouched: [],
      history: [],
      agents: [],
      parseErrors: 0,
    })
  })
})

describe('reduceRecords: the facts that a later record changes', () => {
  it('opens a question on an AskUserQuestion call and closes it when its result comes, in the same read or a later one', () => {
    const b = builder()
    b.userPrompt('Pick a color.')
    b.tick(1000)
    const ask = fakeToolUseId()
    const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'A warm color' }, { label: 'Green' }] }] }
    b.assistant([{ type: 'tool_use', id: ask, name: 'AskUserQuestion', input }])
    const askedAt = T('10:00:01.000')
    const open = reduce(b)
    expect(open.openQuestion).toStrictEqual({
      toolUseId: ask,
      askedAt,
      questions: [{ text: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'A warm color' }, { label: 'Green' }] }],
    })
    expect(open.activity).toStrictEqual({ toolUseId: ask, tool: 'AskUserQuestion', text: 'AskUserQuestion', input: JSON.stringify(input), isOpen: true, at: askedAt })

    const before = b.toRecords().length
    b.tick(5000)
    b.toolResult(ask, 'User answered: Green', { toolUseResult: { answers: { 'Which color?': 'Green' } } })
    const closed = reduce(b)
    expect('openQuestion' in closed).toBe(false)
    expect(closed.activity).toStrictEqual({ toolUseId: ask, tool: 'AskUserQuestion', text: 'AskUserQuestion', isOpen: false, at: askedAt })

    const first = readRecords(emptyRecordState(HOME), b.toRecords().slice(0, before), {})
    expect(transcriptFacts(first).openQuestion?.toolUseId).toBe(ask)
    expect('openQuestion' in transcriptFacts(readRecords(first, b.toRecords().slice(before), {}))).toBe(false)
  })

  it('keeps the options of a question in dialog order, an option with no label included', () => {
    const b = builder()
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A' }, { description: 'no label' }, { label: 'C' }] }] } }])
    expect(reduce(b).openQuestion?.questions).toStrictEqual([{ text: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: '', description: 'no label' }, { label: 'C' }] }])
  })

  it('takes the last open call as the activity, else the last call', () => {
    const b = builder()
    b.userPrompt('Run both.')
    const read = fakeToolUseId()
    const bash = fakeToolUseId()
    b.assistant([{ type: 'tool_use', id: read, name: 'Read', input: { file_path: '/Users/test/Code/demo/a.ts' } }])
    b.assistant([{ type: 'tool_use', id: bash, name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }])
    b.tick(500)
    b.toolResult(bash, 'ok')
    expect(reduce(b).activity).toStrictEqual({ toolUseId: read, tool: 'Read', text: 'Read demo/a.ts', input: JSON.stringify({ file_path: '~/Code/demo/a.ts' }), isOpen: true, at: T('10:00:00.000') })
    b.toolResult(read, 'const a = 1')
    expect(reduce(b).activity).toStrictEqual({ toolUseId: bash, tool: 'Bash', text: 'Bash Run tests', isOpen: false, at: T('10:00:00.000') })
  })

  it('closes the calls that an earlier turn left open when a new prompt comes, and ends a subagent with no result, but not a launched one', () => {
    const b = builder()
    b.userPrompt('Ask me.')
    const sync = fakeToolUseId()
    const async = fakeToolUseId()
    b.assistant([{ type: 'tool_use', id: async, name: 'Agent', input: { description: 'Run tests', prompt: 'Run them.', run_in_background: true } }])
    b.toolResult(async, 'Async agent launched.', { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'a1' } })
    b.assistant([{ type: 'tool_use', id: sync, name: 'Agent', input: { description: 'Review diff', prompt: 'Review it.' } }])
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'AskUserQuestion', input: { questions: [] } }])
    expect(reduce(b).openQuestion?.questions).toEqual([])
    b.tick(3000)
    b.userPrompt('Never mind. Do the other task.')
    const facts = reduce(b)
    expect('openQuestion' in facts).toBe(false)
    expect(facts.activity?.isOpen).toBe(false)
    expect(facts.agents.map((agent) => [agent.toolUseId, agent.isRunning, agent.endedAt])).toEqual([
      [async, true, undefined],
      [sync, false, T('10:00:03.000')],
    ])
  })

  it('runs a subagent until its result, an async agent and a background shell until their task notification', () => {
    const b = builder()
    b.userPrompt('Review and test.')
    const sync = fakeToolUseId()
    const async = fakeToolUseId()
    const shell = fakeToolUseId()
    const team = fakeToolUseId()
    b.assistant([{ type: 'tool_use', id: sync, name: 'Agent', input: { description: 'Review diff', prompt: 'Review it.', subagent_type: 'code-reviewer' } }])
    b.assistant([{ type: 'tool_use', id: async, name: 'Agent', input: { description: 'Run tests', prompt: 'Run them.', subagent_type: 'tester' } }])
    b.assistant([{ type: 'tool_use', id: shell, name: 'Bash', input: { command: 'npm run dev', description: 'Start the server', run_in_background: true } }])
    b.assistant([{ type: 'tool_use', id: team, name: 'Agent', input: { description: 'Join the team', prompt: 'Help.', name: 'helper' } }])
    b.tick(1000)
    b.toolResult(async, 'Async agent launched.', { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'a1', description: 'Run tests', prompt: 'Run them.', outputFile: '/tmp/a1' } })
    b.toolResult(shell, 'Command running in background with ID: b1', { toolUseResult: { backgroundTaskId: 'b1', stdout: '', stderr: '', interrupted: false, isImage: false } })
    b.toolResult(team, 'Spawned.', { toolUseResult: { status: 'teammate_spawned', agentId: 'helper@team', name: 'helper' } })
    const startedAt = T('10:00:00.000')
    expect(reduce(b).agents).toStrictEqual([
      { toolUseId: sync, kind: 'subagent', text: 'Agent Review diff (code-reviewer)', agentType: 'code-reviewer', isRunning: true, startedAt },
      { toolUseId: async, kind: 'subagent', text: 'Agent Run tests (tester)', agentType: 'tester', isRunning: true, startedAt },
      { toolUseId: shell, kind: 'background', text: 'Bash Start the server', isRunning: true, startedAt },
      { toolUseId: team, kind: 'subagent', text: 'Agent Join the team', isRunning: false, startedAt, endedAt: T('10:00:01.000') },
    ])

    b.tick(2000)
    b.toolResult(sync, 'LGTM', { toolUseResult: { status: 'completed', agentId: 'a0', content: [text('LGTM')] } })
    b.tick(1000)
    notification(b, async)
    b.tick(1000)
    queuedNotification(b, shell, '<event>A log line.</event>')
    const ended = reduce(b)
    expect(ended.agents.map((agent) => [agent.toolUseId, agent.isRunning, agent.endedAt])).toEqual([
      [sync, false, T('10:00:03.000')],
      [async, false, T('10:00:04.000')],
      [shell, true, undefined],
      [team, false, T('10:00:01.000')],
    ])
    expect(ended.lastPrompt).toBe('Review and test.')
    expect(ended.history).toHaveLength(1)

    b.tick(1000)
    queuedNotification(b, shell, '<status>killed</status>')
    expect(reduce(b).agents[2]).toMatchObject({ toolUseId: shell, isRunning: false, endedAt: T('10:00:06.000') })
  })

  it('ends an agent whose launch fails', () => {
    const b = builder()
    const failed = fakeToolUseId()
    b.assistant([{ type: 'tool_use', id: failed, name: 'Agent', input: { description: 'Try', prompt: 'x', run_in_background: true } }])
    b.toolResult(failed, 'Error: no such agent type', { isError: true })
    expect(reduce(b).agents[0]).toMatchObject({ toolUseId: failed, isRunning: false })
  })

  it('sets the error tail on an API error or retry record, and clears it on the next reply or prompt', () => {
    const b = builder()
    b.userPrompt('Go.')
    b.tick(1000)
    b.system('api_error', { level: 'error', error: { message: 'Overloaded', formatted: 'API Error: Overloaded' }, retryAttempt: 1, maxRetries: 10, retryInMs: 500 })
    expect(reduce(b).errorTail).toStrictEqual({ kind: 'api-error', text: 'Overloaded', at: T('10:00:01.000') })
    b.tick(500)
    b.system('api_retry', { content: 'Retrying in 2 s' })
    b.turnDuration(1_500, 2)
    expect(reduce(b).errorTail).toStrictEqual({ kind: 'api-retry', text: 'Retrying in 2 s', at: T('10:00:01.500') })
    b.assistant([text('Back.')])
    expect('errorTail' in reduce(b)).toBe(false)
    b.system('api_error', { error: { message: 'Overloaded' } })
    b.userPrompt('Try again.')
    expect('errorTail' in reduce(b)).toBe(false)
  })

  it('sets the error tail on an API error message that Claude Code writes as a reply, and clears it on the next reply', () => {
    const b = builder()
    b.userPrompt('Go.')
    b.assistant([text('Working.')])
    b.tick(1000)
    b.push({ type: 'assistant', uuid: 'api-error-1', parentUuid: null, isSidechain: false, sessionId: b.sessionId, timestamp: b.now(), isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [text(`API Error: Overloaded ${KEY}`)] } })
    const facts = reduce(b)
    expect(facts.errorTail).toStrictEqual({ kind: 'api-error', text: `API Error: Overloaded ${MASKED_KEY}`, at: T('10:00:01.000') })
    expect(facts.lastReply).toBe('Working.')
    b.assistant([text('Back.')])
    expect('errorTail' in reduce(b)).toBe(false)
  })

  it('reads the context of the last reply: an estimated window for an estimated model, none for an unknown model, and no synthetic reply', () => {
    const b = builder({ model: 'claude-haiku-5-5' })
    b.assistant([text('One.')], { usage: { input_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 10, output_tokens: 3 } })
    b.assistant([text('No response requested.')], { model: '<synthetic>', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } })
    const facts = reduce(b)
    expect(facts.context).toStrictEqual({ tokens: 1_015, window: 200_000, model: 'claude-haiku-5-5', isEstimated: true })
    expect(facts.lastReply).toBe('One.')
    b.assistant([text('Two.')], { model: 'unknown-model-x', usage: { input_tokens: 7, output_tokens: 1 } })
    expect('context' in reduce(b)).toBe(false)
  })

  it('keeps 1 touch for each file, the newest, oldest first, from Edit, Write, MultiEdit and NotebookEdit only', () => {
    const b = builder()
    const call = (name: string, input: Record<string, unknown>): void => {
      b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name, input }])
      b.tick(1000)
    }
    call('Edit', { file_path: '/Users/test/Code/demo/a.ts' })
    call('Write', { file_path: '/Users/test/Code/demo/b.ts' })
    call('Edit', { file_path: '/Users/test/Code/demo/a.ts' })
    call('NotebookEdit', { notebook_path: '/Users/test/Code/demo/c.ipynb' })
    call('Read', { file_path: '/Users/test/Code/demo/d.ts' })
    call('MultiEdit', { file_path: '/Users/test/Code/demo/b.ts' })
    expect(reduce(b).filesTouched).toStrictEqual([
      { path: '~/Code/demo/a.ts', tool: 'Edit', at: T('10:00:02.000') },
      { path: '~/Code/demo/c.ipynb', tool: 'NotebookEdit', at: T('10:00:03.000') },
      { path: '~/Code/demo/b.ts', tool: 'MultiEdit', at: T('10:00:05.000') },
    ])
  })

  it('keeps 1 link for each pull request URL, in the order seen, and skips a link with no URL', () => {
    const b = builder()
    b.meta('pr-link', { prNumber: 7, prUrl: 'https://github.com/acme/demo/pull/7' })
    b.meta('pr-link', { prNumber: 9, prUrl: 'https://github.com/acme/demo/pull/9' })
    b.meta('pr-link', { prNumber: 7, prUrl: 'https://github.com/acme/demo/pull/7' })
    b.meta('pr-link', { prNumber: 11 })
    b.meta('pr-link', { prUrl: 'https://github.com/acme/demo/pull/new' })
    expect(reduce(b).prLinks).toStrictEqual([
      { url: 'https://github.com/acme/demo/pull/7', number: 7 },
      { url: 'https://github.com/acme/demo/pull/9', number: 9 },
      { url: 'https://github.com/acme/demo/pull/new' },
    ])
  })
})

describe('reduceRecords: the history', () => {
  it('keeps the last 10 turns, each with its prompt, the last reply of the turn and its end', () => {
    const b = builder()
    for (let n = 1; n <= 12; n++) {
      b.userPrompt(`Prompt ${n}.`)
      b.tick(100)
      b.assistant([text(`Step ${n}.`)])
      b.assistant([text(`Reply ${n}.`)])
      b.turnDuration(100, 2)
      b.tick(1000)
    }
    const history = reduce(b).history
    expect(history).toHaveLength(10)
    expect(history[0]).toStrictEqual({ prompt: 'Prompt 3.', promptAt: T('10:00:02.200'), reply: 'Reply 3.', replyAt: T('10:00:02.300'), endedAt: T('10:00:02.300') })
    expect(history[9]).toMatchObject({ prompt: 'Prompt 12.', reply: 'Reply 12.' })
  })

  it('shows a command turn as its command, gives a peer turn no prompt, and keeps the replies before the first prompt of a cut', () => {
    const b = builder()
    b.assistant([text('Earlier work ends.')])
    b.tick(1000)
    b.userPrompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>')
    b.assistant([text('Review done.')])
    b.tick(1000)
    b.userPrompt('Another Claude session sent a message: check the build')
    b.assistant([text('The build is green.')])
    const facts = reduce(b)
    expect(facts.history).toStrictEqual([
      { reply: 'Earlier work ends.', replyAt: T('10:00:00.000') },
      { prompt: '/review src/a.ts', promptAt: T('10:00:01.000'), reply: 'Review done.', replyAt: T('10:00:01.000') },
      { reply: 'The build is green.', replyAt: T('10:00:02.000') },
    ])
    expect('lastPrompt' in facts).toBe(false)
  })
})

describe('readRecords: reads in parts', () => {
  it('gives the same facts for 1 read and for 2 reads, adds up the parse errors, and never changes the state it reads from', () => {
    const records: readonly TranscriptRecord[] = buildCanonicalSession().toRecords()
    const once = reduceRecords(records, { home: HOME, parseErrors: 2 })
    for (const cut of [1, 5, 13, records.length - 1]) {
      const first = readRecords(emptyRecordState(HOME), records.slice(0, cut), { parseErrors: 1 })
      const frozen = JSON.stringify(first)
      const second = readRecords(first, records.slice(cut), { parseErrors: 1 })
      expect(transcriptFacts(second), `cut at ${cut}`).toStrictEqual(once)
      expect(JSON.stringify(first), `cut at ${cut}`).toBe(frozen)
    }
  })
})

describe('reduceRecords: every text field is sanitized and redacted', () => {
  it('masks a planted key in a reply and in a prompt', () => {
    const b = builder()
    b.userPrompt(`My key is ${KEY}.`)
    b.assistant([text(`Use ${KEY} to call the API.`)])
    const facts = reduce(b)
    expect(facts.lastReply).toBe(`Use ${MASKED_KEY} to call the API.`)
    expect(facts.lastPrompt).toBe(`My key is ${MASKED_KEY}.`)
    expect(facts.history[0]?.reply).toBe(`Use ${MASKED_KEY} to call the API.`)
  })

  it('removes ESC, BEL and a C1 character, keeps newline and tab, and writes the home folder as ~', () => {
    const b = builder()
    b.userPrompt('Open /Users/test/Code/demo/a.ts')
    b.assistant([text(`Red${ESC}[31m text${BEL}\nnext${CSI}line\tend`)])
    const facts = reduce(b)
    expect(facts.lastReply).toBe('Red[31m text\nnextline\tend')
    expect(facts.lastPrompt).toBe('Open ~/Code/demo/a.ts')
  })

  it('masks a string that only its key names as a secret, in a nested input object, in an array of objects and in the input JSON', () => {
    const secret = 'Zq9xW2pL7mN4vB8k'
    const b = builder()
    const input = {
      path: '/Users/test/Code/demo/app',
      env: { API_KEY: secret, password: secret, client_secret: secret, authToken: secret, region: 'eu-west-1' },
      services: [{ name: 'db', password: secret }, { name: 'cache', token: secret }],
      access: { API_KEY: [secret] },
    }
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'mcp__deploy__run', input }])
    const activity = reduce(b).activity
    expect(activity?.input).not.toContain(secret)
    expect(JSON.parse(activity?.input ?? '{}')).toStrictEqual({
      path: '~/Code/demo/app',
      env: { API_KEY: '‹redacted›', password: '‹redacted›', client_secret: '‹redacted›', authToken: '‹redacted›', region: 'eu-west-1' },
      services: [{ name: 'db', password: '‹redacted›' }, { name: 'cache', token: '‹redacted›' }],
      access: { API_KEY: ['‹redacted›'] },
    })
    const keyed = builder()
    keyed.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'mcp__vault__put', input: { API_KEY: secret } }])
    expect(reduce(keyed).activity?.text).toBe('mcp__vault__put ‹redacted›')
  })

  it('cleans each text field of the facts, from every record kind', () => {
    const dirty = (word: string): string => `${word} ${ESC}[2J${BEL}${CSI} ${KEY} /Users/test/Code/demo`
    const b = builder({ gitBranch: dirty('branch'), model: 'claude-opus-5' })
    b.meta('custom-title', { customTitle: dirty('title') })
    b.meta('permission-mode', { permissionMode: dirty('mode') })
    b.meta('pr-link', { prNumber: 7, prUrl: dirty('https://github.com/acme/demo/pull/7') })
    b.userPrompt(dirty('prompt'))
    b.assistant([text(dirty('reply'))])
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'AskUserQuestion', input: { questions: [{ question: dirty('question'), header: dirty('header'), multiSelect: false, options: [{ label: dirty('label'), description: dirty('about') }] }] } }])
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'Agent', input: { description: dirty('agent'), prompt: 'x', subagent_type: dirty('type') } }])
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: 'Edit', input: { file_path: dirty('/Users/test/Code/demo/a.ts') } }])
    b.assistant([{ type: 'tool_use', id: fakeToolUseId(), name: `mcp__demo__${ESC}run`, input: { [`com${CSI}mand`]: dirty('command') } }])
    b.system('api_error', { error: { message: dirty('error') } })
    const facts = reduce(b)

    const texts = strings(facts)
    expect(texts.length).toBeGreaterThan(20)
    for (const value of texts) {
      expect(value).not.toMatch(CONTROL)
      expect(value).not.toContain('sk-ant-')
      expect(value).not.toContain('/Users/test')
    }
    const clean = (word: string): string => `${word} [2J ${MASKED_KEY} ~/Code/demo`
    expect(facts.title).toBe(clean('title'))
    expect(facts.lastReply).toBe(clean('reply'))
    expect(facts.branch).toBe(clean('branch'))
    expect(facts.permissionMode).toBe(clean('mode'))
    expect(facts.errorTail?.text).toBe(clean('error'))
    expect(facts.openQuestion?.questions[0]).toStrictEqual({ text: clean('question'), header: clean('header'), multiSelect: false, options: [{ label: clean('label'), description: clean('about') }] })
    expect(facts.agents[0]).toMatchObject({ text: `Agent ${clean('agent')} (${clean('type')})`, agentType: clean('type') })
    expect(facts.activity?.tool).toBe('mcp__demo__run')
    expect(facts.activity?.input).toBe(JSON.stringify({ command: clean('command') }))
  })
})
