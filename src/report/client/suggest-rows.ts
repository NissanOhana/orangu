/**
 * Pure row selection for the Suggest screen.
 * No DOM, no clock, so node-testable. Session scope renders the selected session's insights; repo/global
 * render the aggregate's crossFindings ranked severity-first (the SAME comparator the aggregate uses,
 * so the screen and the JSON never disagree). Finding conversion preserves the evidence used for IDs.
 */
import type { Analysis, Insight } from '../../model/analysis.js'
import { plural } from './format.js'
import { compareCrossFindings, type Aggregate, type CrossFinding } from '../../analyze/aggregate.js'
import type { Finding, SuggestionProposal, SuggestionRecord, SuggestionScope } from '../../suggest/types.js'
import { kickoffCommands, normalizeSessionIds, sessionCohortFingerprint, suggestionIdV2, suggestionKey } from '../../suggest/id.js'

export const SAVED_PROPOSAL_LIMIT = 12
export const PROPOSAL_LIST_LIMIT = 6

/** The one-time plugin install, typed inside Claude Code (not a shell command); the report and the CLI print the same line. */
export const PLUGIN_INSTALL = '/plugin marketplace add NissanOhana/orangu · /plugin install orangu'

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Runtime guard for append-only records: legacy proposals omit v and structured fields. */
export function hasValidProposal(record: SuggestionRecord): record is SuggestionRecord & { proposal: SuggestionProposal } {
  const p = record.proposal as unknown as Record<string, unknown> | undefined
  return !!p && /^sg_[0-9a-f]{12}$/.test(record.id) && Array.isArray(record.sessionIds) && record.sessionIds.length > 0 && record.sessionIds.every(nonEmptyString) &&
    nonEmptyString(p['title']) && nonEmptyString(p['change']) && /^[SML]$/.test(String(p['effort'])) && nonEmptyString(p['proposalPath']) && (p['v'] ?? 1) === 1
}

export interface PlanRow {
  ruleId: string
  title: string
  detail: string
  /** insights carry one; crossFindings do not, so the screen omits the Fix box */
  recommendation?: string
  savings?: Insight['savings']
  /** kickoff evidence sessions: the selected session, or the finding's examples */
  sessionIds: string[]
  insightId?: string
  /** repo/global identity derived from every session in the active aggregate. */
  cohortFingerprint?: string
  /** repo/global: how many sessions the finding recurs in */
  sessions?: number
  /** the rule's severity (insights and crossFindings both carry one); renders as the row's dot */
  severity?: string
}

/** Privacy stripping can blank generated insight copy; identity and UX still require a safe title. */
export function titleForRule(ruleId: string): string {
  const words = ruleId.trim().replace(/[-_]+/g, ' ') || 'finding'
  return words[0]!.toUpperCase() + words.slice(1)
}

function safeCopy(ruleId: string, title: string, detail: string): { title: string; detail: string } {
  const fallback = titleForRule(ruleId)
  return {
    title: title.trim() || fallback,
    detail: detail.trim() || `The deterministic ${fallback.toLowerCase()} rule matched this evidence.`,
  }
}

/**
 * Cross-session savings shown to a person are the bounded figure (median per session × sessions,
 * aggregate.ts); an older cached aggregate without the field falls back to the raw sum.
 */
export function boundedSavings(f: Pick<CrossFinding, 'totalSavingsTokens' | 'totalSavingsMs'> & Partial<Pick<CrossFinding, 'boundedSavingsTokens' | 'boundedSavingsMs'>>): NonNullable<Insight['savings']> {
  const tokens = f.boundedSavingsTokens ?? f.totalSavingsTokens
  const ms = f.boundedSavingsMs ?? f.totalSavingsMs
  return { ...(tokens ? { tokens } : {}), ...(ms ? { ms } : {}), estimated: true }
}

/** One session-scope plan row per insight: the identity every surface (Suggest, Overview, CLI) shares. */
export function planRowForInsight(i: Insight, sessionId: string | undefined): PlanRow {
  const copy = safeCopy(i.ruleId, i.title, i.detail)
  return {
    ruleId: i.ruleId,
    ...copy,
    recommendation: i.recommendation,
    savings: i.savings,
    sessionIds: sessionId ? [sessionId] : [],
    insightId: i.id,
    severity: i.severity,
  }
}

export function planRows(scope: SuggestionScope, a: Analysis | undefined, agg: Aggregate | null | undefined): PlanRow[] {
  if (scope === 'session') return (a?.insights ?? []).map((i) => planRowForInsight(i, a?.session.id))
  const cohortFingerprint = agg ? sessionCohortFingerprint(agg.sessions.map((session) => session.id)) : undefined
  return [...(agg?.crossFindings ?? [])]
    .sort(compareCrossFindings)
    .map((f) => {
      const copy = safeCopy(f.ruleId, f.title, `Recurs in ${plural(f.sessions, 'session')}.`)
      return {
        ruleId: f.ruleId,
        ...copy,
        savings: boundedSavings(f),
        sessionIds: f.exampleSessionIds,
        sessions: f.sessions,
        severity: f.severity,
        ...(cohortFingerprint ? { cohortFingerprint } : {}),
      }
    })
}

/**
 * The exact improve handoff for one insight, on any screen: the same PlanRow -> Finding -> sg_ id path
 * the Suggest screen walks, and the self-contained `--finding` form file-mode kickoff emits (it needs
 * no persisted record, so it is valid from a file report and from localhost alike).
 */
export function commandForInsight(i: Insight, sessionId: string): string {
  return handoffForInsight(i, sessionId).command
}

/** The same handoff, split: the sg_ id (the readable name of the proposal) and the copy-ready command. */
export function handoffForInsight(i: Insight, sessionId: string): { id: string; command: string } {
  const finding = findingForRow(planRowForInsight(i, sessionId), 'session')
  const key = suggestionKey(finding, 'report')
  const id = suggestionIdV2(key)
  return { id, command: kickoffCommands({ id, ...finding, sessionIds: key.sessionIds, source: 'report' }, 'file').claude }
}

/** Recoverable = sums over the rows actually shown; repo/global scopes use cross-session findings. */
export function recoverableFrom(rows: PlanRow[]): { tokens: number; ms: number } {
  let tokens = 0
  let ms = 0
  for (const r of rows) {
    tokens += r.savings?.tokens ?? 0
    ms += r.savings?.ms ?? 0
  }
  return { tokens, ms }
}

export function findingForRow(row: PlanRow, scope: SuggestionScope): Finding {
  return {
    ruleId: row.ruleId,
    title: row.title,
    scope,
    sessionIds: row.sessionIds,
    ...(row.insightId ? { insightId: row.insightId } : {}),
    ...(row.cohortFingerprint ? { cohortFingerprint: row.cohortFingerprint } : {}),
    evidence: {
      estimated: row.savings?.estimated ?? true,
      sessions: row.sessions ?? 1,
      ...(row.savings?.tokens !== undefined ? { savingsTokens: row.savings.tokens } : {}),
      ...(row.savings?.ms !== undefined ? { savingsMs: row.savings.ms } : {}),
    },
  }
}

export function harnessCommand(scope: 'repo' | 'global'): string {
  return `claude "/orangu:harness --scope ${scope}"`
}

/** Persisted workflow failures survive SSE re-renders as actionable row copy. */
export function kickoffFailureMessage(record: SuggestionRecord | undefined): string {
  if (record?.status !== 'failed') return ''
  const detail = record.kickoff?.error?.trim()
  return detail ? `Improvement workflow failed: ${detail}` : 'Improvement workflow failed. Copy the command to inspect it in Claude Code.'
}

/**
 * Status record for a plan row: prefer the exact canonical v2 identity (or an explicit migrated
 * legacy ID). The readable-field fallback is deliberately limited to v1 records.
 */
export function recordForRow<T extends SuggestionRecord>(records: T[], row: PlanRow, scope: SuggestionScope, suggestionId: string): T | undefined {
  let best: T | undefined
  const sessions = normalizeSessionIds(row.sessionIds).join('\n')
  for (const record of records) {
    if (!Array.isArray(record.sessionIds) || !record.sessionIds.every((id) => typeof id === 'string')) continue
    const exact = record.id === suggestionId || (Array.isArray(record.legacyIds) && record.legacyIds.includes(suggestionId))
    const legacy = record.v === 1 && record.ruleId === row.ruleId && record.scope === scope &&
      normalizeSessionIds(record.sessionIds).join('\n') === sessions && (!row.insightId || !record.insightId || row.insightId === record.insightId)
    if (!exact && !legacy) continue
    if (!best || record.statusAt > best.statusAt) best = record
  }
  return best
}

function identityKeys(record: SuggestionRecord): string[] {
  return [record.id, ...(Array.isArray(record.legacyIds) ? record.legacyIds : []), record.proposal?.proposalPath].filter(nonEmptyString)
}

/**
 * Serve-only inbox selection. Session scope is exact; aggregate scopes require evidence overlap.
 * Mapped rows and migrated/path duplicates are removed before the hard display cap.
 */
export function savedProposalRecords<T extends SuggestionRecord>(
  records: T[],
  scope: SuggestionScope,
  selectedSessionId: string | undefined,
  aggregateSessionIds: string[],
  mappedRecords: T[],
): T[] {
  const activeIds = new Set(scope === 'session' ? (selectedSessionId ? [selectedSessionId] : []) : aggregateSessionIds)
  if (!activeIds.size) return []
  const seen = new Set(mappedRecords.flatMap(identityKeys))
  const result: T[] = []
  const newest = [...records].sort((a, b) => b.statusAt - a.statusAt)
  for (const record of newest) {
    if (record.scope !== scope || !hasValidProposal(record) || !record.sessionIds.some((id) => activeIds.has(id))) continue
    const keys = identityKeys(record)
    if (keys.some((key) => seen.has(key))) continue
    keys.forEach((key) => seen.add(key))
    result.push(record)
    if (result.length === SAVED_PROPOSAL_LIMIT) break
  }
  return result
}
