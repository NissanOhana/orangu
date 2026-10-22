/**
 * The reasons why a cohort skips a session.
 *
 * This module has no import, so the suggestion contract (`types.ts`) reads the type with no node module in its
 * import closure. The god type-check reads that contract with no node types. A frozen baseline stores a count for
 * each reason.
 */
export const COHORT_SKIP_REASONS = [
  'evidence-session',
  'orangu-session',
  'spans-application',
  'still-settling',
  'other-workspace',
  'over-budget',
  'budget-spent',
  'unreadable',
] as const
export type CohortSkipReason = (typeof COHORT_SKIP_REASONS)[number]
