/**
 * The reason codes of a rejection, and 1 browser-facing label for each code.
 *
 * A code is a stored contract: each rejected record keeps its code on disk, so a renamed code orphans every record
 * that stores it. A copy rewrite may change a label. It never changes, removes or reorders a code. A new code is
 * additive.
 */
export const REJECT_REASON_CODES = ['not-wanted', 'already-handled', 'wrong-cause', 'too-much-effort', 'other'] as const
export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number]

export const REJECT_REASON_LABELS: Readonly<Record<RejectReasonCode, string>> = {
  'not-wanted': 'I do not want this change',
  'already-handled': 'It is already handled',
  'wrong-cause': 'The cause is somewhere else',
  'too-much-effort': 'It takes too much effort',
  other: 'Other reason',
}
