/**
 * Fixture applied changes for the history and lesson reads: 1 record for each tag of the History section, each verdict
 * built by the store's own patch on a measured cohort, so the trust policy grades it again on the read. For the client
 * tests and the fixture store of the browser checks. No transcript and no real path.
 */
import { measureCohortEffect, outcomePatch, verificationPatch, type CohortCandidate, type CohortDeps } from '../../src/suggest/cohort.js'
import { buildHistory, buildLessonRead, type ChangeRow, type LessonRead } from '../../src/suggest/lessons.js'
import type { SuggestionViewRecord } from '../../src/model/app-data.js'
import type { SuggestionRecord } from '../../src/suggest/types.js'
import { isTrustedComputedVerification, verificationReceiptSummary } from '../../src/suggest/verification-policy.js'
import { APPLIED_AT, DECREASED, WORKSPACE, appliedOf, metricsOf, proposalOf, sg, uuid } from './suggestion-records.js'

/** Cohort loaders over later sessions in `cwd`, 1 for each tool-call value, each settled (as src/suggest/lessons.test.ts). */
function laterDeps(values: number[], cwd: string): CohortDeps {
  const sessions = values.map((toolCalls, index) => ({ id: uuid(100 + index), startedAt: APPLIED_AT + 1_000 + index * 1_000, endedAt: APPLIED_AT + 2_000 + index * 1_000, toolCalls }))
  return {
    async listCandidates(): Promise<CohortCandidate[]> {
      return sessions.map((s) => ({ sessionId: s.id, path: `/c/${s.id}.jsonl`, mtimeMs: s.endedAt }))
    },
    async loadCandidate(candidate) {
      const s = sessions.find((x) => x.id === candidate.sessionId)!
      return { session: { id: s.id, path: candidate.path, cwd, ranOrangu: false, startedAt: s.startedAt, endedAt: s.endedAt, metrics: metricsOf(s.toolCalls) }, bytesRead: 1_000 }
    },
    async canonicalWorkspace() {
      return cwd
    },
  }
}

/** 10 later sessions as quiet as the baseline of 3, and 10 that make twice the tool calls. */
const SAME = [10, 11, 12, 10, 11, 12, 10, 11, 12, 11]
const MORE = [20, 21, 22, 20, 21, 22, 20, 21, 22, 21]

/** A verified record that the trust policy accepts: the store's own patch on a measured win. */
export async function verifiedOf(id: string, over: Partial<SuggestionRecord> = {}, cwd = WORKSPACE): Promise<SuggestionRecord> {
  const applied = appliedOf(id, { proposal: proposalOf(cwd), ...over })
  const patch = verificationPatch(await measureCohortEffect(applied, [], laterDeps([1, 2, 3], cwd)))
  return { ...applied, ...patch, verificationTrust: 'computed-v2', status: 'verified', statusAt: APPLIED_AT + 50_000, ...over }
}

/** A record with its outcome receipt on the complete later sessions: `unproven` when they match the baseline, else `regressed` or `kept`. */
export async function outcomeOf(id: string, status: 'unproven' | 'regressed' | 'kept', over: Partial<SuggestionRecord> = {}, cwd = WORKSPACE): Promise<SuggestionRecord> {
  const applied = appliedOf(id, { proposal: proposalOf(cwd), ...over })
  const patch = outcomePatch(await measureCohortEffect(applied, [], laterDeps(status === 'unproven' ? SAME : MORE, cwd)))
  return { ...applied, ...patch, status, statusAt: APPLIED_AT + 60_000, ...over }
}

/**
 * 1 applied change for each tag of the History section, in `cwd`: verified, not verified under the current contract,
 * not shown beyond chance, regressed, kept after a regression, dismissed after apply with a reason, and waiting. The
 * titles stand for the stored titles of real findings.
 */
export async function historyRecords(cwd = WORKSPACE): Promise<SuggestionRecord[]> {
  const proposal = proposalOf(cwd)
  return [
    await verifiedOf(sg(0xc1), { ruleId: 'tool-errors', title: 'Run the type check before each commit' }, cwd),
    appliedOf(sg(0xc2), { proposal, ruleId: 'tool-errors', status: 'verified', statusAt: APPLIED_AT + 40_000, title: 'Read the test output before a retry' }),
    await outcomeOf(sg(0xc3), 'unproven', { ruleId: 'repeated-commands', title: 'Keep one test command for the whole repository' }, cwd),
    await outcomeOf(sg(0xc4), 'regressed', { ruleId: 'repeated-commands', title: 'Stop a retry after 2 failed calls' }, cwd),
    await outcomeOf(sg(0xc5), 'kept', { ruleId: 'unverified-edits', title: 'Run the failed test alone before the full suite' }, cwd),
    appliedOf(sg(0xc6), { proposal, ruleId: 'unverified-edits', status: 'rejected', reasonCode: 'wrong-cause', statusAt: APPLIED_AT + 30_000, title: 'Name the goal of the session in the first prompt' }),
    appliedOf(sg(0xc7), { proposal, ruleId: 'context-near-limit', title: 'Keep the context small with a short project file' }),
  ]
}

/**
 * A verified record of the earlier receipt form that the trust policy still accepts: a session comparison over 3 later
 * sessions. The form keeps no earlier sessions and no p-value.
 */
export function earlierVerifiedOf(id: string, cwd = WORKSPACE): SuggestionRecord {
  const later = [uuid(100), uuid(101), uuid(102)]
  return {
    ...appliedOf(id, { scope: 'session', proposal: proposalOf(cwd, [DECREASED]), title: 'Read the test output before a retry' }),
    status: 'verified',
    statusAt: APPLIED_AT + 45_000,
    verificationTrust: 'computed-v1',
    verificationReceipt: {
      v: 1,
      summary: verificationReceiptSummary([DECREASED]),
      measuredSessionIds: later,
      checks: [{ name: 'avgToolCalls decreased', metric: 'avgToolCalls', comparison: 'decreased', before: 11, after: 2, evidence: 'avgToolCalls: 11 → 2 (decreased)', ok: true }],
      receiptPath: '/p/a.verified.json',
    },
    effect: { before: { avgToolCalls: 11 }, after: { avgToolCalls: 2 }, measuredSessionIds: later },
  }
}

/** The app record and the history row of `earlierVerifiedOf`, as the server builds the row and marks the record. */
export function earlierFormFixture(): { record: SuggestionViewRecord; row: ChangeRow } {
  const record = earlierVerifiedOf(sg(0xc8))
  const scope = { workspace: { cwd: WORKSPACE, sessionIds: [uuid(900)] } }
  return {
    record: { ...record, verificationTrusted: isTrustedComputedVerification(record) ? true : undefined },
    row: buildHistory({ records: [record], lines: [record], scope })[0]!,
  }
}

/**
 * The history and the lesson read of `historyRecords` for the workspace, as the server builds them, and the records as
 * the app gets them: each with the trust mark of the serve route (publicSuggestion, src/serve/api.ts).
 */
export async function historyFixture(): Promise<{ records: SuggestionViewRecord[]; history: ChangeRow[]; lessons: LessonRead }> {
  const records = await historyRecords()
  const scope = { workspace: { cwd: WORKSPACE, sessionIds: [uuid(900)] } }
  return {
    records: records.map((record) => ({ ...record, verificationTrusted: isTrustedComputedVerification(record) ? true : undefined })),
    history: buildHistory({ records, lines: records, scope }),
    lessons: buildLessonRead({ records, lines: records, scope, maxBytes: null }),
  }
}
