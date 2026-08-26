import type { Session } from '../model/session.js'
import type { CacheMissEvent, ContextAnalysis, ContextPoint, ModelInfo, TokensAnalysis } from '../model/analysis.js'
import { resolveModel } from '../models/catalog.js'
import { emptyUsage, addUsage, type Usage } from '../model/session.js'
import { round, totalTokens } from './util.js'

export function modelInfos(s: Session): ModelInfo[] {
  return s.meta.models.map((id) => {
    const r = resolveModel(id)
    return { id, displayName: r.displayName, family: r.family, estimatedMatch: r.estimatedMatch && !r.synthetic, contextWindow: r.contextWindow }
  })
}

export function analyzeContext(s: Session): ContextAnalysis {
  const series: ContextPoint[] = []
  const cacheMisses: CacheMissEvent[] = []
  let peak = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalFresh = 0
  let totalOutput = 0
  let cw1h = 0
  for (const u of s.usageEvents) {
    series.push({
      messageUuid: u.messageUuid,
      turnIndex: u.turnIndex,
      agentId: u.agentId,
      ts: u.ts,
      model: u.model,
      contextSize: u.contextSize,
      input: u.usage.input,
      cacheRead: u.usage.cacheRead,
      cacheWrite: u.usage.cacheWrite,
      cacheWrite1h: u.usage.cacheWrite1h,
      output: u.usage.output,
    })
    if (u.cacheMissReason && !u.hiddenIteration) {
      cacheMisses.push({ messageUuid: u.messageUuid, turnIndex: u.turnIndex, agentId: u.agentId, ts: u.ts, model: u.model, type: u.cacheMissReason.type, missedInputTokens: u.cacheMissReason.missedInputTokens })
    }
    if (!u.agentId) {
      if (u.contextSize > peak) peak = u.contextSize
    }
    totalCacheRead += u.usage.cacheRead
    totalCacheWrite += u.usage.cacheWrite
    totalFresh += u.usage.input
    totalOutput += u.usage.output
    cw1h += u.usage.cacheWrite1h
  }
  const main = series.filter((p) => !p.agentId)
  const baseline = main[0]?.contextSize ?? 0
  const final = main.length ? (main[main.length - 1] as ContextPoint).contextSize : 0
  const promptTokens = totalCacheRead + totalCacheWrite + totalFresh
  const cacheHitRatio = promptTokens ? round(totalCacheRead / promptTokens, 4) : 0
  const cacheWrite1hShare = totalCacheWrite ? round(cw1h / totalCacheWrite, 4) : 0
  const reReadMultiplier = peak ? round(totalCacheRead / peak, 2) : 0
  // context window from the main model (largest known)
  let contextWindow: number | undefined
  for (const m of s.meta.models) {
    const cw = resolveModel(m).contextWindow
    if (cw && (!contextWindow || cw > contextWindow)) contextWindow = cw
  }
  // requests per compaction segment
  const requestsPerCompaction: number[] = []
  if (s.compactions.length) {
    let count = 0
    let ci = 0
    const comps = [...s.compactions].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    for (const p of main) {
      while (ci < comps.length && p.ts !== undefined && (comps[ci]!.ts ?? Infinity) <= p.ts) {
        requestsPerCompaction.push(count)
        count = 0
        ci++
      }
      count++
    }
    requestsPerCompaction.push(count)
  }
  // compaction before/after from series
  const compactions = s.compactions.map((c) => {
    let before: number | undefined
    let after: number | undefined
    for (const p of main) {
      if (p.ts === undefined || c.ts === undefined) continue
      if (p.ts <= c.ts) before = p.contextSize
      else if (after === undefined) after = p.contextSize
    }
    return { ts: c.ts, turnIndex: c.turnIndex, trigger: c.trigger, contextBefore: c.contextBefore ?? before, contextAfter: c.contextAfter ?? after }
  })
  return { series, cacheMisses, compactions, peak, baseline, final, contextWindow, cacheHitRatio, cacheWrite1hShare, reReadMultiplier, totalCacheRead, totalCacheWrite, totalFreshInput: totalFresh, totalOutput, requestsPerCompaction }
}

/**
 * Token attribution: where the tokens went, by model, by kind, by turn, by tool category.
 * Every number here is a count the API reported, summed. Nothing is converted into anything.
 */
export function analyzeTokens(s: Session, turnTokens: Array<{ turnIndex: number; tokens: number }>): TokensAnalysis {
  const byModelMap = new Map<string, { tokens: Usage; estimatedMatch: boolean; requests: number }>()
  const byKind = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  const serverToolRequests = { webSearch: 0, webFetch: 0 }
  let total = emptyUsage()
  let mainTokens = 0
  let agentTokens = 0
  const hidden = { count: 0, tokens: 0 }
  const catTokens = new Map<string, number>()
  for (const u of s.usageEvents) {
    const n = totalTokens(u.usage)
    if (u.hiddenIteration) {
      hidden.count++
      hidden.tokens += n
    }
    total = addUsage(total, u.usage)
    if (u.agentId) agentTokens += n
    else mainTokens += n
    byKind.input += u.usage.input
    byKind.output += u.usage.output
    byKind.cacheRead += u.usage.cacheRead
    byKind.cacheWrite5m += u.usage.cacheWrite5m
    byKind.cacheWrite1h += u.usage.cacheWrite1h
    serverToolRequests.webSearch += u.usage.webSearchRequests
    serverToolRequests.webFetch += u.usage.webFetchRequests
    const r = resolveModel(u.model)
    const e = byModelMap.get(u.model) ?? { tokens: emptyUsage(), estimatedMatch: false, requests: 0 }
    e.estimatedMatch = e.estimatedMatch || (r.estimatedMatch && !r.synthetic)
    e.tokens = addUsage(e.tokens, u.usage)
    e.requests++
    byModelMap.set(u.model, e)
  }
  // attribute a request's tokens to the tool category the request issued (approximation: the message's tool_use categories)
  const callsByMsg = new Map<string, string[]>()
  for (const c of s.toolCalls) {
    const arr = callsByMsg.get(c.messageUuid) ?? []
    arr.push(c.category)
    callsByMsg.set(c.messageUuid, arr)
  }
  const msgById = new Map(s.messages.map((m) => [m.uuid, m]))
  // index sibling chunks by provider message id once, with no per-event scan of all messages (O(n²))
  const msgsByProviderId = new Map<string, string[]>()
  for (const m of s.messages) {
    if (!m.providerMessageId) continue
    const arr = msgsByProviderId.get(m.providerMessageId)
    if (arr) arr.push(m.uuid)
    else msgsByProviderId.set(m.providerMessageId, [m.uuid])
  }
  for (const u of s.usageEvents) {
    const m = msgById.get(u.messageUuid)
    // all chunks of the same provider message share the usage; find categories across sibling chunks
    const pid = m?.providerMessageId
    const cats: string[] = []
    if (pid) for (const uuid of msgsByProviderId.get(pid) ?? []) cats.push(...(callsByMsg.get(uuid) ?? []))
    const key = cats.length ? (cats.length === 1 ? (cats[0] as string) : 'mixed') : 'no-tool (text/thinking)'
    catTokens.set(key, (catTokens.get(key) ?? 0) + totalTokens(u.usage))
  }
  let cum = 0
  const byTurn = turnTokens.map((t) => {
    cum += t.tokens
    return { turnIndex: t.turnIndex, tokens: t.tokens, cumulativeTokens: cum }
  })
  return {
    total,
    totalTokens: totalTokens(total),
    byModel: [...byModelMap.entries()]
      .map(([model, e]) => ({ model, displayName: resolveModel(model).displayName, tokens: e.tokens, totalTokens: totalTokens(e.tokens), estimatedMatch: e.estimatedMatch, requests: e.requests }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byKind,
    mainThread: mainTokens,
    agents: agentTokens,
    byTurn,
    byToolCategory: [...catTokens.entries()].map(([category, tokens]) => ({ category, tokens })).sort((a, b) => b.tokens - a.tokens),
    serverToolRequests,
    hiddenIterations: hidden,
  }
}
