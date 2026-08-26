/**
 * Aggregate analysis across many sessions (a repo, or everything globally).
 * Deterministic. Emits an object with the same "components, not a score" discipline as a single Analysis.
 */
import type { Analysis } from '../model/analysis.js'
import { round } from './util.js'

export const AGGREGATE_SCHEMA_VERSION = '2'

export interface SessionRow {
  id: string
  title?: string
  project?: string
  source: string
  startedAt?: number
  wallMs?: number
  activeMs: number
  turns: number
  humanTurns: number
  toolCalls: number
  toolErrors: number
  agents: number
  tokens: number
  contextPeak: number
  cacheHitRatio: number
  compactions: number
  prs: number
  commits: number
  /** additive (v1): `quality.interruptions` of the session */
  interruptions: number
  topInsightRuleId?: string
}

/** one ISO week (Monday 00:00 UTC) bucket of session starts */
export interface WeekBucket {
  weekStartUtc: number
  tokens: number
  sessions: number
}

const SEVERITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }

/**
 * Rank cross-session findings the way `runRules` ranks per-session ones: severity first, then the
 * token figure, then how many sessions it recurs in.
 *
 * Ranking by the token figure alone buries rules that honestly claim no saving. A cache invalidation,
 * for example, re-writes the tokens it would otherwise have re-read: same count, different tier.
 * Severity expresses what the finding is worth; the token figure only orders findings of equal severity.
 */
export function compareCrossFindings(a: CrossFinding, b: CrossFinding): number {
  return (
    (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0) ||
    b.totalSavingsTokens - a.totalSavingsTokens ||
    b.sessions - a.sessions ||
    a.ruleId.localeCompare(b.ruleId)
  )
}

const WEEK_MS = 7 * 86_400_000
const DAY_MS = 86_400_000
/** Monday 00:00 UTC of the ISO week containing `ts` */
export function isoWeekStartUtc(ts: number): number {
  const dayStart = Math.floor(ts / DAY_MS) * DAY_MS
  const dow = new Date(dayStart).getUTCDay() // 0 = Sunday
  const sinceMonday = (dow + 6) % 7
  return dayStart - sinceMonday * DAY_MS
}

/** 12 ISO weeks ending at the week of max(startedAt), zero-filled; [] when no session has a start time. No clock. */
export function byWeekOf(sessions: Array<{ startedAt?: number; tokens: number }>, weeks = 12): WeekBucket[] {
  let latest: number | undefined
  for (const s of sessions) if (s.startedAt !== undefined && (latest === undefined || s.startedAt > latest)) latest = s.startedAt
  if (latest === undefined) return []
  const lastWeek = isoWeekStartUtc(latest)
  const firstWeek = lastWeek - (weeks - 1) * WEEK_MS
  const out: WeekBucket[] = []
  for (let i = 0; i < weeks; i++) out.push({ weekStartUtc: firstWeek + i * WEEK_MS, tokens: 0, sessions: 0 })
  for (const s of sessions) {
    if (s.startedAt === undefined) continue
    const idx = Math.floor((isoWeekStartUtc(s.startedAt) - firstWeek) / WEEK_MS)
    const b = out[idx]
    if (!b) continue // older than the window
    b.tokens += s.tokens
    b.sessions++
  }
  return out
}

export interface RollupItem {
  key: string
  count: number
  tokens: number
  extra?: Record<string, number>
}

export interface CrossFinding {
  ruleId: string
  title: string
  sessions: number
  totalSavingsTokens: number
  totalSavingsMs: number
  axis: string
  severity: string
  exampleSessionIds: string[]
}

export interface Aggregate {
  schemaVersion: string
  generatedAt: number
  scope: string
  sessionCount: number
  totals: {
    tokens: number
    toolCalls: number
    toolErrors: number
    agents: number
    turns: number
    humanTurns: number
    wallMs: number
    activeMs: number
    compactions: number
    prs: number
    commits: number
  }
  averages: {
    tokensPerSession: number
    tokensPerHumanTurn: number
    toolErrorRate: number
    cacheHitRatio: number
    agentsPerSession: number
    contextPeak: number
  }
  byModel: RollupItem[]
  byProject: RollupItem[]
  byTool: RollupItem[]
  byAgentType: RollupItem[]
  bySkill: RollupItem[]
  /** files that dominate the context across the corpus */
  topReReadFiles: Array<{ path: string; sessions: number; totalReads: number }>
  /** recurring tool-error signatures across sessions = environment problems */
  recurringErrors: Array<{ signature: string; tool: string; sessions: number; total: number }>
  crossFindings: CrossFinding[]
  sessions: SessionRow[]
  /** the heaviest sessions by tokens */
  topSessions: SessionRow[]
  /** 12 ISO weeks (Mon 00:00 UTC) ending at max(startedAt), zero-filled; derived from session starts, never the clock */
  byWeek: WeekBucket[]
}

function inc(map: Map<string, RollupItem>, key: string, tokens: number, extra?: Record<string, number>): void {
  const e = map.get(key) ?? { key, count: 0, tokens: 0, extra: {} }
  e.count++
  e.tokens += tokens
  if (extra) for (const [k, v] of Object.entries(extra)) e.extra![k] = (e.extra![k] ?? 0) + v
  map.set(key, e)
}
function sortRollup(map: Map<string, RollupItem>): RollupItem[] {
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count)
}

export function aggregate(analyses: Analysis[], scope: string, now: number): Aggregate {
  const byModel = new Map<string, RollupItem>()
  const byProject = new Map<string, RollupItem>()
  const byTool = new Map<string, RollupItem>()
  const byAgentType = new Map<string, RollupItem>()
  const bySkill = new Map<string, RollupItem>()
  const reReadFiles = new Map<string, { sessions: Set<string>; totalReads: number }>()
  const errorSigs = new Map<string, { tool: string; sessions: Set<string>; total: number }>()
  const findings = new Map<string, CrossFinding>()
  const rows: SessionRow[] = []
  const t = { tokens: 0, toolCalls: 0, toolErrors: 0, agents: 0, turns: 0, humanTurns: 0, wallMs: 0, activeMs: 0, compactions: 0, prs: 0, commits: 0 }
  let cacheRatioSum = 0
  let cacheRatioN = 0

  for (const a of analyses) {
    const sid = a.session.id
    const tokens = a.summary.totalTokens
    t.tokens += tokens
    t.toolCalls += a.summary.toolCalls
    t.toolErrors += a.summary.toolErrors
    t.agents += a.summary.agents
    t.turns += a.summary.turns
    t.humanTurns += a.summary.humanTurns
    t.wallMs += a.summary.wallMs ?? 0
    t.activeMs += a.summary.activeMs
    t.compactions += a.summary.compactions
    t.prs += a.summary.outcomes.prLinks.length
    t.commits += a.summary.outcomes.gitCommits
    cacheRatioSum += a.summary.cacheHitRatio
    cacheRatioN++

    for (const m of a.tokens.byModel) inc(byModel, m.displayName, m.totalTokens)
    const proj = a.session.projectSlug ?? a.session.cwd ?? 'unknown'
    inc(byProject, proj, tokens, { sessions: 1, errors: a.summary.toolErrors })
    for (const s of a.tools.byName) inc(byTool, s.name, 0, { calls: s.count, errors: s.errors })
    for (const at of a.agents.byType) inc(byAgentType, at.agentType, at.tokens, { runs: at.count })
    for (const sk of a.skills.byName) inc(bySkill, sk.name, 0, { uses: sk.count })
    for (const f of a.files.mostReRead) {
      if (f.reads < 3) continue
      const e = reReadFiles.get(f.path) ?? { sessions: new Set(), totalReads: 0 }
      e.sessions.add(sid)
      e.totalReads += f.reads
      reReadFiles.set(f.path, e)
    }
    for (const g of a.tools.errorGroups) {
      const key = g.name + '|' + g.signature
      const e = errorSigs.get(key) ?? { tool: g.name, sessions: new Set(), total: 0 }
      e.sessions.add(sid)
      e.total += g.count
      errorSigs.set(key, e)
    }
    for (const ins of a.insights) {
      const f = findings.get(ins.ruleId) ?? { ruleId: ins.ruleId, title: ins.title.replace(/\d[\d.,kM%×]*/g, 'N'), sessions: 0, totalSavingsTokens: 0, totalSavingsMs: 0, axis: ins.axis, severity: ins.severity, exampleSessionIds: [] }
      f.sessions++
      f.totalSavingsTokens += ins.savings?.tokens ?? 0
      f.totalSavingsMs += ins.savings?.ms ?? 0
      if (f.exampleSessionIds.length < 5) f.exampleSessionIds.push(sid)
      findings.set(ins.ruleId, f)
    }
    rows.push({
      id: sid,
      title: a.session.title,
      project: proj,
      source: a.session.source,
      startedAt: a.session.startedAt,
      wallMs: a.summary.wallMs,
      activeMs: a.summary.activeMs,
      turns: a.summary.turns,
      humanTurns: a.summary.humanTurns,
      toolCalls: a.summary.toolCalls,
      toolErrors: a.summary.toolErrors,
      agents: a.summary.agents,
      tokens,
      contextPeak: a.summary.contextPeak,
      cacheHitRatio: a.summary.cacheHitRatio,
      compactions: a.summary.compactions,
      prs: a.summary.outcomes.prLinks.length,
      commits: a.summary.outcomes.gitCommits,
      interruptions: a.quality.interruptions,
      topInsightRuleId: a.insights[0]?.ruleId,
    })
  }

  rows.sort((a, b) => b.tokens - a.tokens)
  const n = analyses.length || 1
  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    generatedAt: now,
    scope,
    sessionCount: analyses.length,
    totals: { ...t },
    averages: {
      tokensPerSession: round(t.tokens / n, 0),
      tokensPerHumanTurn: t.humanTurns ? round(t.tokens / t.humanTurns, 0) : 0,
      toolErrorRate: t.toolCalls ? round(t.toolErrors / t.toolCalls, 4) : 0,
      cacheHitRatio: cacheRatioN ? round(cacheRatioSum / cacheRatioN, 4) : 0,
      agentsPerSession: round(t.agents / n, 2),
      contextPeak: round(rows.reduce((a, r) => a + r.contextPeak, 0) / n, 0),
    },
    byModel: sortRollup(byModel),
    byProject: sortRollup(byProject),
    byTool: sortRollup(byTool).sort((a, b) => (b.extra?.['calls'] ?? 0) - (a.extra?.['calls'] ?? 0)),
    byAgentType: sortRollup(byAgentType),
    bySkill: sortRollup(bySkill).sort((a, b) => (b.extra?.['uses'] ?? 0) - (a.extra?.['uses'] ?? 0)),
    topReReadFiles: [...reReadFiles.entries()]
      .map(([path, e]) => ({ path, sessions: e.sessions.size, totalReads: e.totalReads }))
      .sort((a, b) => b.totalReads - a.totalReads)
      .slice(0, 20),
    recurringErrors: [...errorSigs.entries()]
      .map(([key, e]) => ({ signature: key.split('|')[1] ?? key, tool: e.tool, sessions: e.sessions.size, total: e.total }))
      .filter((e) => e.sessions >= 2)
      .sort((a, b) => b.sessions - a.sessions || b.total - a.total)
      .slice(0, 20),
    crossFindings: [...findings.values()]
      .map((f) => ({ ...f, totalSavingsTokens: round(f.totalSavingsTokens, 0), totalSavingsMs: round(f.totalSavingsMs, 0) }))
      .sort(compareCrossFindings),
    sessions: rows,
    topSessions: rows.slice(0, 15),
    byWeek: byWeekOf(rows),
  }
}
