import { COHORT_SKIP_REASONS } from './cohort-skip-reasons.js'
import { COHORT_ALPHA, COHORT_MAX, COHORT_MIN, checkEvidence, checkVerdict, isDirectional, overallVerdict, type CohortVerdict } from './cohort-stats.js'
import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  type SuggestionFrozenBaseline,
  type SuggestionOutcomeCheck,
  type SuggestionOutcomeReceipt,
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

/** A cohort session id as the trusted loader stores it: the lowercase form of `SESSION_ID_RE` in `src/discover/discover.ts`. */
const COHORT_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const FROZEN_BASELINE_KEYS = ['v', 'cutAt', 'sessions', 'skipped'] as const satisfies ReadonlyArray<keyof SuggestionFrozenBaseline>
const FROZEN_SESSION_KEYS = ['id', 'startedAt', 'endedAt', 'metrics'] as const satisfies ReadonlyArray<keyof SuggestionFrozenBaseline['sessions'][number]>
const OUTCOME_RECEIPT_KEYS = [
  'v',
  'method',
  'alpha',
  'appliedAt',
  'checkpoint',
  'verdict',
  'laterComplete',
  'confoundedBy',
  'baselineSessionIds',
  'measuredSessionIds',
  'checks',
] as const satisfies ReadonlyArray<keyof SuggestionOutcomeReceipt>
const OUTCOME_CHECK_KEYS = [
  'metric',
  'comparison',
  'name',
  'before',
  'after',
  'beforeMedian',
  'afterMedian',
  'pLower',
  'pHigher',
  'verdict',
] as const satisfies ReadonlyArray<keyof SuggestionOutcomeCheck>
const OUTCOME_VERDICTS: readonly CohortVerdict[] = ['within-noise', 'regressed', 'not-enough-sessions', 'no-directional-check']

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The object has these own keys and no other key, so a stored field cannot carry an extra string. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/**
 * Every rule of a frozen baseline: numbers and lowercase session ids only, in the exact shape of the type. The store
 * applies it on the `applied` move, and again before it grades an outcome against the stored baseline. With
 * `appliedAt`, the cut must not be later than the application time. Returns the first violation.
 */
export function frozenBaselineViolation(value: unknown, appliedAt: number | undefined): string | undefined {
  if (!plainObject(value) || !hasExactKeys(value, FROZEN_BASELINE_KEYS)) return 'frozenBaseline must have exactly the keys v, cutAt, sessions and skipped'
  if (value['v'] !== 1) return 'frozenBaseline v must be 1'
  const cutAt = value['cutAt']
  if (!finiteNonNegative(cutAt)) return 'frozenBaseline cutAt must be a finite number of 0 or more'
  if (appliedAt !== undefined && cutAt > appliedAt) return 'frozenBaseline cutAt must not be later than the application time'
  const sessions = value['sessions']
  if (!Array.isArray(sessions) || sessions.length > COHORT_MAX) return `frozenBaseline must hold 0 to ${COHORT_MAX} sessions`
  let previousId = ''
  for (let index = 0; index < sessions.length; index++) {
    const session: unknown = sessions[index]
    const label = `frozenBaseline sessions[${index}]`
    if (!plainObject(session) || !hasExactKeys(session, FROZEN_SESSION_KEYS)) return `${label} must have exactly the keys id, startedAt, endedAt and metrics`
    const { id, startedAt, endedAt, metrics } = session
    if (typeof id !== 'string' || !COHORT_SESSION_ID_RE.test(id)) return `${label} id must be a lowercase session id`
    if (index > 0 && !(previousId < id)) return 'frozenBaseline sessions must be sorted by id with no repeated id'
    previousId = id
    if (!finiteNonNegative(startedAt) || !finiteNonNegative(endedAt)) return `${label} times must each be a finite number of 0 or more`
    if (startedAt > endedAt || endedAt > cutAt) return `${label} must start before it ends, and end at or before cutAt`
    if (!plainObject(metrics) || !hasExactKeys(metrics, SUGGESTION_VERIFICATION_METRICS)) {
      return `${label} metrics must have exactly the ${SUGGESTION_VERIFICATION_METRICS.length} verification metrics`
    }
    if (!SUGGESTION_VERIFICATION_METRICS.every((metric) => finiteNonNegative(metrics[metric]))) return `${label} metrics must each be a finite number of 0 or more`
  }
  const skipped = value['skipped']
  if (!plainObject(skipped) || !hasExactKeys(skipped, COHORT_SKIP_REASONS)) return `frozenBaseline skipped must have exactly the ${COHORT_SKIP_REASONS.length} skip reasons`
  if (!COHORT_SKIP_REASONS.every((reason) => Number.isSafeInteger(skipped[reason]) && (skipped[reason] as number) >= 0)) {
    return 'frozenBaseline skipped counts must each be a whole number of 0 or more'
  }
  return undefined
}

/**
 * Every rule of an outcome receipt, graded again from its own numbers, with 0 to 10 sessions on each side. The store
 * applies it before a `regressed` or `unproven` move. `status` is that move, and `frozenBaseline` is the baseline that
 * the record stored at its `applied` move. The same rules as `cohortReceiptViolation`, with 3 more: the verdict fits
 * the move, the later cohort is complete unless a short frozen baseline closes it, and the receipt names the frozen
 * sessions. Returns the first violation.
 */
export function outcomeReceiptViolation(
  value: unknown,
  status: 'regressed' | 'unproven',
  reviewed: readonly SuggestionVerificationIntent[],
  appliedAt: number | undefined,
  frozenBaseline: unknown,
): string | undefined {
  if (!plainObject(value) || !hasExactKeys(value, OUTCOME_RECEIPT_KEYS)) return 'outcomeReceipt must have exactly the keys of an outcome receipt'
  const receipt = value as Partial<SuggestionOutcomeReceipt>
  if (receipt.v !== 1 || receipt.method !== 'cohort-rank-v1' || receipt.alpha !== COHORT_ALPHA) return 'outcomeReceipt must be a cohort-rank-v1 outcome receipt at alpha 0.05'
  if (appliedAt === undefined || receipt.appliedAt !== appliedAt) return 'receipt appliedAt must equal the recorded application time'
  if (receipt.checkpoint !== 'first' && receipt.checkpoint !== 'complete') return 'checkpoint must be first or complete'
  if (!OUTCOME_VERDICTS.includes(receipt.verdict as CohortVerdict)) return 'verdict must be a verdict other than verified'
  if (typeof receipt.laterComplete !== 'boolean') return 'laterComplete must be a boolean'
  if (!sortedUniqueIds(receipt.baselineSessionIds, 0, COHORT_MAX, COHORT_SESSION_ID_RE)) return `baselineSessionIds must be 0 to ${COHORT_MAX} sorted unique session ids`
  if (!sortedUniqueIds(receipt.measuredSessionIds, 0, COHORT_MAX, COHORT_SESSION_ID_RE)) return `measuredSessionIds must be 0 to ${COHORT_MAX} sorted unique session ids`
  const baseline = new Set(receipt.baselineSessionIds)
  if (receipt.measuredSessionIds.some((id) => baseline.has(id))) return 'baseline and later cohorts must not share a session'
  if (!sortedUniqueIds(receipt.confoundedBy, 0, MAX_CONFOUNDERS, SUGGESTION_ID_RE)) return 'confoundedBy must be sorted unique suggestion ids'
  let frozen: SuggestionFrozenBaseline | undefined
  if (frozenBaseline !== undefined) {
    if (frozenBaselineViolation(frozenBaseline, appliedAt) !== undefined) return 'the stored frozenBaseline is not valid, so the store cannot grade an outcome against it'
    frozen = frozenBaseline as SuggestionFrozenBaseline
    // A record with a frozen baseline grades against those sessions, and against no other baseline.
    if (JSON.stringify(frozen.sessions.map((session) => session.id)) !== JSON.stringify(receipt.baselineSessionIds)) {
      return 'baselineSessionIds must equal the frozen baseline session ids'
    }
  }
  const checks = receipt.checks
  if (!Array.isArray(checks) || checks.length !== reviewed.length) return 'checks must match the reviewed verificationChecks'
  const nBefore = receipt.baselineSessionIds.length
  const nAfter = receipt.measuredSessionIds.length
  const minP = Number((1 / binomial(nBefore + nAfter, nAfter)).toFixed(6))
  for (let index = 0; index < checks.length; index++) {
    const raw: unknown = checks[index]
    const intent = reviewed[index]!
    if (!plainObject(raw) || !hasExactKeys(raw, OUTCOME_CHECK_KEYS)) return `checks[${index}] must have exactly the keys of an outcome check`
    const check = raw as Partial<SuggestionOutcomeCheck>
    if (check.metric !== intent.metric || check.comparison !== intent.comparison || check.name !== verificationCheckName(intent)) {
      return `checks[${index}] must match the reviewed check ${verificationCheckName(intent)}`
    }
    const { before, after, beforeMedian, afterMedian, pLower, pHigher } = check
    if (!finiteNonNegative(before) || !finiteNonNegative(after) || !finiteNonNegative(beforeMedian) || !finiteNonNegative(afterMedian)) {
      return `checks[${index}] must carry finite metric values`
    }
    if (typeof pLower !== 'number' || typeof pHigher !== 'number' || ![pLower, pHigher].every((p) => p >= minP && p <= 1) || pLower + pHigher < 1) {
      return `checks[${index}] p-values are not possible for ${nBefore} and ${nAfter} sessions`
    }
    const verdict = checkVerdict(intent.comparison, before, after, pLower, pHigher)
    if (check.verdict !== verdict) return `checks[${index}] verdict must be the computed verdict ${verdict}`
  }
  const overall = overallVerdict(checks as SuggestionOutcomeCheck[], nBefore, nAfter)
  if (receipt.verdict !== overall) return `the overall verdict must be the computed verdict ${overall}`
  if (status === 'regressed' && receipt.verdict !== 'regressed') return `a regressed record needs the regressed verdict, not ${receipt.verdict}`
  if (status === 'unproven' && receipt.verdict === 'regressed') return 'an unproven record cannot carry the regressed verdict'
  const shortFrozen = frozen !== undefined && frozen.sessions.length < COHORT_MIN
  if (!receipt.laterComplete && !(shortFrozen && receipt.verdict === 'not-enough-sessions')) {
    return `laterComplete must be true. Only a frozen baseline below ${COHORT_MIN} sessions with the verdict not-enough-sessions closes before the later cohort is complete`
  }
  if (receipt.checkpoint === 'first' && !shortFrozen) return `checkpoint first needs a frozen baseline below ${COHORT_MIN} sessions`
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
