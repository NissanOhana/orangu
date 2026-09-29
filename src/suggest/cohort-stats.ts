/**
 * Noise-aware verification statistics.
 * Platform-neutral and pure: no node imports, no clock, no randomness. The same two cohorts always give the
 * same p-values, so a verified receipt can be re-graded from its own numbers.
 *
 * The test is an exact permutation rank test (Mann-Whitney with midranks for ties). Different sessions are
 * different tasks, so the claim it supports is "later sessions ran lower than the baseline beyond chance",
 * never "the change caused it".
 */
import type { SuggestionVerificationComparison, SuggestionVerificationIntent, SuggestionVerificationMetric } from './types.js'

/** A directional check must beat chance at this one-sided level; a guard fails only past it. */
export const COHORT_ALPHA = 0.05
/** Fewest sessions per side: with three and three, perfect separation reaches exactly p = 1/20. */
export const COHORT_MIN = 3
/** Most sessions per side; the later cohort is the first ten after application, so the verdict freezes there. */
export const COHORT_MAX = 10

export type CohortCheckVerdict = 'improved' | 'within-noise' | 'regressed' | 'held' | 'changed'
export type CohortVerdict = 'verified' | 'within-noise' | 'regressed' | 'not-enough-sessions' | 'no-directional-check'

export interface RankTest {
  /** chance of a later rank sum this low or lower */
  pLower: number
  /** chance of a later rank sum this high or higher */
  pHigher: number
}

export interface CohortCheckResult extends SuggestionVerificationIntent {
  name: string
  before: number
  after: number
  beforeMedian: number
  afterMedian: number
  pLower: number
  pHigher: number
  verdict: CohortCheckVerdict
  evidence: string
}

const round6 = (value: number): number => Number(value.toFixed(6))

function assertFinite(values: readonly number[]): void {
  if (!values.every((value) => Number.isFinite(value))) throw new RangeError('cohort values must be finite numbers')
}

/** Exact one-sided p-values of the later cohort's rank sum under exchangeability. */
export function rankTest(before: readonly number[], after: readonly number[]): RankTest {
  assertFinite(before)
  assertFinite(after)
  if (!before.length || !after.length) return { pLower: 1, pHigher: 1 }
  const pooled = [...before, ...after]
  const order = pooled.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index)
  // Doubled midranks are integers: a tie group over 0-based positions start..end has midrank (start + end) / 2 + 1.
  const doubled = new Array<number>(pooled.length).fill(0)
  for (let start = 0; start < order.length; ) {
    let end = start
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end++
    for (let position = start; position <= end; position++) doubled[order[position]!.index] = start + end + 2
    start = end + 1
  }
  const k = after.length
  const maxSum = doubled.reduce((sum, rank) => sum + rank, 0)
  const observed = doubled.slice(before.length).reduce((sum, rank) => sum + rank, 0)
  // ways[j][s]: how many size-j subsets of the pooled sessions have doubled rank sum s.
  const ways = Array.from({ length: k + 1 }, () => new Array<number>(maxSum + 1).fill(0))
  ways[0]![0] = 1
  for (const rank of doubled) {
    for (let j = k; j >= 1; j--) {
      const row = ways[j]!
      const previous = ways[j - 1]!
      for (let sum = maxSum; sum >= rank; sum--) row[sum]! += previous[sum - rank]!
    }
  }
  const distribution = ways[k]!
  let total = 0
  let lower = 0
  let higher = 0
  for (let sum = 0; sum <= maxSum; sum++) {
    const count = distribution[sum]!
    total += count
    if (sum <= observed) lower += count
    if (sum >= observed) higher += count
  }
  return { pLower: round6(lower / total), pHigher: round6(higher / total) }
}

export function mean6(values: readonly number[]): number {
  if (!values.length) return 0
  return round6(values.reduce((sum, value) => sum + value, 0) / values.length)
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : round6((sorted[middle - 1]! + sorted[middle]!) / 2)
}

function twoSided(pLower: number, pHigher: number): number {
  return round6(Math.min(1, 2 * Math.min(pLower, pHigher)))
}

/** The p-value that answers the question the comparison asks, for display. */
function reportedP(comparison: SuggestionVerificationComparison, pLower: number, pHigher: number): number {
  if (comparison === 'decreased' || comparison === 'not-decreased') return pLower
  if (comparison === 'increased' || comparison === 'not-increased') return pHigher
  return twoSided(pLower, pHigher)
}

/** The one grading rule: evaluateCheck applies it, and the trust policy re-applies it to stored numbers. */
export function checkVerdict(
  comparison: SuggestionVerificationComparison,
  before: number,
  after: number,
  pLower: number,
  pHigher: number,
): CohortCheckVerdict {
  if (comparison === 'decreased') {
    if (pHigher <= COHORT_ALPHA) return 'regressed'
    return after < before && pLower <= COHORT_ALPHA ? 'improved' : 'within-noise'
  }
  if (comparison === 'increased') {
    if (pLower <= COHORT_ALPHA) return 'regressed'
    return after > before && pHigher <= COHORT_ALPHA ? 'improved' : 'within-noise'
  }
  if (comparison === 'not-increased') return pHigher <= COHORT_ALPHA ? 'regressed' : 'held'
  if (comparison === 'not-decreased') return pLower <= COHORT_ALPHA ? 'regressed' : 'held'
  return twoSided(pLower, pHigher) <= COHORT_ALPHA ? 'changed' : 'held'
}

export function evaluateCheck(intent: SuggestionVerificationIntent, before: readonly number[], after: readonly number[]): CohortCheckResult {
  const { pLower, pHigher } = rankTest(before, after)
  const beforeMean = mean6(before)
  const afterMean = mean6(after)
  const beforeMedian = median(before)
  const afterMedian = median(after)
  const verdict = checkVerdict(intent.comparison, beforeMean, afterMean, pLower, pHigher)
  const numbers = { before: beforeMean, after: afterMean, beforeMedian, afterMedian, pLower, pHigher }
  return {
    metric: intent.metric,
    comparison: intent.comparison,
    // Same rule as verificationCheckName; spelled here so the policy can import this module without a cycle.
    name: `${intent.metric} ${intent.comparison}`,
    ...numbers,
    verdict,
    evidence: checkEvidence(intent.metric, intent.comparison, numbers, verdict),
  }
}

/** Deterministic rendering of one graded check; the store re-derives it rather than trusting stored text. */
export function checkEvidence(
  metric: SuggestionVerificationMetric,
  comparison: SuggestionVerificationComparison,
  n: { before: number; after: number; beforeMedian: number; afterMedian: number; pLower: number; pHigher: number },
  verdict: CohortCheckVerdict,
): string {
  const p = reportedP(comparison, n.pLower, n.pHigher)
  return `${metric}: ${n.before} → ${n.after} (median ${n.beforeMedian} → ${n.afterMedian}; exact rank test p=${p}; ${verdict})`
}

export function isDirectional(comparison: SuggestionVerificationComparison): boolean {
  return comparison === 'decreased' || comparison === 'increased'
}

export function overallVerdict(checks: readonly CohortCheckResult[], nBefore: number, nAfter: number): CohortVerdict {
  if (nBefore < COHORT_MIN || nAfter < COHORT_MIN) return 'not-enough-sessions'
  if (checks.some((check) => check.verdict === 'regressed' || check.verdict === 'changed')) return 'regressed'
  const directional = checks.filter((check) => isDirectional(check.comparison))
  if (!directional.length) return 'no-directional-check'
  return directional.every((check) => check.verdict === 'improved') ? 'verified' : 'within-noise'
}
