import type { Session } from '../model/session.js'
import { addUsage, emptyUsage, usageTotal } from '../model/session.js'
import { ANALYSIS_SCHEMA_VERSION, type Analysis, type QualityAnalysis, type SessionEnding, type Summary, type TurnAnalysis } from '../model/analysis.js'
import { catalogInfo } from '../models/catalog.js'
import { analyzeTools } from './tools.js'
import { analyzeFiles, analyzeQuality } from './quality.js'
import { analyzeContext, analyzeTokens, modelInfos } from './context.js'
import { analyzeAgents, analyzeHooks, analyzeSkills, analyzeTime } from './agents.js'
import { runRules, type Rule } from './insights.js'
import { fmtMs, fmtTokens, round, sum, totalTokens } from './util.js'

export interface AnalyzeOptions {
  version?: string
  now?: number
  rules?: Rule[]
}

export function analyzeSession(s: Session, opts: AnalyzeOptions = {}): Analysis {
  const now = opts.now ?? Date.now()
  const version = opts.version ?? '0.0.0'

  // ---- turns ----
  const toolsByTurn = new Map<number, typeof s.toolCalls>()
  const turnOfToolUse = new Map<string, number>()
  for (const c of s.toolCalls) {
    turnOfToolUse.set(c.toolUseId, c.turnIndex)
    if (c.agentId) continue
    const arr = toolsByTurn.get(c.turnIndex) ?? []
    arr.push(c)
    toolsByTurn.set(c.turnIndex, arr)
  }
  const ctxEndByTurn = new Map<number, number>()
  // bucket main-thread usage events by turn once, with no per-turn scan of all events (O(turns × usage))
  const usageByTurn = new Map<number, typeof s.usageEvents>()
  for (const u of s.usageEvents) {
    if (u.agentId) continue
    ctxEndByTurn.set(u.turnIndex, u.contextSize)
    const arr = usageByTurn.get(u.turnIndex)
    if (arr) arr.push(u)
    else usageByTurn.set(u.turnIndex, [u])
  }
  const turns: TurnAnalysis[] = s.turns.map((t) => {
    const calls = toolsByTurn.get(t.index) ?? []
    const counts = new Map<string, number>()
    for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
    const activity = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([n, k]) => (k > 1 ? `${n}×${k}` : n))
      .join(' ')
    return {
      index: t.index,
      kind: t.kind,
      isCommand: t.isCommand,
      commandName: t.commandName,
      promptPreview: t.promptPreview,
      promptChars: t.promptChars,
      startTs: t.startTs,
      endTs: t.endTs,
      durationMs: t.durationMs,
      reportedDurationMs: t.reportedDurationMs,
      firstResponseMs: t.firstResponseMs,
      humanGapMs: t.humanGapMs,
      autoContinuations: t.autoContinuations,
      interrupted: t.interrupted,
      toolCalls: calls.length,
      toolErrors: calls.filter((c) => c.isError).length,
      toolMs: sum(calls.map((c) => c.durationMs ?? 0)),
      agents: t.agentIds,
      models: t.models,
      tokens: t.usage,
      totalTokens: totalTokens(t.usage),
      contextEnd: ctxEndByTurn.get(t.index),
      insightIds: [],
      activity,
    }
  })

  const tools = analyzeTools(s)
  const files = analyzeFiles(s)
  const { quality, outcomes } = analyzeQuality(s, files)
  const context = analyzeContext(s)
  const agents = analyzeAgents(s, turnOfToolUse)
  const skills = analyzeSkills(s)
  const hooks = analyzeHooks(s)
  const time = analyzeTime(s, turns, agents, hooks.totalMs)
  // an agent's tokens are attributed to the turn that spawned it
  const agentTokensByTurn = new Map<number, number>()
  // Attribute each agent's tokens to a turn. Prefer the turn whose Agent tool_use spawned it; for teammate /
  // workflow agents with no spawning tool call, fall back to the turn active at the agent's start time so
  // the per-turn total still reconciles with the session total (otherwise most agent usage silently vanishes).
  const turnAtTime = (ts: number | undefined): number | undefined => {
    if (ts === undefined) return undefined
    for (const t of s.turns) {
      const start = t.startTs
      const end = t.endTs ?? Number.POSITIVE_INFINITY
      if (start !== undefined && ts >= start && ts <= end) return t.index
    }
    // else the last turn that started before ts
    let best: number | undefined
    for (const t of s.turns) if (t.startTs !== undefined && t.startTs <= ts) best = t.index
    return best
  }
  for (const r of agents.runs) {
    const ti = r.turnIndex ?? turnAtTime(r.startTs)
    if (ti !== undefined) agentTokensByTurn.set(ti, (agentTokensByTurn.get(ti) ?? 0) + r.totalTokens)
  }
  // a turn's headline number is its own tokens plus the tokens of the agents it spawned
  for (const t of turns) t.totalTokens = totalTokens(t.tokens) + (agentTokensByTurn.get(t.index) ?? 0)
  const tokenAnalysis = analyzeTokens(
    s,
    turns.map((t) => ({ turnIndex: t.index, tokens: t.totalTokens })),
  )

  const insights = runRules({ s, turns, tools, files, context, tokens: tokenAnalysis, agents, hooks, time, quality }, opts.rules)
  for (const ins of insights) for (const ti of ins.turnIndexes) turns[ti]?.insightIds.push(ins.id)

  // ---- summary ----
  let tokens = emptyUsage()
  for (const u of s.usageEvents) tokens = addUsage(tokens, u.usage)
  const humanTurns = s.turns.filter((t) => t.kind === 'human').length
  const summary: Summary = {
    turns: s.turns.length,
    humanTurns,
    messages: s.messages.length,
    assistantMessages: s.messages.filter((m) => m.role === 'assistant').length,
    toolCalls: s.toolCalls.length,
    toolErrors: s.toolCalls.filter((c) => c.isError).length,
    agents: s.agents.length,
    skills: s.skills.length,
    compactions: s.compactions.length,
    wallMs: s.meta.wallMs,
    activeMs: time.activeMs,
    humanWaitMs: time.humanWaitMs,
    tokens,
    totalTokens: totalTokens(tokens),
    contextPeak: context.peak,
    cacheHitRatio: context.cacheHitRatio,
    outcomes,
    topInsightIds: insights.slice(0, 3).map((i) => i.id),
    narrative: '',
    ending: sessionEnding(s, quality),
  }
  summary.narrative = narrative(s, summary, insights.slice(0, 2).map((i) => i.title))

  // ---- reconciliation ----
  const usageEventsTotal = usageTotal(tokens)
  const turnsPlusAgents = usageTotal(s.turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage())) + usageTotal(agents.totals.tokens)
  const diffPct = usageEventsTotal ? Math.abs(usageEventsTotal - turnsPlusAgents) / usageEventsTotal * 100 : 0

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    generator: { name: 'orangu', version, generatedAt: now, modelCatalogUpdatedAt: catalogInfo().updatedAt },
    session: {
      id: s.meta.sessionId,
      title: s.meta.title,
      source: s.meta.source,
      path: s.meta.path,
      subagentPaths: s.meta.subagentPaths,
      cwd: s.meta.cwd,
      projectSlug: s.meta.projectSlug,
      gitBranches: s.meta.gitBranches,
      clientVersions: s.meta.clientVersions,
      entrypoints: s.meta.entrypoints,
      permissionModes: s.meta.permissionModes,
      models: modelInfos(s),
      effortLevels: s.meta.effortLevels,
      startedAt: s.meta.startedAt,
      endedAt: s.meta.endedAt,
      live: s.meta.possiblyLive,
    },
    summary,
    turns,
    tools,
    agents,
    skills,
    hooks,
    context,
    tokens: tokenAnalysis,
    time,
    files,
    quality,
    insights,
    events: s.events.map((e) => ({ kind: e.kind, ts: e.ts, turnIndex: e.turnIndex, agentId: e.agentId, label: e.label, detail: e.detail })),
    parse: { ...s.parseReport, reconciliation: { usageEventsTotal, turnsPlusAgentsTotal: turnsPlusAgents, matchesWithinPct: round(diffPct, 3), ok: diffPct <= 1 } },
  }
}

/**
 * Precedence for `summary.ending`: interrupted > failing > clean > unknown.
 * "Last test/build run" = the run with the highest turnIndex across testRuns ∪ buildRuns; on a tie the later
 * detection wins (build runs are listed after test runs of the same turn). Deterministic, no clock.
 */
function sessionEnding(s: Session, quality: QualityAnalysis): SessionEnding {
  const last = s.turns[s.turns.length - 1]
  if (last?.interrupted) return 'interrupted'
  let lastRun: { turnIndex: number; ok: boolean } | undefined
  for (const r of [...quality.testRuns, ...quality.buildRuns]) if (!lastRun || r.turnIndex >= lastRun.turnIndex) lastRun = r
  if (!lastRun) return 'unknown'
  return lastRun.ok ? 'clean' : 'failing'
}

function narrative(s: Session, sum: Summary, top: string[]): string {
  const parts: string[] = []
  const what = s.meta.title ? `“${s.meta.title.slice(0, 80)}”` : 'this session'
  parts.push(`In ${what}, the human made ${sum.humanTurns} request${sum.humanTurns === 1 ? '' : 's'}${sum.turns > sum.humanTurns ? ` (${sum.turns} turns incl. commands/automation)` : ''} over ${sum.wallMs ? fmtMs(sum.wallMs) : 'an unknown span'}; the agent was busy for ${fmtMs(sum.activeMs)} of that.`)
  parts.push(`It made ${sum.toolCalls} tool calls${sum.toolErrors ? ` (${sum.toolErrors} failed)` : ''}${sum.agents ? `, ran ${sum.agents} subagent${sum.agents > 1 ? 's' : ''}` : ''}${sum.skills ? `, used ${sum.skills} skill/command invocation${sum.skills > 1 ? 's' : ''}` : ''}, and processed ${fmtTokens(usageTotal(sum.tokens))} tokens.`)
  const o = sum.outcomes
  const outs: string[] = []
  if (o.prLinks.length) outs.push(`${o.prLinks.length} PR${o.prLinks.length > 1 ? 's' : ''}`)
  if (o.gitCommits) outs.push(`${o.gitCommits} commit${o.gitCommits > 1 ? 's' : ''}`)
  if (o.filesEdited || o.filesWritten) outs.push(`${o.filesEdited + o.filesWritten} file${o.filesEdited + o.filesWritten > 1 ? 's' : ''} changed`)
  if (o.testRuns) outs.push(`${o.testRuns} test run${o.testRuns > 1 ? 's' : ''}${o.testRunsFailed ? ` (${o.testRunsFailed} failed)` : ''}`)
  parts.push(outs.length ? `Visible outcomes: ${outs.join(', ')}.` : 'No commits, PRs or test runs were detected.')
  if (top.length) parts.push(`Biggest things to look at: ${top.join('; ')}.`)
  return parts.join(' ')
}
