/**
 * Pure derivations the screens render from. No DOM, no clock: everything comes from the
 * Analysis/Aggregate data or the row the server computed. Unit-tested in node.
 */
import type { Analysis, Insight, QualitySignal, SessionEnding, Summary, ToolCallView, TurnAnalysis } from '../../model/analysis.js'
import type { LiveBadge, RowEventView, SessionSummaryRow } from '../../model/app-data.js'
export type { RowEventView }
import type { WeekBucket } from '../../analyze/aggregate.js'
import { ms, pct, plural, tok } from './format.js'

/** Plain sentence for "How it ended". The word "finished" must never appear. */
const ENDING: Partial<Record<SessionEnding, string>> = {
  clean: 'The last check it ran passed',
  interrupted: 'You stopped it',
  failing: 'The last test run was failing',
}
export function endingWord(ending: SessionEnding, o?: Summary['outcomes']): string {
  const w = ENDING[ending] ?? 'The agent completed its last task'
  // 'clean' = the last check passed; when earlier test runs failed the sentence says so, or it contradicts the headline
  return ending === 'clean' && o && qualityScope(o) ? `${w}; ${o.testRunsFailed} of ${plural(o.testRuns, 'test run')} failed earlier` : w
}

/** "last run" when the test runs were mixed: the verdict word comes from the last one, so it carries its scope. */
export function qualityScope(o: Pick<Summary['outcomes'], 'testRuns' | 'testRunsFailed'>): string {
  return o.testRunsFailed && o.testRunsFailed < o.testRuns ? 'last run' : ''
}


/**
 * Overview headline: what THIS session did, from the outcomes the analyzer counted.
 * Deterministic, no clock, no LLM. Precedence: interrupted > shipped work > effort > nothing.
 *
 * | condition                                              | headline                                              |
 * | ending === 'interrupted'                               | Stopped by you after N turn(s)                        |
 * | any PR, commit, test run, failed build run or          | non-zero parts joined with " · "; a red build run is   |
 * | edited/written file                                    | named before the test clause ("F of N build runs      |
 * |                                                        | failed"); tests as "N test runs green" or "F of N     |
 * |                                                        | test runs failed" (runs are command invocations, not  |
 * |                                                        | test cases)                                           |
 * | else toolCalls > 0                                     | N request(s), M subagent(s), nothing committed        |
 * | else                                                   | N request(s), no tool calls recorded                  |
 *
 * A test run is never named unless outcomes.testRuns > 0 (the `ending` enum alone cannot tell a
 * passing build from a passing test run).
 */
export function outcomeHeadline(s: Summary): string {
  if (s.ending === 'interrupted') return `Stopped by you after ${plural(s.turns, 'turn')}`
  const parts = outcomeBits(s)
  if (parts.length) return parts.join(' · ')
  const requests = plural(s.humanTurns, 'request')
  if (s.toolCalls > 0) return `${requests}, ${s.agents ? plural(s.agents, 'subagent') + ', ' : ''}nothing committed`
  return `${requests}, no tool calls recorded`
}

/** The counted outcomes as phrases ("2 commits", "3 test runs green"); the headline and the Quality axis share them. */
export function outcomeBits(s: Summary): string[] {
  const o = s.outcomes
  const parts: string[] = []
  if (o.prLinks.length) parts.push(plural(o.prLinks.length, 'PR'))
  if (o.gitCommits) parts.push(plural(o.gitCommits, 'commit'))
  const changed = o.filesEdited + o.filesWritten
  if (changed) parts.push(plural(changed, 'file') + ' changed')
  if (o.buildRunsFailed) parts.push(`${o.buildRunsFailed} of ${plural(o.buildRuns, 'build run')} failed`)
  if (o.testRuns) parts.push(o.testRunsFailed ? `${o.testRunsFailed} of ${plural(o.testRuns, 'test run')} failed` : `${plural(o.testRuns, 'test run')} green`)
  return parts
}

/**
 * The Time axis: the big number is ACTIVE time (the assistant working), the note puts it against the
 * wall clock and the time spent waiting for the human. A single-message session has no wall clock;
 * the value is still a real duration, never NaN or a dash.
 */
export function timeAxis(s: Summary): { value: string; note: string } {
  return {
    value: ms(s.activeMs),
    note: s.wallMs !== undefined ? `over ${ms(s.wallMs)} wall · ${ms(s.humanWaitMs)} waiting for you` : 'single-message session',
  }
}

/**
 * Where a finding's evidence lives: the tool it names (evidence.calls[].tool|name or evidence.tools[].name)
 * or its first turn. Undefined when it names neither, so the screen renders no link.
 */
export function insightLink(ins: Pick<Insight, 'evidence' | 'turnIndexes'>): { tool?: string; turn?: number } | undefined {
  const ev = ins.evidence as { calls?: Array<{ tool?: string; name?: string }>; tools?: Array<{ name?: string }> }
  const first = ev.calls?.[0]
  const tool = first?.tool ?? first?.name ?? ev.tools?.[0]?.name
  if (typeof tool === 'string' && tool) return { tool }
  if (ins.turnIndexes.length) return { turn: ins.turnIndexes[0]! }
  return undefined
}

/** Chart x-markers for compactions: the index of the first main-thread point at or after each compaction. */
export function compactionMarkers(compactions: Array<{ ts?: number; turnIndex: number }>, main: Array<{ ts?: number }>): Array<{ x: number; label: string }> {
  return compactions.map((cp) => {
    const near = main.findIndex((p) => p.ts !== undefined && cp.ts !== undefined && p.ts >= cp.ts)
    return { x: near < 0 ? Math.max(0, main.length - 1) : near, label: 'compaction @turn ' + cp.turnIndex }
  })
}

/** The absolute savings claim, tokens first: "save ~1.4k tokens" / "save ~2m 5s"; '' when nothing is claimed. */
export function savingsText(s: Insight['savings']): string {
  if (!s) return ''
  const est = s.estimated ? '~' : ''
  if (s.tokens) return `save ${est}${tok(s.tokens)} tokens`
  if (s.ms) return `save ${est}${ms(s.ms)}`
  return ''
}

export interface SavingsShare {
  /** the pill text: a share of the session when it fits inside it, else the absolute claim */
  text: string
  /** the honest basis sentence for the title tooltip (never a per-rule formula table) */
  title: string
}

/**
 * A finding's savings bounded to the session it was measured in: "~38% of this session" when the
 * session total is known and the claim is not larger than it, else the absolute figure. The title
 * states the basis and which rule estimated or measured it.
 */
export function savingsShare(s: Insight['savings'], sessionTotalTokens: number | undefined, ruleId: string): SavingsShare | undefined {
  if (!s || (!s.tokens && !s.ms)) return undefined
  const how = `${s.estimated ? 'estimated' : 'measured'} by rule ${ruleId}`
  if (s.tokens && sessionTotalTokens && s.tokens <= sessionTotalTokens) {
    const share = s.tokens / sessionTotalTokens
    return {
      text: share < 0.005 ? 'under 1% of this session' : `~${pct(share)} of this session`,
      title: `≈${tok(s.tokens)} tokens of the ${tok(sessionTotalTokens)} this session measured; ${how}`,
    }
  }
  return { text: savingsText(s), title: s.tokens ? `≈${tok(s.tokens)} tokens; ${how}` : `≈${ms(s.ms)}; ${how}` }
}

/** "≈2.1M tokens recoverable across 7 findings" from the rows actually shown; '' when nothing is claimed. */
export function recoverableLine(sum: { tokens: number; ms: number }, findings: number): string {
  if (!findings || (!sum.tokens && !sum.ms)) return ''
  const what = sum.tokens ? `≈${tok(sum.tokens)} tokens` : `≈${ms(sum.ms)}`
  return `${what} recoverable across ${plural(findings, 'finding')}`
}

/**
 * The Context screen's one-sentence takeaway from three measured facts. Each clause appears only
 * when its input exists (no context window: no share of it; no subagent tokens: no third clause),
 * so a thin session gets a shorter true sentence, never a placeholder or NaN.
 */
export function contextHeadline(a: Pick<Analysis, 'summary' | 'context' | 'tokens'>): string {
  const s = a.summary
  const c = a.context
  const parts: string[] = []
  if (c.contextWindow && s.contextPeak) parts.push(`context grew to ${pct(s.contextPeak / c.contextWindow)} of the window`)
  if (s.totalTokens) parts.push(`${pct(s.cacheHitRatio)} of tokens were cache reads`)
  if (s.totalTokens && a.tokens.agents) parts.push(`${pct(a.tokens.agents / s.totalTokens)} went to subagents`)
  if (!parts.length) return 'No token usage was recorded for this session.'
  const line = parts.join('; ')
  return line[0]!.toUpperCase() + line.slice(1) + '.'
}

/** Overview Quality axis headline from the quality signals (deterministic word map, no score). */
export function qualityHeadline(signals: QualitySignal[]): string {
  const tests = signals.find((s) => s.id === 'tests')
  if (tests?.tone === 'good') return 'passing'
  if (tests?.tone === 'bad') return 'failing'
  const shipped = signals.some((s) => (s.id === 'commits' || s.id === 'prs') && Number(s.value) > 0)
  return shipped ? 'shipped' : '–'
}

export interface CatSeg {
  cat: string
  pct: number
}

/** Every tool call attached to a turn, optionally narrowed to one subagent drill-down. */
export function callsForTurn(calls: ToolCallView[], turnIndex: number, agentId?: string): ToolCallView[] {
  return calls.filter((c) => c.turnIndex === turnIndex && (!agentId || c.agentId === agentId))
}

/** Per-turn tool-category mix across the main thread and subagents. */
export function catMixForTurn(calls: ToolCallView[], turnIndex: number, agentId?: string): CatSeg[] {
  const own = callsForTurn(calls, turnIndex, agentId)
  if (!own.length) return []
  const by = new Map<string, number>()
  for (const c of own) by.set(c.category, (by.get(c.category) ?? 0) + 1)
  return [...by.entries()].map(([cat, n]) => ({ cat, pct: (n / own.length) * 100 }))
}

export interface Compaction {
  turnIndex: number
  contextBefore?: number
  contextAfter?: number
}
export interface TurnGroup {
  turns: TurnAnalysis[]
  /** the compaction divider rendered AFTER this group (undefined on the last group) */
  after?: Compaction
}

/** Split the turn list at every compaction boundary (design generalises the two-halves mock). */
export function compactionGroups(turns: TurnAnalysis[], compactions: Compaction[]): TurnGroup[] {
  const cuts = [...compactions].sort((a, b) => a.turnIndex - b.turnIndex).filter((c) => c.turnIndex > (turns[0]?.index ?? 0) && c.turnIndex <= (turns[turns.length - 1]?.index ?? 0))
  const groups: TurnGroup[] = []
  let rest = turns
  for (const c of cuts) {
    const head = rest.filter((t) => t.index < c.turnIndex)
    rest = rest.filter((t) => t.index >= c.turnIndex)
    groups.push({ turns: head, after: c })
  }
  groups.push({ turns: rest, after: undefined })
  return groups
}

/** Polyline points for the Global weekly-token trend (design viewBox 600×110, baseline y=104). */
export function weekPoints(byWeek: WeekBucket[], w = 600, baseline = 104, top = 8): string {
  const n = byWeek.length
  if (!n) return ''
  const max = Math.max(...byWeek.map((b) => b.tokens), 0.0001)
  return byWeek
    .map((b, i) => {
      const x = n === 1 ? w / 2 : (i / (n - 1)) * w
      const y = baseline - (b.tokens / max) * (baseline - top)
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`
    })
    .join(' ')
}

const DAY_MS = 86_400_000

/**
 * Normalise a total over the observed span to a 30-day figure (policy: label "/30d", never "/mo").
 * Span = max(startedAt) − min(startedAt), clamped to ≥ 1 day. Undefined when no session has a start.
 */
export function per30d(total: number, sessions: Array<{ startedAt?: number }>): number | undefined {
  const starts = sessions.map((s) => s.startedAt).filter((v): v is number => v !== undefined)
  if (!starts.length) return undefined
  const spanDays = Math.max(1, (Math.max(...starts) - Math.min(...starts)) / DAY_MS)
  return (total / spanDays) * 30
}

const SOURCE_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', cowork: 'Cowork', desktop: 'Desktop' }

/** policy: fixed source-key → label map; unknown keys pass through raw. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

export interface FeedRow {
  ts?: number
  name: string
  category: string
  summary: string
  durationMs?: number
  agentType?: string
  isError?: boolean
  /** stable tiebreaker for the deterministic sort */
  key: string
}

/** Live feed = tools.calls + events + agent spawns, sorted by ts then toolUseId; the LAST n rows. */
export function liveFeed(a: Analysis, n: number): FeedRow[] {
  const rows: FeedRow[] = []
  for (const c of a.tools.calls)
    rows.push({ ts: c.startTs, name: c.name, category: c.category, summary: c.summary, durationMs: c.durationMs, isError: c.isError, agentType: c.agentId ? 'agent' : undefined, key: c.toolUseId })
  for (const e of a.events) rows.push({ ts: e.ts, name: e.kind, category: 'other', summary: e.label, key: 'ev-' + e.turnIndex + '-' + e.kind })
  for (const r of a.agents.runs)
    rows.push({ ts: r.startTs, name: r.agentType || r.name || r.agentId, category: 'agent', summary: r.taskKind ?? r.description ?? 'subagent run', durationMs: r.durationMs, key: r.agentId })
  rows.sort((x, y) => (x.ts ?? Infinity) - (y.ts ?? Infinity) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  return rows.slice(-n)
}

function rel(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h'
}

/**
 * Badge-gated honesty rule: "possibly live" comes only from a
 * trailing partial. "running" may appear in the client ONLY under or beside the liveness badge,
 * which is itself hedged by `possiblyLive`, never as an unqualified claim; this copy makes no
 * running/finished claim at all, and the offline report still never says "finished"
 * (offline.test.ts / derive.test.ts ratchet).
 */
export function badgeCopy(row: { badge: LiveBadge; possiblyLive: boolean; ageMs: number }): string {
  if (row.badge !== 'ended' && row.possiblyLive) return 'Watching · possibly live'
  if (row.badge === 'ended') return 'ended · updated ' + rel(row.ageMs) + ' ago'
  return 'updated ' + rel(row.ageMs) + ' ago'
}

/** Token count at which a turn enters the top 20% by tokens (design: accent token column). */
export function topTokenThreshold(turns: Array<{ totalTokens: number }>): number {
  if (!turns.length) return Infinity
  const sorted = turns.map((t) => t.totalTokens).sort((a, b) => b - a)
  const k = Math.max(1, Math.floor(sorted.length * 0.2))
  return sorted[k - 1]!
}

/**
 * Re-render preservation: fold the current DOM's expandable state into the saved open-id list.
 * For rows PRESENT in the DOM the DOM wins (newly opened added, user-closed dropped); rows absent
 * from this render keep their saved state so they re-open when they return. Pure; app.ts captures
 * before the wipe and re-applies after (SSE ticks rebuild the whole tree).
 */
export function mergeOpenIds(saved: readonly string[], present: ReadonlyArray<{ id: string; open: boolean }>): string[] {
  const rendered = new Set(present.map((r) => r.id))
  const kept = saved.filter((id) => !rendered.has(id))
  const open = present.filter((r) => r.open).map((r) => r.id)
  return [...new Set([...kept, ...open])]
}

/**
 * UX §4.1 fleet feed: merge each live row's `lastEvents` ring into one chronological strip,
 * tagged with the source session id for the shortId column. Deterministic: ts then sid then
 * ring order (stable sort); undefined ts sorts newest. Returns the LAST n overall.
 */
export function fleetFeed(rows: ReadonlyArray<Pick<SessionSummaryRow, 'id' | 'lastEvents'>>, n: number): Array<RowEventView & { sid: string }> {
  const out: Array<RowEventView & { sid: string }> = []
  for (const r of rows) for (const e of r.lastEvents ?? []) out.push({ ...e, sid: r.id })
  out.sort((x, y) => (x.ts ?? Infinity) - (y.ts ?? Infinity) || (x.sid < y.sid ? -1 : x.sid > y.sid ? 1 : 0))
  return out.slice(-n)
}
