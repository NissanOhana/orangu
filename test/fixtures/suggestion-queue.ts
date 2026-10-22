/**
 * A fixture queue with an item in each of the 6 groups, a folded review item, an earlier record, a deferred check and
 * a long title, for the queue text: its fit tests and the rendered terminal row of the STE gate. The titles stand for
 * the stored titles of real findings, so each one is a clean STE sentence.
 */
import { buildQueue, type QueueCheck, type SuggestionQueue } from '../../src/suggest/queue.js'
import type { SuggestionRecord } from '../../src/suggest/types.js'
import { APPLIED_AT, NOW, WORKSPACE, appliedOf, proposalOf, recordOf, sg, uuid } from './suggestion-records.js'

/** 3 sessions before the change and 4 quiet ones after it, as discovery lists the file times. */
const TIMES = [APPLIED_AT - 3_000, APPLIED_AT - 2_000, APPLIED_AT - 1_000, APPLIED_AT + 1_000, APPLIED_AT + 2_000, APPLIED_AT + 3_000, APPLIED_AT + 4_000]

/** The records of the fixture queue, 1 or more for each group, and 1 closed record that is an earlier record. */
export function queueFixtureRecords(): SuggestionRecord[] {
  return [
    appliedOf(sg(1), { ruleId: 'tool-errors', title: 'Run the type check before each commit, so the same tool error does not come back' }),
    appliedOf(sg(2), { ruleId: 'repeated-commands', status: 'regressed', statusAt: APPLIED_AT + 5_000, title: 'Stop a retry after 2 failed calls' }),
    recordOf(sg(3), { ruleId: 'context-near-limit', status: 'proposed', statusAt: APPLIED_AT + 4_000, proposal: proposalOf(), title: 'Keep the context small with a short project file' }),
    recordOf(sg(4), { title: 'Read each file once, then keep it in context', statusAt: APPLIED_AT + 3_000 }),
    recordOf(sg(5), { title: 'Read each file once, then keep it in context', status: 'failed', statusAt: APPLIED_AT + 2_000, cohortFingerprint: 'aaaaaaaaaaaaaaaa' }),
    recordOf(sg(6), { ruleId: 'cache-ttl-churn', status: 'kicked-off', statusAt: NOW - 3 * 60 * 60_000, title: 'Keep the cache warm between turns' }),
    appliedOf(sg(7), { ruleId: 'unverified-edits', title: 'Run the failed test alone before the full suite' }),
    appliedOf(sg(8), { ruleId: 'interruptions', title: 'Name the goal of the session in the first prompt' }),
    recordOf(sg(9), { status: 'rejected', statusAt: APPLIED_AT - 30_000, reasonCode: 'not-wanted', title: 'Read each file once' }),
  ]
}

/** The queue check of each applied record of the fixture: due, not due yet, and past the byte budget of the read. */
export function queueFixtureChecks(): Record<string, QueueCheck> {
  return {
    [sg(1)]: { check: 'ran', checkpoint: 'first', verdict: 'verified', final: true, baseline: 3 },
    [sg(7)]: { check: 'ran', checkpoint: 'first', verdict: 'within-noise', final: false, baseline: 3 },
    [sg(8)]: { check: 'deferred' },
  }
}

/** The fixture queue of 1 workspace, or of every workspace. */
export function queueFixture(scope: 'workspace' | 'all' = 'workspace'): SuggestionQueue {
  const records = queueFixtureRecords()
  const discovered = Object.fromEntries(records.filter((record) => record.status === 'applied').map((record) => [record.id, TIMES]))
  return buildQueue({
    now: NOW,
    ...(scope === 'workspace' ? { workspace: { cwd: WORKSPACE, sessionIds: [uuid(900)] } } : {}),
    records,
    lines: records,
    checks: queueFixtureChecks(),
    discovered,
  })
}

/** The queue of a workspace with no open record. */
export function emptyQueueFixture(): SuggestionQueue {
  return buildQueue({ now: NOW, workspace: { cwd: WORKSPACE, sessionIds: [uuid(900)] }, records: [], lines: [] })
}
