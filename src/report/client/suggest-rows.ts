/**
 * Pure row selection for the Suggest screen.
 * No DOM, no clock, so node-testable. Session scope renders the selected session's insights; repo/global
 * render the aggregate's crossFindings ranked severity-first (the SAME comparator the aggregate uses,
 * so the screen and the JSON never disagree). Finding conversion preserves the evidence used for IDs.
 */
import type { Analysis, Insight } from '../../model/analysis.js'
import { plural } from './format.js'
import { compareCrossFindings, type Aggregate, type CrossFinding } from '../../analyze/aggregate.js'
import type { Finding, SuggestionRecord, SuggestionScope } from '../../suggest/types.js'
import { kickoffCommands, normalizeSessionIds, sessionCohortFingerprint, suggestionIdV2, suggestionKey } from '../../suggest/id.js'

/** The one-time plugin install, typed inside Claude Code (not a shell command); the report and the CLI print the same line. */
export const PLUGIN_INSTALL = '/plugin marketplace add NissanOhana/orangu · /plugin install orangu'

/**
 * The "In one session" marker of a cross-finding title, said once above a repo or global list. Each row
 * then shows its example title, and `title` keeps the marker for the handoff and the stored records.
 */
export const EXAMPLE_TITLE_CAPTION = 'Each title shows the figures of one example session.'

export interface PlanRow {
  ruleId: string
  /** marked on repo/global ("In one session: …"): findingForRow hands it on, so the --finding token and stored records keep it */
  title: string
  /** repo/global: the example insight's own title, shown on the card in place of the marked `title`; an older aggregate has none, and an empty one shows `title` */
  displayTitle?: string
  detail: string
  /** the change the rule suggests, or the whole recommendation of a finding written before the rule text had parts; a crossFinding carries the one of its example session, an older aggregate none (the card then has no improvement line) */
  improvement?: string
  /** what the finding costs or means; behind the card's Why disclosure */
  why?: string
  /** what the rule counts and skips; behind Why, after `why` */
  method?: string
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

/**
 * Default redaction blanks Insight.detail because it quotes commands and result previews
 * (src/redact/redact.ts). The fallback says so and names the way back, like Coverage does for
 * hidden record types, instead of asserting that evidence exists where none is shown.
 */
export const DETAIL_HIDDEN_BY_REDACTION = 'orangu hides these details because they quote commands and output. To see them, run the report again with --include-text.'

function safeCopy(ruleId: string, title: string, detail: string): { title: string; detail: string } {
  return {
    title: title.trim() || titleForRule(ruleId),
    detail: detail.trim() || DETAIL_HIDDEN_BY_REDACTION,
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
    improvement: i.improvement || i.recommendation,
    why: i.why,
    method: i.method,
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
      // the count against the scope: the list caption already says each title's figures come from one example session
      const copy = safeCopy(f.ruleId, f.title, `This pattern shows in ${f.sessions} of ${plural(agg!.sessionCount, 'session')}.`)
      return {
        ruleId: f.ruleId,
        ...copy,
        displayTitle: f.exampleTitle,
        improvement: f.improvement || f.recommendation,
        why: f.why,
        method: f.method,
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
  return detail ? `Claude could not write the proposal: ${detail}` : 'Claude could not write the proposal. Copy the command. Run it again to see the error.'
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
