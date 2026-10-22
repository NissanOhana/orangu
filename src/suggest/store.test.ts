import { describe, it, expect, beforeEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SuggestionStore } from './store.js'
import { suggestionId, suggestionIdV2, suggestionKey } from './id.js'
import { COHORT_SKIP_REASONS, type CohortSkipReason } from './cohort.js'
import { evaluateCheck, overallVerdict } from './cohort-stats.js'
import { REJECT_REASON_CODES } from './reason-codes.js'
import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  TRANSITIONS,
  type Finding,
  type SuggestionApplicationReceipt,
  type SuggestionCohortCheck,
  type SuggestionFrozenBaseline,
  type SuggestionOutcomeCheck,
  type SuggestionOutcomeReceipt,
  type SuggestionProposal,
  type SuggestionRecord,
  type SuggestionStatus,
  type SuggestionStoreLike,
  type SuggestionVerificationIntent,
  type SuggestionVerificationMetric,
  type SuggestionVerificationReceiptV2,
} from './types.js'

interface StoreWorkerMessage {
  type: string
  ok?: boolean
  error?: string
}

function waitForWorkerMessage(child: ChildProcess, type: string, timeoutMs = 8_000): Promise<StoreWorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for child message ${type}`))
    }, timeoutMs)
    const onMessage = (value: unknown): void => {
      if (!value || typeof value !== 'object' || (value as StoreWorkerMessage).type !== type) return
      cleanup()
      resolve(value as StoreWorkerMessage)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(new Error(`child exited before ${type}: ${code ?? signal ?? 'unknown'}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function waitForWorkerExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'reread-files',
  title: 'The same file was re-read 14 times',
  scope: 'session',
  sessionIds: ['sess-b', 'sess-a'],
  evidence: { savingsTokens: 12_000, estimated: true },
  ...over,
})

function structuredProposal(id: string, files = ['src/a.ts']): SuggestionProposal {
  return {
    v: 1,
    title: 'Reviewed change',
    change: 'Change only reviewed files.',
    effort: 'S',
    files,
    proposalPath: join(home, 'proposals', `${id}.md`),
    manifestPath: join(home, 'proposals', `${id}.json`),
    changeClass: 'script-cli',
    evidence: 'A supported baseline exposed the issue.',
    expectedEffect: 'A later supported session improves.',
    risk: 'The change may need maintenance.',
    verification: 'Compare supported later sessions.',
    verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
  }
}

function applicationReceipt(id: string, files = ['src/a.ts']): SuggestionApplicationReceipt {
  return {
    v: 1,
    summary: 'Changed the reviewed files.',
    files,
    checks: [{ name: 'tests', ok: true }],
    receiptPath: join(home, 'proposals', `${id}.applied.json`),
  }
}

/** A hand-written v2 cohort receipt for the reviewed `avgToolCalls decreased` check (3 before, 3 after, perfect separation). */
function cohortPatch(
  appliedAt: number,
  check: Partial<SuggestionCohortCheck> = {},
  receipt: Partial<SuggestionVerificationReceiptV2> = {},
): { verificationReceipt: SuggestionVerificationReceiptV2; effect: NonNullable<SuggestionRecord['effect']> } {
  const graded: SuggestionCohortCheck = {
    metric: 'avgToolCalls',
    comparison: 'decreased',
    name: 'avgToolCalls decreased',
    before: 12,
    after: 8,
    beforeMedian: 12,
    afterMedian: 8,
    pLower: 0.05,
    pHigher: 1,
    verdict: 'improved',
    evidence: 'avgToolCalls: 12 → 8 (median 12 → 8; exact rank test p=0.05; improved)',
    ok: true,
    ...check,
  }
  const verificationReceipt: SuggestionVerificationReceiptV2 = {
    v: 2,
    method: 'cohort-rank-v1',
    alpha: 0.05,
    appliedAt,
    summary: `Later sessions beat the baseline beyond chance (3 before, 3 after, p ≤ 0.05): ${graded.name}.`,
    baselineSessionIds: ['b1', 'b2', 'b3'],
    measuredSessionIds: ['l1', 'l2', 'l3'],
    confoundedBy: [],
    checks: [graded],
    ...receipt,
  }
  return {
    verificationReceipt,
    effect: { before: { avgToolCalls: graded.before }, after: { avgToolCalls: graded.after }, measuredSessionIds: verificationReceipt.measuredSessionIds },
  }
}

/** A session id as the cohort loader stores it: a lowercase UUID. */
const sid = (n: number): string => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const TOOL_CALLS_DECREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'decreased' }

function sessionMetrics(value: number): Record<SuggestionVerificationMetric, number> {
  return Object.fromEntries(SUGGESTION_VERIFICATION_METRICS.map((metric) => [metric, value])) as Record<SuggestionVerificationMetric, number>
}

/** A frozen baseline with 1 session for each value, every session ended before `cutAt`. */
function frozenBaseline(cutAt: number, values: number[]): SuggestionFrozenBaseline {
  return {
    v: 1,
    cutAt,
    sessions: values.map((value, index) => ({ id: sid(index), startedAt: 10 + index, endedAt: 20 + index, metrics: sessionMetrics(value) })),
    skipped: Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>,
  }
}

/** An outcome receipt graded from the values of each side, with the baseline ids of `frozenBaseline`. */
function outcomeReceipt(
  appliedAt: number,
  before: number[],
  after: number[],
  over: Partial<SuggestionOutcomeReceipt> = {},
  intent: SuggestionVerificationIntent = TOOL_CALLS_DECREASED,
): SuggestionOutcomeReceipt {
  const graded = evaluateCheck(intent, before, after)
  const verdict = overallVerdict([graded], before.length, after.length)
  if (verdict === 'verified') throw new Error('these values verify: an outcome receipt never carries that verdict')
  const check: SuggestionOutcomeCheck = {
    metric: graded.metric,
    comparison: graded.comparison,
    name: graded.name,
    before: graded.before,
    after: graded.after,
    beforeMedian: graded.beforeMedian,
    afterMedian: graded.afterMedian,
    pLower: graded.pLower,
    pHigher: graded.pHigher,
    verdict: graded.verdict,
  }
  return {
    v: 1,
    method: 'cohort-rank-v1',
    alpha: 0.05,
    appliedAt,
    checkpoint: 'complete',
    verdict,
    laterComplete: true,
    confoundedBy: [],
    baselineSessionIds: before.map((_, index) => sid(index)),
    measuredSessionIds: after.map((_, index) => sid(100 + index)),
    checks: [check],
    ...over,
  }
}

/** Run a store call that must throw, and prove that the store file kept every byte. */
async function refusedUnchanged(attempt: () => Promise<unknown>, message: RegExp | string, label?: string): Promise<void> {
  const before = readFileSync(store.path)
  await expect(attempt(), label).rejects.toThrow(message)
  expect(readFileSync(store.path), label).toEqual(before)
}

/** A record moved to applied through the store, with 1 reviewed check. */
async function appliedRecord(
  over: { ruleId?: string; frozen?: SuggestionFrozenBaseline; intent?: SuggestionVerificationIntent; scope?: Finding['scope'] } = {},
): Promise<SuggestionRecord> {
  const scope = over.scope ?? 'session'
  const { record } = await store.upsertNew(
    finding({ ruleId: over.ruleId ?? 'outcome-rule', scope, ...(scope === 'session' ? {} : { cohortFingerprint: '3333333333333333' }) }),
    'report',
  )
  await store.transition(record.id, 'kicked-off')
  await store.transition(record.id, 'proposed', { proposal: { ...structuredProposal(record.id), verificationChecks: [over.intent ?? TOOL_CALLS_DECREASED] } })
  return store.transition(record.id, 'applied', { application: applicationReceipt(record.id), ...(over.frozen ? { frozenBaseline: over.frozen } : {}) })
}

let home: string
let clock: number
let store: SuggestionStore

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orangu-store-'))
  clock = 1_000
  store = new SuggestionStore({ home, now: () => ++clock })
})

describe('SuggestionStore', () => {
  it('creates a new record with a stable id regardless of session order', async () => {
    const a = await store.upsertNew(finding({ sessionIds: ['sess-b', 'sess-a'] }), 'report')
    const b = new SuggestionStore({ home: mkdtempSync(join(tmpdir(), 'orangu-store2-')), now: () => 99 })
    const other = await b.upsertNew(finding({ sessionIds: ['sess-a', 'sess-b'] }), 'report')
    expect(a.created).toBe(true)
    expect(a.record.id).toBe(other.record.id)
    expect(a.record.status).toBe('new')
    expect(a.record.v).toBe(2)
    expect(a.record.key).toEqual(suggestionKey(finding(), 'report'))
    expect(a.record.sessionIds).toEqual(['sess-a', 'sess-b'])
  })

  it('v2 scope and insight identity cannot collide', async () => {
    const session = await store.upsertNew(finding({ scope: 'session', insightId: 'i-1' }), 'report')
    const repo = await store.upsertNew(finding({ scope: 'repo', insightId: 'i-1', cohortFingerprint: '1111111111111111' }), 'report')
    const otherInsight = await store.upsertNew(finding({ scope: 'session', insightId: 'i-2' }), 'report')
    expect(new Set([session.record.id, repo.record.id, otherInsight.record.id]).size).toBe(3)
  })

  it('binds recurring records to the full aggregate cohort and disables lossy legacy ids', async () => {
    const firstFinding = finding({ scope: 'repo', cohortFingerprint: '1111111111111111' })
    const grownFinding = finding({ scope: 'repo', cohortFingerprint: '2222222222222222' })
    const first = await store.upsertNew(firstFinding, 'report')
    const grown = await store.upsertNew(grownFinding, 'report')
    expect(first.record.id).not.toBe(grown.record.id)
    expect(first.record.cohortFingerprint).toBe(firstFinding.cohortFingerprint)
    const lossyLegacy = suggestionId('report', firstFinding.ruleId, firstFinding.sessionIds)
    await expect(store.upsertNew(firstFinding, 'report', lossyLegacy)).rejects.toThrow(/identity mismatch/)
  })

  it('rejects secrets in canonical identity fields before hashing or persistence', async () => {
    await expect(store.upsertNew(finding({ ruleId: 'sk-ant-api03-abc123def456ghi789' }), 'report')).rejects.toThrow(/sensitive material/)
    await expect(store.upsertNew(finding({ sessionIds: ['sk-ant-api03-abc123def456ghi789'] }), 'report')).rejects.toThrow(/sensitive material/)
    expect(existsSync(join(home, 'suggestions.jsonl'))).toBe(false)
  })

  it('is append-only: every mutation adds a line and the last line per id wins', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off', { kickoff: { mode: 'serve', command: 'claude "/orangu:suggest x"' } })
    await store.transition(record.id, 'proposed', { proposal: { title: 't', change: 'c', effort: 'S', proposalPath: join(home, 'proposals', record.id + '.md') } })
    const lines = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const current = await store.get(record.id)
    expect(current!.status).toBe('proposed')
    expect(current!.kickoff?.mode).toBe('serve')
    expect(current!.proposal?.effort).toBe('S')
  })

  it('separates an unterminated crash-tail before appending and replays the next transition', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    appendFileSync(store.path, '{"crash_partial":')

    const kicked = await store.transition(record.id, 'kicked-off')
    expect(kicked.status).toBe('kicked-off')
    const lines = readFileSync(store.path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('{"crash_partial":')
    expect(JSON.parse(lines[0]!).status).toBe('new')
    expect(JSON.parse(lines[2]!).status).toBe('kicked-off')

    const fresh = new SuggestionStore({ home, now: () => 9_000 })
    await expect(fresh.get(record.id)).resolves.toMatchObject({ status: 'kicked-off' })
  })

  it('re-click refreshes a new finding but preserves a lifecycle transition timestamp', async () => {
    const first = await store.upsertNew(finding(), 'report')
    const refreshedFinding = finding({ title: 'Updated live finding', evidence: { estimated: true, sessions: 4, live: true } })
    const refreshed = await store.upsertNew(refreshedFinding, 'report')
    expect(refreshed.record.statusAt).toBeGreaterThan(first.record.statusAt)
    expect(refreshed.record.title).toBe('Updated live finding')
    expect(refreshed.record.evidence).toEqual({ estimated: true, sessions: 4, live: true })
    await store.transition(first.record.id, 'kicked-off')
    const transitionedAt = (await store.get(first.record.id))!.statusAt
    const again = await store.upsertNew(finding({ title: 'Must not replace started work', evidence: { estimated: true, sessions: 99 } }), 'report')
    expect(again.created).toBe(false)
    expect(again.record.status).toBe('kicked-off')
    expect(again.record.createdAt).toBe(first.record.createdAt)
    expect(again.record.statusAt).toBe(transitionedAt)
    expect(again.record.title).toBe('Updated live finding')
    expect(again.record.evidence).toEqual({ estimated: true, sessions: 4, live: true })
  })

  it('an identical re-upsert of a new record appends nothing (orangu report twice = one line)', async () => {
    const first = await store.upsertNew(finding(), 'report')
    expect(first.created).toBe(true)
    // same title, same evidence entries in another key order: still the same finding
    const again = await store.upsertNew(finding({ evidence: { estimated: true, savingsTokens: 12_000 } }), 'report')
    expect(again.created).toBe(false)
    expect(again.record).toEqual(first.record)
    expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(1)
    // a changed title still refreshes (and appends)
    const changed = await store.upsertNew(finding({ title: 'Read 15 times now' }), 'report')
    expect(changed.record.title).toBe('Read 15 times now')
    expect(changed.record.statusAt).toBeGreaterThan(first.record.statusAt)
    expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('throws on illegal transitions (new → verified) and unknown ids', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await expect(store.transition(record.id, 'verified')).rejects.toThrow(/illegal transition new → verified/)
    await expect(store.transition('sg_nope', 'rejected')).rejects.toThrow(/not found/)
  })

  it('rejected is terminal; failed can be re-kicked', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'failed', { kickoff: { mode: 'serve', command: 'x', exitCode: 1 } })
    const rekicked = await store.transition(record.id, 'kicked-off')
    expect(rekicked.status).toBe('kicked-off')
    await store.transition(record.id, 'rejected')
    await expect(store.transition(record.id, 'kicked-off')).rejects.toThrow(/illegal/)
  })

  it('skips corrupt lines and keeps going', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    appendFileSync(join(home, 'suggestions.jsonl'), '{ this is not json\n')
    appendFileSync(join(home, 'suggestions.jsonl'), JSON.stringify({ ...record, id: '$(untrusted)', status: 'new' }) + '\n')
    await store.transition(record.id, 'kicked-off')
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('kicked-off')
  })

  it('skips structurally malformed records before indexing legacy ids', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    appendFileSync(store.path, JSON.stringify({ ...record, legacyIds: 1, statusAt: record.statusAt + 1 }) + '\n')

    await expect(store.all()).resolves.toEqual([record])
    await expect(store.transition(record.id, 'kicked-off')).resolves.toMatchObject({ status: 'kicked-off' })
  })

  it('upsertNew honours only the matching legacy report id (file-mode kickoff parity)', async () => {
    const legacyId = suggestionId('report', finding().ruleId, finding().sessionIds)
    const first = await store.upsertNew(finding(), 'report', legacyId)
    expect(first.created).toBe(true)
    expect(first.record.id).toBe(legacyId)
    expect(first.record.v).toBe(1)
    const again = await store.upsertNew(finding(), 'report', legacyId)
    expect(again.created).toBe(false)
    expect(again.record.id).toBe(legacyId)
    await expect(store.upsertNew(finding(), 'report', 'sg_0123456789ab')).rejects.toThrow(/identity mismatch/)
    await expect(store.upsertNew(finding(), 'skill', legacyId)).rejects.toThrow(/identity mismatch/)
  })

  it('migrates a matching v1 record to v2 without losing lifecycle state and keeps the old id addressable', async () => {
    const f = finding()
    const oldId = suggestionId('report', f.ruleId, f.sessionIds)
    const proposal = { title: 'Existing proposal', change: 'Keep this', effort: 'S' as const, proposalPath: join(home, 'proposals', `${oldId}.md`) }
    const legacy: SuggestionRecord = {
      id: oldId,
      v: 1,
      createdAt: 10,
      source: 'report',
      scope: f.scope,
      sessionIds: [...f.sessionIds].sort(),
      ruleId: f.ruleId,
      title: 'Lossy legacy title',
      evidence: { estimated: true },
      proposal,
      status: 'proposed',
      statusAt: 20,
    }
    appendFileSync(join(home, 'suggestions.jsonl'), JSON.stringify(legacy) + '\n')

    const migrated = await store.upsertNew(f, 'report')
    const expectedId = suggestionIdV2(suggestionKey(f, 'report'))
    expect(migrated.created).toBe(false)
    expect(migrated.record).toMatchObject({ id: expectedId, v: 2, status: 'proposed', proposal, title: f.title, evidence: f.evidence })
    expect(migrated.record.statusAt).toBe(20)
    expect(migrated.record.legacyIds).toContain(oldId)
    expect((await store.get(oldId))?.id).toBe(expectedId)
    expect((await store.all()).map((r) => r.id)).toEqual([expectedId])

    await expect(store.transition(oldId, 'applied')).rejects.toThrow(/structured proposal/)
    const rejected = await store.transition(oldId, 'rejected')
    expect(rejected.id).toBe(expectedId)
    expect((await store.get(oldId))?.status).toBe('rejected')
  })

  it('does not migrate a v1 scope collision into a different v2 finding', async () => {
    const sessionFinding = finding({ scope: 'session' })
    const legacyId = suggestionId('report', sessionFinding.ruleId, sessionFinding.sessionIds)
    await store.upsertNew(sessionFinding, 'report', legacyId)
    await store.transition(legacyId, 'rejected')

    const repoFinding = finding({ scope: 'repo', cohortFingerprint: '1111111111111111' })
    const repo = await store.upsertNew(repoFinding, 'report')
    expect(repo.created).toBe(true)
    expect(repo.record.status).toBe('new')
    expect(repo.record.id).not.toBe(legacyId)
    expect((await store.get(legacyId))?.status).toBe('rejected')
    expect(await store.all()).toHaveLength(2)
  })

  it('honours ORANGU_HOME layout: suggestions.jsonl + proposals/ under home', async () => {
    await store.upsertNew(finding(), 'skill')
    expect(store.path).toBe(join(home, 'suggestions.jsonl'))
    expect(store.proposalsDir).toBe(join(home, 'proposals'))
  })

  it('checks every existing-record identity field before refreshing it', async () => {
    const f = finding({ insightId: 'expected-insight' })
    const mismatches: Array<[string, Partial<SuggestionRecord>]> = [
      ['source', { source: 'skill' }],
      ['scope', { scope: 'global' }],
      ['rule', { ruleId: 'other-rule' }],
      ['sessions', { sessionIds: ['other-session'] }],
      ['insight', { insightId: 'other-insight' }],
    ]
    for (const [label, mismatch] of mismatches) {
      const isolatedHome = mkdtempSync(join(tmpdir(), `orangu-identity-${label}-`))
      const isolatedStore = new SuggestionStore({ home: isolatedHome, now: () => 99 })
      const id = suggestionIdV2(suggestionKey(f, 'report'))
      const hijacked: SuggestionRecord = {
        id,
        v: 2,
        key: suggestionKey(f, 'report'),
        createdAt: 10,
        source: 'report',
        scope: f.scope,
        sessionIds: f.sessionIds,
        ruleId: f.ruleId,
        title: 'Attacker-controlled record',
        insightId: f.insightId,
        evidence: { estimated: true },
        status: 'new',
        statusAt: 20,
        ...mismatch,
      }
      appendFileSync(join(isolatedHome, 'suggestions.jsonl'), JSON.stringify(hijacked) + '\n')

      await expect(isolatedStore.upsertNew(f, 'report'), label).rejects.toThrow(/belongs to a different finding/)
      const lines = readFileSync(join(isolatedHome, 'suggestions.jsonl'), 'utf8').trim().split('\n')
      expect(lines, label).toHaveLength(1)
      expect(JSON.parse(lines[0]!).statusAt, label).toBe(20)
    }
  })

  it('rejects unsafe Windows aliases and missing or duplicate verification plans at the store boundary', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    for (const unsafe of [
      'src/file.',
      'src/file ',
      'src/data:stream',
      'src/.git.',
      'src/CON',
      'src/prn.txt',
      'src/COM1.log',
      'src/LPT9',
      'src//a.ts',
      'src/./a.ts',
      './src/a.ts',
      'src/a.ts/',
      'src/a\n.ts',
      'src\\a.ts',
    ]) {
      await expect(
        store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id, [unsafe]) }),
        unsafe,
      ).rejects.toThrow(/structured proposal/)
    }

    const missingChecks = structuredProposal(record.id)
    delete missingChecks.verificationChecks
    await expect(store.transition(record.id, 'proposed', { proposal: missingChecks })).rejects.toThrow(/verificationChecks/)
    await expect(
      store.transition(record.id, 'proposed', {
        proposal: {
          ...structuredProposal(record.id),
          verificationChecks: [
            { metric: 'avgToolCalls', comparison: 'decreased' },
            { metric: 'avgToolCalls', comparison: 'decreased' },
          ],
        },
      }),
    ).rejects.toThrow(/verificationChecks/)
    await expect(
      store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id, ['SRC/a.ts', 'src/a.ts']) }),
    ).rejects.toThrow(/structured proposal/)
  })

  it('accepts only canonical catalog/research/inference provenance at the store boundary', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    const spoofed = structuredProposal(record.id)
    spoofed.sources = [
      {
        kind: 'catalog',
        label: 'catalog: fix-reread-files',
        url: 'https://evil.example/source',
        verifiedAt: '2026-08-23',
      },
    ]
    await expect(store.transition(record.id, 'proposed', { proposal: spoofed })).rejects.toThrow(/structured proposal/)

    const canonical = structuredProposal(record.id)
    canonical.sources = [
      {
        kind: 'catalog',
        label: 'catalog: fix-reread-files',
        url: 'https://code.claude.com/docs/en/memory.md',
        verifiedAt: '2026-08-23',
      },
      { kind: 'research', label: 'Checked guide', url: 'https://example.com/guide', verifiedAt: '2026-08-26' },
      { kind: 'inference', label: 'Reasoned from bounded evidence' },
    ]
    await expect(store.transition(record.id, 'proposed', { proposal: canonical })).resolves.toMatchObject({ status: 'proposed' })
  })

  it('enforces global apply and aggregate verification scope contracts in direct store use', async () => {
    const global = await store.upsertNew(finding({ scope: 'global', cohortFingerprint: '1111111111111111' }), 'report')
    await store.transition(global.record.id, 'kicked-off')
    await store.transition(global.record.id, 'proposed', { proposal: structuredProposal(global.record.id) })
    await expect(
      store.transition(global.record.id, 'applied', { application: applicationReceipt(global.record.id) }),
    ).rejects.toThrow(/global suggestions cannot be applied\. For a concrete change, create a repo or session suggestion instead\./)

    const repo = await store.upsertNew(finding({ scope: 'repo', cohortFingerprint: '2222222222222222' }), 'report')
    await store.transition(repo.record.id, 'kicked-off')
    await store.transition(repo.record.id, 'proposed', { proposal: structuredProposal(repo.record.id) })
    await store.transition(repo.record.id, 'applied', { application: applicationReceipt(repo.record.id) })
    // Repo scope now verifies through the same computed cohort receipt as session scope.
    await expect(store.transition(repo.record.id, 'verified')).rejects.toThrow(/verification receipt is required/)
    const appliedAt = (await store.get(repo.record.id))!.appliedAt!
    const verified = await store.transition(repo.record.id, 'verified', cohortPatch(appliedAt))
    expect(verified.verificationTrust).toBe('computed-v2')

    // A hand-written applied global line still cannot become verified.
    const globalApplied: SuggestionRecord = { ...(await store.get(global.record.id))!, status: 'applied', application: applicationReceipt(global.record.id), statusAt: 50 }
    appendFileSync(join(home, 'suggestions.jsonl'), `${JSON.stringify(globalApplied)}\n`)
    await expect(store.transition(global.record.id, 'verified', cohortPatch(50))).rejects.toThrow(/global suggestions cannot be verified\. They are review-only\./)
  })

  it('accepts a workspace with a creation time and rejects a malformed one', async () => {
    const { record } = await store.upsertNew(finding({ ruleId: 'workspace-birth' }), 'report')
    await store.transition(record.id, 'kicked-off')
    const proposal = structuredProposal(record.id)
    await expect(
      store.transition(record.id, 'proposed', { proposal: { ...proposal, workspace: { ...proposal.workspace!, birthtimeNs: 'soon' } } }),
    ).rejects.toThrow(/structured proposal/)
    const withBirth = { ...proposal.workspace!, birthtimeNs: '1755000000000000000' }
    const proposed = await store.transition(record.id, 'proposed', { proposal: { ...proposal, workspace: withBirth } })
    expect(proposed.proposal?.workspace).toEqual(withBirth)
  })

  it('stamps appliedAt on application and carries it forward', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    const applied = await store.transition(record.id, 'applied', { application: applicationReceipt(record.id) })
    expect(applied.appliedAt).toBe(applied.statusAt)
    const rejected = await store.transition(record.id, 'rejected')
    expect(rejected.appliedAt).toBe(applied.statusAt)
    expect((await store.get(record.id))!.appliedAt).toBe(applied.statusAt)
  })

  it('accepts only a complete, noise-cleared v2 cohort receipt', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    const { appliedAt } = await store.transition(record.id, 'applied', { application: applicationReceipt(record.id) })
    const ok = cohortPatch(appliedAt!)
    const legacyShape = {
      verificationReceipt: {
        v: 1 as const,
        summary: 'Later-session comparison passed: avgToolCalls decreased.',
        measuredSessionIds: ['later-session'],
        checks: [{ name: 'avgToolCalls decreased', metric: 'avgToolCalls' as const, comparison: 'decreased' as const, before: 12, after: 8, evidence: 'avgToolCalls: 12 → 8 (decreased)', ok: true as const }],
        receiptPath: join(home, 'proposals', `${record.id}.verified.json`),
      },
      effect: { before: { avgToolCalls: 12 }, after: { avgToolCalls: 8 }, measuredSessionIds: ['later-session'] },
    }
    await expect(store.transition(record.id, 'verified', legacyShape)).rejects.toThrow(/must be computed by orangu \(v2 cohort receipt\)/)
    const withinNoise = cohortPatch(appliedAt!, { pLower: 0.4, verdict: 'within-noise' as never })
    await expect(store.transition(record.id, 'verified', withinNoise)).rejects.toThrow(/cohort receipt/)
    const twoBaseline = cohortPatch(appliedAt!, {}, { baselineSessionIds: ['b1', 'b2'] })
    await expect(store.transition(record.id, 'verified', twoBaseline)).rejects.toThrow(/cohort receipt/)
    const wrongSummary = cohortPatch(appliedAt!, {}, { summary: 'It worked.' })
    await expect(store.transition(record.id, 'verified', wrongSummary)).rejects.toThrow(/cohort receipt/)
    const wrongAppliedAt = cohortPatch(appliedAt! + 1)
    await expect(store.transition(record.id, 'verified', wrongAppliedAt)).rejects.toThrow(/cohort receipt/)
    await expect(
      store.transition(record.id, 'verified', { ...ok, effect: { ...ok.effect, after: { avgToolCalls: 1 } } }),
    ).rejects.toThrow(/must exactly match/)
    const verified = await store.transition(record.id, 'verified', ok)
    expect(verified.status).toBe('verified')
    expect(verified.verificationTrust).toBe('computed-v2')
    expect(verified.appliedAt).toBe(appliedAt)
  })

  it('accepts a receipt that names confounders only with the qualified summary', async () => {
    const { record } = await store.upsertNew(finding({ ruleId: 'confounded-change' }), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    const { appliedAt } = await store.transition(record.id, 'applied', { application: applicationReceipt(record.id) })
    const confoundedBy = ['sg_aaaaaaaaaaaa', 'sg_bbbbbbbbbbbb']
    const plainSummary = cohortPatch(appliedAt!).verificationReceipt.summary
    await expect(store.transition(record.id, 'verified', cohortPatch(appliedAt!, {}, { confoundedBy }))).rejects.toThrow(/summary must be the computed summary/)
    await expect(
      store.transition(record.id, 'verified', cohortPatch(appliedAt!, {}, { confoundedBy: ['sg_bbbbbbbbbbbb', 'sg_aaaaaaaaaaaa'] })),
    ).rejects.toThrow(/confoundedBy must be sorted unique suggestion ids/)
    const summary = `${plainSummary} Measured together with 2 other applied changes; not attributable to this change alone.`
    const verified = await store.transition(record.id, 'verified', cohortPatch(appliedAt!, {}, { confoundedBy, summary }))
    expect(verified.verificationTrust).toBe('computed-v2')
    expect(verified.verificationReceipt).toMatchObject({ v: 2, confoundedBy, summary })
  })

  it.skipIf(process.platform === 'win32')('hardens Orangu state directories and JSONL to private POSIX modes', async () => {
    await store.upsertNew(finding(), 'report')
    chmodSync(home, 0o777)
    chmodSync(store.proposalsDir, 0o777)
    chmodSync(store.path, 0o666)

    await store.all()

    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(store.proposalsDir).mode & 0o777).toBe(0o700)
    expect(statSync(store.path).mode & 0o777).toBe(0o600)

    chmodSync(home, 0o777)
    chmodSync(store.proposalsDir, 0o777)
    chmodSync(store.path, 0o666)
    await store.upsertNew(finding({ title: 'Refresh and harden' }), 'report')
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(store.proposalsDir).mode & 0o777).toBe(0o700)
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked state root without changing its target', async () => {
    const container = mkdtempSync(join(tmpdir(), 'orangu-store-root-link-'))
    const outside = join(container, 'outside')
    const linkedHome = join(container, 'linked-home')
    mkdirSync(outside, { mode: 0o755 })
    chmodSync(outside, 0o755)
    const marker = join(outside, 'keep.txt')
    writeFileSync(marker, 'outside bytes stay unchanged')
    symlinkSync(outside, linkedHome, 'dir')
    const before = readFileSync(marker)
    const beforeMode = statSync(outside).mode & 0o777

    const linked = new SuggestionStore({ home: linkedHome })
    await expect(linked.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store directory must be a real directory/)

    expect(readFileSync(marker)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(existsSync(join(outside, 'suggestions.jsonl'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked JSONL without changing its target bytes or mode', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'orangu-store-file-link-'))
    const outside = join(outsideDir, 'outside.jsonl')
    writeFileSync(outside, 'outside bytes stay unchanged\n')
    chmodSync(outside, 0o644)
    symlinkSync(outside, store.path)
    const before = readFileSync(outside)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(store.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store must not be a symbolic link/)

    expect(readFileSync(outside)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(lstatSync(store.path).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects a hard-linked JSONL without changing its target bytes or mode', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'orangu-store-file-hardlink-'))
    const outside = join(outsideDir, 'outside.jsonl')
    writeFileSync(outside, 'outside hard-link bytes stay unchanged\n')
    chmodSync(outside, 0o644)
    linkSync(outside, store.path)
    const before = readFileSync(outside)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(store.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store must have exactly one hard link/)

    expect(readFileSync(outside)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(statSync(outside).nlink).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked lock without changing its target', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orangu-store-lock-link-'))
    const marker = join(outside, 'keep.txt')
    writeFileSync(marker, 'outside lock bytes stay unchanged')
    chmodSync(outside, 0o755)
    const lock = `${store.path}.lock`
    symlinkSync(outside, lock, 'dir')
    const before = readFileSync(marker)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(store.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store lock must be a real directory/)

    expect(readFileSync(marker)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(lstatSync(lock).isSymbolicLink()).toBe(true)
  })

  it('rejects a non-regular or oversized suggestion store instead of replaying it', async () => {
    mkdirSync(store.path)
    await expect(store.all()).rejects.toThrow(/suggestion store must be a regular file/)

    const lockHome = mkdtempSync(join(tmpdir(), 'orangu-store-lock-file-'))
    const lockStore = new SuggestionStore({ home: lockHome })
    writeFileSync(`${lockStore.path}.lock`, 'not a directory')
    await expect(lockStore.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store lock must be a real directory/)

    const otherHome = mkdtempSync(join(tmpdir(), 'orangu-store-oversized-'))
    const oversized = new SuggestionStore({ home: otherHome })
    writeFileSync(oversized.path, '')
    truncateSync(oversized.path, 64 * 1024 * 1024 + 1)
    await expect(oversized.all()).rejects.toThrow(/suggestion store exceeds 67108864 bytes/)

    const tooManyLinesHome = mkdtempSync(join(tmpdir(), 'orangu-store-lines-'))
    const tooManyLines = new SuggestionStore({ home: tooManyLinesHome })
    writeFileSync(tooManyLines.path, Buffer.alloc(100_001, 0x0a))
    await expect(tooManyLines.all()).rejects.toThrow(/suggestion store exceeds 100000 lines/)

    const longRecordHome = mkdtempSync(join(tmpdir(), 'orangu-store-record-'))
    const longRecord = new SuggestionStore({ home: longRecordHome })
    writeFileSync(longRecord.path, '')
    truncateSync(longRecord.path, 4 * 1024 * 1024 + 1)
    await expect(longRecord.all()).rejects.toThrow(/suggestion store record exceeds 4194304 bytes/)
  })

  it('enforces lifecycle artifacts and rejects unrelated patch fields inside the lock', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    await expect(store.transition(record.id, 'proposed')).rejects.toThrow(/proposal is required/)
    await expect(
      store.transition(record.id, 'proposed', { kickoff: { mode: 'serve', command: 'not a proposal' } } as never),
    ).rejects.toThrow(/not valid for this transition/)

    const proposalPath = join(home, 'proposals', `${record.id}.md`)
    const manifestPath = join(home, 'proposals', `${record.id}.json`)
    await expect(
      store.transition(record.id, 'proposed', {
        proposal: {
          v: 1,
          title: 'Unsafe change',
          change: 'Modify repository metadata.',
          effort: 'S',
          files: ['.GiT/config'],
          proposalPath,
          manifestPath,
          changeClass: 'script-cli',
          evidence: 'Unsafe input.',
          expectedEffect: 'None.',
          risk: 'Repository compromise.',
          verification: 'Do not run.',
          verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        },
      }),
    ).rejects.toThrow(/structured proposal/)
    await store.transition(record.id, 'proposed', {
      proposal: {
        v: 1,
        title: 'Reviewed change',
        change: 'Change only the two named files.',
        effort: 'S',
        files: ['src/a.ts', 'src/b.ts'],
        proposalPath,
        manifestPath,
        changeClass: 'script-cli',
        evidence: 'The baseline repeated an unreliable operation.',
        expectedEffect: 'The next run uses the deterministic path.',
        risk: 'The script may need maintenance.',
        verification: 'Compare supported later sessions.',
        verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
      },
    })
    await expect(store.transition(record.id, 'applied')).rejects.toThrow(/application receipt is required/)
    await expect(
      store.transition(record.id, 'applied', {
        application: {
          v: 1,
          summary: 'Changed one unreviewed file.',
          files: ['src/a.ts', 'src/c.ts'],
          checks: [{ name: 'tests', ok: true }],
          receiptPath: join(home, 'proposals', `${record.id}.applied.json`),
        },
      }),
    ).rejects.toThrow(/exactly match/)

    await store.transition(record.id, 'applied', {
      application: {
        v: 1,
        summary: 'Changed the reviewed files.',
        files: ['src/b.ts', 'src/a.ts'],
        checks: [{ name: 'tests', ok: true }],
        receiptPath: join(home, 'proposals', `${record.id}.applied.json`),
      },
    })
    await expect(store.transition(record.id, 'verified')).rejects.toThrow(/verification receipt is required/)
    await expect(
      store.transition(record.id, 'verified', {
        application: {
          v: 1,
          summary: 'Replacement receipt',
          files: ['src/a.ts', 'src/b.ts'],
          checks: [{ name: 'tests', ok: true }],
          receiptPath: '/tmp/replacement.json',
        },
      } as never),
    ).rejects.toThrow(/not valid for this transition/)
    const appliedAt = (await store.get(record.id))!.appliedAt!
    const ok = cohortPatch(appliedAt)
    await expect(store.transition(record.id, 'verified', { verificationReceipt: ok.verificationReceipt })).rejects.toThrow(/effect is required/)
    await expect(
      store.transition(record.id, 'verified', {
        verificationReceipt: ok.verificationReceipt,
        effect: { before: { avgToolCalls: 999 }, after: { avgToolCalls: 0 }, measuredSessionIds: ok.effect.measuredSessionIds },
      }),
    ).rejects.toThrow(/must exactly match/)
    const movedGoalposts = cohortPatch(appliedAt, { comparison: 'not-increased', name: 'avgToolCalls not-increased', verdict: 'held', evidence: 'avgToolCalls: 12 → 8 (median 12 → 8; exact rank test p=1; held)' })
    await expect(store.transition(record.id, 'verified', movedGoalposts)).rejects.toThrow(/exactly match the reviewed proposal verificationChecks/)
    const verified = await store.transition(record.id, 'verified', ok)
    expect(verified.status).toBe('verified')
    expect(verified.verificationTrust).toBe('computed-v2')
  })

  it('does not allow a patch object to overwrite record identity or status', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await expect(store.transition(record.id, 'rejected', { id: 'sg_000000000000', status: 'verified' } as never)).rejects.toThrow(
      /field "id" is not a lifecycle artifact/,
    )
    await expect(store.transition(record.id, 'rejected', { verificationTrust: 'computed-v1' } as never)).rejects.toThrow(
      /field "verificationTrust" is not a lifecycle artifact/,
    )
    expect((await store.get(record.id))?.status).toBe('new')
  })

  it('does not retrofit the computed verification marker onto replayed legacy records', async () => {
    const f = finding()
    const id = suggestionIdV2(suggestionKey(f, 'report'))
    const legacyVerified: SuggestionRecord = {
      id,
      v: 2,
      key: suggestionKey(f, 'report'),
      createdAt: 10,
      source: 'report',
      ...f,
      status: 'verified',
      statusAt: 20,
    }
    appendFileSync(join(home, 'suggestions.jsonl'), `${JSON.stringify(legacyVerified)}\n`)
    expect((await store.get(id))?.verificationTrust).toBeUndefined()
  })

  it('moves a record into regressed, unproven or kept only by the 6 new moves, and keeps every 0.11.0 move', async () => {
    expect(TRANSITIONS).toEqual({
      new: ['kicked-off', 'rejected'],
      'kicked-off': ['proposed', 'failed', 'rejected'],
      proposed: ['applied', 'rejected'],
      applied: ['verified', 'regressed', 'unproven', 'rejected'],
      verified: ['rejected'],
      rejected: [],
      failed: ['kicked-off', 'rejected'],
      regressed: ['kept', 'rejected'],
      unproven: ['rejected'],
      kept: ['rejected'],
    })
    const closed = ['regressed', 'unproven', 'kept'] as const
    const into = Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.filter((to) => (closed as readonly string[]).includes(to)).map((to) => `${from} → ${to}`))
    expect(into).toEqual(['applied → regressed', 'applied → unproven', 'regressed → kept'])

    const { record } = await store.upsertNew(finding(), 'report')
    const refusesEachNewStatus = async () => {
      const from = (await store.get(record.id))!.status
      for (const to of closed) await refusedUnchanged(() => store.transition(record.id, to), `illegal transition ${from} → ${to}`)
    }
    await refusesEachNewStatus()
    await store.transition(record.id, 'kicked-off')
    await refusesEachNewStatus()
    await store.transition(record.id, 'failed', { kickoff: { mode: 'serve', command: 'x', exitCode: 1 } })
    await refusesEachNewStatus()
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    await refusesEachNewStatus()
    const { appliedAt } = await store.transition(record.id, 'applied', { application: applicationReceipt(record.id) })
    // From applied, a measured close needs its receipt, and kept is not a move.
    await refusedUnchanged(() => store.transition(record.id, 'regressed'), /outcome receipt is required/)
    await refusedUnchanged(() => store.transition(record.id, 'unproven'), /outcome receipt is required/)
    await refusedUnchanged(() => store.transition(record.id, 'kept'), 'illegal transition applied → kept')
    await store.transition(record.id, 'verified', cohortPatch(appliedAt!))
    await refusesEachNewStatus()
    await store.transition(record.id, 'rejected')
    await refusesEachNewStatus()
  })

  it('refuses each new field on every move that does not own it', async () => {
    const like: SuggestionStoreLike = store
    const base = await appliedRecord()
    const values = {
      frozenBaseline: frozenBaseline(1_000, [5, 6, 7]),
      outcomeReceipt: outcomeReceipt(base.appliedAt!, [5, 6, 7], [6, 5, 7]),
      reasonCode: 'other',
      workspaceCwd: realpathSync(home),
    } as const
    const owner: Record<keyof typeof values, SuggestionStatus[]> = {
      frozenBaseline: ['applied'],
      outcomeReceipt: ['regressed', 'unproven'],
      reasonCode: ['rejected'],
      workspaceCwd: ['rejected'],
    }
    let statusAt = clock + 1_000
    let moves = 0
    let attempts = 0
    for (const [from, tos] of Object.entries(TRANSITIONS) as Array<[SuggestionStatus, SuggestionStatus[]]>) {
      for (const to of tos) {
        moves++
        // Put the record in the state that the move leaves. The field check runs before any check of the move itself.
        appendFileSync(store.path, `${JSON.stringify({ ...base, status: from, statusAt: ++statusAt })}\n`)
        for (const field of Object.keys(values) as Array<keyof typeof values>) {
          if (owner[field].includes(to)) continue
          attempts++
          await refusedUnchanged(
            () => like.transition(base.id, to, { [field]: values[field] } as never),
            `field "${field}" is not valid for this transition`,
            `${from} → ${to} with ${field}`,
          )
        }
      }
    }
    // Every legal move of the table. Each move tries the 4 fields, less the fields that it owns: 1 on each move into
    // applied, regressed and unproven, and 2 on each of the 9 moves into rejected.
    expect(moves).toBe(18)
    expect(attempts).toBe(18 * 4 - (1 + 1 + 1 + 9 * 2))
  })

  it('reads a stored line with a new status, moves it only by the table, and still skips an unknown status such as paused', async () => {
    const applied = await appliedRecord()
    const id = applied.id
    // Lines that a later step wrote: this build knows each status and refuses each move that the table does not name.
    let statusAt = applied.statusAt
    const refused: Record<'regressed' | 'unproven' | 'kept', SuggestionStatus[]> = {
      regressed: ['verified', 'regressed', 'unproven', 'applied'],
      unproven: ['verified', 'kept', 'regressed', 'unproven'],
      kept: ['verified', 'kept', 'regressed', 'unproven'],
    }
    for (const status of ['regressed', 'unproven', 'kept'] as const) {
      appendFileSync(store.path, `${JSON.stringify({ ...applied, status, statusAt: ++statusAt })}\n`)
      await expect(store.get(id)).resolves.toMatchObject({ status, statusAt })
      for (const to of refused[status]) {
        await refusedUnchanged(() => store.transition(id, to), `illegal transition ${status} → ${to} for ${id} (allowed: ${TRANSITIONS[status].join(', ')})`)
      }
    }
    // A status that no orangu knows stays refused on read, so the line before it still wins, in both reads.
    appendFileSync(store.path, `${JSON.stringify({ ...applied, status: 'paused', statusAt: ++statusAt })}\n`)
    await expect(store.get(id)).resolves.toMatchObject({ status: 'kept' })
    expect((await store.lines(id)).map((line) => line.status)).toEqual(['new', 'kicked-off', 'proposed', 'applied', 'regressed', 'unproven', 'kept'])
  })
})

describe('SuggestionStore outcome moves', () => {
  it('closes an applied record as regressed with a graded receipt, then keeps it and carries the receipt', async () => {
    const applied = await appliedRecord({ frozen: frozenBaseline(1_000, [1, 2, 3]) })
    expect(applied.frozenBaseline).toEqual(frozenBaseline(1_000, [1, 2, 3]))
    const receipt = outcomeReceipt(applied.appliedAt!, [1, 2, 3], [10, 11, 12])
    expect(receipt.verdict).toBe('regressed')
    const regressed = await store.transition(applied.id, 'regressed', { outcomeReceipt: receipt })
    expect(regressed).toMatchObject({ status: 'regressed', outcomeReceipt: receipt, frozenBaseline: applied.frozenBaseline, appliedAt: applied.appliedAt })
    const kept = await store.transition(applied.id, 'kept')
    expect(kept).toMatchObject({ status: 'kept', outcomeReceipt: receipt, appliedAt: applied.appliedAt })
    const rejected = await store.transition(applied.id, 'rejected', { reasonCode: 'wrong-cause' })
    expect(rejected).toMatchObject({ status: 'rejected', reasonCode: 'wrong-cause', outcomeReceipt: receipt })
    expect((await store.lines(applied.id)).map((line) => line.status)).toEqual(['new', 'kicked-off', 'proposed', 'applied', 'regressed', 'kept', 'rejected'])
  })

  it('closes an applied record as unproven at the complete checkpoint, with no frozen baseline on an older record', async () => {
    const applied = await appliedRecord()
    const receipt = outcomeReceipt(applied.appliedAt!, [5, 6, 7], [6, 5, 7, 6, 5, 7, 6, 5, 7, 6])
    expect(receipt).toMatchObject({ verdict: 'within-noise', checkpoint: 'complete', laterComplete: true })
    await expect(store.transition(applied.id, 'unproven', { outcomeReceipt: receipt })).resolves.toMatchObject({ status: 'unproven', outcomeReceipt: receipt })
    await expect(store.transition(applied.id, 'rejected')).resolves.toMatchObject({ status: 'rejected', outcomeReceipt: receipt })
  })

  it('closes a record with a frozen baseline below 3 sessions as unproven before the later cohort is complete', async () => {
    const applied = await appliedRecord({ frozen: frozenBaseline(1_000, [5, 6]) })
    for (const later of [[], [4]]) {
      const receipt = outcomeReceipt(applied.appliedAt!, [5, 6], later, { checkpoint: 'first', laterComplete: false })
      expect(receipt.verdict).toBe('not-enough-sessions')
      const isolated = later.length ? await appliedRecord({ ruleId: 'short-baseline-later', frozen: frozenBaseline(1_000, [5, 6]) }) : applied
      const closed = await store.transition(isolated.id, 'unproven', { outcomeReceipt: { ...receipt, appliedAt: isolated.appliedAt! } })
      expect(closed).toMatchObject({ status: 'unproven', outcomeReceipt: { checkpoint: 'first', laterComplete: false, baselineSessionIds: [sid(0), sid(1)] } })
    }
  })

  it('refuses a check whose stored verdict differs from the verdict of its numbers', async () => {
    const applied = await appliedRecord()
    const receipt = outcomeReceipt(applied.appliedAt!, [1, 2, 3], [10, 11, 12])
    const relabelled = { ...receipt, checks: [{ ...receipt.checks[0]!, verdict: 'within-noise' as const }] }
    await refusedUnchanged(() => store.transition(applied.id, 'regressed', { outcomeReceipt: relabelled }), /checks\[0\] verdict must be the computed verdict regressed/)
    const movedNumbers = { ...receipt, checks: [{ ...receipt.checks[0]!, pHigher: 0.5 }] }
    await refusedUnchanged(() => store.transition(applied.id, 'regressed', { outcomeReceipt: movedNumbers }), /checks\[0\] verdict must be the computed verdict within-noise/)
  })

  it('refuses an overall verdict that differs from the verdict of its checks', async () => {
    const applied = await appliedRecord()
    const withinNoise = outcomeReceipt(applied.appliedAt!, [5, 6, 7], [6, 5, 7])
    await refusedUnchanged(
      () => store.transition(applied.id, 'regressed', { outcomeReceipt: { ...withinNoise, verdict: 'regressed' } }),
      /the overall verdict must be the computed verdict within-noise/,
    )
    await refusedUnchanged(
      () => store.transition(applied.id, 'unproven', { outcomeReceipt: { ...withinNoise, verdict: 'no-directional-check' } }),
      /the overall verdict must be the computed verdict within-noise/,
    )
  })

  it('refuses a regressed or unproven receipt before the later cohort is complete, except a short frozen baseline with the same ids', async () => {
    const older = await appliedRecord({ ruleId: 'older-record' })
    const regressed = outcomeReceipt(older.appliedAt!, [1, 2, 3], [10, 11, 12], { laterComplete: false })
    await refusedUnchanged(() => store.transition(older.id, 'regressed', { outcomeReceipt: regressed }), /laterComplete must be true/)
    const withinNoise = outcomeReceipt(older.appliedAt!, [5, 6, 7], [6, 5, 7], { laterComplete: false })
    await refusedUnchanged(() => store.transition(older.id, 'unproven', { outcomeReceipt: withinNoise }), /laterComplete must be true/)
    // A short baseline on the receipt alone is not the exception: the record must carry the frozen baseline.
    const shortNoFreeze = outcomeReceipt(older.appliedAt!, [5, 6], [4], { checkpoint: 'first', laterComplete: false })
    await refusedUnchanged(() => store.transition(older.id, 'unproven', { outcomeReceipt: shortNoFreeze }), /laterComplete must be true/)

    // A frozen baseline of 3 sessions is not short, so too few later sessions still wait for the complete cohort.
    const full = await appliedRecord({ ruleId: 'full-freeze', frozen: frozenBaseline(1_000, [5, 6, 7]) })
    const fewLater = outcomeReceipt(full.appliedAt!, [5, 6, 7], [4], { laterComplete: false })
    expect(fewLater.verdict).toBe('not-enough-sessions')
    await refusedUnchanged(() => store.transition(full.id, 'unproven', { outcomeReceipt: fewLater }), /laterComplete must be true/)

    // The short frozen baseline must be the receipt's baseline.
    const short = await appliedRecord({ ruleId: 'short-freeze', frozen: frozenBaseline(1_000, [5, 6]) })
    const otherIds = { ...outcomeReceipt(short.appliedAt!, [5, 6], [4], { checkpoint: 'first', laterComplete: false }), baselineSessionIds: [sid(0), sid(7)] }
    await refusedUnchanged(() => store.transition(short.id, 'unproven', { outcomeReceipt: otherIds }), /baselineSessionIds must equal the frozen baseline/)
  })

  it('refuses a regressed move whose verdict is not regressed, and an unproven move whose verdict is', async () => {
    const applied = await appliedRecord()
    const withinNoise = outcomeReceipt(applied.appliedAt!, [5, 6, 7], [6, 5, 7])
    await refusedUnchanged(() => store.transition(applied.id, 'regressed', { outcomeReceipt: withinNoise }), /a regressed record needs the regressed verdict, not within-noise/)
    const regressed = outcomeReceipt(applied.appliedAt!, [1, 2, 3], [10, 11, 12])
    await refusedUnchanged(() => store.transition(applied.id, 'unproven', { outcomeReceipt: regressed }), /an unproven record cannot carry the regressed verdict/)
  })

  it('refuses a frozen baseline with more than 10 sessions, an unsorted or repeated id, or a value that is not a finite number of 0 or more', async () => {
    const { record } = await store.upsertNew(finding({ ruleId: 'freeze-shape' }), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    const application = applicationReceipt(record.id)
    const good = frozenBaseline(1_000, [5, 6, 7])
    const session = good.sessions[0]!
    const bad: Array<[string, unknown, RegExp]> = [
      ['11 sessions', frozenBaseline(1_000, Array.from({ length: 11 }, (_, index) => index)), /0 to 10 sessions/],
      ['unsorted ids', { ...good, sessions: [good.sessions[1], good.sessions[0], good.sessions[2]] }, /sorted by id with no repeated id/],
      ['a repeated id', { ...good, sessions: [session, session, good.sessions[2]] }, /sorted by id with no repeated id/],
      ['a NaN metric', { ...good, sessions: [{ ...session, metrics: { ...session.metrics, avgToolCalls: Number.NaN } }, ...good.sessions.slice(1)] }, /finite number of 0 or more/],
      ['a negative metric', { ...good, sessions: [{ ...session, metrics: { ...session.metrics, avgToolErrors: -1 } }, ...good.sessions.slice(1)] }, /finite number of 0 or more/],
      ['an infinite time', { ...good, sessions: [{ ...session, endedAt: Number.POSITIVE_INFINITY }, ...good.sessions.slice(1)] }, /finite number of 0 or more/],
      ['a negative cut', { ...good, cutAt: -1 }, /finite number of 0 or more/],
      ['a fractional skip count', { ...good, skipped: { ...good.skipped, unreadable: 0.5 } }, /whole number of 0 or more/],
      ['a negative skip count', { ...good, skipped: { ...good.skipped, 'budget-spent': -1 } }, /whole number of 0 or more/],
      ['a session that ends after the cut', { ...good, sessions: [{ ...session, endedAt: 1_001 }, ...good.sessions.slice(1)] }, /end at or before cutAt/],
      ['a session that ends before it starts', { ...good, sessions: [{ ...session, startedAt: 30, endedAt: 20 }, ...good.sessions.slice(1)] }, /end at or before cutAt/],
      ['an id that is not a session id', { ...good, sessions: [{ ...session, id: 'baseline one' }, ...good.sessions.slice(1)] }, /lowercase session id/],
      ['an uppercase id', { ...good, sessions: [{ ...session, id: session.id.toUpperCase() }, ...good.sessions.slice(1)] }, /lowercase session id/],
      ['a missing metric', { ...good, sessions: [{ ...session, metrics: { avgToolCalls: 5 } }, ...good.sessions.slice(1)] }, /exactly the 8 verification metrics/],
      ['a missing skip reason', { ...good, skipped: { unreadable: 0 } }, /exactly the 8 skip reasons/],
      ['version 2', { ...good, v: 2 }, /frozenBaseline v must be 1/],
      ['a cut after the application time', frozenBaseline(1_000_000, [5, 6, 7]), /cutAt must not be later than the application time/],
    ]
    for (const [label, value, message] of bad) {
      await refusedUnchanged(() => store.transition(record.id, 'applied', { application, frozenBaseline: value as SuggestionFrozenBaseline }), message, label)
    }
    // 0 and 10 sessions are the bounds, and a move with no freeze stays legal.
    const empty = await appliedRecord({ ruleId: 'freeze-empty', frozen: frozenBaseline(1_000, []) })
    expect(empty.frozenBaseline?.sessions).toEqual([])
    const ten = await appliedRecord({ ruleId: 'freeze-ten', frozen: frozenBaseline(1_000, Array.from({ length: 10 }, (_, index) => index)) })
    expect(ten.frozenBaseline?.sessions).toHaveLength(10)
    await expect(store.transition(record.id, 'applied', { application })).resolves.not.toHaveProperty('frozenBaseline')
  })

  it('refuses a receipt that is not exactly the outcome shape, a missing receipt, and global scope', async () => {
    const applied = await appliedRecord()
    const at = applied.appliedAt!
    const good = outcomeReceipt(at, [5, 6, 7], [6, 5, 7])
    const check = good.checks[0]!
    const bad: Array<[string, unknown, RegExp]> = [
      ['a summary', { ...good, summary: 'Later sessions did not move.' }, /exactly the keys of an outcome receipt/],
      ['an evidence line', { ...good, checks: [{ ...check, evidence: 'avgToolCalls: 6 → 6' }] }, /checks\[0\] must have exactly the keys of an outcome check/],
      ['the verified verdict', { ...good, verdict: 'verified' }, /verdict must be a verdict other than verified/],
      ['version 2', { ...good, v: 2 }, /cohort-rank-v1 outcome receipt at alpha 0.05/],
      ['another application time', { ...good, appliedAt: at + 1 }, /appliedAt must equal the recorded application time/],
      ['an unknown checkpoint', { ...good, checkpoint: 'second' }, /checkpoint must be first or complete/],
      ['the first checkpoint with no short frozen baseline', { ...good, checkpoint: 'first' }, /checkpoint first needs a frozen baseline below 3 sessions/],
      ['11 later sessions', { ...good, measuredSessionIds: Array.from({ length: 11 }, (_, index) => sid(100 + index)) }, /measuredSessionIds must be 0 to 10 sorted unique session ids/],
      ['a later id that is not a session id', { ...good, measuredSessionIds: ['later one', sid(101), sid(102)] }, /measuredSessionIds must be 0 to 10 sorted unique session ids/],
      ['unsorted baseline ids', { ...good, baselineSessionIds: [sid(1), sid(0), sid(2)] }, /baselineSessionIds must be 0 to 10 sorted unique session ids/],
      ['a shared session', { ...good, measuredSessionIds: [sid(0), sid(101), sid(102)] }, /must not share a session/],
      ['an unsorted confounder list', { ...good, confoundedBy: ['sg_bbbbbbbbbbbb', 'sg_aaaaaaaaaaaa'] }, /confoundedBy must be sorted unique suggestion ids/],
      ['a check for another metric', { ...good, checks: [{ ...check, metric: 'avgToolErrors' }] }, /checks\[0\] must match the reviewed check avgToolCalls decreased/],
      ['a renamed check', { ...good, checks: [{ ...check, name: 'tool calls went down' }] }, /checks\[0\] must match the reviewed check avgToolCalls decreased/],
      ['a negative mean', { ...good, checks: [{ ...check, before: -1 }] }, /checks\[0\] must carry finite metric values/],
      ['an impossible p-value', { ...good, checks: [{ ...check, pLower: 0.01, pHigher: 0.5 }] }, /p-values are not possible for 3 and 3 sessions/],
      ['no check', { ...good, checks: [] }, /checks must match the reviewed verificationChecks/],
      ['a boolean as laterComplete text', { ...good, laterComplete: 'yes' }, /laterComplete must be a boolean/],
    ]
    for (const [label, value, message] of bad) {
      await refusedUnchanged(() => store.transition(applied.id, 'unproven', { outcomeReceipt: value as SuggestionOutcomeReceipt }), message, label)
    }
    await refusedUnchanged(() => store.transition(applied.id, 'unproven', {}), /outcome receipt is required/)
    await refusedUnchanged(() => store.transition(applied.id, 'unproven', { outcomeReceipt: good, reasonCode: 'other' } as never), /field "reasonCode" is not valid for this transition/)

    // A hand-written applied global line still cannot close: global is review-only.
    const global = await store.upsertNew(finding({ ruleId: 'global-outcome', scope: 'global', cohortFingerprint: '4444444444444444' }), 'report')
    appendFileSync(store.path, `${JSON.stringify({ ...applied, id: global.record.id, key: global.record.key, scope: 'global', cohortFingerprint: '4444444444444444', ruleId: 'global-outcome', statusAt: clock + 500 })}\n`)
    for (const to of ['regressed', 'unproven'] as const) {
      await refusedUnchanged(() => store.transition(global.record.id, to, { outcomeReceipt: good }), /global suggestions are review-only/)
    }
  })

  it('keeps a stored guard-only record readable and lets it close as unproven with the no-directional-check verdict', async () => {
    // The manifest loader refuses a new guard-only set. A record that an older orangu stored keeps its path to a close.
    const guard: SuggestionVerificationIntent = { metric: 'avgToolErrors', comparison: 'not-increased' }
    const applied = await appliedRecord({ ruleId: 'guard-only', intent: guard })
    await expect(store.get(applied.id)).resolves.toMatchObject({ status: 'applied', proposal: { verificationChecks: [guard] } })
    const receipt = outcomeReceipt(applied.appliedAt!, [1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], {}, guard)
    expect(receipt.verdict).toBe('no-directional-check')
    await expect(store.transition(applied.id, 'unproven', { outcomeReceipt: receipt })).resolves.toMatchObject({ status: 'unproven' })
  })
})

describe('SuggestionStore rejection fields', () => {
  it('stores a reason code and a canonical workspace path on a rejection', async () => {
    const cwd = realpathSync(home)
    for (const [index, code] of REJECT_REASON_CODES.entries()) {
      const { record } = await store.upsertNew(finding({ ruleId: `reject-${index}` }), 'report')
      const rejected = await store.transition(record.id, 'rejected', { reasonCode: code, workspaceCwd: cwd })
      expect(rejected).toMatchObject({ status: 'rejected', reasonCode: code, workspaceCwd: cwd })
    }
    // Both fields stay optional: a rejection with neither is legal for every scope.
    const global = await store.upsertNew(finding({ ruleId: 'reject-global', scope: 'global', cohortFingerprint: '5555555555555555' }), 'report')
    const plain = await store.transition(global.record.id, 'rejected')
    expect(plain).not.toHaveProperty('reasonCode')
    expect(plain).not.toHaveProperty('workspaceCwd')
  })

  it('refuses a reason code that is not 1 of the 5 codes', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    for (const code of ['paused', 'Other', 'other ', 'I changed my mind', '', 3, null]) {
      await refusedUnchanged(() => store.transition(record.id, 'rejected', { reasonCode: code as never }), /reasonCode must be 1 of not-wanted, already-handled, wrong-cause, too-much-effort, other/)
    }
  })

  it('refuses a workspace path that is not absolute and canonical, and a record that has a proposal workspace', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    const cwd = realpathSync(home)
    for (const path of ['relative/dir', `${cwd}/`, `${cwd}/./x`, `${cwd}/../x`, `${cwd}//x`, `${cwd}\nx`, `${cwd}\u0000`, `/${'a'.repeat(4_096)}`, '', 42]) {
      await refusedUnchanged(() => store.transition(record.id, 'rejected', { workspaceCwd: path as never }), /workspaceCwd must be an absolute canonical path/)
    }
    const applied = await appliedRecord()
    await refusedUnchanged(
      () => store.transition(applied.id, 'rejected', { workspaceCwd: cwd }),
      /workspaceCwd is only for a record with no proposal workspace/,
    )
  })
})

describe('SuggestionStore new fields hold no free text', () => {
  const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const SUGGESTION_ID = /^sg_[0-9a-f]{12}$/
  const ENUM_VALUES = new Set<string>([
    ...SUGGESTION_VERIFICATION_METRICS,
    ...SUGGESTION_VERIFICATION_COMPARISONS,
    ...SUGGESTION_VERIFICATION_METRICS.flatMap((metric) => SUGGESTION_VERIFICATION_COMPARISONS.map((comparison) => `${metric} ${comparison}`)),
    ...REJECT_REASON_CODES,
    'cohort-rank-v1',
    'first',
    'complete',
    'within-noise',
    'regressed',
    'not-enough-sessions',
    'no-directional-check',
    'improved',
    'held',
    'changed',
  ])
  const SHAPE_KEYS = new Set<string>([
    ...['v', 'cutAt', 'sessions', 'skipped', 'id', 'startedAt', 'endedAt', 'metrics'],
    ...['method', 'alpha', 'appliedAt', 'checkpoint', 'verdict', 'laterComplete', 'confoundedBy', 'baselineSessionIds', 'measuredSessionIds', 'checks'],
    ...['metric', 'comparison', 'name', 'before', 'after', 'beforeMedian', 'afterMedian', 'pLower', 'pHigher'],
    ...SUGGESTION_VERIFICATION_METRICS,
    ...COHORT_SKIP_REASONS,
  ])
  const NEW_FIELDS = ['frozenBaseline', 'outcomeReceipt', 'reasonCode', 'workspaceCwd'] as const

  /** Each leaf of a new field that is not a finite number, a boolean, an id, an enum value or the bound workspace path. */
  function freeText(value: unknown, path: string, workspaceCwd: string, found: string[]): number {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) found.push(`${path} = ${value}`)
      return 1
    }
    if (typeof value === 'boolean') return 1
    if (typeof value === 'string') {
      if (!SESSION_ID.test(value) && !SUGGESTION_ID.test(value) && !ENUM_VALUES.has(value) && !(path === 'workspaceCwd' && value === workspaceCwd)) {
        found.push(`${path} = ${JSON.stringify(value)}`)
      }
      return 1
    }
    if (Array.isArray(value)) return value.reduce<number>((sum, item, index) => sum + freeText(item, `${path}[${index}]`, workspaceCwd, found), 0)
    if (value && typeof value === 'object') {
      let leaves = 0
      for (const [key, item] of Object.entries(value)) {
        if (!SHAPE_KEYS.has(key)) found.push(`${path}.${key}`)
        leaves += freeText(item, `${path}.${key}`, workspaceCwd, found)
      }
      return leaves
    }
    found.push(`${path} is ${value === null ? 'null' : typeof value}`)
    return 1
  }

  it('walks the new fields of the stored line after each new move and finds only numbers, booleans, ids, enum values and the workspace path', async () => {
    const workspaceCwd = realpathSync(home)
    const walkLastLine = (move: string, expected: readonly (typeof NEW_FIELDS)[number][]): void => {
      const lines = readFileSync(store.path, 'utf8').trimEnd().split('\n')
      const stored = JSON.parse(lines.at(-1)!) as Record<string, unknown>
      expect(NEW_FIELDS.filter((field) => stored[field] !== undefined), move).toEqual(expected)
      const found: string[] = []
      const leaves = NEW_FIELDS.reduce((sum, field) => sum + (stored[field] === undefined ? 0 : freeText(stored[field], field, workspaceCwd, found)), 0)
      expect(found, move).toEqual([])
      expect(leaves, move).toBeGreaterThan(0)
    }

    const regressedPath = await appliedRecord({ ruleId: 'walk-regressed', frozen: frozenBaseline(1_000, [1, 2, 3]) })
    walkLastLine('applied with a frozen baseline', ['frozenBaseline'])
    await store.transition(regressedPath.id, 'regressed', { outcomeReceipt: outcomeReceipt(regressedPath.appliedAt!, [1, 2, 3], [10, 11, 12], { confoundedBy: ['sg_aaaaaaaaaaaa'] }) })
    walkLastLine('applied → regressed', ['frozenBaseline', 'outcomeReceipt'])
    await store.transition(regressedPath.id, 'kept')
    walkLastLine('regressed → kept', ['frozenBaseline', 'outcomeReceipt'])
    await store.transition(regressedPath.id, 'rejected', { reasonCode: 'not-wanted' })
    walkLastLine('kept → rejected', ['frozenBaseline', 'outcomeReceipt', 'reasonCode'])

    const regressedRejected = await appliedRecord({ ruleId: 'walk-regressed-rejected', frozen: frozenBaseline(1_000, [1, 2, 3]) })
    await store.transition(regressedRejected.id, 'regressed', { outcomeReceipt: outcomeReceipt(regressedRejected.appliedAt!, [1, 2, 3], [10, 11, 12]) })
    await store.transition(regressedRejected.id, 'rejected', { reasonCode: 'already-handled' })
    walkLastLine('regressed → rejected', ['frozenBaseline', 'outcomeReceipt', 'reasonCode'])

    const unprovenPath = await appliedRecord({ ruleId: 'walk-unproven', frozen: frozenBaseline(1_000, [5, 6]) })
    await store.transition(unprovenPath.id, 'unproven', { outcomeReceipt: outcomeReceipt(unprovenPath.appliedAt!, [5, 6], [4], { checkpoint: 'first', laterComplete: false }) })
    walkLastLine('applied → unproven', ['frozenBaseline', 'outcomeReceipt'])
    await store.transition(unprovenPath.id, 'rejected', { reasonCode: 'too-much-effort' })
    walkLastLine('unproven → rejected', ['frozenBaseline', 'outcomeReceipt', 'reasonCode'])

    const { record } = await store.upsertNew(finding({ ruleId: 'walk-rejected' }), 'report')
    await store.transition(record.id, 'rejected', { reasonCode: 'other', workspaceCwd })
    walkLastLine('new → rejected', ['reasonCode', 'workspaceCwd'])
  })

  it('refuses a key that is not in the shape of a new field', async () => {
    const applied = await appliedRecord()
    const at = applied.appliedAt!
    const receipt = outcomeReceipt(at, [5, 6, 7], [6, 5, 7])
    await refusedUnchanged(() => store.transition(applied.id, 'unproven', { outcomeReceipt: { ...receipt, note: 'free text' } as never }), /exactly the keys of an outcome receipt/)
    await refusedUnchanged(
      () => store.transition(applied.id, 'unproven', { outcomeReceipt: { ...receipt, checks: [{ ...receipt.checks[0]!, note: 'free text' }] } as never }),
      /exactly the keys of an outcome check/,
    )

    const { record } = await store.upsertNew(finding({ ruleId: 'freeze-keys' }), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    const application = applicationReceipt(record.id)
    const good = frozenBaseline(1_000, [5, 6, 7])
    const session = good.sessions[0]!
    const smuggled: Array<[unknown, RegExp]> = [
      [{ ...good, note: 'free text' }, /exactly the keys v, cutAt, sessions and skipped/],
      [{ ...good, sessions: [{ ...session, title: 'free text' }, ...good.sessions.slice(1)] }, /exactly the keys id, startedAt, endedAt and metrics/],
      [{ ...good, sessions: [{ ...session, metrics: { ...session.metrics, note: 1 } }, ...good.sessions.slice(1)] }, /exactly the 8 verification metrics/],
      [{ ...good, skipped: { ...good.skipped, note: 0 } }, /exactly the 8 skip reasons/],
    ]
    for (const [value, message] of smuggled) {
      await refusedUnchanged(() => store.transition(record.id, 'applied', { application, frozenBaseline: value as SuggestionFrozenBaseline }), message)
    }
  })
})

describe('SuggestionStore.lines', () => {
  it('returns every valid line of 1 record in file order, with no last line wins', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    const other = await store.upsertNew(finding({ ruleId: 'other-rule' }), 'report')
    await store.transition(record.id, 'kicked-off')
    appendFileSync(store.path, '{ not json\n')
    await store.transition(other.record.id, 'rejected')
    appendFileSync(store.path, `${JSON.stringify({ ...record, status: 'paused' })}\n`)
    await store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id) })
    await store.transition(record.id, 'applied', { application: applicationReceipt(record.id) })

    const lines = await store.lines(record.id)
    expect(lines.map((line) => line.status)).toEqual(['new', 'kicked-off', 'proposed', 'applied'])
    expect(lines.every((line) => line.id === record.id)).toBe(true)
    expect(lines.map((line) => line.statusAt)).toEqual([...lines.map((line) => line.statusAt)].sort((a, b) => a - b))
    expect(lines.at(-1)).toEqual(await store.get(record.id))
  })

  it('returns every valid line of the file with no id, and no line for an unknown id or a missing store', async () => {
    await expect(store.lines()).resolves.toEqual([])
    await expect(store.lines('sg_000000000000')).resolves.toEqual([])
    const { record } = await store.upsertNew(finding(), 'report')
    const other = await store.upsertNew(finding({ ruleId: 'other-rule' }), 'report')
    await store.transition(record.id, 'rejected')
    appendFileSync(store.path, '{ not json\n')
    expect((await store.lines()).map((line) => `${line.id}:${line.status}`)).toEqual([`${record.id}:new`, `${other.record.id}:new`, `${record.id}:rejected`])
    await expect(store.lines('sg_000000000000')).resolves.toEqual([])
  })

  it('matches a migrated record through its legacy ids, by the old id and by the new id', async () => {
    const f = finding()
    const oldId = suggestionId('report', f.ruleId, f.sessionIds)
    const legacy: SuggestionRecord = {
      id: oldId,
      v: 1,
      createdAt: 10,
      source: 'report',
      scope: f.scope,
      sessionIds: [...f.sessionIds].sort(),
      ruleId: f.ruleId,
      title: 'Legacy title',
      evidence: { estimated: true },
      status: 'kicked-off',
      statusAt: 20,
    }
    appendFileSync(store.path, `${JSON.stringify({ ...legacy, status: 'new', statusAt: 10 })}\n${JSON.stringify(legacy)}\n`)
    const migrated = await store.upsertNew(f, 'report')
    await store.transition(oldId, 'rejected')
    const expected = [`${oldId}:new`, `${oldId}:kicked-off`, `${migrated.record.id}:kicked-off`, `${migrated.record.id}:rejected`]
    for (const id of [oldId, migrated.record.id]) {
      expect((await store.lines(id)).map((line) => `${line.id}:${line.status}`), id).toEqual(expected)
    }
  })

  it('applies the caps of the replay: 64 MiB, 4 MiB a line and 100,000 lines', async () => {
    const oversized = new SuggestionStore({ home: mkdtempSync(join(tmpdir(), 'orangu-lines-oversized-')) })
    writeFileSync(oversized.path, '')
    truncateSync(oversized.path, 64 * 1024 * 1024 + 1)
    await expect(oversized.lines()).rejects.toThrow(/suggestion store exceeds 67108864 bytes/)

    const tooManyLines = new SuggestionStore({ home: mkdtempSync(join(tmpdir(), 'orangu-lines-count-')) })
    writeFileSync(tooManyLines.path, Buffer.alloc(100_001, 0x0a))
    await expect(tooManyLines.lines('sg_000000000000')).rejects.toThrow(/suggestion store exceeds 100000 lines/)

    const longRecord = new SuggestionStore({ home: mkdtempSync(join(tmpdir(), 'orangu-lines-record-')) })
    writeFileSync(longRecord.path, '')
    truncateSync(longRecord.path, 4 * 1024 * 1024 + 1)
    await expect(longRecord.lines()).rejects.toThrow(/suggestion store record exceeds 4194304 bytes/)
  })
})

describe('SuggestionStore write serialization', () => {
  it('two concurrent transitions from the same state append exactly once', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    // both are new → rejected; without serialization both replay `new` and both append
    const results = await Promise.allSettled([store.transition(record.id, 'rejected'), store.transition(record.id, 'rejected')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const lines = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2) // create + the single winning transition
    expect((await store.get(record.id))!.status).toBe('rejected')
  })

  it('a rejected suggestion cannot be resurrected by a concurrent kicked-off transition', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    // FIFO queue: rejected runs first, so kicked-off must re-replay and see the terminal state
    const results = await Promise.allSettled([store.transition(record.id, 'rejected'), store.transition(record.id, 'kicked-off')])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('rejected')
    expect((await store.get(record.id))!.status).toBe('rejected')
  })

  it('two store instances on the same home (two writers) are serialized by the lockfile', async () => {
    const other = new SuggestionStore({ home, now: () => 9_000 })
    const { record } = await store.upsertNew(finding(), 'report')
    const results = await Promise.allSettled([store.transition(record.id, 'rejected'), other.transition(record.id, 'rejected')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lines = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect((await store.get(record.id))!.status).toBe('rejected')
  })

  it('a stale lock (dead writer) is broken instead of deadlocking', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    const lock = join(home, 'suggestions.jsonl.lock')
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const rec = await store.transition(record.id, 'kicked-off')
    expect(rec.status).toBe('kicked-off')
    expect(existsSync(lock)).toBe(false) // released after the write
  })

  it('does not break a live stale lock and refuses a paused writer after ownership loss', async () => {
    const moduleUrl = new URL('./store.ts', import.meta.url).href
    const sharedFinding = JSON.stringify(finding())
    const pausedScript = `
      import { SuggestionStore } from ${JSON.stringify(moduleUrl)}
      const store = new SuggestionStore({ home: ${JSON.stringify(home)}, now: () => 2_000 })
      const acquire = store.acquireLock.bind(store)
      store.acquireLock = async () => {
        const guard = await acquire()
        process.send?.({ type: 'locked' })
        await new Promise((resolve) => process.once('message', resolve))
        return guard
      }
      try {
        await store.upsertNew(${sharedFinding}, 'report')
        process.send?.({ type: 'result', ok: true })
      } catch (error) {
        process.send?.({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        process.disconnect?.()
      }
    `
    const contenderScript = `
      import { SuggestionStore } from ${JSON.stringify(moduleUrl)}
      const store = new SuggestionStore({ home: ${JSON.stringify(home)}, now: () => 3_000 })
      const acquire = store.acquireLock.bind(store)
      store.acquireLock = async () => {
        const guard = await acquire()
        process.send?.({ type: 'acquired' })
        await new Promise((resolve) => process.once('message', resolve))
        return guard
      }
      process.send?.({ type: 'started' })
      try {
        await store.upsertNew(${sharedFinding}, 'report')
        process.send?.({ type: 'result', ok: true })
      } catch (error) {
        process.send?.({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        process.disconnect?.()
      }
    `
    const spawnWorker = (script: string): ChildProcess => spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )

    const paused = spawnWorker(pausedScript)
    let contender: ChildProcess | undefined
    try {
      const pausedResult = waitForWorkerMessage(paused, 'result')
      await waitForWorkerMessage(paused, 'locked')
      const lock = `${store.path}.lock`
      const ownerPath = join(lock, 'owner.json')
      const old = new Date(Date.now() - 60_000)
      utimesSync(lock, old, old)

      contender = spawnWorker(contenderScript)
      const contenderAcquired = waitForWorkerMessage(contender, 'acquired')
      const contenderResult = waitForWorkerMessage(contender, 'result')
      await waitForWorkerMessage(contender, 'started')
      let contenderAcquiredEarly = false
      void contenderAcquired.then(
        () => { contenderAcquiredEarly = true },
        () => { contenderAcquiredEarly = true },
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(contenderAcquiredEarly).toBe(false)
      expect(existsSync(store.path)).toBe(false)

      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { v: number; pid: number; createdAt: number }
      expect(owner.pid).toBe(paused.pid)
      writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: '0'.repeat(64) })}\n`)
      paused.send?.('continue')

      await expect(pausedResult).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/lock ownership lost/) })
      await waitForWorkerExit(paused)
      await expect(contenderAcquired).resolves.toMatchObject({ type: 'acquired' })
      expect(existsSync(store.path)).toBe(false)
      contender.send?.('continue')
      await expect(contenderResult).resolves.toMatchObject({ ok: true })
      await waitForWorkerExit(contender)

      const records = await new SuggestionStore({ home }).all()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ status: 'new', createdAt: 3_000 })
    } finally {
      if (paused.exitCode === null && paused.signalCode === null) paused.kill('SIGKILL')
      if (contender && contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL')
    }
  }, 12_000)
})
