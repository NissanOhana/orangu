/**
 * Deterministic insight rules. Each rule reads the Session + already-computed analysis slices and returns
 * zero or more Insights with evidence, a recommendation and (when computable) a savings estimate.
 *
 * Rules must: be explainable in one sentence, cite the records they used (turn indexes), and never guess.
 * Token estimates derived from bytes use ~4 bytes/token and are always flagged estimated.
 *
 * Savings are token counts and nothing else. A rule may claim a saving only when following its
 * recommendation would have caused FEWER TOKENS to be sent or generated. A change that merely moves
 * the same tokens between categories (a cache tier, a cache miss) or between models saves nothing we
 * can measure, and those rules say so instead of inventing a number.
 */
import type { Session, ToolCall, Usage } from '../model/session.js'
import type { AgentsAnalysis, ContextAnalysis, FilesAnalysis, HooksAnalysis, Insight, InsightSeverity, QualityAnalysis, TimeAnalysis, TokensAnalysis, ToolsAnalysis, TurnAnalysis } from '../model/analysis.js'
import { resolveModel } from '../models/catalog.js'
import { usageTotal } from '../model/session.js'
import { fmtMs, fmtTokens, round, shortPath, totalTokens } from './util.js'
import { bashTemplate, repeatedNgrams } from './tools.js'

export interface RuleContext {
  s: Session
  turns: TurnAnalysis[]
  tools: ToolsAnalysis
  files: FilesAnalysis
  context: ContextAnalysis
  tokens: TokensAnalysis
  agents: AgentsAnalysis
  hooks: HooksAnalysis
  time: TimeAnalysis
  quality: QualityAnalysis
}
export type Rule = (ctx: RuleContext) => Insight[]

const BYTES_PER_TOKEN = 4

/**
 * A savings estimate must never exceed the tokens the session actually moved. Cap at 60% of the total.
 * Savings are always token counts: a rule may only claim a saving when following its recommendation
 * would have caused FEWER TOKENS to be sent or generated. A rule that would merely have changed which
 * model handled the same tokens has no saving to claim, and claims none.
 */
function capSavings(ctx: RuleContext, tokens: number): number {
  const cap = ctx.tokens.totalTokens * 0.6
  return cap > 0 ? Math.min(tokens, cap) : tokens
}

/** dominant model of the main thread, by tokens */
function mainModel(ctx: RuleContext): string | undefined {
  const m = ctx.tokens.byModel[0]?.model
  return m ?? ctx.s.meta.models[0]
}
let seq = 0
function mk(partial: Omit<Insight, 'id'>): Insight {
  seq++
  return { id: `${partial.ruleId}-${seq}`, ...partial }
}
export function resetInsightIds(): void {
  seq = 0
}

// ---------------- rules ----------------

const rereadFiles: Rule = (ctx) => {
  const out: Insight[] = []
  // "redundant" = re-reads WITHIN one context; a file read once per subagent is not redundant.
  const rr = ctx.files.mostReRead.filter((f) => f.redundantReads >= 2)
  if (!rr.length) return out
  const top = rr.slice(0, 5)
  const wastedBytes = top.reduce((a, f) => a + (f.bytesRead / Math.max(1, f.reads)) * f.redundantReads, 0)
  const wastedTokens = Math.round(wastedBytes / BYTES_PER_TOKEN)
  // each redundant read is paid as fresh cache-write once and then carried as cache-read in later requests
  const laterRequests = Math.max(1, ctx.context.series.filter((p) => !p.agentId).length / 2)
  // the redundant bytes are written into context once and then re-read on every later request
  const carriedTokens = capSavings(ctx, Math.round(wastedTokens + wastedTokens * laterRequests))
  const totalReReads = rr.reduce((a, f) => a + f.redundantReads, 0)
  out.push(
    mk({
      ruleId: 'reread-files',
      severity: totalReReads >= 10 ? 'high' : totalReReads >= 5 ? 'medium' : 'low',
      axis: 'tokens',
      title: `${rr.length} file${rr.length > 1 ? 's' : ''} re-read within one context (${totalReReads} redundant reads, ${fmtTokens(carriedTokens)} tokens)`,
      detail: top.map((f) => `${f.path} ×${f.reads} (${f.redundantReads} redundant${f.agentReads ? `, ${f.agentReads} in agents` : ''})`).join('; '),
      recommendation:
        'A file already in context does not need re-reading; the re-read is sent again as fresh input and then carried in every later request. Read once, keep notes, or use Grep with line ranges; for large files read only the needed offset/limit. Sub-agents cannot see the parent context, so reads inside agents are expected.',
      evidence: { files: top.map((f) => ({ path: f.path, reads: f.reads, redundantReads: f.redundantReads, bytesRead: f.bytesRead, turns: f.turnIndexes.slice(0, 20) })), wastedTokensEstimate: wastedTokens, carriedTokensEstimate: carriedTokens },
      turnIndexes: [...new Set(top.flatMap((f) => f.turnIndexes))].slice(0, 30),
      savings: { tokens: carriedTokens, estimated: true },
      personas: ['developer', 'lead'],
    }),
  )
  return out
}

const repeatedCommands: Rule = (ctx) => {
  const counts = new Map<string, { n: number; turns: number[]; errors: number }>()
  for (const c of ctx.s.toolCalls) {
    if (c.name !== 'Bash') continue
    const cmd = String((c.input as Record<string, unknown> | undefined)?.['command'] ?? '').trim()
    if (!cmd || cmd.length < 6) continue
    const e = counts.get(cmd) ?? { n: 0, turns: [], errors: 0 }
    e.n++
    if (!e.turns.includes(c.turnIndex)) e.turns.push(c.turnIndex)
    if (c.isError) e.errors++
    counts.set(cmd, e)
  }
  const rep = [...counts.entries()].filter(([, e]) => e.n >= 4).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
  if (!rep.length) return []
  return [
    mk({
      ruleId: 'repeated-commands',
      severity: rep[0]![1].n >= 8 ? 'medium' : 'low',
      axis: 'time',
      title: `${rep.length} identical shell command${rep.length > 1 ? 's' : ''} repeated 4+ times`,
      detail: rep.map(([cmd, e]) => `"${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}" ×${e.n}${e.errors ? ` (${e.errors} failed)` : ''}`).join('; '),
      recommendation: 'Repeated identical commands are usually a verify loop (tests/build) or a polling loop. Verify loops are healthy when each run follows a change; polling should use a wait/monitor primitive instead of re-running. If the same command keeps failing, fix the environment once rather than retrying.',
      evidence: { commands: rep.map(([cmd, e]) => ({ command: cmd.slice(0, 200), count: e.n, errors: e.errors, turns: e.turns.slice(0, 20) })) },
      turnIndexes: [...new Set(rep.flatMap(([, e]) => e.turns))].slice(0, 30),
      personas: ['developer'],
    }),
  ]
}

const toolErrors: Rule = (ctx) => {
  const out: Insight[] = []
  const total = ctx.s.toolCalls.length
  const errs = ctx.s.toolCalls.filter((c) => c.isError)
  if (!errs.length) return out
  const rate = errs.length / Math.max(1, total)
  const groups = ctx.tools.errorGroups.filter((g) => g.count >= 3).slice(0, 5)
  if (rate >= 0.1 || groups.length) {
    out.push(
      mk({
        ruleId: 'tool-errors',
        severity: rate >= 0.2 || (groups[0]?.count ?? 0) >= 6 ? 'high' : rate >= 0.1 || groups.length ? 'medium' : 'low',
        axis: 'quality',
        title: `${errs.length} tool errors (${round(rate * 100, 1)}% of ${total} calls)${groups.length ? `, ${groups.length} recurring signature${groups.length > 1 ? 's' : ''}` : ''}`,
        detail: groups.length ? groups.map((g) => `${g.name}: "${g.signature}" ×${g.count}`).join('; ') : `most in ${errs[0]!.name}`,
        recommendation: 'A recurring error signature is an environment or instruction problem, not bad luck: fix the root cause once (missing dependency, wrong path, permission, flaky command) or add the correct invocation to CLAUDE.md so the agent stops rediscovering it. Each failed call still burns its output tokens plus a retry turn.',
        evidence: { errorRate: round(rate, 4), groups },
        turnIndexes: [...new Set(errs.map((c) => c.turnIndex))].slice(0, 30),
        savings: { tokens: Math.round(errs.reduce((a, c) => a + (c.resultBytes ?? 0), 0) / BYTES_PER_TOKEN), estimated: true },
        personas: ['developer', 'qa'],
      }),
    )
  }
  return out
}

const oversizedResults: Rule = (ctx) => {
  const big = ctx.s.toolCalls.filter((c) => (c.resultBytes ?? 0) >= 40_000).sort((a, b) => (b.resultBytes ?? 0) - (a.resultBytes ?? 0))
  if (!big.length) return []
  const bytes = big.reduce((a, c) => a + (c.resultBytes ?? 0), 0)
  const tokens = Math.round(bytes / BYTES_PER_TOKEN)
  // main-thread results are carried in every later main request; agent-only results live in the agent's
  // context (discarded when it returns), so they do not get the main-thread carry multiplier.
  const mainBytes = big.filter((c) => !c.agentId).reduce((a, c) => a + (c.resultBytes ?? 0), 0)
  const mainTokens = Math.round(mainBytes / BYTES_PER_TOKEN)
  const laterRequests = Math.max(1, ctx.context.series.filter((p) => !p.agentId).length / 3)
  const carriedTokens = capSavings(ctx, Math.round(mainTokens + mainTokens * laterRequests))
  const top = big.slice(0, 5)
  return [
    mk({
      ruleId: 'oversized-tool-results',
      severity: bytes > 400_000 ? 'high' : bytes > 150_000 ? 'medium' : 'low',
      axis: 'context',
      title: `${big.length} tool result${big.length > 1 ? 's' : ''} over 40 KB, ${fmtTokens(tokens)} tokens carried in context`,
      detail: top.map((c) => `${c.inputSummary} → ${Math.round((c.resultBytes ?? 0) / 1024)} KB${c.agentId ? ' (agent)' : ''}`).join('; '),
      recommendation: 'Large outputs stay in context for the rest of the session and are re-read on every request. Trim at the source: pipe through head/tail/grep, use --limit/offset on Read, ask for summaries, or run the noisy step inside a subagent whose context is discarded.',
      evidence: { calls: top.map((c) => ({ tool: c.name, summary: c.inputSummary, bytes: c.resultBytes, turnIndex: c.turnIndex, agentId: c.agentId })), totalBytes: bytes, carriedTokensEstimate: carriedTokens },
      turnIndexes: [...new Set(top.map((c) => c.turnIndex))],
      savings: { tokens: carriedTokens, estimated: true },
      personas: ['developer'],
    }),
  ]
}

const sequentialReads: Rule = (ctx) => {
  // within a turn, count consecutive single-call read/search messages on the main thread
  const out: Insight[] = []
  const runsPerTurn = new Map<number, number>()
  const byTurn = new Map<number, typeof ctx.s.toolCalls>()
  for (const c of ctx.s.toolCalls) {
    if (c.agentId) continue
    const arr = byTurn.get(c.turnIndex) ?? []
    arr.push(c)
    byTurn.set(c.turnIndex, arr)
  }
  let totalRuns = 0
  let totalCalls = 0
  let ms = 0
  for (const [ti, calls] of byTurn) {
    let run = 0
    let runMs = 0
    const flush = () => {
      if (run >= 4) {
        totalRuns++
        totalCalls += run
        ms += runMs
        runsPerTurn.set(ti, (runsPerTurn.get(ti) ?? 0) + 1)
      }
      run = 0
      runMs = 0
    }
    for (const c of calls) {
      const isLightCall = (c.category === 'read' || c.category === 'search') && c.parallelGroupSize === 1
      if (isLightCall) {
        run++
        runMs += c.durationMs ?? 0
      } else flush()
    }
    flush()
  }
  if (!totalRuns) return out
  out.push(
    mk({
      ruleId: 'sequential-reads',
      severity: totalCalls >= 20 ? 'medium' : 'low',
      axis: 'time',
      title: `${totalCalls} read/search calls issued one-by-one in ${totalRuns} run${totalRuns > 1 ? 's' : ''} of 4+`,
      detail: `Each sequential call is a full model round-trip. Turns: ${[...runsPerTurn.keys()].slice(0, 12).join(', ')}`,
      recommendation: 'Independent reads and searches can be issued in one message (parallel tool calls) or delegated to an Explore subagent that returns a summary. That removes one model round-trip per call and keeps the raw file contents out of the main context.',
      evidence: { runs: totalRuns, calls: totalCalls, turns: [...runsPerTurn.entries()] },
      turnIndexes: [...runsPerTurn.keys()].slice(0, 30),
      savings: { ms: Math.round(ms * 0.6), estimated: true },
      personas: ['developer'],
    }),
  )
  return out
}

const contextPressure: Rule = (ctx) => {
  const out: Insight[] = []
  const win = ctx.context.contextWindow
  const peak = ctx.context.peak
  const comps = ctx.s.compactions.length
  if (comps) {
    out.push(
      mk({
        ruleId: 'compactions',
        severity: comps >= 3 ? 'high' : comps >= 2 ? 'medium' : 'low',
        axis: 'context',
        title: `${comps} context compaction${comps > 1 ? 's' : ''}${win ? ` (peak ${fmtTokens(peak)} of ${fmtTokens(win)})` : ''}`,
        detail: ctx.context.compactions.map((c) => `turn ${c.turnIndex}${c.contextBefore ? ` at ${fmtTokens(c.contextBefore)}` : ''}${c.contextAfter ? ` → ${fmtTokens(c.contextAfter)}` : ''}`).join('; '),
        recommendation: 'Every compaction throws away working memory and the agent re-derives it (extra reads, repeated commands). Split long efforts into sessions with a written handover, keep tool outputs small, push exploration into subagents, and compact deliberately at a milestone rather than letting auto-compact hit mid-task.',
        evidence: { compactions: ctx.context.compactions, requestsPerSegment: ctx.context.requestsPerCompaction },
        turnIndexes: ctx.context.compactions.map((c) => c.turnIndex),
        personas: ['developer', 'anyone'],
      }),
    )
  } else if (win && peak > win * 0.7) {
    out.push(
      mk({
        ruleId: 'context-near-limit',
        severity: 'medium',
        axis: 'context',
        title: `Context reached ${round((peak / win) * 100, 0)}% of the ${fmtTokens(win)} window`,
        detail: `peak ${fmtTokens(peak)} tokens; baseline (system prompt + tools + CLAUDE.md) ${fmtTokens(ctx.context.baseline)}`,
        recommendation: 'You are close to auto-compaction. Wrap up the current milestone, write a handover note, and start a fresh session for the next chunk; or trim large tool outputs.',
        evidence: { peak, window: win, baseline: ctx.context.baseline },
        turnIndexes: [],
        personas: ['developer', 'anyone'],
      }),
    )
  }
  return out
}

const preambleWeight: Rule = (ctx) => {
  const base = ctx.context.baseline
  const reqs = ctx.context.series.filter((p) => !p.agentId).length
  if (base < 25_000 || reqs < 5) return []
  const carried = base * reqs
  return [
    mk({
      ruleId: 'preamble-weight',
      severity: base > 60_000 ? 'medium' : 'low',
      axis: 'tokens',
      title: `Every request starts from a ${fmtTokens(base)}-token baseline (system prompt, tools, CLAUDE.md, skills)`,
      detail: `${reqs} requests × ${fmtTokens(base)} ≈ ${fmtTokens(carried)} cache-read tokens just to carry the preamble`,
      recommendation: 'The baseline is small per request (it is re-read from cache, not re-sent) but it multiplies by every request. Trim CLAUDE.md to rules that bind, defer long docs to on-demand reads, prune MCP servers and skills you do not use in this repo, and check for large SessionStart hook output.',
      evidence: { baselineTokens: base, requests: reqs, carriedTokens: carried },
      turnIndexes: [0],
      savings: { tokens: Math.round(carried * 0.3), estimated: true },
      personas: ['developer', 'lead'],
    }),
  ]
}

const cacheHealth: Rule = (ctx) => {
  const out: Insight[] = []
  const reqs = ctx.context.series.filter((p) => !p.agentId).length
  if (reqs < 8) return out
  const ratio = ctx.context.cacheHitRatio
  if (ratio < 0.6) {
    out.push(
      mk({
        ruleId: 'low-cache-hit',
        severity: ratio < 0.4 ? 'high' : 'medium',
        axis: 'tokens',
        title: `Prompt cache hit ratio is ${round(ratio * 100, 0)}%`,
        detail: `${fmtTokens(ctx.context.totalCacheRead)} read from cache vs ${fmtTokens(ctx.context.totalCacheWrite)} written and ${fmtTokens(ctx.context.totalFreshInput)} fresh input`,
        recommendation: 'A low ratio means the prompt prefix keeps changing, or requests are spaced beyond the cache TTL (5 min by default, 1 h when enabled), so the context is re-written instead of re-read. Avoid editing the system prompt/CLAUDE.md mid-session, keep working steadily during a task, and expect low ratios in short sessions.',
        evidence: { cacheHitRatio: ratio, totalCacheRead: ctx.context.totalCacheRead, totalCacheWrite: ctx.context.totalCacheWrite, freshInput: ctx.context.totalFreshInput },
        turnIndexes: [],
        personas: ['developer', 'lead'],
      }),
    )
  }
  return out
}

const humanWait: Rule = (ctx) => {
  const wall = ctx.time.wallMs ?? 0
  if (wall < 10 * 60_000) return []
  const share = ctx.time.humanWaitMs / wall
  if (share < 0.5) return []
  return [
    mk({
      ruleId: 'human-wait-dominates',
      severity: 'info',
      axis: 'time',
      title: `${round(share * 100, 0)}% of the ${fmtMs(wall)} wall time was waiting for the human`,
      detail: `assistant active ${fmtMs(ctx.time.activeMs)}; longest gap ${fmtMs(ctx.time.longestGaps[0]?.gapMs ?? 0)} before turn ${ctx.time.longestGaps[0]?.turnIndex ?? '-'}`,
      recommendation: 'Not a problem by itself; it means the agent was mostly idle. If you want more throughput, batch requests, run background agents, or hand the agent a longer autonomous brief with clear stop conditions.',
      evidence: { wallMs: wall, activeMs: ctx.time.activeMs, humanWaitMs: ctx.time.humanWaitMs },
      turnIndexes: ctx.time.longestGaps.map((g) => g.turnIndex),
      personas: ['anyone', 'lead'],
    }),
  ]
}

const agentEconomics: Rule = (ctx) => {
  const out: Insight[] = []
  const a = ctx.agents
  if (!a.runs.length) return out
  const share = ctx.tokens.totalTokens ? a.totals.totalTokens / ctx.tokens.totalTokens : 0
  const idle = a.runs.filter((r) => r.hasTranscript && r.toolCallCount === 0 && r.messageCount <= 2)
  const noTranscript = a.runs.filter((r) => !r.hasTranscript).length
  out.push(
    mk({
      ruleId: 'agent-fanout',
      severity: 'info',
      axis: 'tokens',
      title: `${a.runs.length} subagent run${a.runs.length > 1 ? 's' : ''} = ${round(share * 100, 0)}% of the session's tokens (${fmtTokens(a.totals.totalTokens)}), max ${a.maxConcurrency} in parallel`,
      detail: a.byType.slice(0, 5).map((t) => `${t.agentType} ×${t.count} ${fmtTokens(t.tokens)}`).join('; ') + (noTranscript ? `; ${noTranscript} run${noTranscript > 1 ? 's' : ''} without a local transcript (usage from parent summary only)` : ''),
      recommendation: 'Subagents keep exploration out of your main context and can run in parallel; they are worth it when the returned summary is much smaller than what they read. Watch for agents that re-read what the parent already knew, and for agents whose brief makes them read far more than they report back.',
      evidence: { byType: a.byType, byModel: a.byModel, concurrentMs: a.concurrentMs, maxConcurrency: a.maxConcurrency },
      turnIndexes: [...new Set(a.runs.map((r) => r.turnIndex).filter((x): x is number => x !== undefined))].slice(0, 30),
      personas: ['developer', 'lead'],
    }),
  )
  if (idle.length) {
    out.push(
      mk({
        ruleId: 'idle-agents',
        severity: 'low',
        axis: 'tokens',
        title: `${idle.length} subagent${idle.length > 1 ? 's' : ''} did no tool calls`,
        detail: idle.slice(0, 5).map((r) => r.agentType ?? r.name ?? r.agentId).join(', '),
        recommendation: 'An agent that only answers from its prompt could have been a plain model call in the main thread; or its brief was too thin to act on. Give agents concrete files/commands to act on.',
        evidence: { agents: idle.map((r) => ({ agentId: r.agentId, type: r.agentType, tokens: r.tokens })) },
        turnIndexes: [],
        personas: ['developer'],
      }),
    )
  }
  return out
}

const hooksOverhead: Rule = (ctx) => {
  const h = ctx.hooks
  const out: Insight[] = []
  if (h.errors) {
    out.push(
      mk({
        ruleId: 'hook-errors',
        severity: h.errors >= 5 ? 'medium' : 'low',
        axis: 'quality',
        title: `${h.errors} hook error${h.errors > 1 ? 's' : ''}`,
        detail: h.byCommand.filter((c) => c.errors).slice(0, 5).map((c) => `${c.command.slice(0, 50)} ×${c.errors}`).join('; '),
        recommendation: 'Failing hooks add noise to every turn and can block continuation. Fix or remove them in settings.json.',
        evidence: { byCommand: h.byCommand.filter((c) => c.errors) },
        turnIndexes: [],
        personas: ['developer'],
      }),
    )
  }
  if (h.totalMs > 60_000 || (ctx.time.activeMs && h.totalMs > ctx.time.activeMs * 0.05)) {
    out.push(
      mk({
        ruleId: 'hook-latency',
        severity: 'low',
        axis: 'time',
        title: `Hooks consumed ${fmtMs(h.totalMs)} across ${h.runs} runs`,
        detail: h.byCommand.slice(0, 5).map((c) => `${c.command.slice(0, 50)} ${fmtMs(c.totalMs)}`).join('; '),
        recommendation: 'Slow Stop/PostToolUse hooks run on every turn. Make them async (background &), cache their work, or scope them to the events that need them.',
        evidence: { totalMs: h.totalMs, byCommand: h.byCommand.slice(0, 5) },
        turnIndexes: [],
        savings: { ms: Math.round(h.totalMs * 0.8), estimated: true },
        personas: ['developer'],
      }),
    )
  }
  return out
}

const interruptionsAndErrors: Rule = (ctx) => {
  const out: Insight[] = []
  const q = ctx.quality
  if (q.interruptions >= 2) {
    out.push(
      mk({
        ruleId: 'interruptions',
        severity: q.interruptions >= 4 ? 'medium' : 'low',
        axis: 'quality',
        title: `${q.interruptions} interruptions by the user`,
        detail: 'the agent was stopped mid-turn; work in flight was discarded',
        recommendation: 'Frequent interruptions usually mean the brief was under-specified or the agent went off-plan. Ask for a short plan first, or set explicit stop conditions.',
        evidence: { interruptions: q.interruptions },
        turnIndexes: ctx.s.events.filter((e) => e.kind === 'interrupt').map((e) => e.turnIndex),
        personas: ['anyone'],
      }),
    )
  }
  if (q.userCorrections.length >= 2) {
    out.push(
      mk({
        ruleId: 'user-corrections',
        severity: q.userCorrections.length >= 4 ? 'high' : 'medium',
        axis: 'quality',
        title: `${q.userCorrections.length} correction prompts ("no / wrong / again / revert")`,
        detail: q.userCorrections.slice(0, 4).map((c) => `turn ${c.turnIndex}: ${c.preview.slice(0, 60)}`).join('; '),
        recommendation: 'Each correction is a wasted round trip and a signal the instructions or the agent\'s verification loop are weak. Add the missed rule to CLAUDE.md, require the agent to run the check before claiming done, or use a reviewer subagent.',
        evidence: { corrections: q.userCorrections },
        turnIndexes: q.userCorrections.map((c) => c.turnIndex),
        personas: ['anyone', 'lead'],
      }),
    )
  }
  if (q.apiErrors) {
    out.push(
      mk({
        ruleId: 'api-errors',
        severity: q.apiErrors >= 5 ? 'medium' : 'low',
        axis: 'time',
        title: `${q.apiErrors} API error${q.apiErrors > 1 ? 's' : ''} / retries`,
        detail: ctx.s.events.filter((e) => e.kind === 'api_error').slice(0, 3).map((e) => `${e.label}${e.detail ? ': ' + e.detail.slice(0, 60) : ''}`).join('; '),
        recommendation: 'Rate limits and overloads are outside your control; a model fallback silently changes which model answered for the rest of the turn. Check the model column in the timeline.',
        evidence: { apiErrors: q.apiErrors },
        turnIndexes: ctx.s.events.filter((e) => e.kind === 'api_error').map((e) => e.turnIndex),
        personas: ['developer'],
      }),
    )
  }
  const fb = ctx.s.events.filter((e) => e.kind === 'model_fallback')
  if (fb.length) {
    out.push(
      mk({
        ruleId: 'model-fallback',
        severity: 'medium',
        axis: 'quality',
        title: `Model fell back ${fb.length} time${fb.length > 1 ? 's' : ''}`,
        detail: [...new Set(fb.map((e) => e.label))].join('; '),
        recommendation: 'A fallback means the model you chose was unavailable; the replacement may behave differently. Re-run quality-critical steps on the intended model when it is back.',
        evidence: { events: fb },
        turnIndexes: fb.map((e) => e.turnIndex),
        personas: ['developer', 'lead'],
      }),
    )
  }
  return out
}

const outputHeavyWrites: Rule = (ctx) => {
  // Write/Edit inputs come back as output tokens, which the model generates one at a time
  let bytes = 0
  const big: Array<{ summary: string; bytes: number; turnIndex: number }> = []
  for (const c of ctx.s.toolCalls) {
    if (c.category !== 'write' && c.category !== 'edit') continue
    bytes += c.inputBytes
    if (c.inputBytes >= 20_000) big.push({ summary: c.inputSummary, bytes: c.inputBytes, turnIndex: c.turnIndex })
  }
  if (!big.length) return []
  const tokens = Math.round(big.reduce((a, b) => a + b.bytes, 0) / BYTES_PER_TOKEN)
  return [
    mk({
      ruleId: 'large-writes',
      /* savings capped below */
      severity: tokens > 40_000 ? 'medium' : 'low',
      axis: 'tokens',
      title: `${big.length} large Write/Edit call${big.length > 1 ? 's' : ''} generated ${fmtTokens(tokens)} output tokens`,
      detail: big.slice(0, 5).map((b) => `${b.summary} ${Math.round(b.bytes / 1024)} KB`).join('; '),
      recommendation: 'Every byte of a generated file is an output token the model had to produce, and output is the slowest thing it does. Prefer targeted Edits over rewriting whole files, generate boilerplate with a script or template, and never paste large data through the model.',
      evidence: { calls: big.slice(0, 10), totalWriteBytes: bytes, outputTokensEstimate: tokens },
      turnIndexes: [...new Set(big.map((b) => b.turnIndex))],
      savings: { tokens: Math.round(capSavings(ctx, tokens * 0.5)), estimated: true },
      personas: ['developer'],
    }),
  ]
}

const slowFirstResponse: Rule = (ctx) => {
  const p95 = ctx.time.firstResponse.p95
  if (!p95 || p95 < 30_000 || ctx.turns.length < 5) return []
  return [
    mk({
      ruleId: 'slow-first-response',
      severity: 'low',
      axis: 'time',
      title: `p95 time-to-first-response is ${fmtMs(p95)}`,
      detail: `p50 ${fmtMs(ctx.time.firstResponse.p50)}, max ${fmtMs(ctx.time.firstResponse.max)}; large contexts and long thinking both add latency before the first token`,
      recommendation: 'Latency grows with context size and effort level. Keep the context lean, lower effort for mechanical steps, and use a faster model for trivial turns.',
      evidence: ctx.time.firstResponse,
      turnIndexes: [],
      personas: ['developer'],
    }),
  ]
}

const unresolvedTools: Rule = (ctx) => {
  const un = ctx.s.toolCalls.filter((c) => c.unresolved)
  if (!un.length || ctx.s.meta.possiblyLive) return []
  return [
    mk({
      ruleId: 'unresolved-tool-calls',
      severity: 'low',
      axis: 'quality',
      title: `${un.length} tool call${un.length > 1 ? 's' : ''} never received a result`,
      detail: un.slice(0, 5).map((c) => c.inputSummary).join('; '),
      recommendation: 'Usually an interruption or a crash mid-tool. If it recurs with the same tool, look for a hanging command (missing timeout, interactive prompt).',
      evidence: { calls: un.slice(0, 10).map((c) => ({ tool: c.name, summary: c.inputSummary, turnIndex: c.turnIndex })) },
      turnIndexes: [...new Set(un.map((c) => c.turnIndex))],
      personas: ['developer'],
    }),
  ]
}

// ---------------- core quality, token, and time rules ----------------

const unverifiedEdits: Rule = (ctx) => {
  // `medium` when files were edited but no test/build ever ran; `high` when the last
  // MAIN-THREAD test run failed and the session ended. Neither branch fires on a possibly-live
  // session. Test runs inside subagents are ignored for the high branch: the claim is that the
  // main thread's own verification ended red, and a subagent's suite (its own worktree, its own
  // scope) says nothing about that.
  const q = ctx.quality
  if (ctx.s.meta.possiblyLive) return []
  const edited = ctx.files.files.filter((f) => f.edits > 0)
  const mainTests = q.testRuns.filter((t) => !t.agentId)
  const lastTest = mainTests.length ? mainTests[mainTests.length - 1] : undefined
  if (lastTest && !lastTest.ok) {
    return [
      mk({
        ruleId: 'unverified-edits',
        severity: 'high',
        axis: 'quality',
        title: 'The last test run failed and the session ended',
        detail: `"${lastTest.command}" (turn ${lastTest.turnIndex}) was the final main-thread test run; ${mainTests.filter((t) => t.ok).length} of ${mainTests.length} main-thread test runs passed; ${edited.length} file${edited.length === 1 ? '' : 's'} edited`,
        recommendation: 'The session closed on a red test, so whatever was delivered is unverified. Re-open, make the suite green (or record why the failure is expected), and make "tests pass" an explicit stop condition in the brief.',
        evidence: { lastTest, testRuns: mainTests.length, testRunsFailed: mainTests.filter((t) => !t.ok).length, filesEdited: edited.length },
        turnIndexes: [lastTest.turnIndex],
        personas: ['qa', 'developer', 'pm'],
      }),
    ]
  }
  if (edited.length && !q.testRuns.length && !q.buildRuns.length) {
    const top = edited.slice(0, 5)
    return [
      mk({
        ruleId: 'unverified-edits',
        severity: 'medium',
        axis: 'quality',
        title: `${edited.length} file${edited.length === 1 ? '' : 's'} edited but no test or build ran`,
        detail: top.map((f) => `${f.path} (${f.edits} edit${f.edits === 1 ? '' : 's'})`).join('; '),
        recommendation: 'Edits that were never exercised by a test, build or typecheck are unverified. Ask the agent to run the project\'s check after editing (and put that command in CLAUDE.md so it does not have to rediscover it).',
        evidence: { filesEdited: edited.length, files: top.map((f) => ({ path: f.path, edits: f.edits })), testRuns: 0, buildRuns: 0 },
        turnIndexes: [...new Set(top.flatMap((f) => f.turnIndexes))].slice(0, 30),
        personas: ['qa', 'developer', 'pm'],
      }),
    ]
  }
  return []
}

const editChurn: Rule = (ctx) => {
  // A file with >= 6 edits by one context is churn (low); >= 3 re-edits of a just-written
  // region within 10 minutes is thrash (medium). Edits are counted per context (main thread or
  // one subagent). Six agents each touching a file once is fan-out, not churn; this mirrors the
  // per-context treatment in reread-files. A quick re-edit = an Edit whose old_string (>= 24
  // chars, so a short anchor like `}` cannot fake containment) appears in an earlier Edit's
  // new_string on the same file in the same context, within the 10-minute window. Living
  // documents (.md files such as status notes and plans) are edited across many turns by design and
  // are suppressed entirely.
  const TEN_MIN = 10 * 60_000
  const MIN_ANCHOR = 24
  const history = new Map<string, Array<{ newString: string; ts?: number }>>()
  const quick = new Map<string, number>() // per (context, path)
  const edits = new Map<string, { path: string; edits: number; turnIndexes: number[] }>() // per (context, path)
  for (const c of ctx.s.toolCalls) {
    if (c.category !== 'edit') continue
    const i = c.input as Record<string, unknown> | undefined
    const p = typeof i?.['file_path'] === 'string' ? (i['file_path'] as string) : typeof i?.['notebook_path'] === 'string' ? (i['notebook_path'] as string) : undefined
    if (!p || p.endsWith('.md')) continue
    const path = shortPath(p, ctx.s.meta.cwd)
    const key = (c.agentId ?? 'main') + '\0' + path
    const e = edits.get(key) ?? { path, edits: 0, turnIndexes: [] }
    e.edits++
    if (!e.turnIndexes.includes(c.turnIndex)) e.turnIndexes.push(c.turnIndex)
    edits.set(key, e)
    const oldStr = String(i?.['old_string'] ?? '')
    const newStr = String(i?.['new_string'] ?? '')
    const h = history.get(key) ?? []
    if (oldStr.length >= MIN_ANCHOR) {
      for (const prev of h) {
        if (prev.ts !== undefined && c.startTs !== undefined && c.startTs - prev.ts <= TEN_MIN && prev.newString.includes(oldStr)) {
          quick.set(key, (quick.get(key) ?? 0) + 1)
          break
        }
      }
    }
    h.push({ newString: newStr, ts: c.startTs })
    if (h.length > 20) h.shift()
    history.set(key, h)
  }
  const pathOfKey = (key: string) => key.slice(key.indexOf('\0') + 1)
  const quickByPath = new Map<string, number>()
  for (const [key, n] of quick) {
    const path = pathOfKey(key)
    quickByPath.set(path, Math.max(quickByPath.get(path) ?? 0, n))
  }
  const churned = [...edits.values()].filter((e) => e.edits >= 6).sort((a, b) => b.edits - a.edits)
  const thrashed = [...quick.entries()].filter(([, n]) => n >= 3).map(([key, n]) => [pathOfKey(key), n] as const)
  if (!churned.length && !thrashed.length) return []
  const top = churned.slice(0, 5)
  return [
    mk({
      ruleId: 'edit-churn',
      severity: thrashed.length ? 'medium' : 'low',
      axis: 'quality',
      title: churned.length
        ? `${churned.length} file${churned.length === 1 ? '' : 's'} edited 6+ times by one context${thrashed.length ? `, ${thrashed.length} re-edited within 10 min` : ''}`
        : `${thrashed.length} file${thrashed.length === 1 ? '' : 's'} re-edited 3+ times within 10 minutes`,
      detail: (top.length ? top : thrashed.map(([path, n]) => ({ path, edits: n, turnIndexes: [] as number[] })))
        .map((f) => `${f.path} ×${f.edits} edit${f.edits === 1 ? '' : 's'}${quickByPath.get(f.path) ? ` (${quickByPath.get(f.path)} quick re-edit${quickByPath.get(f.path) === 1 ? '' : 's'})` : ''}`)
        .join('; '),
      recommendation: 'Repeated edits to the same file, especially re-touching lines written minutes earlier, mean the change was designed while typing. Plan the change first (or ask for a short plan), then write the whole block once; churn burns output tokens and review attention. (Edits are counted per context: many agents each touching a file once is fan-out, not churn; .md living documents are not counted.)',
      evidence: { files: top.map((f) => ({ path: f.path, edits: f.edits, quickReEdits: quickByPath.get(f.path) ?? 0 })), thrashedFiles: thrashed.map(([path, n]) => ({ path, quickReEdits: n })) },
      turnIndexes: [...new Set(top.flatMap((f) => f.turnIndexes))].slice(0, 30),
      personas: ['developer', 'qa'],
    }),
  ]
}

const WORKTREE_PATH_RE = /\/\.?worktrees?\/|\/worktree-/
/**
 * revert-like git segment classifier. Returns what the segment is, so the rule can apply the
 * session-level exclusions (stash-pop pairing, repeated-pathspec rituals).
 * Deliberately NOT counted (cheap deterministic subset of "setup or harness protocol, not undo"):
 * - `git restore --staged …`: unstages, does not discard work
 * - `git checkout <named-ref> -- <path>` where the ref is any branch/remote ref: that transplants
 *   content between branches (integration / sync-from-base), it does not undo this session's work;
 *   only ref-less `checkout -- <path>` and `checkout HEAD[~n] -- <path>` restore local state
 * - `git reset --hard main|master|origin/*` in a worktree context or within the first 3 turns:
 *   the branch-setup idiom (sync a fresh worktree to the base branch)
 * - `git stash [push]` before any edit/write happened, or in a worktree context (handled here);
 *   a stash later re-applied (`stash pop`/`apply`) is parking, not undo (handled by the rule)
 * "Worktree context" = the session cwd is a worktree-style path OR the command itself addresses one.
 */
type RevertHit = { kind: 'revert' | 'restore' | 'reset-hard' | 'checkout' | 'stash'; pathspec?: string }
function revertHits(cmd: string, opts: { worktreeCtx: boolean; earlyTurn: boolean; sawEdit: boolean }): RevertHit[] {
  const hits: RevertHit[] = []
  for (const seg of cmd.split(/&&|\|\||[;\n]/)) {
    const w = seg.trim().split(/\s+/).filter(Boolean)
    const base = (w[0] ?? '').split('/').pop()
    if (base !== 'git') continue
    const sub = w[1]
    const isBaseRef = (x: string | undefined) => x === 'main' || x === 'master' || x?.startsWith('origin/') === true
    if (sub === 'revert') hits.push({ kind: 'revert' })
    else if (sub === 'restore') {
      if (!w.includes('--staged')) hits.push({ kind: 'restore' })
    } else if (sub === 'reset' && w.includes('--hard')) {
      const target = w.slice(2).find((x) => !x.startsWith('-'))
      if (!(isBaseRef(target) && (opts.worktreeCtx || opts.earlyTurn))) hits.push({ kind: 'reset-hard' })
    } else if (sub === 'checkout') {
      const dd = w.indexOf('--')
      if (dd === -1) continue
      const ref = w.slice(2, dd).find((x) => !x.startsWith('-'))
      // a named ref (branch, remote, tag) transplants content; only local-state restores count
      if (ref !== undefined && !/^HEAD(~\d*|\^+)?$/.test(ref)) continue
      hits.push({ kind: 'checkout', pathspec: w.slice(dd + 1).join(' ') || undefined })
    } else if (sub === 'stash' && (w[2] === undefined || w[2] === 'push')) {
      if (opts.sawEdit && !opts.worktreeCtx) hits.push({ kind: 'stash' })
    }
  }
  return hits
}
/** does any segment re-apply a stash? (a parked stash is not an undo) */
function hasStashReapply(cmd: string): boolean {
  return cmd.split(/&&|\|\||[;\n]/).some((seg) => {
    const w = seg.trim().split(/\s+/).filter(Boolean)
    const base = (w[0] ?? '').split('/').pop()
    return base === 'git' && w[1] === 'stash' && (w[2] === 'pop' || w[2] === 'apply')
  })
}

const reverts: Rule = (ctx) => {
  // Edit-then-revert pairs and revert-like git commands are `low`; `medium` when a revert
  // command follows a failed test run in the same turn (the change was backed out red).
  // Noise floor: one isolated revert-like command in a whole session is routine work, not a
  // finding: it takes two revert signals (an edit-then-revert pair counts as two: the write and
  // the un-write) or a revert after a failed test to fire.
  const pairs = ctx.files.editedThenReverted
  const failedTestTurns = new Set(ctx.quality.testRuns.filter((t) => !t.ok).map((t) => t.turnIndex))
  const worktreeCwd = WORKTREE_PATH_RE.test(ctx.s.meta.cwd ?? '')
  const seenFailedTest = new Set<number>() // turns where a failed test already happened, in record order
  const candidates: Array<{ command: string; turnIndex: number; afterFailedTest: boolean; hits: RevertHit[] }> = []
  let sawEdit = false
  let stashReapplied = false
  const checkoutPathspecCount = new Map<string, number>()
  for (const c of ctx.s.toolCalls) {
    if (c.category === 'edit' || c.category === 'write') sawEdit = true
    if (c.name !== 'Bash') continue
    const cmd = String((c.input as Record<string, unknown> | undefined)?.['command'] ?? '')
    if (!cmd) continue
    if (hasStashReapply(cmd)) stashReapplied = true
    const hits = revertHits(cmd, { worktreeCtx: worktreeCwd || WORKTREE_PATH_RE.test(cmd), earlyTurn: c.turnIndex < 3, sawEdit })
    if (hits.length) {
      candidates.push({ command: cmd.slice(0, 120), turnIndex: c.turnIndex, afterFailedTest: seenFailedTest.has(c.turnIndex), hits })
      for (const h of hits) if (h.kind === 'checkout' && h.pathspec) checkoutPathspecCount.set(h.pathspec, (checkoutPathspecCount.get(h.pathspec) ?? 0) + 1)
    }
    if (c.isError && failedTestTurns.has(c.turnIndex)) seenFailedTest.add(c.turnIndex)
  }
  // session-level exclusions: a stash that is popped/applied later parked work rather than
  // discarding it; the same pathspec checkout-restored 3+ times is a pre-commit ritual
  // (regenerated files being reset), not an undo.
  const revertCalls = candidates.filter((r) =>
    r.hits.some((h) => {
      if (h.kind === 'stash' && stashReapplied) return false
      if (h.kind === 'checkout' && h.pathspec && (checkoutPathspecCount.get(h.pathspec) ?? 0) >= 3) return false
      return true
    }),
  )
  const afterFail = revertCalls.filter((r) => r.afterFailedTest)
  if (pairs * 2 + revertCalls.length < 2 && !afterFail.length) return []
  return [
    mk({
      ruleId: 'reverts',
      severity: afterFail.length ? 'medium' : 'low',
      axis: 'quality',
      title: `${pairs + revertCalls.length} revert${pairs + revertCalls.length === 1 ? '' : 's'} (${pairs} edit-then-revert pair${pairs === 1 ? '' : 's'}, ${revertCalls.length} git revert-like command${revertCalls.length === 1 ? '' : 's'})${afterFail.length ? ' after a failed test' : ''}`,
      detail: revertCalls.slice(0, 5).map((r) => `turn ${r.turnIndex}: "${r.command.slice(0, 60)}"${r.afterFailedTest ? ' (after a failed test)' : ''}`).join('; ') || 'an Edit restored the exact string a previous Edit replaced',
      recommendation: 'Reverted work is done twice: once to write it, once to undo it. A revert right after a failed test means the change shipped before it was checked. Have the agent run the test before committing to an approach, or try it in a worktree/branch it can throw away. (Not counted here, as setup or protocol rather than undo: git restore --staged; stashes before anything was edited, in a worktree context, or later popped/applied; checkout -- from a named branch ref (content transplant); the same pathspec checkout-restored 3+ times (regenerated-file ritual); and git reset --hard main/origin/* in a worktree or the session’s opening turns.)',
      evidence: { editedThenReverted: pairs, revertCommands: revertCalls.slice(0, 10).map((r) => ({ command: r.command, turnIndex: r.turnIndex, afterFailedTest: r.afterFailedTest })), afterFailedTest: afterFail.length },
      turnIndexes: [...new Set(revertCalls.map((r) => r.turnIndex))].slice(0, 30),
      personas: ['qa', 'developer'],
    }),
  ]
}

const cacheDominatesTokens: Rule = (ctx) => {
  // Cache share alone is not a useful signal because a normal cached session can be dominated by
  // cache traffic. `reReadMultiplier` measures how often the peak context was carried instead.
  // Escalation combines that repetition with a total-token magnitude floor.
  const k = ctx.tokens.byKind
  const total = ctx.tokens.totalTokens
  const peak = ctx.context.peak
  if (!total || !peak) return []
  const carried = ctx.context.reReadMultiplier
  if (carried < 100) return []
  const cacheTokens = k.cacheRead + k.cacheWrite5m + k.cacheWrite1h
  const share = cacheTokens / total
  return [
    mk({
      ruleId: 'cache-dominates-tokens',
      severity: total >= 750_000_000 ? 'high' : 'info',
      axis: 'tokens',
      title: `The context was carried through the model ${round(carried, 0)}×: ${fmtTokens(total)} tokens, ${round(share * 100, 0)}% of them context re-read or re-written`,
      detail: `cache read ${fmtTokens(k.cacheRead)} + cache write ${fmtTokens(k.cacheWrite5m + k.cacheWrite1h)} against a ${fmtTokens(peak)}-token peak; output is only ${round((k.output / total) * 100, 1)}% of the total, because every call re-reads the whole context before it writes a single token`,
      recommendation: 'Each API call re-reads the whole context, so context size, not output, is where your tokens go. Fewer, larger steps (batch tool calls), subagents with a fresh small context for scans, and a deliberate /compact when the work changes shape are the levers.',
      evidence: { byKind: k, reReadMultiplier: carried, cacheShare: round(share, 4), outputShare: round(k.output / total, 4), peakContext: peak, totalTokens: total },
      turnIndexes: [],
      personas: ['developer', 'pm', 'anyone'],
    }),
  ]
}

const slowTools: Rule = (ctx) => {
  // a tool with p95 > 30 s over >= 5 calls stalls every turn that touches it. Agent/Task waits
  // are delegation, not tool latency. They are covered by the agent and time-budget rules.
  const slow = ctx.tools.byName
    .filter((t) => t.category !== 'agent' && t.category !== 'task' && t.count >= 5 && t.p95Ms > 30_000)
    .sort((a, b) => b.p95Ms - a.p95Ms)
  if (!slow.length) return []
  const top = slow[0]!
  return [
    mk({
      ruleId: 'slow-tool',
      severity: 'low',
      axis: 'time',
      title: `${top.name} is slow: p95 ${fmtMs(top.p95Ms)} over ${top.count} calls`,
      detail: slow.slice(0, 3).map((t) => `${t.name}: p95 ${fmtMs(t.p95Ms)}, max ${fmtMs(t.maxMs)}, ${fmtMs(t.totalMs)} total across ${t.count} calls`).join('; '),
      recommendation: 'A consistently slow tool stalls every turn that touches it. Time the command outside the session, cache or pre-build what it recomputes, narrow its scope, or run it in the background and poll instead of blocking the turn.',
      evidence: { tools: slow.slice(0, 5).map((t) => ({ name: t.name, count: t.count, p95Ms: t.p95Ms, maxMs: t.maxMs, totalMs: t.totalMs })) },
      turnIndexes: [],
      personas: ['developer'],
    }),
  ]
}

const agentHealth: Rule = (ctx) => {
  // Agents that did not finish are low severity (medium for 2+ hard errors); deep trees are informational.
  // On disk today `run.status` is only ever teammate_spawned / async_launched / completed / killed.
  // `killed` is the one failure-shaped terminal state and is a WEAK signal (a deliberate kill of a
  // background agent is routine), so it caps at `low`. /error|fail/i is kept for adapters that do
  // report explicit error states; richer notification-derived end states can be added separately.
  const out: Insight[] = []
  const hardFailed = ctx.agents.runs.filter((r) => r.status !== undefined && /error|fail/i.test(r.status))
  const killed = ctx.agents.runs.filter((r) => r.status === 'killed')
  const failed = [...hardFailed, ...killed]
  if (failed.length) {
    out.push(
      mk({
        ruleId: 'failed-agents',
        severity: hardFailed.length >= 2 ? 'medium' : 'low',
        axis: 'quality',
        title: `${failed.length} subagent run${failed.length === 1 ? '' : 's'} did not finish (${killed.length ? `${killed.length} killed` : ''}${killed.length && hardFailed.length ? ', ' : ''}${hardFailed.length ? `${hardFailed.length} errored` : ''})`,
        detail: failed.slice(0, 5).map((r) => `${r.agentType ?? r.name ?? r.agentId} (${r.status}${r.toolErrors ? `, ${r.toolErrors} tool errors` : ''}) ${fmtTokens(r.totalTokens)}`).join('; '),
        recommendation: 'An agent that was killed or errored spends its tokens without a usable result, and the parent usually redoes the work inline. Read the agent\'s last output, tighten its brief (concrete files, commands, stop conditions), and surface the failure reason instead of retrying blind. A deliberate kill of a stale background agent is fine. This is a pointer, not an alarm.',
        evidence: { failed: failed.slice(0, 10).map((r) => ({ agentId: r.agentId, agentType: r.agentType, name: r.name, status: r.status, toolErrors: r.toolErrors, tokens: r.totalTokens })) },
        turnIndexes: [...new Set(failed.map((r) => r.turnIndex).filter((x): x is number => x !== undefined))].slice(0, 30),
        personas: ['developer', 'qa'],
      }),
    )
  }
  if (ctx.agents.maxDepth >= 3) {
    out.push(
      mk({
        ruleId: 'deep-fanout',
        severity: 'info',
        axis: 'tokens',
        title: `Agents spawned agents ${ctx.agents.maxDepth} levels deep`,
        detail: `${ctx.agents.runs.length} run${ctx.agents.runs.length === 1 ? '' : 's'}, max depth ${ctx.agents.maxDepth}, max ${ctx.agents.maxConcurrency} concurrent`,
        recommendation: 'Deep agent trees multiply context baselines and make failures hard to attribute. Prefer a flat fan-out from the main thread with a tight brief per agent; reserve depth for genuinely recursive work.',
        evidence: { maxDepth: ctx.agents.maxDepth, runs: ctx.agents.runs.length, maxConcurrency: ctx.agents.maxConcurrency },
        turnIndexes: [],
        personas: ['developer', 'lead'],
      }),
    )
  }
  return out
}

const skillTokenWeight: Rule = (ctx) => {
  // A skill whose per-invocation token weight exceeds 2x the session's median per-human-turn
  // tokens. The per-skill weight is computed here from the usage events Claude Code itself attributed
  // to the skill (`attributionSkill` on assistant records); no attribution, no finding.
  if (!ctx.s.skills.length) return []
  const humanTurnTokens = ctx.turns.filter((t) => t.kind === 'human').map((t) => t.totalTokens).sort((a, b) => a - b)
  if (humanTurnTokens.length < 3) return []
  const mid = humanTurnTokens.length % 2 ? humanTurnTokens[(humanTurnTokens.length - 1) / 2]! : (humanTurnTokens[humanTurnTokens.length / 2 - 1]! + humanTurnTokens[humanTurnTokens.length / 2]!) / 2
  if (mid <= 0) return []
  const norm = (name: string) => name.split(':').pop() ?? name
  const counts = new Map<string, number>()
  for (const k of ctx.s.skills) counts.set(norm(k.name), (counts.get(norm(k.name)) ?? 0) + 1)
  const tokensBySkill = new Map<string, number>()
  for (const u of ctx.s.usageEvents) {
    const name = u.attribution?.skill
    if (!name) continue
    tokensBySkill.set(norm(name), (tokensBySkill.get(norm(name)) ?? 0) + totalTokens(u.usage))
  }
  const heavy: Array<{ name: string; invocations: number; tokens: number; perInvocationTokens: number }> = []
  for (const [name, tokens] of tokensBySkill) {
    const invocations = Math.max(1, counts.get(name) ?? 1)
    const per = tokens / invocations
    if (per > 2 * mid) heavy.push({ name, invocations, tokens, perInvocationTokens: Math.round(per) })
  }
  if (!heavy.length) return []
  heavy.sort((a, b) => b.perInvocationTokens - a.perInvocationTokens)
  const top = heavy[0]!
  return [
    mk({
      ruleId: 'skill-token-weight',
      severity: 'low',
      axis: 'tokens',
      title: `Skill ${top.name} moves ${fmtTokens(top.perInvocationTokens)} tokens per invocation, over 2× the median turn (${fmtTokens(Math.round(mid))})`,
      detail: heavy.slice(0, 5).map((c) => `${c.name}: ${fmtTokens(c.tokens)} over ${c.invocations} invocation${c.invocations === 1 ? '' : 's'} (${fmtTokens(c.perInvocationTokens)} each)`).join('; '),
      recommendation: 'A heavy skill usually means its body (and the files it loads) bloats the context for every step it runs. Trim the skill\'s instructions, defer its reference docs to on-demand reads, or give it a smaller model / lower effort in its frontmatter.',
      evidence: { skills: heavy.slice(0, 10), medianHumanTurnTokens: Math.round(mid) },
      turnIndexes: [],
      personas: ['developer', 'lead'],
    }),
  ]
}

const timeBudget: Rule = (ctx) => {
  // Tools or subagents taking >= 75% of active time are worth naming. modelMs is a residual
  // (active − tools − agents), not a measurement. Never fire on it. Shares are clamped to 100%
  // (toolMs is an interval union and clamped in analyzeTime, but belt-and-braces here).
  // Guarded to sessions with at least a minute of active work so trivial chats stay quiet.
  const active = ctx.time.activeMs
  if (active < 60_000) return []
  const parts = [
    { key: 'tool execution', ms: ctx.time.toolMs },
    { key: 'subagents', ms: ctx.time.agentMs },
  ]
    .map((p) => ({ ...p, share: Math.min(1, p.ms / active) }))
    .filter((p) => p.share >= 0.75)
  if (!parts.length) return []
  const dominant = parts.sort((a, b) => b.share - a.share)[0]!
  const rec =
    dominant.key === 'tool execution'
      ? 'Tool execution dominates the active time: the model is mostly waiting on commands. Look at the slowest tools (timeouts, caching, narrower scope) or run long commands in the background.'
      : 'Subagent wall time dominates: spawn agents in parallel or async so the parent keeps working, and tighten agent briefs so they finish sooner.'
  return [
    mk({
      ruleId: 'time-budget',
      severity: 'info',
      axis: 'time',
      title: `${round(dominant.share * 100, 0)}% of the ${fmtMs(active)} active time went to ${dominant.key}`,
      detail: `tools ${fmtMs(ctx.time.toolMs)} · subagents ${fmtMs(ctx.time.agentMs)} · model ${fmtMs(ctx.time.modelMs)} · active ${fmtMs(active)}`,
      recommendation: rec,
      evidence: { activeMs: active, toolMs: ctx.time.toolMs, agentMs: ctx.time.agentMs, modelMs: ctx.time.modelMs, dominant: dominant.key },
      turnIndexes: [],
      personas: ['pm', 'developer', 'anyone'],
    }),
  ]
}


// ---------------- additional diagnostic rules ----------------

/** miss types a user action can influence; `unavailable` / `previous_message_not_found` are infra-side */
const ACTIONABLE_MISS = new Set(['tools_changed', 'model_changed', 'system_changed', 'messages_changed'])

const cacheInvalidation: Rule = (ctx) => {
  // Group cache misses by diagnostic reason and count the tokens the miss forced to be re-written.
  // NO savings is claimed: a miss re-writes the same tokens it would otherwise have re-read, so the
  // token count is unchanged; only the category moves. Wallpaper guard: infra-side misses with no
  // token count never fire alone.
  const misses = ctx.context.cacheMisses
  if (!misses.length) return []
  const tokenEvents = misses.filter((e) => (e.missedInputTokens ?? 0) > 0)
  const actionable = misses.filter((e) => ACTIONABLE_MISS.has(e.type))
  if (!tokenEvents.length && !actionable.length) return []
  const byType = new Map<string, { events: number; missedTokens: number }>()
  for (const e of misses) {
    const g = byType.get(e.type) ?? { events: 0, missedTokens: 0 }
    g.events++
    g.missedTokens += e.missedInputTokens ?? 0
    byType.set(e.type, g)
  }
  const missedTotal = tokenEvents.reduce((a, e) => a + (e.missedInputTokens ?? 0), 0)
  const maxMissed = tokenEvents.reduce((a, e) => Math.max(a, e.missedInputTokens ?? 0), 0)
  const countable = new Set([...tokenEvents, ...actionable]).size
  // doc thresholds: low per event < 50k, medium 50k–300k, high > 300k or more than 3 events per session.
  // The count-driven high branch also needs a 50k medium floor on missed tokens:
  // many tiny misses are worth naming, but not at `high`; below the floor they cap at medium.
  const severity: InsightSeverity =
    maxMissed > 300_000 || (countable > 3 && missedTotal >= 50_000) ? 'high' : maxMissed >= 50_000 || countable > 3 ? 'medium' : 'low'
  return [
    mk({
      ruleId: 'cache-invalidation',
      severity,
      axis: 'tokens',
      title: `${misses.length} cache invalidation event${misses.length === 1 ? '' : 's'} re-wrote ${fmtTokens(missedTotal)} tokens into the cache`,
      detail: [...byType.entries()].sort((a, b) => b[1].missedTokens - a[1].missedTokens).map(([t, g]) => `${t} ×${g.events}${g.missedTokens ? ` (${fmtTokens(g.missedTokens)} tokens)` : ''}`).join('; '),
      recommendation:
        'Switching models (/model) or loading new tools mid-session invalidates the prompt cache: the whole context has to be written again instead of read back, and a re-write is slower than a cache hit. Load MCP tools at the start, avoid model switches inside a long session, or start a fresh session for a different model. `unavailable` and `previous_message_not_found` misses are on the provider side. There is nothing to change.',
      evidence: {
        byType: [...byType.entries()].map(([type, g]) => ({ type, events: g.events, missedTokens: g.missedTokens })),
        events: misses.slice(0, 10).map((e) => ({ turnIndex: e.turnIndex, type: e.type, missedInputTokens: e.missedInputTokens, model: e.model, agentId: e.agentId })),
        missedTokensTotal: missedTotal,
      },
      turnIndexes: [...new Set(misses.map((e) => e.turnIndex))].slice(0, 30),
      personas: ['developer', 'lead'],
    }),
  ]
}

const cacheTtlChurn: Rule = (ctx) => {
  // The 5-minute and 1-hour tiers write the same token count, so this reports configuration rather
  // than a saving. The relevant denominator is total cache writes, and the materiality floor keeps
  // trivial write volumes from producing a finding.
  const k = ctx.tokens.byKind
  const writes = k.cacheWrite5m + k.cacheWrite1h
  if (writes < 100_000) return []
  const share = k.cacheWrite1h / writes
  if (share <= 0.75) return []
  const gaps = ctx.s.turns.map((t) => t.humanGapMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b)
  const medianGap = gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2) : undefined
  const quickCadence = gaps.length >= 3 && medianGap !== undefined && medianGap < 5 * 60_000
  return [
    mk({
      ruleId: 'cache-ttl-churn',
      severity: quickCadence ? 'medium' : 'info',
      axis: 'tokens',
      title: `${round(share * 100, 0)}% of the ${fmtTokens(writes)} tokens written to cache went to the 1-hour tier`,
      detail: `${fmtTokens(k.cacheWrite1h)} on the 1h tier vs ${fmtTokens(k.cacheWrite5m)} on the 5m tier${medianGap !== undefined ? `; median gap between turns ${fmtMs(medianGap)}` : ''}`,
      recommendation:
        'Claude Code can hold your context in the cache for 5 minutes or for 1 hour. Both write the same tokens, so this changes nothing about your usage. But when your turns come faster than every 5 minutes, the short tier keeps the cache just as warm. Nothing to change in the transcript; this is a harness setting worth knowing about.',
      evidence: { cacheWrite1hTokens: k.cacheWrite1h, cacheWrite5mTokens: k.cacheWrite5m, cacheWrites: writes, cacheWrite1hShareOfWrites: round(share, 4), medianTurnGapMs: medianGap, quickCadence },
      turnIndexes: [],
      personas: ['lead', 'pm', 'developer'],
    }),
  ]
}

const blockingQuestions: Rule = (ctx) => {
  // An AskUserQuestion whose result took minutes-to-hours is the run waiting on a human decision.
  // low > 5 min, medium > 30 min, high > 2 h with no subagent working in the gap.
  const FIVE_MIN = 5 * 60_000
  const asks = ctx.s.toolCalls.filter((c) => c.name === 'AskUserQuestion' && (c.durationMs ?? 0) > FIVE_MIN)
  if (!asks.length) return []
  const overlapsAgent = (a: ToolCall) =>
    ctx.s.agents.some((r) => r.startTs !== undefined && r.endTs !== undefined && a.startTs !== undefined && a.endTs !== undefined && r.startTs < a.endTs && r.endTs > a.startTs)
  let severity: InsightSeverity = 'low'
  for (const a of asks) {
    const ms = a.durationMs ?? 0
    if (ms > 2 * 3_600_000 && !overlapsAgent(a)) severity = 'high'
    else if (ms > 30 * 60_000 && severity !== 'high') severity = 'medium'
  }
  const totalMs = asks.reduce((a, c) => a + (c.durationMs ?? 0), 0)
  const longest = asks.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a))
  return [
    mk({
      ruleId: 'blocking-questions',
      severity,
      axis: 'time',
      title: `${asks.length} question${asks.length === 1 ? '' : 's'} to the human blocked the run for ${fmtMs(totalMs)} (longest ${fmtMs(longest.durationMs ?? 0)})`,
      detail: asks.slice(0, 5).map((c) => `turn ${c.turnIndex}: ${fmtMs(c.durationMs ?? 0)}${overlapsAgent(c) ? ' (subagents kept working)' : ''}`).join('; '),
      recommendation:
        'A blocking question stops the whole run until someone answers. Front-load the decisions into the brief, give the agent a default (“if unsure, do X”), or have it park the question and continue on independent work.',
      evidence: { asks: asks.slice(0, 10).map((c) => ({ turnIndex: c.turnIndex, durationMs: c.durationMs, backgroundWork: overlapsAgent(c) })), totalBlockedMs: totalMs },
      turnIndexes: [...new Set(asks.map((c) => c.turnIndex))].slice(0, 30),
      savings: { ms: totalMs, estimated: true },
      personas: ['pm', 'developer', 'anyone'],
    }),
  ]
}

const truncatedReadsRule: Rule = (ctx) => {
  // Read results Claude Code cut at the token cap (toolUseResult.file.truncatedByTokenCap).
  // low each; medium when the same file was capped twice (the slice never got narrower).
  const trunc = ctx.s.toolCalls.filter((c) => c.truncated)
  if (!trunc.length) return []
  const byFile = new Map<string, { count: number; turnIndexes: number[] }>()
  for (const c of trunc) {
    const i = c.input as Record<string, unknown> | undefined
    const raw = typeof i?.['file_path'] === 'string' ? (i['file_path'] as string) : c.inputSummary
    const path = shortPath(raw, ctx.s.meta.cwd)
    const e = byFile.get(path) ?? { count: 0, turnIndexes: [] }
    e.count++
    if (!e.turnIndexes.includes(c.turnIndex)) e.turnIndexes.push(c.turnIndex)
    byFile.set(path, e)
  }
  const repeat = [...byFile.entries()].filter(([, e]) => e.count >= 2)
  return [
    mk({
      ruleId: 'truncated-reads',
      severity: repeat.length ? 'medium' : 'low',
      axis: 'context',
      title: `${trunc.length} Read result${trunc.length === 1 ? '' : 's'} hit the token cap${repeat.length ? `; ${repeat.length} file${repeat.length === 1 ? '' : 's'} capped twice` : ''}`,
      detail: [...byFile.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([p, e]) => `${p} ×${e.count}`).join('; '),
      recommendation:
        'A capped Read spent its tokens and still did not deliver the whole file; re-reading the same file capped again doubles that. Use offset/limit or grep to fetch the slice you need.',
      evidence: { files: [...byFile.entries()].slice(0, 10).map(([path, e]) => ({ path, count: e.count })), truncationNotices: ctx.s.meta.truncatedReads },
      turnIndexes: [...new Set(trunc.map((c) => c.turnIndex))].slice(0, 30),
      personas: ['developer'],
    }),
  ]
}

const hiddenIterationsRule: Rule = (ctx) => {
  // usage.iterations can carry attempts that never appeared as messages (fallback retries).
  // Doc ladder says `critical` for a session-scoped fallback, but that severity does not exist in the
  // contract (Tier E backlog), so it caps at `high` here.
  const hidden = ctx.s.usageEvents.filter((u) => u.hiddenIteration)
  if (!hidden.length) return []
  const fallbacks = hidden.filter((u) => u.hiddenIteration!.type === 'fallback_message')
  const sessionScoped = ctx.s.messages.some((m) => m.systemSubtype === 'model_refusal_fallback')
  const severity: InsightSeverity = sessionScoped ? 'high' : fallbacks.length ? 'medium' : 'info'
  const tokens = hidden.reduce((a, u) => a + usageTotal(u.usage), 0)
  return [
    mk({
      ruleId: 'hidden-iterations',
      severity,
      axis: 'tokens',
      title: `${hidden.length} hidden iteration${hidden.length === 1 ? '' : 's'} used ${fmtTokens(tokens)} tokens you never saw as a message${sessionScoped ? ': a refusal switched the model for the rest of the session' : ''}`,
      detail: hidden.slice(0, 5).map((u) => `turn ${u.turnIndex}: ${u.hiddenIteration!.type ?? 'iteration'} on ${u.model}`).join('; '),
      recommendation: sessionScoped
        ? 'A safety classifier declined one request and Claude Code fell back to another model for the rest of the session. That is not the model you chose, and not necessarily the same quality. If you wanted the original model, start a new session.'
        : 'These attempts used tokens but never appeared as messages (a refused or retried first try). Nothing to fix per event; recurring fallbacks are worth a look at the model column in the timeline.',
      evidence: { count: hidden.length, tokens, fallbackMessages: fallbacks.length, sessionScopedFallback: sessionScoped, rollup: ctx.tokens.hiddenIterations },
      turnIndexes: [...new Set(hidden.map((u) => u.turnIndex))].slice(0, 30),
      personas: ['developer', 'pm'],
    }),
  ]
}

const binaryAttachments: Rule = (ctx) => {
  // A base64 PDF/image block over 500 KB is re-sent with every later call.
  const big: Array<{ kind: string; bytes: number; turnIndex: number }> = []
  for (const m of ctx.s.messages) {
    for (const b of m.blocks) {
      if ((b.kind === 'image' || b.kind === 'document') && b.bytes > 500_000) big.push({ kind: b.kind, bytes: b.bytes, turnIndex: m.turnIndex })
    }
  }
  if (!big.length) return []
  const bytes = big.reduce((a, b) => a + b.bytes, 0)
  const tokens = Math.round(bytes / BYTES_PER_TOKEN)
  return [
    mk({
      ruleId: 'binary-attachments',
      severity: 'medium',
      axis: 'context',
      title: `${big.length} binary attachment${big.length === 1 ? '' : 's'} over 500 KB in the transcript (${Math.round(bytes / 1024)} KB total)`,
      detail: big.slice(0, 5).map((b) => `${b.kind} ${Math.round(b.bytes / 1024)} KB at turn ${b.turnIndex}`).join('; '),
      recommendation: 'A pasted PDF/image is re-sent with every call. Convert it to text (or extract the pages you need) before pasting, and keep large binaries out of the conversation.',
      evidence: { blocks: big.slice(0, 10), totalBytes: bytes, estimatedTokens: tokens },
      turnIndexes: [...new Set(big.map((b) => b.turnIndex))].slice(0, 30),
      savings: { tokens, estimated: true },
      personas: ['developer', 'anyone'],
    }),
  ]
}

const queuedPrompts: Rule = (ctx) => {
  // Prompts queued while the agent worked. Positive framing (the queue kept the session busy
  // instead of idle); away summaries mean the human caught up after being away.
  // Machine task notifications are not queued human prompts, so the threshold binds on human
  // enqueues only; the notification count stays visible as context.
  const q = ctx.s.meta.queueOperations
  const enqueued = q?.['enqueue'] ?? 0
  const human = ctx.s.meta.enqueueKinds?.human ?? enqueued
  const notification = ctx.s.meta.enqueueKinds?.notification ?? 0
  const away = ctx.s.events.filter((e) => e.kind === 'away_summary').length
  if (human < 20) return []
  return [
    mk({
      ruleId: 'queued-prompts',
      severity: 'info',
      axis: 'time',
      title: `${human} prompt${human === 1 ? '' : 's'} queued while the agent worked${away ? `; ${away} away summar${away === 1 ? 'y' : 'ies'}` : ''}`,
      detail: `queue operations: ${Object.entries(q ?? {}).map(([op, n]) => `${op} ×${n}`).join(', ') || 'none'}${notification ? `; ${notification} machine notification${notification === 1 ? '' : 's'} (task/system) not counted as prompts` : ''}`,
      recommendation:
        'Queueing prompts keeps the agent busy instead of idle between your visits. This is the session working well, not a problem. Away summaries mean Claude Code caught you up after time away.',
      evidence: { queueOperations: q ?? {}, humanEnqueues: human, notificationEnqueues: notification, awaySummaries: away },
      turnIndexes: [],
      personas: ['pm', 'anyone'],
    }),
  ]
}

const MECHANICAL_TOOLS = new Set(['TaskUpdate', 'TaskCreate', 'Read', 'Glob', 'Grep', 'ToolSearch', 'ListAgents'])
const READONLY_BASH_RE = /^\s*(ls|cat|head|tail|wc|grep|rg|find|pwd|echo)\b|^\s*git\s+(status|log|diff|show|branch)\b|^\s*gh\s+(pr|run)\s+(view|list)\b/
const thinkingOnMechanical: Rule = (ctx) => {
  // More than 2k thinking tokens on one mechanical tool call (Read, Glob, or read-only Bash).
  // Only fires where the client reported thinking_tokens (CC >= 2.1.228); never estimated from block length.
  const usesByProviderMsg = new Map<string, Array<{ name: string; input: unknown }>>()
  const msgByUuid = new Map(ctx.s.messages.map((m) => [m.uuid, m]))
  for (const m of ctx.s.messages) {
    if (m.role !== 'assistant' || !m.providerMessageId) continue
    for (const b of m.blocks) {
      if (b.kind !== 'tool_use') continue
      const arr = usesByProviderMsg.get(m.providerMessageId) ?? []
      arr.push({ name: b.name, input: b.input })
      usesByProviderMsg.set(m.providerMessageId, arr)
    }
  }
  const hits: Array<{ turnIndex: number; tool: string; thinkingTokens: number }> = []
  let totalThinking = 0
  for (const u of ctx.s.usageEvents) {
    if (u.hiddenIteration) continue
    totalThinking += u.thinkingTokens ?? 0
    if ((u.thinkingTokens ?? 0) <= 2_000) continue
    const m = msgByUuid.get(u.messageUuid)
    const uses = m?.providerMessageId ? (usesByProviderMsg.get(m.providerMessageId) ?? []) : []
    if (uses.length !== 1) continue
    const t = uses[0]!
    const cmd = String((t.input as Record<string, unknown> | undefined)?.['command'] ?? '')
    const mechanical = MECHANICAL_TOOLS.has(t.name) || (t.name === 'Bash' && READONLY_BASH_RE.test(cmd))
    if (mechanical) hits.push({ turnIndex: u.turnIndex, tool: t.name, thinkingTokens: u.thinkingTokens ?? 0 })
  }
  if (!hits.length) return []
  const wasted = hits.reduce((a, h) => a + h.thinkingTokens, 0)
  return [
    mk({
      ruleId: 'thinking-on-mechanical',
      severity: 'low',
      axis: 'tokens',
      title: `${hits.length} mechanical single-tool call${hits.length === 1 ? '' : 's'} spent over 2k thinking tokens each (${fmtTokens(wasted)} total)`,
      detail: hits.slice(0, 5).map((h) => `turn ${h.turnIndex}: ${h.tool} with ${fmtTokens(h.thinkingTokens)} thinking tokens`).join('; '),
      recommendation:
        'Thinking tokens are output tokens: the model generates them one at a time, so they add latency as well as volume, and a routine Read or status check rarely needs them. Lower the effort for mechanical steps (/effort medium, or effort in an agent’s frontmatter); keep high effort for the hard ones, where thinking is the point.',
      evidence: { calls: hits.slice(0, 10), wastedThinkingTokens: wasted, sessionThinkingTokens: totalThinking },
      turnIndexes: [...new Set(hits.map((h) => h.turnIndex))].slice(0, 30),
      savings: { tokens: Math.round(capSavings(ctx, wasted)), estimated: true },
      personas: ['developer'],
    }),
  ]
}

const outputBurst: Rule = (ctx) => {
  // Messages that wrote > 8k output tokens; `low` when bursts carried Write/Edit content a
  // script or template could have generated. It takes 10+ bursts, a repeated working style rather
  // than an isolated large response, to be worth naming.
  const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  const bursts = ctx.s.usageEvents.filter((u) => !u.hiddenIteration && u.usage.output > 8_000)
  if (bursts.length < 10) return []
  const msgByUuid = new Map(ctx.s.messages.map((m) => [m.uuid, m]))
  const editToolByProviderMsg = new Map<string, string>()
  for (const m of ctx.s.messages) {
    if (m.role !== 'assistant' || !m.providerMessageId) continue
    for (const b of m.blocks) if (b.kind === 'tool_use' && EDIT_TOOLS.has(b.name)) editToolByProviderMsg.set(m.providerMessageId, b.name)
  }
  const rows = bursts.map((u) => {
    const pid = msgByUuid.get(u.messageUuid)?.providerMessageId
    return { turnIndex: u.turnIndex, outputTokens: u.usage.output, model: u.model, writeTool: pid ? editToolByProviderMsg.get(pid) : undefined, agentId: u.agentId }
  })
  const scripted = rows.filter((r) => r.writeTool)
  return [
    mk({
      ruleId: 'output-burst',
      severity: scripted.length >= 3 ? 'low' : 'info',
      axis: 'tokens',
      title: `${bursts.length} message${bursts.length === 1 ? '' : 's'} wrote over 8k output tokens${scripted.length ? ` (${scripted.length} generating file content)` : ''}`,
      detail: rows.sort((a, b) => b.outputTokens - a.outputTokens).slice(0, 5).map((r) => `turn ${r.turnIndex}: ${fmtTokens(r.outputTokens)} tokens${r.writeTool ? ` (${r.writeTool})` : ''}`).join('; '),
      recommendation:
        'Output is the one kind of token the model has to produce one at a time, so a burst is also the slowest part of a turn. A burst that is mostly generated file content (a big Write/Edit) can often come from a script or template instead; a burst of prose or plan text is usually the work itself.',
      evidence: { bursts: rows.slice(0, 10), writeBursts: scripted.length },
      turnIndexes: [...new Set(rows.map((r) => r.turnIndex))].slice(0, 30),
      personas: ['developer', 'lead'],
    }),
  ]
}

const mcpDefinitionWeight: Rule = (ctx) => {
  // MCP servers whose deferred tools were listed all session and never called. The listing itself
  // rides in every request; the count per server is exact, the token weight is an ESTIMATE
  // (~25 tokens per listed name-line) because the transcript does not carry the definition bytes.
  const TOKENS_PER_LISTED_TOOL = 25
  const roster = (ctx.s.meta.deferredToolNames ?? []).filter((n) => n.startsWith('mcp__'))
  if (!roster.length) return []
  const called = new Map<string, number>() // server -> calls
  for (const c of ctx.s.toolCalls) {
    if (!c.name.startsWith('mcp__')) continue
    const server = c.name.split('__')[1] ?? c.name
    called.set(server, (called.get(server) ?? 0) + 1)
  }
  const listed = new Map<string, number>() // server -> listed tool count
  for (const n of roster) {
    const server = n.split('__')[1] ?? n
    listed.set(server, (listed.get(server) ?? 0) + 1)
  }
  const idle = [...listed.entries()].filter(([server, n]) => n >= 5 && !(called.get(server) ?? 0)).sort((a, b) => b[1] - a[1])
  if (!idle.length) return []
  const idleTools = idle.reduce((a, [, n]) => a + n, 0)
  // An idle server alone is weak evidence. The weight matters once the listing has been carried through
  // enough requests, so the rule requires an estimated 500k carried tokens for the session.
  const mainRequests = ctx.context.series.filter((p) => !p.agentId).length
  const estTokens = idleTools * TOKENS_PER_LISTED_TOOL * mainRequests
  if (estTokens < 500_000) return []
  return [
    mk({
      ruleId: 'mcp-definition-weight',
      severity: 'info',
      axis: 'context',
      title: `${idle.length} MCP server${idle.length === 1 ? '' : 's'} listed ${idleTools} tools that were never called (≈ ${fmtTokens(estTokens)} tokens carried, estimated)`,
      detail: idle.slice(0, 5).map(([server, n]) => `${server}: ${n} tools, 0 calls`).join('; '),
      recommendation:
        'Every connected MCP server puts its tool listing into the session, and loading its schemas adds more on top. Disable servers you do not use in this repo (project .mcp.json / settings), or keep them deferred and unloaded.',
      evidence: { servers: idle.map(([server, tools]) => ({ server, tools, calls: 0 })), listedMcpTools: roster.length, mainRequests, estimatedCarriedTokens: estTokens, estimatedTokensPerRequest: idleTools * TOKENS_PER_LISTED_TOOL, estimated: true },
      turnIndexes: [],
      personas: ['developer', 'lead'],
    }),
  ]
}

// ---------------- workflow improvement rules ----------------

const scriptCandidate: Rule = (ctx) => {
  // Detect scriptable deterministic work with two patterns:
  //  (a) templated Bash repeats: bashTemplate() folds paths/hashes/numbers to placeholders; a
  //      template with >= 5 instances across >= 2 distinct raw commands is scriptable. Identical
  //      commands (1 distinct raw) are repeated-commands' territory, excluded here.
  //  (b) a repeated tool sequence: the same 3-call n-gram with >= 2 distinct tool names, counted
  //      NON-overlapping and PER CONTEXT (main thread and each agent separately, never across the
  //      boundary, because cross-context sums re-inflate on 200-agent sessions). Grams made only of
  //      read/search/task bookkeeping belong to sequential-reads, grams touching Agent/plan/ask
  //      calls belong to fanout-opportunity or are interactive; both are excluded (no double-firing).
  // The rule fires only when the top pattern reaches x15, filtering incidental repetition in long
  // sessions. Lower-frequency patterns still ride along in evidence once the rule fires.
  // Savings: model tokens (fresh input + output) of the turns that carried the repeats x (n-1)/n:
  // a script runs the batch as one turn instead of n. ESTIMATE, capped.
  // Turn indexes are PER-CONTEXT counters (every agent restarts at 0), so turns are keyed
  // by (agentId, turnIndex); a bare turnIndex would match unrelated contexts' usage events.
  const ctxTurn = (r: { agentId?: string; turnIndex: number }): string => `${r.agentId ?? ''}|${r.turnIndex}`
  const turnOf = (k: string): number => Number(k.slice(k.lastIndexOf('|') + 1))
  const templates = new Map<string, { count: number; raws: Set<string>; turns: Set<string>; sample: string }>()
  for (const c of ctx.s.toolCalls) {
    if (c.name !== 'Bash') continue
    const cmd = String((c.input as Record<string, unknown> | undefined)?.['command'] ?? '').trim()
    if (!cmd || cmd.length < 6) continue
    const t = bashTemplate(cmd)
    const e = templates.get(t) ?? { count: 0, raws: new Set<string>(), turns: new Set<string>(), sample: cmd }
    e.count++
    if (e.raws.size < 12) e.raws.add(cmd)
    e.turns.add(ctxTurn(c))
    templates.set(t, e)
  }
  const tpl = [...templates.entries()]
    .filter(([, e]) => e.count >= 5 && e.raws.size >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)

  const byCtxKey = new Map<string, ToolCall[]>()
  for (const c of ctx.s.toolCalls) {
    const k = c.agentId ?? ''
    const arr = byCtxKey.get(k)
    if (arr) arr.push(c)
    else byCtxKey.set(k, [c])
  }
  const gramBest = new Map<string, { gram: string; count: number; turns: Set<string> }>()
  for (const calls of byCtxKey.values()) {
    const syms = calls.map((c) => c.name)
    for (const h of repeatedNgrams(syms, 3, 4)) {
      if (new Set(h.gram).size < 2) continue
      const cats = h.gram.map((_, j) => calls[h.starts[0]! + j]!.category)
      if (cats.some((cat) => cat === 'agent' || cat === 'ask' || cat === 'plan')) continue
      if (cats.every((cat) => cat === 'read' || cat === 'search' || cat === 'task')) continue
      const key = h.gram.join('→')
      const prev = gramBest.get(key)
      if (prev && prev.count >= h.count) continue
      const turns = new Set<string>()
      for (const start of h.starts) for (let j = 0; j < h.gram.length; j++) turns.add(ctxTurn(calls[start + j]!))
      gramBest.set(key, { gram: key, count: h.count, turns })
    }
  }
  const grams = [...gramBest.values()].sort((a, b) => b.count - a.count || (a.gram < b.gram ? -1 : 1)).slice(0, 3)
  const topCount = Math.max(tpl[0]?.[1].count ?? 0, grams[0]?.count ?? 0)
  if (topCount < 15) return []

  const tokensInTurns = (turns: Set<string>): { inTok: number; outTok: number } => {
    let inTok = 0
    let outTok = 0
    for (const u of ctx.s.usageEvents) {
      if (u.hiddenIteration || !turns.has(ctxTurn(u))) continue
      inTok += u.usage.input
      outTok += u.usage.output
    }
    return { inTok, outTok }
  }
  let saveIn = 0
  let saveOut = 0
  const unionTurns = new Set<string>()
  const items: Array<{ turns: Set<string>; n: number }> = [
    ...tpl.map(([, e]) => ({ turns: e.turns, n: e.count })),
    ...grams.map((g) => ({ turns: g.turns, n: g.count })),
  ]
  for (const it of items) {
    const { inTok, outTok } = tokensInTurns(it.turns)
    const f = (it.n - 1) / it.n
    saveIn += inTok * f
    saveOut += outTok * f
    for (const t of it.turns) unionTurns.add(t)
  }
  const union = tokensInTurns(unionTurns)
  saveIn = Math.min(saveIn, union.inTok)
  saveOut = Math.min(saveOut, union.outTok)
  const tokens = Math.round(capSavings(ctx, saveIn + saveOut))
  const parts: string[] = []
  if (tpl.length) parts.push(`${tpl.length} Bash template${tpl.length > 1 ? 's' : ''} ×${tpl[0]![1].count}`)
  if (grams.length) parts.push(`${grams.length} tool sequence${grams.length > 1 ? 's' : ''} ×${grams[0]!.count}`)
  return [
    mk({
      ruleId: 'script-candidate',
      severity: topCount >= 30 ? 'medium' : 'low',
      axis: 'tokens',
      title: `Scriptable repetition: ${parts.join(', ')}; a script could run the batch in one turn`,
      detail: [
        ...tpl.map(([t, e]) => `"${t.slice(0, 80)}${t.length > 80 ? '…' : ''}" ×${e.count} (${e.raws.size >= 12 ? '12+' : e.raws.size} variants)`),
        ...grams.map((g) => `${g.gram} ×${g.count}`),
      ].join('; '),
      recommendation:
        'The same command shape or tool sequence executed n times is a script waiting to be written: generate it once (a loop over the varying path/number), run it as one Bash call, and spend one model turn instead of n. The agent can write the script itself, so ask for it.',
      evidence: {
        templates: tpl.map(([t, e]) => ({ template: t, count: e.count, distinctCommands: e.raws.size, sample: e.sample.slice(0, 160), turns: [...new Set([...e.turns].map(turnOf))].slice(0, 20) })),
        sequences: grams.map((g) => ({ gram: g.gram, count: g.count, turns: [...new Set([...g.turns].map(turnOf))].slice(0, 20) })),
        estimatedRepeatedTokens: tokens,
      },
      turnIndexes: [...new Set([...unionTurns].map(turnOf))].slice(0, 30),
      savings: { tokens, estimated: true },
      personas: ['developer'],
    }),
  ]
}

const AGENT_SPAWN_TOOLS = new Set(['Agent', 'Task'])
const fanoutOpportunity: Rule = (ctx) => {
  // Detect >= 3 consecutive serial main-thread Agent spawns in one turn, each
  // issued alone (parallelGroupSize 1) and started only after the previous returned, whose prompts
  // show no output-dependency. Dependency HEURISTIC (cheap, documented): a later prompt is
  // dependent when it quotes any 16-char window of an earlier spawn's ~200-char result preview, or
  // names the earlier agent's id / name. When result content is stripped (no preview), independence
  // is decided from ids/lengths alone; never from full content matching.
  // Serial same-category read/search tool runs are sequential-reads' territory: this rule only
  // looks at Agent/Task calls, so the two can never double-fire.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  interface Item {
    call: ToolCall
    prompt: string
    preview: string
  }
  const dependsOn = (later: Item, earlier: Item): boolean => {
    const spawned = earlier.call.spawnedAgentId
    if (spawned && later.prompt.includes(spawned)) return true
    const nm = String((earlier.call.input as Record<string, unknown> | undefined)?.['name'] ?? '')
    if (nm.length >= 4 && later.prompt.includes(nm)) return true
    if (earlier.preview.length >= 16) {
      for (let i = 0; i + 16 <= earlier.preview.length; i++) if (later.prompt.includes(earlier.preview.slice(i, i + 16))) return true
    }
    return false
  }
  const byTurn = new Map<number, ToolCall[]>()
  for (const c of ctx.s.toolCalls) {
    if (c.agentId || !AGENT_SPAWN_TOOLS.has(c.name)) continue
    const arr = byTurn.get(c.turnIndex)
    if (arr) arr.push(c)
    else byTurn.set(c.turnIndex, [c])
  }
  const runs: Item[][] = []
  for (const calls of byTurn.values()) {
    let run: Item[] = []
    const flush = () => {
      if (run.length >= 3) runs.push(run)
      run = []
    }
    for (const c of calls) {
      if (c.parallelGroupSize !== 1 || c.unresolved) {
        flush()
        continue
      }
      const input = c.input as Record<string, unknown> | undefined
      const item: Item = { call: c, prompt: norm(String(input?.['prompt'] ?? '')), preview: norm(String(c.resultPreview ?? '')) }
      const prev = run[run.length - 1]
      const overlapsPrev = !!prev && prev.call.endTs !== undefined && c.startTs !== undefined && c.startTs < prev.call.endTs
      if (overlapsPrev || run.some((e) => dependsOn(item, e))) flush()
      run.push(item)
    }
    flush()
  }
  if (!runs.length) return []
  let serialMs = 0
  let parallelMs = 0
  const agentsInRuns = runs.reduce((a, r) => a + r.length, 0)
  const evRuns = runs.slice(0, 5).map((r) => {
    const durs = r.map((e) => e.call.durationMs ?? 0)
    const total = durs.reduce((a, d) => a + d, 0)
    const max = Math.max(...durs)
    serialMs += total
    parallelMs += max
    return {
      turnIndex: r[0]!.call.turnIndex,
      agents: r.map((e) => ({ type: String((e.call.input as Record<string, unknown> | undefined)?.['subagent_type'] ?? ''), promptChars: e.prompt.length, durationMs: e.call.durationMs })),
      serialMs: total,
      longestMs: max,
    }
  })
  const savedMs = Math.max(0, serialMs - parallelMs)
  return [
    mk({
      ruleId: 'fanout-opportunity',
      severity: 'low',
      axis: 'time',
      title: `${agentsInRuns} subagents ran one-after-another in ${runs.length} run${runs.length > 1 ? 's' : ''} with no visible dependency; a parallel fan-out would cut the wait`,
      detail: evRuns.map((r) => `turn ${r.turnIndex}: ${r.agents.length} serial spawns (${r.agents.map((a) => a.type || 'agent').join(', ')}), ${fmtMs(r.serialMs)} serial vs ${fmtMs(r.longestMs)} longest`).join('; '),
      recommendation:
        'Independent subagents can be spawned in one message (parallel tool calls) or with run_in_background. The wall-clock time becomes the longest run instead of the sum. Keep serial spawning for agents that consume an earlier agent’s result.',
      evidence: {
        runs: evRuns,
        heuristic:
          'independence = no 16-char overlap between a later prompt and an earlier result preview (~200 chars), and no reference to an earlier agent id/name; stripped results (no preview) are treated as independent; ids/lengths only, never full-content matching',
      },
      turnIndexes: [...new Set(runs.map((r) => r[0]!.call.turnIndex))].slice(0, 30),
      savings: { ms: savedMs, estimated: true },
      personas: ['developer', 'lead'],
    }),
  ]
}

const modelForTask: Rule = (ctx) => {
  // Detect an agent type whose requests are mostly mechanical
  // (exactly one tool_use in the provider message, < 200 output tokens, no reported thinking), running
  // on a frontier model rather than the small one. `info`, naming the agent type and the token volume
  // those mechanical requests moved.
  //
  // NO savings is claimed and none can be: routing the same work to a smaller model sends exactly the
  // same tokens. What survives the removal of the price table is the routing observation itself, which
  // is the useful half: a frontier model doing single-tool lookups is a configuration choice worth
  // seeing, and the reasons to change it (latency, leaving the big model free for judgment) are real
  // without any number attached to them. >= 10 mechanical requests and >= 60% share to fire.
  if (!ctx.s.agents.length) return []
  // `name` is teammate-authored display text; only the structural agent type
  // may become a grouping key or be copied into insight evidence.
  const typeById = new Map(ctx.s.agents.map((a) => [a.agentId, a.agentType ?? 'unknown']))
  const msgByUuid = new Map(ctx.s.messages.map((m) => [m.uuid, m]))
  const toolUsesByPid = new Map<string, number>()
  for (const m of ctx.s.messages) {
    if (m.role !== 'assistant' || !m.providerMessageId) continue
    let n = 0
    for (const b of m.blocks) if (b.kind === 'tool_use') n++
    if (n) toolUsesByPid.set(m.providerMessageId, (toolUsesByPid.get(m.providerMessageId) ?? 0) + n)
  }
  interface Group {
    agentType: string
    model: string
    requests: number
    mech: number
    mechTokens: number
  }
  const groups = new Map<string, Group>()
  for (const u of ctx.s.usageEvents) {
    if (!u.agentId || u.hiddenIteration) continue
    const r = resolveModel(u.model)
    if (r.family === 'haiku' || r.family === 'none' || r.synthetic) continue
    const agentType = typeById.get(u.agentId) ?? 'unknown'
    const key = agentType + '|' + u.model
    const g = groups.get(key) ?? { agentType, model: u.model, requests: 0, mech: 0, mechTokens: 0 }
    g.requests++
    const pid = msgByUuid.get(u.messageUuid)?.providerMessageId
    const tools = pid ? (toolUsesByPid.get(pid) ?? 0) : 0
    if (tools === 1 && u.usage.output < 200 && (u.thinkingTokens ?? 0) === 0) {
      g.mech++
      g.mechTokens += totalTokens(u.usage)
    }
    groups.set(key, g)
  }
  const qual = [...groups.values()]
    .filter((g) => g.mech >= 10 && g.mech / g.requests >= 0.6)
    .sort((a, b) => b.mechTokens - a.mechTokens || a.agentType.localeCompare(b.agentType))
  if (!qual.length) return []
  const top = qual[0]!
  return [
    mk({
      ruleId: 'model-for-task',
      severity: 'info',
      axis: 'tokens',
      title: `Agent type '${top.agentType}' is ${round((top.mech / top.requests) * 100, 0)}% mechanical on ${resolveModel(top.model).displayName} (${fmtTokens(top.mechTokens)} tokens in those requests)`,
      detail: qual
        .slice(0, 5)
        .map((g) => `${g.agentType} on ${resolveModel(g.model).displayName}: ${g.mech}/${g.requests} mechanical requests, ${fmtTokens(g.mechTokens)} tokens`)
        .join('; '),
      recommendation:
        'A mostly-mechanical agent type (single tool call, tiny output, no thinking) does not need the frontier model: set model: haiku in that agent’s frontmatter or the Agent call. It will send the same tokens either way. What you get back is a faster turn and the big model left free for the judgment-heavy agents.',
      evidence: {
        agentTypes: qual.slice(0, 5).map((g) => ({
          agentType: g.agentType,
          model: g.model,
          requests: g.requests,
          mechanicalRequests: g.mech,
          mechanicalShare: round(g.mech / g.requests, 3),
          mechanicalTokens: g.mechTokens,
        })),
        criteria: 'mechanical = exactly 1 tool_use, < 200 output tokens, no reported thinking; grouped per agent type × model; fires at >= 10 mechanical and >= 60% share on a non-haiku model',
      },
      turnIndexes: [],
      personas: ['lead', 'developer'],
    }),
  ]
}

const writeNotEdit: Rule = (ctx) => {
  // Detect Write on a file previously Read in the same context, where the written
  // length is within ±30% of the read length (reads >= 1 KB): a modification re-emitting the whole
  // file as output tokens. >= 2 occurrences to fire (a one-off full rewrite can be legitimate).
  const lastRead = new Map<string, number>()
  const rewrites: Array<{ path: string; turnIndex: number; readBytes: number; writtenChars: number }> = []
  for (const c of ctx.s.toolCalls) {
    const input = c.input as Record<string, unknown> | undefined
    const path = typeof input?.['file_path'] === 'string' ? (input['file_path'] as string) : undefined
    if (!path) continue
    const key = (c.agentId ?? '') + '|' + path
    if (c.name === 'Read') {
      if (!c.isError && (c.resultBytes ?? 0) >= 1_000) lastRead.set(key, c.resultBytes!)
      else lastRead.delete(key)
      continue
    }
    if (c.name !== 'Write' || c.isError) continue
    const content = input?.['content']
    if (typeof content !== 'string') continue
    const rb = lastRead.get(key)
    if (rb === undefined) continue
    if (content.length >= rb * 0.7 && content.length <= rb * 1.3) rewrites.push({ path, turnIndex: c.turnIndex, readBytes: rb, writtenChars: content.length })
  }
  if (rewrites.length < 2) return []
  // an Edit would emit only the changed hunks; assume ~40% of the file would still have been emitted
  const tokens = Math.round((rewrites.reduce((a, r) => a + r.writtenChars, 0) / BYTES_PER_TOKEN) * 0.6)
  const saved = Math.round(capSavings(ctx, tokens))
  return [
    mk({
      ruleId: 'write-not-edit',
      severity: 'low',
      axis: 'tokens',
      title: `${rewrites.length} Write call${rewrites.length > 1 ? 's' : ''} rewrote a file already read, at roughly the same length`,
      detail: rewrites
        .slice(0, 5)
        .map((r) => `${shortPath(r.path)}: read ${Math.round(r.readBytes / 1024)} KB → wrote ${Math.round(r.writtenChars / 1024)} KB (turn ${r.turnIndex})`)
        .join('; '),
      recommendation:
        'Edit beats Write for modifications: Write re-emits the whole file as output tokens, which the model has to generate one at a time, while Edit sends only the changed hunk. Reserve Write for new files and genuine full rewrites.',
      evidence: { rewrites: rewrites.slice(0, 10), tolerance: 'written length within ±30% of the last read length, reads >= 1 KB, same context (main thread or the same agent)' },
      turnIndexes: [...new Set(rewrites.map((r) => r.turnIndex))].slice(0, 30),
      savings: { tokens: saved, estimated: true },
      personas: ['developer'],
    }),
  ]
}

export const RULES: Rule[] = [
  rereadFiles,
  repeatedCommands,
  toolErrors,
  oversizedResults,
  sequentialReads,
  contextPressure,
  preambleWeight,
  cacheHealth,
  humanWait,
  agentEconomics,
  hooksOverhead,
  interruptionsAndErrors,
  outputHeavyWrites,
  slowFirstResponse,
  unresolvedTools,
  unverifiedEdits,
  editChurn,
  reverts,
  cacheDominatesTokens,
  slowTools,
  agentHealth,
  skillTokenWeight,
  timeBudget,
  cacheInvalidation,
  cacheTtlChurn,
  blockingQuestions,
  truncatedReadsRule,
  hiddenIterationsRule,
  binaryAttachments,
  queuedPrompts,
  thinkingOnMechanical,
  outputBurst,
  mcpDefinitionWeight,
  scriptCandidate,
  fanoutOpportunity,
  modelForTask,
  writeNotEdit,
]

const SEV_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }

export function runRules(ctx: RuleContext, rules: Rule[] = RULES): Insight[] {
  resetInsightIds()
  const out: Insight[] = []
  for (const r of rules) {
    try {
      out.push(...r(ctx))
    } catch {
      /* a rule must never break the analysis */
    }
  }
  out.sort((a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0) || (b.savings?.tokens ?? 0) - (a.savings?.tokens ?? 0))
  return out
}
