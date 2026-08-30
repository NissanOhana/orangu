/**
 * SessionBuilder: emits realistic Claude Code transcript records for tests.
 * Shapes mirror the supported Claude Code JSONL records.
 * Everything is synthetic; nothing here comes from a real session.
 */
export interface Usage {
  input_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens: number
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }
  service_tier?: string
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number }
  /** CC >= 2.1.228: thinking token count inside output_tokens */
  output_tokens_details?: { thinking_tokens: number }
  /** per-attempt billing entries; the last one mirrors the top-level usage */
  iterations?: Array<Record<string, unknown>>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }>; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** the attribution* fields Claude Code stamps on an assistant record it ran on behalf of a skill, plugin, MCP server or agent */
export interface Attribution {
  skill?: string
  plugin?: string
  mcpServer?: string
  mcpTool?: string
  agent?: string
}

export interface BuilderOptions {
  sessionId?: string
  cwd?: string
  gitBranch?: string
  version?: string
  model?: string
  startAt?: string // ISO
  entrypoint?: string
  effort?: string
}

let counter = 0
/** reset the synthetic id counter so a fixture built twice yields byte-identical records (golden corpus) */
export function resetIds(): void {
  counter = 0
}
const pad = (n: number, w: number) => n.toString(16).padStart(w, '0')
export function fakeUuid(prefix = 'u'): string {
  counter++
  const c = pad(counter, 12)
  return `${prefix.padEnd(8, '0').slice(0, 8)}-${pad(counter, 4)}-4000-8000-${c}`
}
export function fakeToolUseId(): string {
  counter++
  return `toolu_${counter.toString(36).padStart(20, '0')}`
}
export function fakeMessageId(): string {
  counter++
  return `msg_${counter.toString(36).padStart(20, '0')}`
}

export class SessionBuilder {
  readonly sessionId: string
  readonly cwd: string
  readonly gitBranch: string
  readonly version: string
  readonly model: string
  readonly entrypoint: string
  readonly effort: string
  private clock: number
  private lastUuid: string | null = null
  private records: Record<string, unknown>[] = []
  private isSidechain = false
  private agentId: string | undefined
  private promptId: string | undefined

  constructor(opts: BuilderOptions = {}) {
    this.sessionId = opts.sessionId ?? fakeUuid('sess')
    this.cwd = opts.cwd ?? '/Users/test/Code/demo'
    this.gitBranch = opts.gitBranch ?? 'main'
    this.version = opts.version ?? '2.1.226'
    this.model = opts.model ?? 'claude-opus-5'
    this.entrypoint = opts.entrypoint ?? 'cli'
    this.effort = opts.effort ?? 'high'
    this.clock = Date.parse(opts.startAt ?? '2026-08-14T10:00:00.000Z')
  }

  /** advance the synthetic clock */
  tick(ms: number): this {
    this.clock += ms
    return this
  }
  now(): string {
    return new Date(this.clock).toISOString()
  }

  /** start a sidechain (subagent) context; records will carry isSidechain:true and agentId */
  sidechain(agentId: string, on = true): this {
    this.isSidechain = on
    this.agentId = on ? agentId : undefined
    return this
  }

  private base(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const uuid = fakeUuid()
    const rec: Record<string, unknown> = {
      parentUuid: this.lastUuid,
      isSidechain: this.isSidechain,
      userType: 'external',
      entrypoint: this.entrypoint,
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
      uuid,
      timestamp: this.now(),
      ...extra,
    }
    if (this.agentId) rec['agentId'] = this.agentId
    this.lastUuid = uuid
    return rec
  }

  /** a human prompt (starts a new turn) */
  userPrompt(text: string, opts: { permissionMode?: string; isMeta?: boolean } = {}): this {
    this.promptId = fakeUuid('prompt')
    const rec = this.base({
      type: 'user',
      promptId: this.promptId,
      message: { role: 'user', content: text },
      permissionMode: opts.permissionMode ?? 'default',
      origin: 'user',
      promptSource: 'user',
    })
    if (opts.isMeta) rec['isMeta'] = true
    this.records.push(rec)
    return this
  }

  /** an assistant API response; returns the tool_use ids created so tests can pair results */
  assistant(
    blocks: ContentBlock[],
    opts: {
      usage?: Partial<Usage>
      model?: string
      stopReason?: string
      messageId?: string
      effort?: string
      requestId?: string
      diagnostics?: Record<string, unknown>
      /** Claude Code's own attribution of the request to a skill / plugin / MCP server / agent (attribution* record fields) */
      attribution?: Attribution
    } = {},
  ): this {
    const usage: Usage = {
      input_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
      output_tokens: 120,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      service_tier: 'standard',
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      ...opts.usage,
    }
    if (opts.usage?.cache_creation_input_tokens && !opts.usage.cache_creation) {
      usage.cache_creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: opts.usage.cache_creation_input_tokens }
    }
    const rec = this.base({
      type: 'assistant',
      requestId: opts.requestId ?? `req_${fakeUuid('r').replace(/-/g, '')}`,
      effort: opts.effort ?? this.effort,
      message: {
        model: opts.model ?? this.model,
        id: opts.messageId ?? fakeMessageId(),
        type: 'message',
        role: 'assistant',
        content: blocks,
        stop_reason: opts.stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        stop_sequence: null,
        usage,
        ...(opts.diagnostics ? { diagnostics: opts.diagnostics } : {}),
      },
    })
    if (opts.attribution) {
      const a = opts.attribution
      if (a.skill !== undefined) rec['attributionSkill'] = a.skill
      if (a.plugin !== undefined) rec['attributionPlugin'] = a.plugin
      if (a.mcpServer !== undefined) rec['attributionMcpServer'] = a.mcpServer
      if (a.mcpTool !== undefined) rec['attributionMcpTool'] = a.mcpTool
      if (a.agent !== undefined) rec['attributionAgent'] = a.agent
    }
    this.records.push(rec)
    return this
  }

  /** the user-role record that carries a tool_result block */
  toolResult(
    toolUseId: string,
    content: string | Array<{ type: string; text?: string }>,
    opts: { isError?: boolean; toolUseResult?: unknown; sourceToolAssistantUUID?: string } = {},
  ): this {
    const block: ContentBlock = { type: 'tool_result', tool_use_id: toolUseId, content }
    if (opts.isError) block.is_error = true
    const rec = this.base({
      type: 'user',
      promptId: this.promptId,
      message: { role: 'user', content: [block] },
      toolUseResult: opts.toolUseResult ?? (typeof content === 'string' ? content : { content }),
      sourceToolAssistantUUID: opts.sourceToolAssistantUUID ?? this.lastUuid,
    })
    this.records.push(rec)
    return this
  }

  /** shorthand: one assistant tool_use + its result, with a synthetic duration */
  toolCall(
    name: string,
    input: Record<string, unknown>,
    result: string,
    opts: { durationMs?: number; isError?: boolean; usage?: Partial<Usage>; toolUseResult?: unknown; text?: string; thinking?: string; model?: string; attribution?: Attribution } = {},
  ): string {
    const id = fakeToolUseId()
    const blocks: ContentBlock[] = []
    if (opts.thinking) blocks.push({ type: 'thinking', thinking: opts.thinking })
    if (opts.text) blocks.push({ type: 'text', text: opts.text })
    blocks.push({ type: 'tool_use', id, name, input })
    this.assistant(blocks, { usage: opts.usage, model: opts.model, attribution: opts.attribution })
    this.tick(opts.durationMs ?? 800)
    this.toolResult(id, result, { isError: opts.isError, toolUseResult: opts.toolUseResult })
    return id
  }

  system(subtype: string, extra: Record<string, unknown> = {}): this {
    this.records.push(this.base({ type: 'system', subtype, level: 'info', isMeta: false, ...extra }))
    return this
  }

  turnDuration(durationMs: number, messageCount: number): this {
    return this.system('turn_duration', { durationMs, messageCount })
  }

  stopHookSummary(hooks: Array<{ command: string; durationMs?: number }>): this {
    return this.system('stop_hook_summary', {
      hookCount: hooks.length,
      hookInfos: hooks,
      hookErrors: [],
      hookAdditionalContext: [],
      preventedContinuation: false,
      stopReason: '',
      hasOutput: false,
      toolUseID: fakeUuid('hook'),
    })
  }

  /** compact summary as Claude Code writes it after /compact or auto-compact */
  compactSummary(summary: string): this {
    const rec = this.base({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: summary },
    })
    this.records.push(rec)
    return this
  }

  /** non-conversation records that Claude Code appends */
  meta(type: string, fields: Record<string, unknown>): this {
    this.records.push({ type, sessionId: this.sessionId, ...fields })
    return this
  }

  /** a generic attachment record (deferred_tools_delta, read_truncation_notice, queued_command, ...) */
  attachment(type: string, fields: Record<string, unknown> = {}): this {
    this.records.push(this.base({ type: 'attachment', attachment: { type, ...fields } }))
    return this
  }

  /** a queue-operation record (enqueue / dequeue / remove / popAll); content present on enqueue/remove */
  queueOp(operation: string, content?: string): this {
    const rec: Record<string, unknown> = { type: 'queue-operation', operation, sessionId: this.sessionId, timestamp: this.now() }
    if (content !== undefined) rec['content'] = content
    this.records.push(rec)
    return this
  }

  attachmentHook(hookName: string, hookEvent: string, stdout = ''): this {
    this.records.push(
      this.base({
        type: 'attachment',
        attachment: { type: 'hook_success', hookName, hookEvent, toolUseID: fakeUuid('hook'), content: '', stdout },
      }),
    )
    return this
  }

  push(rec: Record<string, unknown>): this {
    this.records.push(rec)
    return this
  }

  toRecords(): Record<string, unknown>[] {
    return this.records.map((r) => ({ ...r }))
  }
  toJsonl(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  }
}

/** A canonical small session used across tests: 2 turns, 3 tool calls, one error, one sidechain, hooks, turn durations. */
export function buildCanonicalSession(o: { cwd?: string } = {}): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', startAt: '2026-08-14T10:00:00.000Z', cwd: o.cwd })
  b.meta('mode', { mode: 'normal' })
  b.meta('permission-mode', { permissionMode: 'default' })
  b.attachmentHook('SessionStart:startup', 'SessionStart')
  // turn 1
  b.userPrompt('Fix the failing test in src/foo.ts')
  b.tick(1500)
  b.assistant([{ type: 'thinking', thinking: 'Let me look at the file.' }, { type: 'text', text: 'Looking at the test.' }], {
    usage: { input_tokens: 4, cache_creation_input_tokens: 12_000, cache_read_input_tokens: 0, output_tokens: 40 },
  })
  b.tick(200)
  b.toolCall('Read', { file_path: '/Users/test/Code/demo/src/foo.ts' }, '1\tconst a = 1\n2\texport default a\n', {
    durationMs: 120,
    usage: { input_tokens: 2, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 300, output_tokens: 60 },
    toolUseResult: { type: 'text', file: { filePath: '/Users/test/Code/demo/src/foo.ts', content: 'const a = 1', numLines: 2, startLine: 1, totalLines: 2 } },
  })
  b.toolCall('Bash', { command: 'npm test', description: 'Run tests' }, 'FAIL src/foo.test.ts\n1 failed', {
    durationMs: 4200,
    isError: true,
    usage: { input_tokens: 2, cache_read_input_tokens: 12_300, cache_creation_input_tokens: 200, output_tokens: 55 },
    toolUseResult: { stdout: 'FAIL src/foo.test.ts', stderr: '', interrupted: false, isImage: false },
  })
  b.toolCall('Edit', { file_path: '/Users/test/Code/demo/src/foo.ts', old_string: 'const a = 1', new_string: 'const a = 2' }, 'The file has been updated.', {
    durationMs: 90,
    usage: { input_tokens: 2, cache_read_input_tokens: 12_500, cache_creation_input_tokens: 400, output_tokens: 80 },
    toolUseResult: { filePath: '/Users/test/Code/demo/src/foo.ts', oldString: 'const a = 1', newString: 'const a = 2', replaceAll: false },
  })
  b.toolCall('Bash', { command: 'npm test', description: 'Run tests' }, 'PASS src/foo.test.ts\n1 passed', {
    durationMs: 3900,
    usage: { input_tokens: 2, cache_read_input_tokens: 12_900, cache_creation_input_tokens: 150, output_tokens: 50 },
    toolUseResult: { stdout: 'PASS src/foo.test.ts', stderr: '', interrupted: false, isImage: false },
  })
  b.assistant([{ type: 'text', text: 'Fixed: the constant was wrong; tests pass now.' }], {
    usage: { input_tokens: 2, cache_read_input_tokens: 13_050, cache_creation_input_tokens: 100, output_tokens: 30 },
  })
  b.stopHookSummary([{ command: 'afplay done.mp3', durationMs: 300 }])
  b.turnDuration(11_000, 12)
  // human thinks for a while
  b.tick(120_000)
  // turn 2 with a subagent
  b.userPrompt('Now review the diff with a subagent')
  b.tick(900)
  const agentToolId = fakeToolUseId()
  b.assistant([{ type: 'tool_use', id: agentToolId, name: 'Agent', input: { description: 'Review diff', prompt: 'Review the diff', subagent_type: 'code-reviewer' } }], {
    usage: { input_tokens: 2, cache_read_input_tokens: 13_150, cache_creation_input_tokens: 500, output_tokens: 90 },
  })
  // sidechain records (as they would appear inline in older versions; newer versions store them under <id>/subagents/)
  b.sidechain('a1b2c3d4e5f60718')
  b.tick(300)
  b.userPrompt('Review the diff')
  b.tick(2000)
  b.assistant([{ type: 'text', text: 'Reviewing.' }], { model: 'claude-sonnet-5', usage: { input_tokens: 5000, output_tokens: 200 } })
  b.toolCall('Bash', { command: 'git diff' }, 'diff --git a/src/foo.ts', { durationMs: 150, usage: { input_tokens: 5200, output_tokens: 150 } })
  b.assistant([{ type: 'text', text: 'LGTM' }], { model: 'claude-sonnet-5', usage: { input_tokens: 5400, output_tokens: 60 } })
  b.sidechain('', false)
  b.tick(100)
  b.toolResult(agentToolId, 'LGTM', {
    toolUseResult: { status: 'completed', agentId: 'a1b2c3d4e5f60718', content: [{ type: 'text', text: 'LGTM' }], totalDurationMs: 2550, totalTokens: 16_010, totalToolUseCount: 1, usage: { input_tokens: 15_600, output_tokens: 410, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  })
  b.assistant([{ type: 'text', text: 'The reviewer says LGTM.' }], {
    usage: { input_tokens: 2, cache_read_input_tokens: 13_650, cache_creation_input_tokens: 80, output_tokens: 20 },
  })
  b.turnDuration(6_000, 8)
  b.meta('custom-title', { customTitle: 'Fix foo test' })
  return b
}
