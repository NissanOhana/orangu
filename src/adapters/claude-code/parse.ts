/**
 * Claude Code adapter: raw transcript records -> normalized Session.
 *
 * Tolerant by construction: every field access is guarded, unknown record/block types are counted
 * (never fatal), and the output is always a complete Session object.
 */
import { basename, dirname } from 'node:path'
import type {
  AgentRun,
  CacheMissReason,
  PromptKind,
  Block,
  CompactionEvent,
  HookRun,
  Message,
  ParseReport,
  ParseWarning,
  Session,
  SessionEvent,
  SessionMeta,
  SkillInvocation,
  ToolCall,
  Turn,
  Usage,
  UsageEvent,
} from '../../model/session.js'
import { addUsage, emptyUsage, TURN_STARTING_KINDS } from '../../model/session.js'
import type { JsonObject } from './jsonl.js'
import {
  evidenceManifestSidecarFiles,
  MAX_LOCAL_SESSION_BYTES,
  prevalidateEvidenceSession,
  readEvidenceSessionManifest,
  type EvidenceSessionManifest,
  type PrevalidateEvidenceSessionOptions,
  type ReadEvidenceSessionResult,
} from './evidence-input.js'
import type { ParseInput } from './parse-input.js'
import { categorizeTool, skillNameFromInput, summarizeToolInput } from './tools.js'

export type { ParseInput } from './parse-input.js'

// ---------- typed access helpers ----------
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown): boolean => v === true
const obj = (v: unknown): JsonObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined)
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined)
const ts = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}
const bytesOf = (v: unknown): number => {
  try {
    return typeof v === 'string' ? Buffer.byteLength(v) : Buffer.byteLength(JSON.stringify(v) ?? '')
  } catch {
    return 0
  }
}
const preview = (s: string, max = 160): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

interface FileInput {
  index: number
  path: string
  records: JsonObject[]
  lineNumbers?: number[]
  agentIdHint?: string
  meta?: JsonObject
  totalLines: number
  badLines: number
  bytes: number
  trailingPartial: boolean
}

// ---------- usage ----------
export function parseUsage(u: unknown): Usage | undefined {
  const o = obj(u)
  if (!o) return undefined
  const cc = obj(o['cache_creation'])
  const st = obj(o['server_tool_use'])
  const cacheWrite = num(o['cache_creation_input_tokens']) ?? 0
  let w5 = num(cc?.['ephemeral_5m_input_tokens'])
  let w1 = num(cc?.['ephemeral_1h_input_tokens'])
  // when the total cache-write is > 0 but the nested TTL split is absent or all-zero, attribute the whole
  // amount to the 1h bucket (the main-chain default and the higher price: conservative, never undercounts)
  if (cacheWrite > 0 && (w5 ?? 0) + (w1 ?? 0) === 0) {
    w5 = 0
    w1 = cacheWrite
  }
  return {
    input: num(o['input_tokens']) ?? 0,
    output: num(o['output_tokens']) ?? 0,
    cacheRead: num(o['cache_read_input_tokens']) ?? 0,
    cacheWrite,
    cacheWrite5m: w5 ?? (w1 === undefined ? cacheWrite : 0),
    cacheWrite1h: w1 ?? 0,
    webSearchRequests: num(st?.['web_search_requests']) ?? 0,
    webFetchRequests: num(st?.['web_fetch_requests']) ?? 0,
    serviceTier: str(o['service_tier']),
    speed: str(o['speed']),
    inferenceGeo: str(o['inference_geo']),
  }
}

// ---------- blocks ----------
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  const a = arr(content)
  if (!a) return ''
  const parts: string[] = []
  for (const b of a) {
    const o = obj(b)
    if (!o) continue
    if (o['type'] === 'text' && typeof o['text'] === 'string') parts.push(o['text'])
  }
  return parts.join('\n')
}

type CountMap = Map<string, number>

function addCount(counts: CountMap, key: string, amount = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + amount)
}

function countRecord(counts: CountMap): Record<string, number> {
  return Object.fromEntries(counts)
}

function parseBlocks(content: unknown, keepText: boolean, unknownBlockTypes: CountMap): Block[] {
  if (typeof content === 'string') return [{ kind: 'text', text: keepText ? content : '' }]
  const a = arr(content)
  if (!a) return []
  const out: Block[] = []
  for (const raw of a) {
    const b = obj(raw)
    if (!b) continue
    const t = str(b['type']) ?? 'other'
    switch (t) {
      case 'text':
        out.push({ kind: 'text', text: keepText ? (str(b['text']) ?? '') : '' })
        break
      case 'thinking': {
        const th = str(b['thinking']) ?? ''
        out.push({ kind: 'thinking', chars: th.length, text: keepText ? th : undefined })
        break
      }
      case 'redacted_thinking':
        out.push({ kind: 'redacted_thinking', rawType: t, bytes: bytesOf(b['data']) })
        break
      case 'tool_use':
        out.push({ kind: 'tool_use', toolUseId: str(b['id']) ?? '', name: str(b['name']) ?? 'unknown', input: b['input'] })
        break
      case 'tool_result': {
        const c = b['content']
        out.push({
          kind: 'tool_result',
          toolUseId: str(b['tool_use_id']) ?? '',
          text: textOfContent(c),
          isError: bool(b['is_error']),
          bytes: bytesOf(c),
        })
        break
      }
      case 'image':
      case 'document':
        out.push({ kind: t, rawType: t, bytes: bytesOf(b['source']) })
        break
      case 'fallback': {
        const from = obj(b['from'])
        const to = obj(b['to'])
        out.push({ kind: 'other', rawType: 'fallback', bytes: 0, note: `model fallback ${str(from?.['model']) ?? '?'} → ${str(to?.['model']) ?? '?'}` })
        break
      }
      default:
        addCount(unknownBlockTypes, t)
        out.push({ kind: 'other', rawType: t, bytes: bytesOf(b) })
    }
  }
  return out
}

const COMMAND_RE = /<command-name>\s*([^<\s]+)\s*<\/command-name>/
const INTERRUPT_RE = /\[Request interrupted by user/i
/**
 * A machine-generated queue enqueue: the harness pastes a task/system notification envelope into the
 * queue when a background task finishes. Task and system notification wrappers are machine events.
 * Agent and cross-session message envelopes are not matched; they are inbound prompts, just not typed
 * by the human.
 */
const NOTIFICATION_ENQUEUE_RE = /^\s*<(?:task|system)-notification>/
const LEADING_REMINDERS_RE = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/

/** Classify a non-tool-result user message. Uses Claude Code's origin/promptSource when present, else content heuristics. */
export function classifyPrompt(r: JsonObject, text: string, isMeta: boolean): PromptKind {
  const origin = obj(r['origin'])
  const originKind = str(origin?.['kind'])
  const promptSource = str(r['promptSource'])
  if (INTERRUPT_RE.test(text.slice(0, 200))) return 'interrupt'
  if (r['isVisibleInTranscriptOnly'] === true) return 'meta'
  if (originKind === 'human' || promptSource === 'typed') return COMMAND_RE.test(text) ? 'command' : 'human'
  if (originKind === 'task-notification') return 'notification'
  if (originKind === 'peer' || originKind === 'teammate' || originKind === 'cross-session') return 'peer'
  const t = text.replace(LEADING_REMINDERS_RE, '').trimStart()
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return 'command'
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-caveat>') || t.startsWith('<local-command-stderr>')) return 'local_output'
  if (t.startsWith('<task-notification>')) return 'notification'
  if (t.startsWith('<teammate-message') || t.startsWith('<cross-session-message') || t.startsWith('Another Claude session sent a message')) return 'peer'
  if (isMeta && promptSource === 'system') return 'scheduled'
  if (isMeta) return 'meta'
  // known Claude Code injected wrappers → meta. Arbitrary pasted markup (<div>, <Component>, <xml>) is NOT
  // meta: a real human prompt can start with pasted code, and we must not lose that turn.
  const META_TAGS = ['<user-prompt-submit-hook>', '<system-reminder>', '<budget:', '<total_tokens>', '<user-memory-input>', '<important_context>', '<function_results>', '<returned-by-']
  if (META_TAGS.some((tag) => t.startsWith(tag))) return 'meta'
  return 'human'
}

// ---------- sidecar discovery ----------
export async function discoverSubagentFiles(mainPath: string): Promise<Array<{ path: string; metaPath?: string; agentIdHint: string }>> {
  return evidenceManifestSidecarFiles(await prevalidateEvidenceSession(mainPath, { maxBytes: MAX_LOCAL_SESSION_BYTES }))
}

// ---------- stable read with a bounded retry ----------
/**
 * A write that lands between prevalidation and the read of a live transcript surfaces as one of two
 * errors from evidence-input.ts: "changed before it was read" (the inode snapshot no longer matches at
 * open) or "changed while it was being read" (it stopped matching after the read, or a sidecar entry
 * did). Both mean the session is still being written, not that the input is unsafe, so the one-shot
 * verbs (report / analyze / evidence / estimate) re-run the prevalidate + read pair a bounded number of
 * times. Every other error (symbolic link, non-regular file, byte or record cap, a sidecar escaping its
 * root, "changed during prevalidation") stays fail-closed and is never retried.
 */
const TRANSIENT_INPUT_CHANGE_RE = /^session (?:input|sidecar (?:directory|tree)) changed (?:before it was read|while it was being read)\b/
export function isTransientInputChange(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_INPUT_CHANGE_RE.test(error.message)
}
/** attempts at the prevalidate + read pair before the race is reported to the caller */
export const STABLE_READ_ATTEMPTS = 3
/** pause before attempt 2 and before attempt 3 (ms): an appending writer finishes a line in far less */
const STABLE_READ_BACKOFF_MS = [20, 80] as const
export const STILL_WRITING_HINT = 'the session is still being written; re-run, or use `orangu watch` to follow it live'

/**
 * Run the prevalidate + read pair, retrying the WHOLE pair when a live transcript is appended between the
 * snapshot and the read (or during it). Every loader that turns a transcript path into records goes through
 * here (report/analyze via the cache, evidence, estimate, verification), so a session that is still being
 * written is retried at the seam the verbs actually use. Only the transient "changed before/while it was
 * being read" errors retry; symlink, size-cap, non-regular-file and root-escape errors stay fail-closed.
 */
export async function withStableSessionRead<T>(
  path: string,
  options: PrevalidateEvidenceSessionOptions | undefined,
  read: (manifest: EvidenceSessionManifest) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(await prevalidateEvidenceSession(path, options))
    } catch (error) {
      if (!isTransientInputChange(error)) throw error
      if (attempt >= STABLE_READ_ATTEMPTS) throw new Error(`${(error as Error).message}; ${STILL_WRITING_HINT}`)
      const pause = STABLE_READ_BACKOFF_MS[Math.min(attempt, STABLE_READ_BACKOFF_MS.length) - 1]!
      await new Promise<void>((resolve) => setTimeout(resolve, pause))
    }
  }
}

/** prevalidate + read one session (main transcript and, unless excluded, its sidecars) with the retry above */
export function readStableEvidenceSession(path: string, options?: PrevalidateEvidenceSessionOptions, maxBytes?: number): Promise<ReadEvidenceSessionResult> {
  return withStableSessionRead(path, options, (manifest) => readEvidenceSessionManifest(manifest, maxBytes))
}

const readStableSession = readStableEvidenceSession

// ---------- main entry ----------
export async function parseClaudeCodeSession(input: ParseInput): Promise<Session> {
  const t0 = Date.now()
  const keepText = input.keepText ?? true
  const files: FileInput[] = []
  let effectiveInput = input
  if (input.path && input.records === undefined) {
    const loaded = await readStableSession(input.path, { includeSidecars: !input.noSidecar, maxBytes: MAX_LOCAL_SESSION_BYTES })
    effectiveInput = { ...loaded.parseInput, keepText: input.keepText, noSidecar: true }
  } else if (input.path && input.records && input.subagents === undefined && !input.noSidecar) {
    const loaded = await readStableSession(input.path, { maxBytes: MAX_LOCAL_SESSION_BYTES })
    effectiveInput = { ...input, subagents: loaded.parseInput.subagents }
  }
  const mainPath = effectiveInput.path ?? '(memory)'

  if (effectiveInput.records) {
    files.push({
      index: 0,
      path: mainPath,
      records: effectiveInput.records,
      lineNumbers: effectiveInput.lineNumbers,
      totalLines: effectiveInput.totalLines ?? effectiveInput.records.length,
      badLines: effectiveInput.badLines ?? 0,
      bytes: effectiveInput.bytes ?? 0,
      trailingPartial: effectiveInput.trailingPartial ?? false,
    })
  } else {
    throw new Error('parseClaudeCodeSession: need path or records')
  }

  if (effectiveInput.subagents) {
    for (const s of effectiveInput.subagents) {
      files.push({
        index: files.length,
        path: s.path,
        records: s.records,
        lineNumbers: s.lineNumbers,
        agentIdHint: s.agentIdHint ?? basename(s.path, '.jsonl').replace(/^agent-/, ''),
        meta: s.meta,
        totalLines: s.totalLines ?? s.records.length,
        badLines: s.badLines ?? 0,
        bytes: s.bytes ?? 0,
        trailingPartial: s.trailingPartial ?? false,
      })
    }
  }

  return buildSession(files, mainPath, keepText, t0)
}

interface PendingTool {
  call: ToolCall
  msg: Message
}

function buildSession(files: FileInput[], mainPath: string, keepText: boolean, t0: number): Session {
  const recordCounts: CountMap = new Map()
  const unknownRecordTypes: CountMap = new Map()
  const unknownBlockTypes: CountMap = new Map()
  const warnings = new Map<string, ParseWarning>()
  const warn = (code: string, message: string, line?: number) => {
    const w = warnings.get(code)
    if (w) w.count++
    else warnings.set(code, { code, message, count: 1, sampleLine: line })
  }

  const KNOWN_TYPES = new Set([
    'user', 'assistant', 'system', 'attachment', 'summary', 'last-prompt', 'mode', 'permission-mode', 'custom-title', 'agent-name',
    'queue-operation', 'file-history-snapshot', 'file-history-delta', 'pr-link', 'progress', 'ai-title', 'frame-link', 'relocated',
    'worktree-state', 'started', 'result',
  ])

  const messages: Message[] = []
  const toolCalls: ToolCall[] = []
  const toolByUseId = new Map<string, PendingTool>()
  const agents = new Map<string, AgentRun>()
  const skills: SkillInvocation[] = []
  const hooks: HookRun[] = []
  const compactions: CompactionEvent[] = []
  const usageEvents: UsageEvent[] = []
  const events: SessionEvent[] = []
  const turns: Turn[] = []

  const meta: SessionMeta = {
    sessionId: '',
    source: 'claude-code',
    path: mainPath,
    subagentPaths: files.slice(1).map((f) => f.path),
    gitBranches: [],
    clientVersions: [],
    entrypoints: [],
    permissionModes: [],
    models: [],
    effortLevels: [],
    possiblyLive: false,
    truncatedReads: 0,
  }
  const attachmentTypes: CountMap = new Map()
  const attachmentBytes: CountMap = new Map()
  const systemSubtypes: CountMap = new Map()
  const queueOperations: CountMap = new Map()
  let enqueueHuman = 0
  let enqueueNotification = 0
  const deferredToolNames = new Set<string>()
  // per provider message id: diagnostics/thinking are carried on some chunks only, so first non-null / max wins
  const cacheMissByProviderMsg = new Map<string, CacheMissReason>()
  const thinkingByProviderMsg = new Map<string, number>()
  const prByNumber = new Map<string, SessionEvent>()
  const setAdd = (list: string[], v: string | undefined) => {
    if (v && !list.includes(v)) list.push(v)
  }

  // dedupe streamed chunks: last record per provider message id wins for usage
  const lastRecordForProviderMsg = new Map<string, number>() // providerMessageId -> messages[] index

  let currentTurn: Turn | undefined
  let mainTurnIndex = -1
  const agentTurnIndex = new Map<string, number>()
  let firstTs: number | undefined
  let lastTs: number | undefined
  let firstPromptPreview: string | undefined
  let lastNonPromptTs: number | undefined // end of previous turn for humanGap
  let pendingAskCount = 0

  const seenSessionIds = new Set<string>()
  const seenUuids = new Set<string>()
  const pendingTeammateLinks: Array<{ toolUseId: string; name: string; teamName?: string; parentAgentId?: string; turnIndex?: number; reportedTotalTokens?: number; reportedDurationMs?: number; status?: string; endTs?: number; startTs?: number; description?: string }> = []
  let pendingBoundary: CompactionEvent | undefined
  const hiddenIterations: Array<{ messageUuid: string; iterations: Array<{ model?: string; usage: Usage; type?: string }> }> = []

  for (const f of files) {
    const isSub = f.index > 0
    let subAgentId = f.agentIdHint
    if (isSub && f.meta) {
      // meta.json: agentType, description, name, spawnDepth, model, taskKind, teamName, color, permissionMode
      const id = subAgentId ?? `agent-${f.index}`
      const run = ensureAgent(agents, id)
      run.agentType = str(f.meta['agentType']) ?? run.agentType
      run.description = str(f.meta['description']) ?? run.description
      run.name = str(f.meta['name']) ?? run.name
      run.model = str(f.meta['model']) ?? run.model
      run.spawnDepth = num(f.meta['spawnDepth']) ?? run.spawnDepth
      run.taskKind = str(f.meta['taskKind']) ?? run.taskKind
      run.teamName = str(f.meta['teamName']) ?? run.teamName
      run.transcriptPath = f.path
    }

    for (let ri = 0; ri < f.records.length; ri++) {
      const r = f.records[ri] as JsonObject
      const line = f.lineNumbers?.[ri] ?? ri + 1
      const type = str(r['type']) ?? 'unknown'
      addCount(recordCounts, type)
      if (!KNOWN_TYPES.has(type)) addCount(unknownRecordTypes, type)

      const sid = str(r['sessionId'])
      if (sid) seenSessionIds.add(sid)
      if (!meta.sessionId && sid && !isSub) meta.sessionId = sid
      setAdd(meta.gitBranches, str(r['gitBranch']))
      setAdd(meta.clientVersions, str(r['version']))
      setAdd(meta.entrypoints, str(r['entrypoint']))
      if (!meta.cwd) meta.cwd = str(r['cwd'])

      const t = ts(r['timestamp'])
      if (t !== undefined) {
        if (firstTs === undefined || t < firstTs) firstTs = t
        if (lastTs === undefined || t > lastTs) lastTs = t
      }

      // ---- non-message records ----
      if (type === 'custom-title') {
        meta.customTitle = str(r['customTitle']) ?? meta.customTitle
        continue
      }
      if (type === 'agent-name') {
        meta.agentName = str(r['agentName']) ?? meta.agentName
        continue
      }
      if (type === 'ai-title') {
        meta.aiTitle = str(r['aiTitle']) ?? meta.aiTitle
        continue
      }
      if (type === 'relocated') {
        meta.relocatedCwd = str(r['relocatedCwd']) ?? meta.relocatedCwd
        continue
      }
      if (type === 'worktree-state') {
        meta.worktree = true
        continue
      }
      if (type === 'frame-link') {
        events.push({ kind: 'other', ts: t, turnIndex: mainTurnIndex, label: 'frame link', detail: str(r['path']) })
        continue
      }
      if (type === 'permission-mode') {
        setAdd(meta.permissionModes, str(r['permissionMode']))
        continue
      }
      if (type === 'pr-link') {
        // re-emitted on every turn while a PR is in play: dedupe by number, first occurrence wins
        const key = String(r['prNumber'] ?? r['prUrl'] ?? '?')
        if (!prByNumber.has(key)) {
          const ev: SessionEvent = { kind: 'pr_link', ts: t, turnIndex: mainTurnIndex, label: `PR #${key}`, detail: str(r['prUrl']) }
          prByNumber.set(key, ev)
          events.push(ev)
        }
        continue
      }
      if (type === 'summary') {
        // conversation summary written on resume/compaction in some versions
        continue
      }
      if (type === 'attachment') {
        const a = obj(r['attachment'])
        const at = str(a?.['type']) ?? 'unknown'
        addCount(attachmentTypes, at)
        addCount(attachmentBytes, at, bytesOf(a))
        if (at.startsWith('hook')) {
          // a hook_success attachment is a context-injection notice with no timing; the authoritative,
          // timed Stop-hook records come from the stop_hook_summary system record. Only record non-Stop
          // hook events here (SessionStart/UserPromptSubmit/PreToolUse...), and mark failures.
          const he = str(a?.['hookEvent'])
          if (he && he !== 'Stop') {
            hooks.push({ hookEvent: he, hookName: str(a?.['hookName']), ok: at !== 'hook_error' && at !== 'hook_failure', ts: t, turnIndex: mainTurnIndex })
          }
        } else if (at === 'skill_listing' && !isSub) {
          const names = (arr(a?.['names']) ?? []).filter((x): x is string => typeof x === 'string')
          const count = num(a?.['skillCount']) ?? names.length
          if (!meta.skillsAvailable || bool(a?.['isInitial'])) meta.skillsAvailable = { count, names }
        } else if (at === 'read_truncation_notice') {
          meta.truncatedReads++
        } else if (at === 'deferred_tools_delta') {
          for (const key of ['addedNames', 'readdedNames']) for (const n of arr(a?.[key]) ?? []) if (typeof n === 'string') deferredToolNames.add(n)
        } else if (at === 'queued_command') {
          events.push({ kind: 'other', ts: t, turnIndex: mainTurnIndex, label: 'queued command', detail: str(a?.['commandMode']) })
        } else if (at === 'ultra_effort_enter' || at === 'ultra_effort_exit' || at === 'plan_mode_exit') {
          events.push({ kind: at === 'plan_mode_exit' ? 'plan_mode' : 'other', ts: t, turnIndex: mainTurnIndex, label: at })
        }
        continue
      }
      if (type === 'queue-operation') {
        const op = str(r['operation']) ?? 'unknown'
        addCount(queueOperations, op)
        if (op === 'enqueue') {
          const content = str(r['content']) ?? ''
          const isNotification = NOTIFICATION_ENQUEUE_RE.test(content)
          if (isNotification) enqueueNotification++
          else enqueueHuman++
          events.push({ kind: 'other', ts: t, turnIndex: mainTurnIndex, label: isNotification ? 'queued notification' : 'queued message', detail: preview(content, 100) })
        }
        continue
      }
      if (type !== 'user' && type !== 'assistant' && type !== 'system') continue

      // ---- messages ----
      const recUuid = str(r['uuid'])
      if (recUuid) {
        if (seenUuids.has(recUuid)) {
          warn('duplicate_uuid', 'record uuid written more than once (superseded rewrite); first occurrence kept', line)
          continue
        }
        seenUuids.add(recUuid)
      }
      const isSidechain = bool(r['isSidechain']) || isSub
      const agentId = str(r['agentId']) ?? (isSub ? subAgentId : undefined)
      if (isSub && !subAgentId && agentId) subAgentId = agentId
      const message = obj(r['message'])
      const role: Message['role'] = type === 'system' ? 'system' : ((str(message?.['role']) as Message['role'] | undefined) ?? (type as 'user' | 'assistant'))
      const content = message?.['content']
      const blocks = type === 'system' ? [] : parseBlocks(content, keepText, unknownBlockTypes)
      const hasToolResult = blocks.some((b) => b.kind === 'tool_result')
      const isMeta = bool(r['isMeta'])
      const isCompactSummary = bool(r['isCompactSummary'])
      const text = type === 'system' ? (str(r['content']) ?? '') : textOfContent(content)
      const cmd = COMMAND_RE.exec(text)?.[1]
      const interrupted = INTERRUPT_RE.test(text)
      const isPromptLike = type === 'user' && !hasToolResult && !isCompactSummary && !!message
      const promptKind: PromptKind | undefined = isPromptLike ? classifyPrompt(r, text, isMeta) : undefined
      const startsTurn = !!promptKind && TURN_STARTING_KINDS.has(promptKind)
      const isHumanPrompt = startsTurn && !isSidechain
      const isAgentPrompt = startsTurn && isSidechain && !isMeta

      // turn bookkeeping (main thread)
      if (isHumanPrompt) {
        mainTurnIndex++
        const prevEnd = currentTurn?.endTs ?? lastNonPromptTs
        currentTurn = {
          index: mainTurnIndex,
          kind: promptKind ?? 'human',
          startTs: t,
          promptPreview: preview(text),
          promptChars: text.length,
          commandName: cmd,
          messageUuids: [],
          toolCallIds: [],
          agentIds: [],
          usage: emptyUsage(),
          models: [],
          isCommand: promptKind === 'command',
          interrupted: false,
          autoContinuations: 0,
          humanGapMs: prevEnd !== undefined && t !== undefined && t >= prevEnd ? t - prevEnd : undefined,
        }
        turns.push(currentTurn)
        if (!firstPromptPreview && promptKind === 'human') firstPromptPreview = currentTurn.promptPreview
        if (cmd) skills.push({ name: cmd, via: 'command', turnIndex: mainTurnIndex, ts: t, args: preview(text.replace(COMMAND_RE, ''), 80) || undefined })
      } else if (promptKind && !isSidechain && (promptKind === 'notification' || promptKind === 'local_output') && currentTurn) {
        currentTurn.autoContinuations++
      } else if (isAgentPrompt && agentId) {
        agentTurnIndex.set(agentId, (agentTurnIndex.get(agentId) ?? -1) + 1)
        const run = ensureAgent(agents, agentId)
        if (run.startTs === undefined || (t !== undefined && t < run.startTs)) run.startTs = t
      }
      const turnIndex = agentId ? (agentTurnIndex.get(agentId) ?? 0) : mainTurnIndex

      const usage = type === 'assistant' ? parseUsage(message?.['usage']) : undefined
      const model = str(message?.['model'])
      const iters = type === 'assistant' ? arr(obj(message?.['usage'])?.['iterations']) : undefined
      const providerMessageId = str(message?.['id'])
      let cacheMissReason: CacheMissReason | undefined
      let thinkingTokens: number | undefined
      if (type === 'assistant') {
        const cmr = obj(obj(message?.['diagnostics'])?.['cache_miss_reason'])
        if (cmr) cacheMissReason = { type: str(cmr['type']) ?? 'unknown', missedInputTokens: num(cmr['cache_missed_input_tokens']) }
        thinkingTokens = num(obj(obj(message?.['usage'])?.['output_tokens_details'])?.['thinking_tokens'])
        if (providerMessageId) {
          if (cacheMissReason && !cacheMissByProviderMsg.has(providerMessageId)) cacheMissByProviderMsg.set(providerMessageId, cacheMissReason)
          if (thinkingTokens !== undefined) {
            const prevTh = thinkingByProviderMsg.get(providerMessageId)
            if (prevTh === undefined || thinkingTokens > prevTh) thinkingByProviderMsg.set(providerMessageId, thinkingTokens)
          }
        }
      }
      const apiErr = bool(r['isApiErrorMessage']) || r['error'] !== undefined
      const msg: Message = {
        uuid: str(r['uuid']) ?? `${f.index}:${line}`,
        parentUuid: str(r['parentUuid']),
        role,
        ts: t,
        turnIndex,
        agentId,
        isSidechain,
        isMeta,
        isCompactSummary,
        isToolResultCarrier: hasToolResult,
        isHumanPrompt,
        promptKind,
        blocks,
        model,
        effort: str(r['effort']),
        requestId: str(r['requestId']),
        providerMessageId,
        stopReason: str(message?.['stop_reason']),
        usage,
        usageCounted: false,
        preview: preview(text || blocks.map((b) => (b.kind === 'tool_use' ? `[${b.name}]` : b.kind === 'thinking' ? '[thinking]' : b.kind === 'tool_result' ? '[result]' : '')).join(' ')),
        line,
        fileIndex: f.index,
        systemSubtype: type === 'system' ? str(r['subtype']) : undefined,
        commandName: cmd,
        interrupted,
        apiError: apiErr ? { status: (r['apiErrorStatus'] as number | string | undefined), message: preview(str(r['error']) ?? text, 200) } : undefined,
        attribution:
          type === 'assistant' && (r['attributionSkill'] !== undefined || r['attributionPlugin'] !== undefined || r['attributionMcpServer'] !== undefined || r['attributionAgent'] !== undefined)
            ? { skill: str(r['attributionSkill']), plugin: str(r['attributionPlugin']), mcpServer: str(r['attributionMcpServer']), mcpTool: str(r['attributionMcpTool']), agent: str(r['attributionAgent']) }
            : undefined,
        thinkingTokens,
        cacheMissReason,
      }
      const mi = messages.length
      messages.push(msg)
      if (iters && iters.length > 1) {
        const list: Array<{ model?: string; usage: Usage; type?: string }> = []
        for (let k = 0; k < iters.length - 1; k++) {
          const io = obj(iters[k])
          const iu = parseUsage(io)
          if (iu) list.push({ model: str(io?.['model']), usage: iu, type: str(io?.['type']) })
        }
        if (list.length) hiddenIterations.push({ messageUuid: msg.uuid, iterations: list })
      }
      if (!agentId && currentTurn) currentTurn.messageUuids.push(msg.uuid)
      if (interrupted) {
        if (currentTurn && !agentId) currentTurn.interrupted = true
        events.push({ kind: 'interrupt', ts: t, turnIndex, agentId, label: 'Request interrupted by user' })
      }
      for (const b of blocks) {
        if (b.kind === 'other' && b.rawType === 'fallback') events.push({ kind: 'model_fallback', ts: t, turnIndex, agentId, label: b.note ?? 'model fallback' })
      }
      if (apiErr) events.push({ kind: 'api_error', ts: t, turnIndex, agentId, label: `API error${msg.apiError?.status ? ' ' + String(msg.apiError.status) : ''}`, detail: msg.apiError?.message })
      if (isCompactSummary) {
        if (pendingBoundary && pendingBoundary.summaryChars === undefined) {
          pendingBoundary.summaryChars = text.length
          pendingBoundary = undefined
        } else {
          compactions.push({ ts: t, turnIndex, trigger: 'unknown', summaryChars: text.length })
        }
      }
      if (type === 'system') {
        const sub = msg.systemSubtype
        addCount(systemSubtypes, sub ?? 'unknown')
        if (sub === 'compact_boundary') {
          const cm = obj(r['compactMetadata'])
          const ev: CompactionEvent = {
            ts: t,
            turnIndex,
            trigger: str(cm?.['trigger']) ?? 'unknown',
            contextBefore: num(cm?.['preTokens']),
            contextAfter: num(cm?.['postTokens']),
            durationMs: num(cm?.['durationMs']),
            cumulativeDroppedTokens: num(cm?.['cumulativeDroppedTokens']),
          }
          compactions.push(ev)
          pendingBoundary = ev
        } else if (sub === 'turn_duration') {
          if (currentTurn && !agentId) currentTurn.reportedDurationMs = num(r['durationMs'])
        } else if (sub === 'stop_hook_summary') {
          for (const h of arr(r['hookInfos']) ?? []) {
            const ho = obj(h)
            hooks.push({ hookEvent: 'Stop', command: str(ho?.['command']), durationMs: num(ho?.['durationMs']), ok: true, ts: t, turnIndex })
          }
          for (const e of arr(r['hookErrors']) ?? []) {
            const eo = obj(e)
            hooks.push({ hookEvent: 'Stop', command: str(eo?.['command']) ?? preview(String(e), 80), ok: false, ts: t, turnIndex })
          }
        } else if (sub === 'scheduled_task_fire') {
          events.push({ kind: 'scheduled_fire', ts: t, turnIndex, label: str(r['cronKind']) ?? 'scheduled', detail: preview(text, 120) })
        } else if (sub === 'away_summary') {
          events.push({ kind: 'away_summary', ts: t, turnIndex, label: 'away summary', detail: preview(text, 200) })
        } else if (sub === 'api_error' || sub === 'api_retry') {
          events.push({ kind: 'api_error', ts: t, turnIndex, label: sub, detail: preview(text, 200) })
        }
        continue
      }

      // ---- assistant: usage, tool_use ----
      if (type === 'assistant') {
        setAdd(meta.models, model)
        setAdd(meta.effortLevels, msg.effort)
        if (currentTurn && !agentId && model && !currentTurn.models.includes(model)) currentTurn.models.push(model)
        if (usage && providerMessageId) {
          // chunks of one API response repeat the usage; pick the record with a stop_reason (final chunk),
          // else the one with the largest output_tokens, else the last one seen (subagent files can carry partial usage)
          const prev = lastRecordForProviderMsg.get(providerMessageId)
          const prevMsg = prev !== undefined ? (messages[prev] as Message) : undefined
          const better = !prevMsg || (!prevMsg.stopReason && !!msg.stopReason) || (!!prevMsg.stopReason === !!msg.stopReason && (usage.output >= (prevMsg.usage?.output ?? 0)))
          if (better) {
            if (prevMsg) prevMsg.usageCounted = false
            lastRecordForProviderMsg.set(providerMessageId, mi)
          }
        }
        msg.usageCounted = !!usage && model !== '<synthetic>'
        for (const b of blocks) {
          if (b.kind !== 'tool_use') continue
          const name = b.name
          const call: ToolCall = {
            toolUseId: b.toolUseId,
            name,
            category: categorizeTool(name),
            input: b.input,
            inputSummary: summarizeToolInput(name, b.input),
            inputBytes: bytesOf(b.input),
            messageUuid: msg.uuid,
            turnIndex,
            agentId,
            startTs: t,
            isError: false,
            unresolved: true,
            parallelGroupSize: 1,
            skillName: name === 'Skill' ? skillNameFromInput(b.input) : undefined,
          }
          toolCalls.push(call)
          if (b.toolUseId) toolByUseId.set(b.toolUseId, { call, msg })
          if (currentTurn && !agentId) currentTurn.toolCallIds.push(b.toolUseId)
          if (name === 'Skill' && call.skillName) skills.push({ name: call.skillName, via: 'tool', turnIndex, ts: t, agentId, args: str(obj(b.input)?.['args']) })
          if (name === 'AskUserQuestion') pendingAskCount++
          if (name === 'EnterPlanMode' || name === 'ExitPlanMode') events.push({ kind: 'plan_mode', ts: t, turnIndex, agentId, label: name })
          if (agentId) {
            const run = ensureAgent(agents, agentId)
            run.toolCallCount++
          }
        }
        if (agentId) {
          const run = ensureAgent(agents, agentId)
          run.messageCount++
          if (model && !run.model) run.model = model
        }
        continue
      }

      // ---- user: tool results, meta ----
      if (type === 'user') {
        if (agentId && !hasToolResult) {
          const run = ensureAgent(agents, agentId)
          run.messageCount++
        }
        for (const b of blocks) {
          if (b.kind !== 'tool_result') continue
          const p = toolByUseId.get(b.toolUseId)
          if (!p) {
            warn('orphan_tool_result', 'tool_result without a matching tool_use', line)
            continue
          }
          const c = p.call
          c.endTs = t
          c.durationMs = t !== undefined && c.startTs !== undefined && t >= c.startTs ? t - c.startTs : undefined
          c.resultBytes = b.bytes
          c.isError = b.isError
          c.unresolved = false
          c.resultPreview = preview(b.text, 200)
          const tur = r['toolUseResult']
          c.resultMeta = tur
          const turo = obj(tur)
          if (typeof tur === 'string' && /^error/i.test(tur)) c.isError = true
          if (turo) {
            if (bool(turo['interrupted'])) c.errorHint = 'interrupted'
            if (bool(obj(turo['file'])?.['truncatedByTokenCap'])) c.truncated = true
            const exit = num(turo['exitCode']) ?? num(turo['exit_code'])
            if (exit !== undefined && exit !== 0) {
              c.isError = true
              c.errorHint = `exit ${exit}`
            }
            if (typeof turo['stderr'] === 'string' && turo['stderr'] && c.isError && !c.errorHint) c.errorHint = preview(turo['stderr'], 120)
            // Agent tool: link the spawned agent to this tool call.
            // In-process subagents report `agentId` (the sidecar hash id). Teammate spawns instead report
            // status=teammate_spawned with agent_id/teammate_id = "<name>@<team>" and name/team_name, and those
            // don't match the sidecar filename, so we defer them and match by (name, teamName) in pass two.
            if (c.name === 'Agent' || c.name === 'Task') {
              const aid = str(turo['agentId'])
              if (aid) {
                c.spawnedAgentId = aid
                const run = ensureAgent(agents, aid)
                run.spawnedByToolUseId = c.toolUseId
                run.parentAgentId = agentId
                const inp = obj(c.input)
                run.description = run.description ?? str(inp?.['description'])
                run.agentType = run.agentType ?? str(inp?.['subagent_type'])
                run.name = run.name ?? str(inp?.['name'])
                run.reportedTotalTokens = num(turo['totalTokens'])
                run.reportedDurationMs = num(turo['totalDurationMs'])
                run.status = str(turo['status'])
                if (run.endTs === undefined) run.endTs = t
                if (run.startTs === undefined) run.startTs = c.startTs
                const u = parseUsage(turo['usage'])
                if (u && run.messageCount === 0) run.usage = u
                if (currentTurn && !agentId && !currentTurn.agentIds.includes(aid)) currentTurn.agentIds.push(aid)
              } else {
                const name = str(turo['name'])
                const teamName = str(turo['team_name']) ?? str(turo['teamName'])
                if (name) {
                  pendingTeammateLinks.push({
                    toolUseId: c.toolUseId,
                    name,
                    teamName,
                    parentAgentId: agentId,
                    turnIndex: !agentId && currentTurn ? currentTurn.index : undefined,
                    reportedTotalTokens: num(turo['totalTokens']),
                    reportedDurationMs: num(turo['totalDurationMs']),
                    status: str(turo['status']),
                    endTs: t,
                    startTs: c.startTs,
                    description: str(obj(c.input)?.['description']),
                  })
                }
              }
            }
          }
          if (c.isError && !c.errorHint) c.errorHint = preview(b.text, 120)
        }
        if (isHumanPrompt || isMeta) {
          // nothing else
        }
        if (!isHumanPrompt) lastNonPromptTs = t ?? lastNonPromptTs
        continue
      }
    }
  }

  // ---- second pass: usage events, turn usage, parallel groups, agent aggregation ----
  const groupCount = new Map<string, number>() // providerMessageId -> tool_use count
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.providerMessageId) continue
    const n = m.blocks.filter((b) => b.kind === 'tool_use').length
    if (n) groupCount.set(m.providerMessageId, (groupCount.get(m.providerMessageId) ?? 0) + n)
  }
  const msgByUuid = new Map(messages.map((m) => [m.uuid, m]))
  // resolve teammate spawns: match toolUseResult.name(+team_name) to the sidecar agent loaded from meta.json
  if (pendingTeammateLinks.length) {
    const byNameTeam = new Map<string, AgentRun>()
    for (const run of agents.values()) if (run.name) byNameTeam.set(run.name + '\u0000' + (run.teamName ?? ''), run)
    for (const link of pendingTeammateLinks) {
      const run = byNameTeam.get(link.name + '\u0000' + (link.teamName ?? '')) ?? [...agents.values()].find((r) => r.name === link.name)
      if (!run) continue
      const call = toolByUseId.get(link.toolUseId)?.call
      if (call) call.spawnedAgentId = run.agentId
      run.spawnedByToolUseId = run.spawnedByToolUseId ?? link.toolUseId
      run.parentAgentId = run.parentAgentId ?? link.parentAgentId
      run.status = run.status ?? link.status
      run.reportedTotalTokens = run.reportedTotalTokens ?? link.reportedTotalTokens
      run.reportedDurationMs = run.reportedDurationMs ?? link.reportedDurationMs
      run.description = run.description ?? link.description
      if (run.startTs === undefined) run.startTs = link.startTs
      if (run.endTs === undefined) run.endTs = link.endTs
      if (link.turnIndex !== undefined) {
        const turn = turns[link.turnIndex]
        if (turn && !turn.agentIds.includes(run.agentId)) turn.agentIds.push(run.agentId)
      }
    }
  }
  for (const c of toolCalls) {
    const m = msgByUuid.get(c.messageUuid)
    const pid = m?.providerMessageId
    if (pid) c.parallelGroupSize = groupCount.get(pid) ?? 1
  }

  const agentsWithTranscriptUsage = new Set<string>()
  for (const [idx, m] of messages.entries()) {
    if (m.role !== 'assistant' || !m.usage) continue
    // dedupe: only the last chunk per provider message id counts (index carried from the loop, so no O(n²) indexOf)
    if (m.providerMessageId) {
      const lastIdx = lastRecordForProviderMsg.get(m.providerMessageId)
      m.usageCounted = lastIdx === idx && m.model !== '<synthetic>'
    }
    if (!m.usageCounted) continue
    const u = m.usage
    const evCacheMiss = (m.providerMessageId ? cacheMissByProviderMsg.get(m.providerMessageId) : undefined) ?? m.cacheMissReason
    const evThinking = (m.providerMessageId ? thinkingByProviderMsg.get(m.providerMessageId) : undefined) ?? m.thinkingTokens
    usageEvents.push({ messageUuid: m.uuid, ts: m.ts, turnIndex: m.turnIndex, agentId: m.agentId, model: m.model ?? 'unknown', effort: m.effort, attribution: m.attribution, usage: u, contextSize: u.input + u.cacheRead + u.cacheWrite, thinkingTokens: evThinking, cacheMissReason: evCacheMiss })
    if (m.agentId) {
      const run = ensureAgent(agents, m.agentId)
      // transcript usage replaces the parent's single-call summary the first time we see it
      if (!agentsWithTranscriptUsage.has(m.agentId)) {
        agentsWithTranscriptUsage.add(m.agentId)
        run.usage = u
      } else run.usage = addUsage(run.usage, u)
    } else {
      const turn = turns[m.turnIndex]
      if (turn) turn.usage = addUsage(turn.usage, u)
    }
  }
  // hidden earlier attempts (fallback_message etc.): billed on their own model, only for the counted chunk
  const countedUuids = new Set(usageEvents.map((u) => u.messageUuid))
  for (const h of hiddenIterations) {
    if (!countedUuids.has(h.messageUuid)) continue
    const m = msgByUuid.get(h.messageUuid)
    if (!m) continue
    h.iterations.forEach((it, idx) => {
      usageEvents.push({ messageUuid: m.uuid, ts: m.ts, turnIndex: m.turnIndex, agentId: m.agentId, model: it.model ?? m.model ?? 'unknown', effort: m.effort, usage: it.usage, contextSize: it.usage.input + it.usage.cacheRead + it.usage.cacheWrite, hiddenIteration: { index: idx, type: it.type } })
      if (m.agentId) {
        const run = ensureAgent(agents, m.agentId)
        run.usage = addUsage(run.usage, it.usage)
      } else {
        const turn = turns[m.turnIndex]
        if (turn) turn.usage = addUsage(turn.usage, it.usage)
      }
    })
  }
  // agent runs: usage from the subagent transcript when we had one. For a no-transcript agent (teammate,
  // async) the parent only reports `totalTokens`, which is the agent's FINAL context size, not its
  // consumption. Pricing that at any token rate is wrong in both directions and trips reconciliation.
  // So we leave usage at zero (cost shown as unknown/summary-only) and keep reportedTotalTokens as metadata.
  for (const run of agents.values()) {
    if (run.startTs !== undefined && run.endTs !== undefined && run.endTs >= run.startTs) run.durationMs = run.endTs - run.startTs
    else if (run.reportedDurationMs !== undefined) run.durationMs = run.reportedDurationMs
  }
  // agent end from last message ts in its transcript
  for (const m of messages) {
    if (!m.agentId || m.ts === undefined) continue
    const run = agents.get(m.agentId)
    if (!run) continue
    if (run.endTs === undefined || m.ts > run.endTs) run.endTs = m.ts
    if (run.startTs === undefined || m.ts < run.startTs) run.startTs = m.ts
  }
  for (const run of agents.values()) {
    if (run.startTs !== undefined && run.endTs !== undefined && run.endTs >= run.startTs) run.durationMs = run.endTs - run.startTs
  }

  // turn boundaries: endTs = ts of last main-thread message before the next prompt; firstResponse
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] as Turn
    let end: number | undefined
    let firstAssistant: number | undefined
    for (const uuid of turn.messageUuids) {
      const m = msgByUuid.get(uuid)
      if (!m || m.ts === undefined) continue
      if (end === undefined || m.ts > end) end = m.ts
      if (m.role === 'assistant' && (firstAssistant === undefined || m.ts < firstAssistant)) firstAssistant = m.ts
    }
    // tool results / agents can extend past the last message: include tool endTs
    for (const id of turn.toolCallIds) {
      const c = toolByUseId.get(id)?.call
      if (c?.endTs !== undefined && (end === undefined || c.endTs > end)) end = c.endTs
    }
    turn.endTs = end
    turn.durationMs = end !== undefined && turn.startTs !== undefined && end >= turn.startTs ? end - turn.startTs : undefined
    turn.firstResponseMs = firstAssistant !== undefined && turn.startTs !== undefined && firstAssistant >= turn.startTs ? firstAssistant - turn.startTs : undefined
  }
  // human gap = this prompt - previous turn end
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1] as Turn
    const cur = turns[i] as Turn
    if (prev.endTs !== undefined && cur.startTs !== undefined && cur.startTs >= prev.endTs) cur.humanGapMs = cur.startTs - prev.endTs
  }

  if (pendingAskCount) events.push({ kind: 'permission_prompt', turnIndex: -1, label: `AskUserQuestion x${pendingAskCount}` })

  meta.startedAt = firstTs
  meta.endedAt = lastTs
  meta.wallMs = firstTs !== undefined && lastTs !== undefined ? lastTs - firstTs : undefined
  meta.title = meta.customTitle ?? meta.aiTitle ?? firstPromptPreview ?? turns[0]?.promptPreview
  if (!meta.sessionId) meta.sessionId = basename(mainPath, '.jsonl')
  if (files[0]?.trailingPartial) meta.possiblyLive = true
  if (seenSessionIds.size > 1) warn('multiple_session_ids', `records reference ${seenSessionIds.size} distinct sessionIds (resumed/forked session)`)
  if (queueOperations.size) meta.queueOperations = countRecord(queueOperations)
  if (enqueueHuman || enqueueNotification) meta.enqueueKinds = { human: enqueueHuman, notification: enqueueNotification }
  if (deferredToolNames.size) meta.deferredToolNames = [...deferredToolNames].sort()
  meta.projectSlug = mainPath !== '(memory)' ? basename(dirname(mainPath)) : undefined
  if (meta.projectSlug && !meta.projectSlug.startsWith('-') && !/^[A-Za-z]-/.test(meta.projectSlug)) meta.projectSlug = undefined

  const parseReport: ParseReport = {
    totalLines: files.reduce((a, f) => a + f.totalLines, 0),
    badLines: files.reduce((a, f) => a + f.badLines, 0),
    recordCounts: countRecord(recordCounts),
    unknownRecordTypes: countRecord(unknownRecordTypes),
    unknownBlockTypes: countRecord(unknownBlockTypes),
    attachmentTypes: countRecord(attachmentTypes),
    attachmentBytes: countRecord(attachmentBytes),
    systemSubtypes: countRecord(systemSubtypes),
    warnings: [...warnings.values()],
    parseMs: Date.now() - t0,
    bytes: files.reduce((a, f) => a + f.bytes, 0),
  }
  const unresolved = toolCalls.filter((c) => c.unresolved).length
  if (unresolved) parseReport.warnings.push({ code: 'unresolved_tool_calls', message: 'tool_use without a tool_result (interrupted or still running)', count: unresolved })

  return {
    meta,
    turns,
    messages,
    toolCalls,
    agents: [...agents.values()].sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0)),
    skills,
    hooks,
    compactions,
    usageEvents,
    events,
    parseReport,
  }
}

function ensureAgent(map: Map<string, AgentRun>, id: string): AgentRun {
  let run = map.get(id)
  if (!run) {
    run = { agentId: id, spawnDepth: 0, messageCount: 0, toolCallCount: 0, usage: emptyUsage() }
    map.set(id, run)
  }
  return run
}
