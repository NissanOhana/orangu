import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  type SuggestionRecord,
  type SuggestionVerificationIntent,
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

/**
 * Only records emitted by the current validated transition may display the
 * strong `verified` claim. Older append-only lines remain readable but are
 * deliberately presented as legacy/unverified evidence.
 */
export function isTrustedComputedVerification(record: SuggestionRecord): boolean {
  if (record.status !== 'verified' || record.verificationTrust !== 'computed-v1' || record.scope !== 'session') return false
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
