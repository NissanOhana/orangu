/**
 * Suggestion contract.
 * Platform-neutral: imported by the CLI bundle, the serve layer AND the report client bundle.
 * No node imports here.
 */
import type { ChangeClass } from './change-classes.js'

export type SuggestionScope = 'session' | 'repo' | 'global'
export type SuggestionSource = 'report' | 'skill'
export type SuggestionStatus = 'new' | 'kicked-off' | 'proposed' | 'applied' | 'verified' | 'rejected' | 'failed'

/** legal status moves; the store throws on anything else */
export const TRANSITIONS: Record<SuggestionStatus, SuggestionStatus[]> = {
  new: ['kicked-off', 'rejected'],
  'kicked-off': ['proposed', 'failed', 'rejected'],
  proposed: ['applied', 'rejected'],
  applied: ['verified', 'rejected'],
  verified: ['rejected'],
  rejected: [],
  failed: ['kicked-off', 'rejected'],
}

export interface SuggestionEvidence {
  savingsTokens?: number
  savingsMs?: number
  /** true when any figure is derived (bytes/4) rather than reported by the API */
  estimated: boolean
  sessions?: number
  turnIndexes?: number[]
  live?: boolean
  [k: string]: unknown
}

/** what the report/skill hands to the store to create (or find) a record */
export interface Finding {
  ruleId: string
  title: string
  scope: SuggestionScope
  sessionIds: string[]
  insightId?: string
  /** Aggregate-only identity of the complete repo/global session cohort. */
  cohortFingerprint?: string
  evidence: SuggestionEvidence
}

/**
 * Canonical identity for newly-created suggestions. `sessionIds` are normalized,
 * de-duplicated and sorted before hashing (see `suggestionKey`).
 *
 * `source` remains part of the key so a report finding and a separately-created
 * skill finding do not silently become the same workflow record. File and serve
 * report handoffs both use `source: "report"`, so their ids are identical.
 */
export interface SuggestionKey {
  v: 2
  source: SuggestionSource
  scope: SuggestionScope
  ruleId: string
  sessionIds: string[]
  insightId?: string
  cohortFingerprint?: string
}

export interface SuggestionRecord {
  id: string
  v: 1 | 2
  /** present on v2 records; absent on readable legacy v1 JSONL lines */
  key?: SuggestionKey
  /** legacy ids that resolve to this canonical record after an on-write migration */
  legacyIds?: string[]
  createdAt: number
  source: SuggestionSource
  scope: SuggestionScope
  sessionIds: string[]
  ruleId: string
  title: string
  insightId?: string
  cohortFingerprint?: string
  evidence: SuggestionEvidence
  proposal?: SuggestionProposal
  application?: SuggestionApplicationReceipt
  verificationReceipt?: SuggestionVerificationReceipt
  /** Store-owned marker for verification that passed the current computed-evidence contract. */
  verificationTrust?: 'computed-v1'
  status: SuggestionStatus
  statusAt: number
  effect?: { before: Record<string, number>; after: Record<string, number>; measuredSessionIds: string[] }
  kickoff?: { mode: 'file' | 'serve'; command: string; pid?: number; exitCode?: number; error?: string }
}

/** A bounded, machine-readable companion to the human-readable proposal Markdown. */
export interface SuggestionProposalSource {
  kind: 'catalog' | 'research' | 'inference'
  label: string
  url?: string
  /** ISO-8601 calendar date for an online source that was actually checked. */
  verifiedAt?: string | null
}

export interface SuggestionProposal {
  /** absent only on readable legacy proposal records */
  v?: 1
  title: string
  change: string
  effort: 'S' | 'M' | 'L'
  files?: string[]
  proposalPath: string
  manifestPath?: string
  changeClass?: ChangeClass
  evidence?: string
  expectedEffect?: string
  risk?: string
  verification?: string
  /** Required on structured v1 proposals; the reviewed metrics a later receipt must match exactly. */
  verificationChecks?: SuggestionVerificationIntent[]
  sources?: SuggestionProposalSource[]
  rank?: number
  /** Captured by Orangu when the structured proposal is accepted. */
  workspace?: SuggestionWorkspaceIdentity
}

export interface SuggestionWorkspaceIdentity {
  cwd: string
  device: string
  inode: string
}

export interface SuggestionApplicationCheck {
  name: string
  command?: string
  ok: true
}

/** Written by the apply skill only after every named local check succeeds. */
export interface SuggestionApplicationReceipt {
  v: 1
  summary: string
  files: string[]
  checks: SuggestionApplicationCheck[]
  receiptPath: string
}

export const SUGGESTION_VERIFICATION_METRICS = [
  'avgTotalTokens',
  'avgToolCalls',
  'avgToolErrors',
  'avgActiveMs',
  'avgContextPeak',
  'avgTestRunsFailed',
  'avgBuildRunsFailed',
  'avgInterruptions',
] as const
export type SuggestionVerificationMetric = (typeof SUGGESTION_VERIFICATION_METRICS)[number]

export const SUGGESTION_VERIFICATION_COMPARISONS = ['decreased', 'not-increased', 'increased', 'not-decreased', 'equal'] as const
export type SuggestionVerificationComparison = (typeof SUGGESTION_VERIFICATION_COMPARISONS)[number]

export interface SuggestionVerificationIntent {
  metric: SuggestionVerificationMetric
  comparison: SuggestionVerificationComparison
}

/** A comparison Orangu computed from resolved baseline and later Analysis objects. */
export interface SuggestionVerificationCheck extends SuggestionVerificationIntent {
  name: string
  before: number
  after: number
  /** Human-readable rendering of the computed values; never accepted from the input artifact. */
  evidence: string
  ok: true
}

/** Later evidence, kept separate from the claim that a change was merely applied. */
export interface SuggestionVerificationReceipt {
  v: 1
  summary: string
  measuredSessionIds: string[]
  checks: SuggestionVerificationCheck[]
  receiptPath: string
}

/** `orangu estimate` output: the gate before any LLM-facing read (§AI) */
export interface Estimate {
  bytes: number
  approxTokens: number
  sessions: number
  files: number
  overThreshold: boolean
  /**
   * Session selectors that could not be projected (no such session, or the transcript could not be
   * loaded), with the reason. They contribute nothing to `bytes`, so `overThreshold` speaks only for
   * the sessions counted. Present for session projections; `estimate harness` sizes one report and omits it.
   */
  skipped?: SkippedSession[]
}
export interface SkippedSession {
  selector: string
  reason: string
}
/** ≈ 20 KB of slim JSON (≈ 4 bytes / token) */
export const ESTIMATE_TOKEN_THRESHOLD = 5000

/** policy + the finding (needed to create the record) */
export interface KickoffRequest {
  finding: Finding
  mode: 'copy' | 'run'
  confirm?: boolean
  suggestionId?: string
}
export interface KickoffResponse {
  record: SuggestionRecord
  /** Host-specific, copy-only handoffs for the same canonical finding. */
  commands: { claude: string; codex: string }
  /** Backward-compatible alias for commands.claude. */
  command: string
  /** The loopback report is an authority-limited copy handoff and never spawns. */
  spawned: false
  error?: string
}

/** additive `orangu estimate --suggestion ... --receipt ... --json` result */
export interface ConfirmationReceiptResult {
  valid: boolean
  expiresAt?: number
  reason?: string
}

export interface SuggestionStoreLike {
  all(): Promise<SuggestionRecord[]>
  get(id: string): Promise<SuggestionRecord | undefined>
  /** Explicit ids are accepted only when they match this finding's canonical id or legacy report hash. */
  upsertNew(f: Finding, source: SuggestionSource, id?: string): Promise<{ record: SuggestionRecord; created: boolean }>
  transition(
    id: string,
    to: SuggestionStatus,
    patch?: Partial<Pick<SuggestionRecord, 'proposal' | 'application' | 'verificationReceipt' | 'kickoff' | 'effect'>>,
  ): Promise<SuggestionRecord>
}
