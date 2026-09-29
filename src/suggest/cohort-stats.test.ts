import { describe, expect, it } from 'vitest'
import {
  COHORT_ALPHA,
  COHORT_MAX,
  COHORT_MIN,
  checkVerdict,
  evaluateCheck,
  mean6,
  median,
  overallVerdict,
  rankTest,
  type CohortCheckResult,
} from './cohort-stats.js'

/** Brute force over every size-k subset of the pooled positions: the reference the DP must equal. */
function bruteForce(before: number[], after: number[]): { pLower: number; pHigher: number } {
  const pooled = [...before, ...after]
  const sorted = [...pooled].sort((a, b) => a - b)
  const midrank = (value: number): number => {
    const first = sorted.indexOf(value)
    const last = sorted.lastIndexOf(value)
    return (first + last) / 2 + 1
  }
  const ranks = pooled.map(midrank)
  const observed = after.reduce((sum, value) => sum + midrank(value), 0)
  const k = after.length
  let lower = 0
  let higher = 0
  let total = 0
  const walk = (start: number, chosen: number, sum: number): void => {
    if (chosen === k) {
      total++
      if (sum <= observed + 1e-9) lower++
      if (sum >= observed - 1e-9) higher++
      return
    }
    for (let index = start; index < ranks.length; index++) walk(index + 1, chosen + 1, sum + ranks[index]!)
  }
  walk(0, 0, 0)
  return { pLower: Number((lower / total).toFixed(6)), pHigher: Number((higher / total).toFixed(6)) }
}

describe('cohort constants', () => {
  it('pin the reviewed rule: p <= 0.05, 3 to 10 sessions per side', () => {
    expect(COHORT_ALPHA).toBe(0.05)
    expect(COHORT_MIN).toBe(3)
    expect(COHORT_MAX).toBe(10)
  })
})

describe('rankTest', () => {
  it('gives 1/20 when three later sessions all sit below three baseline sessions', () => {
    expect(rankTest([5, 6, 7], [1, 2, 3])).toEqual({ pLower: 0.05, pHigher: 1 })
  })

  it('cannot beat chance with one session per side', () => {
    expect(rankTest([3], [1])).toEqual({ pLower: 0.5, pHigher: 1 })
  })

  it('returns p = 1 both ways when every value is equal', () => {
    expect(rankTest([1, 1, 1], [1, 1, 1])).toEqual({ pLower: 1, pHigher: 1 })
  })

  it('uses midranks for ties', () => {
    expect(rankTest([2, 2, 3], [1, 2, 2])).toEqual({ pLower: 0.3, pHigher: 1 })
  })

  it('returns p = 1 both ways when a side is empty', () => {
    expect(rankTest([], [1, 2])).toEqual({ pLower: 1, pHigher: 1 })
    expect(rankTest([1, 2], [])).toEqual({ pLower: 1, pHigher: 1 })
  })

  it('is symmetric: lower for (a, b) equals higher for (b, a)', () => {
    const pairs: Array<[number[], number[]]> = [
      [[4, 9, 2, 7], [1, 3, 8]],
      [[10, 10, 12], [11, 9, 9, 30]],
      [[0, 0, 1], [0, 2, 2]],
      [[5, 1, 5, 1, 5], [2, 2, 2]],
    ]
    for (const [a, b] of pairs) {
      expect(rankTest(a, b).pLower).toBe(rankTest(b, a).pHigher)
      expect(rankTest(a, b).pHigher).toBe(rankTest(b, a).pLower)
    }
  })

  it('equals brute-force enumeration of every split', () => {
    const cases: Array<[number[], number[]]> = [
      [[4, 9, 2, 7], [1, 3, 8]],
      [[10, 10, 12, 3], [11, 9, 9, 30, 3]],
      [[0, 0, 1, 7, 7, 7], [0, 2, 2, 7]],
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0.5, 1.5, 2.5, 11, 12, 13, 14, 15, 16, 17]],
    ]
    for (const [before, after] of cases) expect(rankTest(before, after)).toEqual(bruteForce(before, after))
  })
})

describe('mean6 and median', () => {
  it('round the mean to six decimals and take the middle value', () => {
    expect(mean6([1, 2, 2])).toBe(1.666667)
    expect(mean6([])).toBe(0)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('evaluateCheck', () => {
  it('calls a lower later cohort improved only beyond chance', () => {
    const check = evaluateCheck({ metric: 'avgToolCalls', comparison: 'decreased' }, [10, 12, 11, 13], [2, 3, 1])
    expect(check).toMatchObject({ name: 'avgToolCalls decreased', before: 11.5, after: 2, beforeMedian: 11.5, afterMedian: 2, verdict: 'improved' })
    expect(check.pLower).toBe(0.028571)
    expect(check.evidence).toBe('avgToolCalls: 11.5 → 2 (median 11.5 → 2; exact rank test p=0.028571; improved)')
  })

  it('keeps an indistinguishable decrease within noise', () => {
    expect(evaluateCheck({ metric: 'avgToolCalls', comparison: 'decreased' }, [3, 4, 5], [4, 3, 5]).verdict).toBe('within-noise')
  })

  it('names a significant move the wrong way a regression', () => {
    expect(evaluateCheck({ metric: 'avgToolCalls', comparison: 'decreased' }, [1, 2, 3], [10, 11, 12]).verdict).toBe('regressed')
    expect(evaluateCheck({ metric: 'avgToolErrors', comparison: 'not-increased' }, [1, 2, 3], [10, 11, 12]).verdict).toBe('regressed')
    expect(evaluateCheck({ metric: 'avgToolCalls', comparison: 'increased' }, [10, 11, 12], [1, 2, 3]).verdict).toBe('regressed')
  })

  it('lets a guard hold when nothing moved beyond chance', () => {
    expect(evaluateCheck({ metric: 'avgToolErrors', comparison: 'not-increased' }, [5, 6, 7], [6, 5, 7]).verdict).toBe('held')
    expect(evaluateCheck({ metric: 'avgActiveMs', comparison: 'not-decreased' }, [5, 6, 7], [6, 5, 7]).verdict).toBe('held')
    expect(evaluateCheck({ metric: 'avgContextPeak', comparison: 'equal' }, [5, 6, 7], [5, 6, 7]).verdict).toBe('held')
  })

  it('reports an equal check that moved as changed, using the two-sided p', () => {
    const check = evaluateCheck({ metric: 'avgContextPeak', comparison: 'equal' }, [10, 11, 12, 13], [1, 2, 3, 4])
    expect(check.verdict).toBe('changed')
    expect(check.evidence).toContain('p=0.028572') // 2 x the stored one-sided 0.014286: re-gradable from the receipt
  })

  it('handles all-zero metrics without NaN', () => {
    const decreased = evaluateCheck({ metric: 'avgInterruptions', comparison: 'decreased' }, [0, 0, 0], [0, 0, 0])
    const guard = evaluateCheck({ metric: 'avgInterruptions', comparison: 'not-increased' }, [0, 0, 0], [0, 0, 0])
    expect(decreased.verdict).toBe('within-noise')
    expect(guard.verdict).toBe('held')
    for (const value of [decreased.before, decreased.after, decreased.pLower, decreased.pHigher, decreased.beforeMedian]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('an increase that clears chance is improved', () => {
    expect(evaluateCheck({ metric: 'avgToolCalls', comparison: 'increased' }, [1, 2, 3], [10, 11, 12]).verdict).toBe('improved')
  })
})

describe('checkVerdict', () => {
  it('is the single rule evaluateCheck applies, so stored numbers can be re-graded', () => {
    expect(checkVerdict('decreased', 11.5, 2, 0.028571, 1)).toBe('improved')
    expect(checkVerdict('decreased', 11.5, 2, 0.4, 1)).toBe('within-noise')
    expect(checkVerdict('decreased', 2, 3, 0.9, 0.05)).toBe('regressed')
    expect(checkVerdict('not-increased', 2, 3, 0.9, 0.2)).toBe('held')
    expect(checkVerdict('equal', 2, 3, 0.02, 0.99)).toBe('changed')
    expect(checkVerdict('equal', 2, 3, 0.03, 0.99)).toBe('held')
  })
})

describe('overallVerdict', () => {
  const check = (comparison: CohortCheckResult['comparison'], verdict: CohortCheckResult['verdict']): CohortCheckResult => ({
    metric: 'avgToolCalls',
    comparison,
    name: `avgToolCalls ${comparison}`,
    before: 1,
    after: 1,
    beforeMedian: 1,
    afterMedian: 1,
    pLower: 1,
    pHigher: 1,
    verdict,
    evidence: 'x',
  })

  it('needs at least three sessions on each side before anything else', () => {
    expect(overallVerdict([check('decreased', 'regressed')], 2, 5)).toBe('not-enough-sessions')
    expect(overallVerdict([check('decreased', 'improved')], 5, 2)).toBe('not-enough-sessions')
  })

  it('reports any regression or changed equal check as regressed', () => {
    expect(overallVerdict([check('decreased', 'improved'), check('not-increased', 'regressed')], 3, 3)).toBe('regressed')
    expect(overallVerdict([check('decreased', 'improved'), check('equal', 'changed')], 3, 3)).toBe('regressed')
  })

  it('cannot verify guards alone', () => {
    expect(overallVerdict([check('not-increased', 'held'), check('equal', 'held')], 3, 3)).toBe('no-directional-check')
  })

  it('requires every directional check to clear noise', () => {
    expect(overallVerdict([check('decreased', 'improved'), check('increased', 'within-noise')], 3, 3)).toBe('within-noise')
    expect(overallVerdict([check('decreased', 'improved'), check('increased', 'improved'), check('not-increased', 'held')], 3, 3)).toBe('verified')
  })
})
