/**
 * Pure derivations the screens render from. No DOM, no clock: everything comes from the
 * Analysis/Aggregate data or the row the server computed. Unit-tested in node.
 */
import type { Analysis, QualitySignal, SessionEnding, ToolCallView, TurnAnalysis } from '../../model/analysis.js'
import type { LiveBadge, RowEventView, SessionSummaryRow } from '../../model/app-data.js'
export type { RowEventView }
import type { WeekBucket } from '../../analyze/aggregate.js'

/** Plain sentence for "How it ended". The word "finished" must never appear. */
const ENDING: Partial<Record<SessionEnding, string>> = {
  clean: 'Cleanly: the last test run was green',
  interrupted: 'You stopped it',
  failing: 'The last test run was failing',
}
export function endingWord(ending: SessionEnding): string {
  return ENDING[ending] ?? 'The agent completed its last task'
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
