import { COHORT_ALPHA, COHORT_MAX, COHORT_MIN, checkEvidence, checkVerdict, isDirectional } from './cohort-stats.js'
import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  type SuggestionRecord,
  type SuggestionVerificationIntent,
  type SuggestionVerificationReceiptV2,
} from './types.js'

export function verificationIntentKey(intent: SuggestionVerificationIntent): string {
  return `${intent.metric}:${intent.comparison}`
}

export function hasUniqueVerificationIntents(intents: readonly SuggestionVerificationIntent[]): boolean {
  return new Set(intents.map(verificationIntentKey)).size === intents.length
}

/** Pair-set equality for untrusted receipt intent; order cannot change reviewed meaning. */
export function sameVerificationIntentSet(
  left: readonly SuggestionVerificationIntent[],
  right: readonly SuggestionVerificationIntent[],
): boolean {
  if (left.length !== right.length) return false
  const leftKeys = left.map(verificationIntentKey).sort()
  const rightKeys = right.map(verificationIntentKey).sort()
  return leftKeys.every((key, index) => key === rightKeys[index])
}

/** Persisted receipts use the proposal's reviewed order as part of their canonical representation. */
export function sameVerificationIntentSequence(
  left: readonly SuggestionVerificationIntent[],
  right: readonly SuggestionVerificationIntent[],
): boolean {
  return left.length === right.length && left.every((intent, index) => verificationIntentKey(intent) === verificationIntentKey(right[index]!))
}

export function verificationCheckName(intent: SuggestionVerificationIntent): string {
  return `${intent.metric} ${intent.comparison}`
}

export function verificationReceiptSummary(intents: readonly SuggestionVerificationIntent[]): string {
  return `Later-session comparison passed: ${intents.map(verificationCheckName).join('; ')}.`
}

function isIntent(value: unknown): value is SuggestionVerificationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const intent = value as Partial<SuggestionVerificationIntent>
  return SUGGESTION_VERIFICATION_METRICS.includes(intent.metric as never) &&
    SUGGESTION_VERIFICATION_COMPARISONS.includes(intent.comparison as never)
}

function numericMapMatches(value: unknown, expected: Record<string, number>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  const wanted = Object.entries(expected)
  return entries.length === wanted.length && wanted.every(([key, number]) => (value as Record<string, unknown>)[key] === number)
}

/** When the change was applied: the stamped time, or `statusAt` while the record is still `applied`. */
export function applicationTime(record: SuggestionRecord): number | undefined {
  if (typeof record.appliedAt === 'number' && Number.isFinite(record.appliedAt) && record.appliedAt > 0) return record.appliedAt
  return record.status === 'applied' && Number.isFinite(record.statusAt) && record.statusAt > 0 ? record.statusAt : undefined
}

export function cohortReceiptSummary(
  receipt: Pick<SuggestionVerificationReceiptV2, 'checks' | 'baselineSessionIds' | 'measuredSessionIds' | 'confoundedBy'>,
): string {
  const head =
    `Later sessions beat the baseline beyond chance (${receipt.baselineSessionIds.length} before, ` +
    `${receipt.measuredSessionIds.length} after, p ≤ ${COHORT_ALPHA}): ${receipt.checks.map(verificationCheckName).join('; ')}.`
  const others = receipt.confoundedBy.length
  return others
    ? `${head} Measured together with ${others} other applied change${others === 1 ? '' : 's'}; not attributable to this change alone.`
    : head
}

const SUGGESTION_ID_RE = /^sg_[0-9a-f]{12}$/
const MAX_CONFOUNDERS = 64

function binomial(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i
  return result
}

function sortedUniqueIds(value: unknown, min: number, max: number, pattern?: RegExp): value is string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false
  if (!value.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 500 && (!pattern || pattern.test(id)))) return false
  return value.every((id, index) => index === 0 || (value[index - 1] as string) < id)
}

const finiteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * Every rule a v2 cohort receipt must satisfy, re-derived from its own numbers: the store applies it before
 * the `verified` transition and the trust check applies it again on every read. Returns the first violation.
 */
export function cohortReceiptViolation(
  value: unknown,
  reviewed: readonly SuggestionVerificationIntent[],
  appliedAt: number | undefined,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'receipt must be an object'
  const receipt = value as Partial<SuggestionVerificationReceiptV2>
  if (receipt.v !== 2 || receipt.method !== 'cohort-rank-v1' || receipt.alpha !== COHORT_ALPHA) return 'receipt must be a cohort-rank-v1 receipt at alpha 0.05'
  if (appliedAt === undefined || receipt.appliedAt !== appliedAt) return 'receipt appliedAt must equal the recorded application time'
  if (!sortedUniqueIds(receipt.baselineSessionIds, COHORT_MIN, COHORT_MAX)) return `baselineSessionIds must be ${COHORT_MIN}-${COHORT_MAX} sorted unique ids`
  if (!sortedUniqueIds(receipt.measuredSessionIds, COHORT_MIN, COHORT_MAX)) return `measuredSessionIds must be ${COHORT_MIN}-${COHORT_MAX} sorted unique ids`
  const baseline = new Set(receipt.baselineSessionIds)
  if (receipt.measuredSessionIds.some((id) => baseline.has(id))) return 'baseline and later cohorts must not share a session'
  if (!sortedUniqueIds(receipt.confoundedBy, 0, MAX_CONFOUNDERS, SUGGESTION_ID_RE)) return 'confoundedBy must be sorted unique suggestion ids'
  const checks = receipt.checks
  if (!Array.isArray(checks) || checks.length !== reviewed.length) return 'checks must match the reviewed verificationChecks'
  const nBefore = receipt.baselineSessionIds.length
  const nAfter = receipt.measuredSessionIds.length
  const minP = Number((1 / binomial(nBefore + nAfter, nAfter)).toFixed(6))
  for (let index = 0; index < checks.length; index++) {
    const check = checks[index]
    const intent = reviewed[index]!
    if (!check || typeof check !== 'object' || check.metric !== intent.metric || check.comparison !== intent.comparison) {
      return `checks[${index}] must match the reviewed check ${verificationCheckName(intent)}`
    }
    if (check.name !== verificationCheckName(intent) || check.ok !== true) return `checks[${index}] must be a passing, named check`
    const numbers = [check.before, check.after, check.beforeMedian, check.afterMedian]
    if (!numbers.every(finiteNonNegative)) return `checks[${index}] must carry finite metric values`
    const p = [check.pLower, check.pHigher]
    if (!p.every((x) => typeof x === 'number' && x >= minP && x <= 1) || check.pLower + check.pHigher < 1) {
      return `checks[${index}] p-values are not possible for ${nBefore} and ${nAfter} sessions`
    }
    const verdict = checkVerdict(check.comparison, check.before, check.after, check.pLower, check.pHigher)
    if (verdict !== check.verdict || (verdict !== 'improved' && verdict !== 'held')) return `checks[${index}] did not pass: ${verdict}`
    if (check.evidence !== checkEvidence(check.metric, check.comparison, check, verdict)) return `checks[${index}] evidence must be the computed rendering`
  }
  if (!checks.some((check) => isDirectional(check.comparison))) return 'at least one check must name a direction (decreased or increased)'
  if (receipt.summary !== cohortReceiptSummary(receipt as SuggestionVerificationReceiptV2)) return 'summary must be the computed summary'
  return undefined
}

function effectMatchesChecks(record: SuggestionRecord, checks: ReadonlyArray<{ metric: string; before: number; after: number }>, measured: readonly string[]): boolean {
  const effect = record.effect
  if (!effect || !Array.isArray(effect.measuredSessionIds) || JSON.stringify(effect.measuredSessionIds) !== JSON.stringify(measured)) return false
  const before = Object.fromEntries(checks.map((check) => [check.metric, check.before]))
  const after = Object.fromEntries(checks.map((check) => [check.metric, check.after]))
  return numericMapMatches(effect.before, before) && numericMapMatches(effect.after, after)
}

function isTrustedCohortVerification(record: SuggestionRecord): boolean {
  if (record.scope !== 'session' && record.scope !== 'repo') return false
  const proposal = record.proposal
  const receipt = record.verificationReceipt
  if (
    proposal?.v !== 1 ||
    !proposal.workspace?.cwd ||
    !Array.isArray(proposal.verificationChecks) ||
    proposal.verificationChecks.length === 0 ||
    !proposal.verificationChecks.every(isIntent) ||
    !hasUniqueVerificationIntents(proposal.verificationChecks) ||
    record.application?.v !== 1 ||
    receipt?.v !== 2
  ) return false
  if (cohortReceiptViolation(receipt, proposal.verificationChecks, record.appliedAt) !== undefined) return false
  return effectMatchesChecks(record, receipt.checks, receipt.measuredSessionIds)
}

/**
 * Only records emitted by a validated transition may display the strong `verified` claim: `computed-v2`
 * (noise-aware cohorts, session or repo scope) or the earlier `computed-v1` session comparison. Older
 * append-only lines remain readable but are deliberately presented as legacy/unverified evidence.
 */
export function isTrustedComputedVerification(record: SuggestionRecord): boolean {
  if (record.status !== 'verified') return false
  if (record.verificationTrust === 'computed-v2') return isTrustedCohortVerification(record)
  if (record.verificationTrust !== 'computed-v1' || record.scope !== 'session') return false
  const proposal = record.proposal
  const application = record.application
  const receipt = record.verificationReceipt
  const effect = record.effect
  if (
    proposal?.v !== 1 ||
    !proposal.workspace?.cwd ||
    !Array.isArray(proposal.verificationChecks) ||
    proposal.verificationChecks.length === 0 ||
    !proposal.verificationChecks.every(isIntent) ||
    !hasUniqueVerificationIntents(proposal.verificationChecks) ||
    application?.v !== 1 ||
    receipt?.v !== 1 ||
    !effect ||
    !Array.isArray(receipt.checks) ||
    receipt.checks.length !== proposal.verificationChecks.length ||
    !Array.isArray(receipt.measuredSessionIds) ||
    receipt.measuredSessionIds.length === 0 ||
    JSON.stringify(receipt.measuredSessionIds) !== JSON.stringify(effect.measuredSessionIds)
  ) return false
  if (receipt.summary !== verificationReceiptSummary(proposal.verificationChecks)) return false
  for (let index = 0; index < proposal.verificationChecks.length; index++) {
    const intent = proposal.verificationChecks[index]!
    const check = receipt.checks[index]
    if (
      !check ||
      check.ok !== true ||
      check.metric !== intent.metric ||
      check.comparison !== intent.comparison ||
      check.name !== verificationCheckName(intent) ||
      !Number.isFinite(check.before) ||
      !Number.isFinite(check.after) ||
      typeof check.evidence !== 'string' ||
      !check.evidence
    ) return false
  }
  const before = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.before]))
  const after = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.after]))
  return numericMapMatches(effect.before, before) && numericMapMatches(effect.after, after)
}
