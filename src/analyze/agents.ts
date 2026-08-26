import type { Session } from '../model/session.js'
import type { AgentStat, AgentsAnalysis, HooksAnalysis, SkillsAnalysis, TimeAnalysis, TurnAnalysis } from '../model/analysis.js'
import { addUsage, emptyUsage } from '../model/session.js'
import { percentile, round, sum, totalTokens } from './util.js'

export function analyzeAgents(s: Session, turnOfToolUse: Map<string, number>): AgentsAnalysis {
  // tokens per agent from its own usage events (an agent may mix models); fall back to the
  // aggregate usage the parent reported when we never saw the agent's own transcript
  const tokensByAgent = new Map<string, number>()
  for (const u of s.usageEvents) {
    if (!u.agentId) continue
    tokensByAgent.set(u.agentId, (tokensByAgent.get(u.agentId) ?? 0) + totalTokens(u.usage))
  }
  const runs: AgentStat[] = s.agents.map((a) => {
    const errors = s.toolCalls.filter((c) => c.agentId === a.agentId && c.isError).length
    const own = tokensByAgent.get(a.agentId)
    return {
      agentId: a.agentId,
      name: a.name,
      agentType: a.agentType,
      description: a.description,
      model: a.model,
      spawnDepth: a.spawnDepth,
      parentAgentId: a.parentAgentId,
      spawnedByToolUseId: a.spawnedByToolUseId,
      turnIndex: a.spawnedByToolUseId ? turnOfToolUse.get(a.spawnedByToolUseId) : undefined,
      startTs: a.startTs,
      endTs: a.endTs,
      durationMs: a.durationMs,
      messageCount: a.messageCount,
      toolCallCount: a.toolCallCount,
      toolErrors: errors,
      tokens: a.usage,
      totalTokens: own ?? totalTokens(a.usage),
      reportedTotalTokens: a.reportedTotalTokens,
      reportedDurationMs: a.reportedDurationMs,
      status: a.status,
      transcriptPath: a.transcriptPath,
      teamName: a.teamName,
      taskKind: a.taskKind,
      hasTranscript: a.messageCount > 0,
    }
  })
  let tokens = emptyUsage()
  let dur = 0
  let toolCalls = 0
  for (const r of runs) {
    tokens = addUsage(tokens, r.tokens)
    dur += r.durationMs ?? 0
    toolCalls += r.toolCallCount
  }
  const byTypeMap = new Map<string, { count: number; tokens: number; dur: number[] }>()
  const byModelMap = new Map<string, { count: number; tokens: number }>()
  for (const r of runs) {
    // `name` is teammate-authored display text and may contain arbitrary private
    // prose. Cross-session rollups must only use the structural agent type.
    const t = r.agentType ?? 'unknown'
    const e = byTypeMap.get(t) ?? { count: 0, tokens: 0, dur: [] }
    e.count++
    e.tokens += totalTokens(r.tokens)
    if (r.durationMs !== undefined) e.dur.push(r.durationMs)
    byTypeMap.set(t, e)
    const m = r.model ?? 'unknown'
    const me = byModelMap.get(m) ?? { count: 0, tokens: 0 }
    me.count++
    me.tokens += totalTokens(r.tokens)
    byModelMap.set(m, me)
  }
  // concurrency: sweep line over [startTs, endTs]
  const iv = runs.filter((r) => r.startTs !== undefined && r.endTs !== undefined).map((r) => [r.startTs as number, r.endTs as number] as const)
  const evs: Array<[number, number]> = []
  for (const [a, b] of iv) {
    evs.push([a, 1])
    evs.push([b, -1])
  }
  evs.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let cur = 0
  let maxC = 0
  let concurrentMs = 0
  let lastT = 0
  for (const [t, d] of evs) {
    if (cur > 0) concurrentMs += t - lastT
    cur += d
    if (cur > maxC) maxC = cur
    lastT = t
  }
  const mainUsage = s.turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage())
  const mainTokens = totalTokens(mainUsage)
  const agentTokens = totalTokens(tokens)
  return {
    runs,
    totals: { count: runs.length, tokens, totalTokens: agentTokens, durationMs: dur, toolCalls },
    byType: [...byTypeMap.entries()].map(([agentType, e]) => ({ agentType, count: e.count, tokens: e.tokens, avgDurationMs: e.dur.length ? round(sum(e.dur) / e.dur.length, 0) : 0 })).sort((a, b) => b.tokens - a.tokens),
    byModel: [...byModelMap.entries()].map(([model, e]) => ({ model, count: e.count, tokens: e.tokens })).sort((a, b) => b.tokens - a.tokens),
    maxDepth: runs.reduce((m, r) => Math.max(m, r.spawnDepth), 0),
    concurrentMs,
    maxConcurrency: maxC,
    mainThreadShare: { tokens: mainTokens + agentTokens ? round(mainTokens / (mainTokens + agentTokens), 4) : 1 },
  }
}

export function analyzeSkills(s: Session): SkillsAnalysis {
  const byName = new Map<string, { count: number; via: Set<'tool' | 'command'>; turnIndexes: number[] }>()
  for (const k of s.skills) {
    const e = byName.get(k.name) ?? { count: 0, via: new Set(), turnIndexes: [] }
    e.count++
    e.via.add(k.via)
    if (!e.turnIndexes.includes(k.turnIndex)) e.turnIndexes.push(k.turnIndex)
    byName.set(k.name, e)
  }
  return {
    invocations: s.skills.map((k) => ({ name: k.name, via: k.via, turnIndex: k.turnIndex, ts: k.ts, agentId: k.agentId, args: k.args })),
    byName: [...byName.entries()].map(([name, e]) => ({ name, count: e.count, via: [...e.via], turnIndexes: e.turnIndexes })).sort((a, b) => b.count - a.count),
  }
}

export function analyzeHooks(s: Session): HooksAnalysis {
  const byCmd = new Map<string, { count: number; totalMs: number; errors: number; hookEvent?: string }>()
  const byEvent = new Map<string, number>()
  let totalMs = 0
  let errors = 0
  for (const h of s.hooks) {
    const key = h.command ?? h.hookName ?? h.hookEvent ?? 'hook'
    const e = byCmd.get(key) ?? { count: 0, totalMs: 0, errors: 0, hookEvent: h.hookEvent }
    e.count++
    e.totalMs += h.durationMs ?? 0
    if (!h.ok) e.errors++
    byCmd.set(key, e)
    totalMs += h.durationMs ?? 0
    if (!h.ok) errors++
    const ev = h.hookEvent ?? 'unknown'
    byEvent.set(ev, (byEvent.get(ev) ?? 0) + 1)
  }
  return {
    runs: s.hooks.length,
    errors,
    totalMs,
    byCommand: [...byCmd.entries()].map(([command, e]) => ({ command, ...e })).sort((a, b) => b.totalMs - a.totalMs),
    events: [...byEvent.entries()].map(([hookEvent, count]) => ({ hookEvent, count })),
  }
}

/** total covered milliseconds of a set of possibly-overlapping [start, end] intervals */
function unionMs(iv: Array<readonly [number, number]>): number {
  if (!iv.length) return 0
  const sorted = [...iv].sort((a, b) => a[0] - b[0])
  let total = 0
  let curStart = sorted[0]![0]
  let curEnd = sorted[0]![1]
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i]!
    if (a <= curEnd) {
      if (b > curEnd) curEnd = b
    } else {
      total += curEnd - curStart
      curStart = a
      curEnd = b
    }
  }
  total += curEnd - curStart
  return total
}

export function analyzeTime(s: Session, turns: TurnAnalysis[], agents: AgentsAnalysis, hooksMs: number): TimeAnalysis {
  const activeMs = sum(turns.map((t) => t.durationMs ?? 0))
  const humanWaitMs = sum(turns.map((t) => t.humanGapMs ?? 0))
  // Tool time is an interval UNION (like concurrentMs): parallel tool calls overlap in wall time,
  // so a plain sum can exceed the active time and push time-budget shares past 100%.
  const toolIv: Array<readonly [number, number]> = []
  let unanchoredToolMs = 0
  for (const c of s.toolCalls) {
    if (c.agentId || c.name === 'Agent' || c.name === 'Task') continue
    if (c.durationMs === undefined) continue
    if (c.startTs !== undefined) toolIv.push([c.startTs, c.startTs + c.durationMs] as const)
    else unanchoredToolMs += c.durationMs
  }
  const toolMs = Math.min(unionMs(toolIv) + unanchoredToolMs, activeMs)
  const agentMs = Math.min(agents.concurrentMs, activeMs)
  const modelMs = Math.max(0, activeMs - toolMs - agentMs)
  const fr = turns.map((t) => t.firstResponseMs).filter((x): x is number => x !== undefined)
  return {
    wallMs: s.meta.wallMs,
    activeMs,
    humanWaitMs,
    toolMs,
    agentMs,
    modelMs,
    longestTurns: [...turns].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 5).map((t) => ({ turnIndex: t.index, durationMs: t.durationMs ?? 0, preview: t.promptPreview })),
    longestGaps: [...turns].filter((t) => t.humanGapMs !== undefined).sort((a, b) => (b.humanGapMs ?? 0) - (a.humanGapMs ?? 0)).slice(0, 5).map((t) => ({ turnIndex: t.index, gapMs: t.humanGapMs ?? 0 })),
    firstResponse: { p50: percentile(fr, 50), p95: percentile(fr, 95), max: fr.length ? Math.max(...fr) : 0 },
    hooksMs,
  }
}
