/**
 * The Analysis model = orangu's public API.
 *
 * `orangu analyze --json` emits exactly this object. The HTML report renders it. The agentic skills read it
 * (never the raw transcript). CI asserts on it. Treat changes as API changes: bump `schemaVersion`.
 *
 * Principles:
 * - components, never a composite score: every number is traceable to records
 * - tokens are the only usage metric orangu reports: input, cache read, cache write, output, and
 *   sums of those. There is no money anywhere in this shape, by rule. A token count is something
 *   the transcript actually recorded; a currency figure would be something we made up.
 * - time in ms, effort as S/M/L, tokens as raw integers
 */
import type { ParseReport, PromptKind, Usage } from './session.js'

export const ANALYSIS_SCHEMA_VERSION = '2'

export interface AnalysisSessionInfo {
  id: string
  title?: string
  source: string
  path: string
  subagentPaths: string[]
  cwd?: string
  projectSlug?: string
  gitBranches: string[]
  clientVersions: string[]
  entrypoints: string[]
  permissionModes: string[]
  models: ModelInfo[]
  effortLevels: string[]
  startedAt?: number
  endedAt?: number
  live: boolean
}

export interface ModelInfo {
  id: string
  displayName: string
  family: string
  /** the model *id* was matched by alias/family fallback, so the name and window are approximate */
  estimatedMatch: boolean
  contextWindow?: number
}

export interface Outcomes {
  prLinks: Array<{ label: string; url?: string; turnIndex: number }>
  gitCommits: number
  testRuns: number
  testRunsFailed: number
  buildRuns: number
  buildRunsFailed: number
  filesRead: number
  filesEdited: number
  filesWritten: number
  webLookups: number
}

export interface Summary {
  turns: number
  humanTurns: number
  messages: number
  assistantMessages: number
  toolCalls: number
  toolErrors: number
  agents: number
  skills: number
  compactions: number
  wallMs?: number
  /** time the assistant was working (sum of turn durations, main thread) */
  activeMs: number
  /** time spent waiting for the human between turns */
  humanWaitMs: number
  tokens: Usage
  /** input + output + cacheRead + cacheWrite: the session's headline token number */
  totalTokens: number
  contextPeak: number
  cacheHitRatio: number
  outcomes: Outcomes
  /** the 3 highest-impact insights, by id */
  topInsightIds: string[]
  /** one-paragraph deterministic narrative for non-technical readers */
  narrative: string
  /**
   * How the session ended (additive, v1). Precedence: interrupted > failing > clean > unknown.
   * interrupted = the last turn was interrupted; failing = the last test/build run did not pass;
   * clean = the last test/build run passed; unknown = no test/build run at all.
   */
  ending: SessionEnding
}

export type SessionEnding = 'clean' | 'interrupted' | 'failing' | 'unknown'

export interface TurnAnalysis {
  index: number
  kind: PromptKind
  isCommand: boolean
  commandName?: string
  promptPreview: string
  promptChars: number
  startTs?: number
  endTs?: number
  durationMs?: number
  reportedDurationMs?: number
  firstResponseMs?: number
  humanGapMs?: number
  autoContinuations: number
  interrupted: boolean
  toolCalls: number
  toolErrors: number
  toolMs: number
  agents: string[]
  models: string[]
  tokens: Usage
  contextEnd?: number
  /** this turn's tokens plus the tokens of every agent it spawned */
  totalTokens: number
  /** insight ids anchored to this turn */
  insightIds: string[]
  /** compact activity string for the timeline, e.g. "Read×3 Bash×2 Edit" */
  activity: string
}

export interface ToolStat {
  name: string
  category: string
  count: number
  errors: number
  unresolved: number
  totalMs: number
  avgMs: number
  p95Ms: number
  maxMs: number
  resultBytesTotal: number
  resultBytesMax: number
  inputBytesTotal: number
  /** share of calls issued in a parallel group (>1 tool_use in the same message) */
  parallelShare: number
  /** count in the main thread vs inside agents */
  mainCount: number
  agentCount: number
}

export interface ToolErrorGroup {
  name: string
  signature: string
  count: number
  sampleTurnIndex: number
  sampleHint?: string
}

export interface ToolCallView {
  toolUseId: string
  name: string
  category: string
  summary: string
  turnIndex: number
  agentId?: string
  startTs?: number
  durationMs?: number
  resultBytes?: number
  isError: boolean
  errorHint?: string
  parallelGroupSize: number
}

export interface ToolsAnalysis {
  byName: ToolStat[]
  byCategory: Array<{ category: string; count: number; totalMs: number; errors: number }>
  errorGroups: ToolErrorGroup[]
  slowest: ToolCallView[]
  largestResults: ToolCallView[]
  parallelism: { groups: number; parallelGroups: number; maxGroupSize: number; parallelCallShare: number }
  /** all calls, ordered, for the timeline and explorer */
  calls: ToolCallView[]
}

export interface AgentStat {
  agentId: string
  name?: string
  agentType?: string
  description?: string
  model?: string
  spawnDepth: number
  parentAgentId?: string
  spawnedByToolUseId?: string
  turnIndex?: number
  startTs?: number
  endTs?: number
  durationMs?: number
  messageCount: number
  toolCallCount: number
  toolErrors: number
  tokens: Usage
  totalTokens: number
  reportedTotalTokens?: number
  reportedDurationMs?: number
  status?: string
  transcriptPath?: string
  teamName?: string
  taskKind?: string
  /** true when we had the subagent transcript itself; false when only the parent's summary */
  hasTranscript: boolean
}

export interface AgentsAnalysis {
  runs: AgentStat[]
  totals: { count: number; tokens: Usage; totalTokens: number; durationMs: number; toolCalls: number }
  byType: Array<{ agentType: string; count: number; tokens: number; avgDurationMs: number }>
  byModel: Array<{ model: string; count: number; tokens: number }>
  maxDepth: number
  /** wall time during which at least one agent was running */
  concurrentMs: number
  maxConcurrency: number
  /** share of all tokens spent on the main thread rather than inside agents */
  mainThreadShare: { tokens: number }
}

export interface SkillsAnalysis {
  invocations: Array<{ name: string; via: 'tool' | 'command'; turnIndex: number; ts?: number; agentId?: string; args?: string }>
  byName: Array<{ name: string; count: number; via: Array<'tool' | 'command'>; turnIndexes: number[] }>
}

export interface HooksAnalysis {
  runs: number
  errors: number
  totalMs: number
  byCommand: Array<{ command: string; count: number; totalMs: number; errors: number; hookEvent?: string }>
  events: Array<{ hookEvent: string; count: number }>
}

export interface ContextPoint {
  messageUuid: string
  turnIndex: number
  agentId?: string
  ts?: number
  model: string
  contextSize: number
  input: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  output: number
}

/** one prompt-cache miss with its reported reason (additive, v1 adapter signal) */
export interface CacheMissEvent {
  messageUuid: string
  turnIndex: number
  agentId?: string
  ts?: number
  model: string
  /** messages_changed | previous_message_not_found | unavailable | tools_changed | system_changed | model_changed */
  type: string
  /** tokens re-written because of the miss, when the API reported them */
  missedInputTokens?: number
}

export interface ContextAnalysis {
  series: ContextPoint[]
  /** cache misses with a reported cache_miss_reason (additive, v1) */
  cacheMisses: CacheMissEvent[]
  compactions: Array<{ ts?: number; turnIndex: number; trigger: string; contextBefore?: number; contextAfter?: number }>
  peak: number
  /** context of the first request = system prompt + tools + CLAUDE.md + first prompt */
  baseline: number
  final: number
  contextWindow?: number
  cacheHitRatio: number
  cacheWrite1hShare: number
  /** total tokens the model re-read across the session / peak context; how many times the context was "re-read" */
  reReadMultiplier: number
  totalCacheRead: number
  totalCacheWrite: number
  totalFreshInput: number
  totalOutput: number
  /** requests whose cache write was never followed by a cache read of similar size before compaction (approx.) */
  requestsPerCompaction: number[]
}

export interface TokensAnalysis {
  total: Usage
  /** input + output + cacheRead + cacheWrite */
  totalTokens: number
  byModel: Array<{ model: string; displayName: string; tokens: Usage; totalTokens: number; estimatedMatch: boolean; requests: number }>
  /** token counts per kind; these are the four numbers the API actually reports */
  byKind: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
  mainThread: number
  agents: number
  byTurn: Array<{ turnIndex: number; tokens: number; cumulativeTokens: number }>
  byToolCategory: Array<{ category: string; tokens: number }>
  /** server-tool calls are metered per request, not per token, so they are counted, never converted */
  serverToolRequests: { webSearch: number; webFetch: number }
  /** hidden iterations (usage.iterations beyond the visible response: fallback retries etc.) */
  hiddenIterations: { count: number; tokens: number }
}

export interface TimeAnalysis {
  wallMs?: number
  activeMs: number
  humanWaitMs: number
  toolMs: number
  agentMs: number
  /** activeMs - toolMs - agentWaitMs (approx. model latency + streaming) */
  modelMs: number
  longestTurns: Array<{ turnIndex: number; durationMs: number; preview: string }>
  longestGaps: Array<{ turnIndex: number; gapMs: number }>
  firstResponse: { p50: number; p95: number; max: number }
  hooksMs: number
}

export interface FileStat {
  path: string
  reads: number
  edits: number
  writes: number
  bytesRead: number
  turnIndexes: number[]
  agentReads: number
  /** reads beyond the first WITHIN a single context (main thread, or one subagent). A file read once per
   * subagent across many agents is not redundant, because each agent has fresh context. This is the honest count. */
  redundantReads: number
}

export interface FilesAnalysis {
  files: FileStat[]
  mostReRead: FileStat[]
  totalDistinct: number
  editedThenReverted: number
}

export interface QualitySignal {
  id: string
  label: string
  value: number | string | boolean
  /** 'good' | 'neutral' | 'bad' | 'unknown' */
  tone: 'good' | 'neutral' | 'bad' | 'unknown'
  detail?: string
  evidenceTurnIndexes?: number[]
}

export interface QualityAnalysis {
  signals: QualitySignal[]
  testRuns: Array<{ turnIndex: number; command: string; ok: boolean; agentId?: string }>
  buildRuns: Array<{ turnIndex: number; command: string; ok: boolean }>
  gitCommits: Array<{ turnIndex: number; ok: boolean; message?: string }>
  userCorrections: Array<{ turnIndex: number; preview: string }>
  interruptions: number
  apiErrors: number
  toolErrorRate: number
  reworkFiles: number
}

export type InsightSeverity = 'info' | 'low' | 'medium' | 'high'
export type Persona = 'developer' | 'lead' | 'pm' | 'qa' | 'anyone'

export interface Insight {
  id: string
  ruleId: string
  severity: InsightSeverity
  /** which axis it mostly affects */
  axis: 'quality' | 'time' | 'tokens' | 'context'
  title: string
  detail: string
  recommendation: string
  evidence: Record<string, unknown>
  turnIndexes: number[]
  savings?: { tokens?: number; ms?: number; estimated: boolean }
  personas: Persona[]
}

export interface Reconciliation {
  /** sum over usage events vs sum over turns+agents; should match to within tolerance */
  usageEventsTotal: number
  turnsPlusAgentsTotal: number
  matchesWithinPct: number
  ok: boolean
}

export interface Analysis {
  schemaVersion: string
  generator: { name: string; version: string; generatedAt: number; modelCatalogUpdatedAt: string }
  session: AnalysisSessionInfo
  summary: Summary
  turns: TurnAnalysis[]
  tools: ToolsAnalysis
  agents: AgentsAnalysis
  skills: SkillsAnalysis
  hooks: HooksAnalysis
  context: ContextAnalysis
  tokens: TokensAnalysis
  time: TimeAnalysis
  files: FilesAnalysis
  quality: QualityAnalysis
  insights: Insight[]
  events: Array<{ kind: string; ts?: number; turnIndex: number; agentId?: string; label: string; detail?: string }>
  parse: ParseReport & { reconciliation: Reconciliation }
}
