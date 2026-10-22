import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COHORT_SIDE_BYTES,
  COHORT_SKIP_REASONS,
  effectFinality,
  freezeBaseline,
  measureCohortEffect,
  nextStep,
  outcomePatch,
  ranOranguLifecycle,
  verificationPatch,
  type CohortCandidate,
  type CohortDeps,
  type CohortEffect,
  type CohortSession,
  type CohortSkipReason,
} from './cohort.js'
import { evaluateCheck, overallVerdict } from './cohort-stats.js'
import { SuggestionStore } from './store.js'
import type { SuggestionFrozenBaseline, SuggestionOutcomeReceipt, SuggestionRecord, SuggestionVerificationIntent, SuggestionVerificationMetric } from './types.js'

const T = 100_000
const WORKSPACE = '/w'
const MiB = 1024 * 1024

interface FakeSession {
  id: string
  startedAt: number
  endedAt: number
  toolCalls: number
  cwd?: string
  skip?: 'still-settling' | 'unreadable' | 'over-budget'
  bytes?: number
  ranOrangu?: boolean
  /** a settling skip with no start time: the loader could not read the head of the transcript */
  startUnknown?: boolean
}

const uuid = (n: number): string => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function fakeDeps(sessions: FakeSession[]): CohortDeps & { loaded: string[] } {
  const loaded: string[] = []
  return {
    loaded,
    async listCandidates(cwd: string): Promise<CohortCandidate[]> {
      expect(cwd).toBe(WORKSPACE)
      return sessions.map((s) => ({ sessionId: s.id, path: `/projects/-w/${s.id}.jsonl`, mtimeMs: s.endedAt }))
    },
    async loadCandidate(candidate: CohortCandidate, maxBytes: number) {
      loaded.push(candidate.sessionId)
      const s = sessions.find((x) => x.id === candidate.sessionId)!
      const bytesRead = s.bytes ?? 1_000
      // The loader reports the start time of a settling session from the head of its transcript.
      if (s.skip === 'still-settling') return s.startUnknown ? { skip: s.skip, bytesRead } : { skip: s.skip, bytesRead, startedAt: s.startedAt }
      if (s.skip) return { skip: s.skip, bytesRead }
      if (bytesRead > maxBytes) return { skip: 'over-budget' as const, bytesRead: 0 }
      const session: CohortSession = {
        id: s.id,
        path: candidate.path,
        cwd: s.cwd ?? WORKSPACE,
        ranOrangu: s.ranOrangu ?? false,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        metrics: {
          avgTotalTokens: 100,
          avgToolCalls: s.toolCalls,
          avgToolErrors: 0,
          avgActiveMs: 1_000,
          avgContextPeak: 10,
          avgTestRunsFailed: 0,
          avgBuildRunsFailed: 0,
          avgInterruptions: 0,
        },
      }
      return { session, bytesRead }
    },
    async canonicalWorkspace() {
      return WORKSPACE
    },
  }
}

function appliedRecord(over: Partial<SuggestionRecord> = {}, checks: SuggestionVerificationIntent[] = [{ metric: 'avgToolCalls', comparison: 'decreased' }]): SuggestionRecord {
  return {
    id: 'sg_aaaaaaaaaaaa',
    v: 2,
    createdAt: 1,
    source: 'report',
    scope: 'session',
    sessionIds: [uuid(900)],
    ruleId: 'reread-files',
    title: 'Re-read files',
    evidence: { estimated: true },
    proposal: {
      v: 1,
      title: 'Reviewed change',
      change: 'Change one file.',
      effort: 'S',
      files: ['src/a.ts'],
      proposalPath: '/p/a.md',
      manifestPath: '/p/a.json',
      changeClass: 'instruction',
      evidence: 'e',
      expectedEffect: 'x',
      risk: 'r',
      verification: 'v',
      verificationChecks: checks,
      workspace: { cwd: WORKSPACE, device: '1', inode: '2' },
    },
    application: { v: 1, summary: 's', files: ['src/a.ts'], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.applied.json' },
    appliedAt: T,
    status: 'applied',
    statusAt: T,
    ...over,
  }
}

/** n baseline sessions ending before T and n later sessions starting after T, with separated tool calls. */
function separated(n: number, idBase = 0): FakeSession[] {
  const out: FakeSession[] = []
  for (let i = 0; i < n; i++) out.push({ id: uuid(idBase + i), startedAt: T - 50_000 + i * 1_000, endedAt: T - 40_000 + i * 1_000, toolCalls: 20 + i })
  for (let i = 0; i < n; i++) out.push({ id: uuid(idBase + 100 + i), startedAt: T + 1_000 + i * 1_000, endedAt: T + 2_000 + i * 1_000, toolCalls: 1 + i })
  return out
}

describe('measureCohortEffect: selection', () => {
  it('takes the 10 most recent baseline sessions and the first 10 later sessions', async () => {
    const sessions = separated(12)
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(sessions))
    expect(effect.baseline.map((s) => s.id)).toEqual([...Array(10).keys()].map((i) => uuid(11 - i)))
    expect(effect.later.map((s) => s.id)).toEqual([...Array(10).keys()].map((i) => uuid(100 + i)))
    expect(effect.verdict).toBe('verified')
    expect(effect.appliedAt).toBe(T)
  })

  it('leaves the finding\'s own sessions out of the baseline without reading them', async () => {
    const sessions = [...separated(4), { id: uuid(900), startedAt: T - 9_000, endedAt: T - 8_000, toolCalls: 99 }]
    const deps = fakeDeps(sessions)
    const byPath = appliedRecord({ sessionIds: [uuid(900), `/some/where/${uuid(3)}.jsonl`] })
    const effect = await measureCohortEffect(byPath, [], deps)
    expect(effect.baseline.map((s) => s.id)).not.toContain(uuid(900))
    expect(effect.baseline.map((s) => s.id)).not.toContain(uuid(3))
    expect(effect.skipped['evidence-session']).toBe(2)
    expect(deps.loaded).not.toContain(uuid(900))
  })

  it('counts a session resumed across the application in neither cohort', async () => {
    const sessions = [...separated(3), { id: uuid(500), startedAt: T - 5_000, endedAt: T + 60_000, toolCalls: 0 }]
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(sessions))
    expect([...effect.baseline, ...effect.later].map((s) => s.id)).not.toContain(uuid(500))
    expect(effect.skipped['spans-application']).toBe(1)
  })

  it('skips a session from another cwd that shares the project directory', async () => {
    const sessions = [...separated(3), { id: uuid(501), startedAt: T + 10_000, endedAt: T + 11_000, toolCalls: 0, cwd: '/w-other' }]
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(sessions))
    expect(effect.later.map((s) => s.id)).not.toContain(uuid(501))
    expect(effect.skipped['other-workspace']).toBe(1)
  })

  it('counts settling and unreadable sessions and keeps going', async () => {
    const sessions = [
      ...separated(3),
      // It starts after the 3 later sessions, so it does not hold the first checkpoint (see the settling tests below).
      { id: uuid(502), startedAt: T + 9_000, endedAt: T + 9_100, toolCalls: 0, skip: 'still-settling' as const },
      { id: uuid(503), startedAt: T - 900, endedAt: T - 800, toolCalls: 0, skip: 'unreadable' as const },
    ]
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(sessions))
    expect(effect.skipped['still-settling']).toBe(1)
    expect(effect.skipped.unreadable).toBe(1)
    expect(effect.baseline).toHaveLength(3)
    expect(effect.later).toHaveLength(3)
  })

  it('gives each side its own byte budget and stops a side, in order, once it is spent', async () => {
    // Four 64 MiB sessions (the per-session cap) spend one side's 256 MiB; that side stops there instead of
    // skipping ahead to smaller sessions, so session size cannot decide who is in a cohort.
    const sessions = separated(6).map((s) => ({ ...s, bytes: 64 * MiB }))
    sessions.push({ id: uuid(300), startedAt: T + 50_000, endedAt: T + 51_000, toolCalls: 0, bytes: 1_000 })
    const deps = fakeDeps(sessions)
    const effect = await measureCohortEffect(appliedRecord(), [], deps)
    expect(COHORT_SIDE_BYTES).toBe(256 * MiB)
    expect(effect.baseline).toHaveLength(4)
    expect(effect.later).toHaveLength(4)
    expect(effect.later.map((s) => s.id)).not.toContain(uuid(300))
    expect(effect.skipped['budget-spent']).toBe(2)
    expect(deps.loaded).toHaveLength(8)
  })

  it('skips a session over the per-session cap on either side and keeps reading', async () => {
    const sessions = [...separated(3), { id: uuid(301), startedAt: T + 500, endedAt: T + 600, toolCalls: 0, bytes: 100 * MiB }]
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(sessions))
    expect(effect.skipped['over-budget']).toBe(1)
    expect(effect.later).toHaveLength(3)
  })

  it("never counts orangu's own lifecycle sessions as evidence, so checking cannot manufacture a result", async () => {
    // Ten ordinary sessions before the change, then only short verify runs after it: without the rule the three
    // tiny verify sessions would beat the baseline at p = 1/286.
    const before = separated(10).filter((s) => s.startedAt < T)
    const verifyRuns = [0, 1, 2, 3].map((i) => ({ id: uuid(400 + i), startedAt: T + 10_000 * (i + 1), endedAt: T + 10_000 * (i + 1) + 500, toolCalls: 2, ranOrangu: true }))
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps([...before, ...verifyRuns]))
    expect(effect.later).toHaveLength(0)
    expect(effect.skipped['orangu-session']).toBe(4)
    expect(effect.verdict).toBe('not-enough-sessions')
    const withOranguBaseline = [...before.slice(0, 3).map((s) => ({ ...s, ranOrangu: true })), ...before.slice(3)]
    expect((await measureCohortEffect(appliedRecord(), [], fakeDeps(withOranguBaseline))).skipped['orangu-session']).toBe(3)
  })

  it('rechecks the workspace identity after reading the transcripts', async () => {
    const deps = fakeDeps(separated(3))
    let calls = 0
    deps.canonicalWorkspace = async () => {
      calls++
      if (calls > 1) throw new Error('invalid suggestion artifact: reviewed proposal workspace identity no longer matches')
      return WORKSPACE
    }
    await expect(measureCohortEffect(appliedRecord(), [], deps)).rejects.toThrow(/workspace identity no longer matches/)
    expect(calls).toBe(2)
  })

  it('reports not enough sessions below three per side', async () => {
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(separated(2)))
    expect(effect.verdict).toBe('not-enough-sessions')
    expect(() => verificationPatch(effect)).toThrow(/not verified: not-enough-sessions/)
  })

  it('reports within noise when the later sessions overlap the baseline', async () => {
    const sessions = separated(3).map((s, i) => ({ ...s, toolCalls: [5, 6, 7, 6, 5, 7][i]! }))
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps(sessions))
    expect(effect.verdict).toBe('within-noise')
    expect(() => verificationPatch(effect)).toThrow(/not verified: within-noise/)
  })
})

describe('nextStep', () => {
  it('says a full later cohort is final, and that a verified record needs nothing more', async () => {
    const overlap = separated(10).map((s) => ({ ...s, toolCalls: s.startedAt < T ? 5 + (s.toolCalls % 3) : 5 + ((s.toolCalls + 1) % 3) }))
    const full = await measureCohortEffect(appliedRecord(), [], fakeDeps(overlap))
    expect(full.verdict).toBe('within-noise')
    expect(nextStep(full)).toBe(
      'the complete checkpoint (10 of 10 later sessions) did not beat the baseline beyond chance. Record it as unproven: orangu suggest --record sg_aaaaaaaaaaaa',
    )
    const partial = await measureCohortEffect(appliedRecord(), [], fakeDeps(overlap.filter((s) => s.startedAt < T || s.startedAt < T + 5_000)))
    expect(partial.verdict).toBe('within-noise')
    expect(partial.laterCount).toBe(4)
    expect(nextStep(partial)).toBe(
      'the first checkpoint (the first 3 later sessions) did not beat the baseline beyond chance. That is not final. Orangu grades again when the later cohort is complete (4 of 10 so far)',
    )
    const done = await measureCohortEffect(appliedRecord({ status: 'verified' }), [], fakeDeps(separated(3)))
    expect(nextStep(done)).toBe('already recorded as verified')
    // A verified record names no step at any later verdict: --record and --set verified take an applied record only.
    const verifiedFull = await measureCohortEffect(appliedRecord({ status: 'verified' }), [], fakeDeps(overlap))
    expect(verifiedFull.verdict).toBe('within-noise')
    expect(nextStep(verifiedFull)).toBe('already recorded as verified')
    // A later side that spent its byte budget is final too: newer sessions are never read.
    const heavy = overlap.map((s) => (s.startedAt > T ? { ...s, bytes: 60 * MiB } : s))
    const budgetFull = await measureCohortEffect(appliedRecord(), [], fakeDeps(heavy))
    expect(budgetFull.later).toHaveLength(4)
    expect(budgetFull.laterComplete).toBe(true)
    expect(nextStep(budgetFull)).toBe(
      'the complete checkpoint (4 later sessions, the byte budget is spent) did not beat the baseline beyond chance. Record it as unproven: orangu suggest --record sg_aaaaaaaaaaaa',
    )
    const stranded = await measureCohortEffect(appliedRecord(), [], fakeDeps(heavy.map((s) => (s.startedAt > T ? { ...s, bytes: 100 * MiB } : s)).concat(
      separated(10).filter((s) => s.startedAt > T).slice(0, 2).map((s, i) => ({ ...s, id: uuid(700 + i), bytes: 120 * MiB })),
    )))
    expect(stranded.verdict).toBe('not-enough-sessions')
    expect(stranded.laterComplete).toBe(false)
  })
})

describe('ranOranguLifecycle', () => {
  it('recognises orangu skills, slash commands, and CLI calls, and nothing else', () => {
    const skill = (name: string) => ({ skills: [{ name }], toolCalls: [] })
    const bash = (command: string) => ({ skills: [], toolCalls: [{ name: 'Bash', input: { command } }] })
    for (const name of ['orangu:improve', 'orangu:apply', '/orangu:harness', 'orangu-analyze', 'orangu:feedback']) expect(ranOranguLifecycle(skill(name)), name).toBe(true)
    for (const command of ["orangu suggest --effect 'sg_0123456789ab' --json --quiet", 'node "/p/bin/orangu.cli.mjs" evidence latest --quiet', 'npx orangu harness --json']) {
      expect(ranOranguLifecycle(bash(command)), command).toBe(true)
    }
    for (const name of ['improve', 'code-review', 'my-orangutan']) expect(ranOranguLifecycle(skill(name)), name).toBe(false)
    for (const command of ['npm test', 'grep -r orangu src', 'node dist/orangu.js report --open', 'git log --oneline']) expect(ranOranguLifecycle(bash(command)), command).toBe(false)
    expect(ranOranguLifecycle({ skills: [], toolCalls: [{ name: 'Read', input: { file_path: 'orangu suggest' } }] })).toBe(false)
  })
})

describe('measureCohortEffect: confounders', () => {
  it('names other changes applied in the same workspace inside the window, both ways', async () => {
    const a = appliedRecord({ id: 'sg_aaaaaaaaaaaa', appliedAt: T })
    const b = appliedRecord({ id: 'sg_bbbbbbbbbbbb', appliedAt: T + 30 })
    const otherWorkspace = appliedRecord({ id: 'sg_cccccccccccc', appliedAt: T + 60 })
    otherWorkspace.proposal = { ...otherWorkspace.proposal!, workspace: { cwd: '/elsewhere', device: '1', inode: '3' } }
    const longBefore = appliedRecord({ id: 'sg_dddddddddddd', appliedAt: 5 })
    const neverApplied = appliedRecord({ id: 'sg_eeeeeeeeeeee', appliedAt: undefined, status: 'proposed', statusAt: T + 5 })
    const others = [a, b, otherWorkspace, longBefore, neverApplied]
    const sessions = separated(3).map((s) => (s.startedAt > T ? { ...s, startedAt: s.startedAt + 100, endedAt: s.endedAt + 100 } : s))
    expect((await measureCohortEffect(a, others, fakeDeps(sessions))).confoundedBy).toEqual(['sg_bbbbbbbbbbbb'])
    expect((await measureCohortEffect(b, others, fakeDeps(sessions))).confoundedBy).toEqual(['sg_aaaaaaaaaaaa'])
  })
})

describe('measureCohortEffect: preconditions', () => {
  it('refuses global scope, records that were never applied, and an unknown application time', async () => {
    const deps = fakeDeps(separated(3))
    await expect(measureCohortEffect(appliedRecord({ scope: 'global' }), [], deps)).rejects.toThrow(/global suggestions are review-only/)
    await expect(measureCohortEffect(appliedRecord({ status: 'proposed', appliedAt: undefined }), [], deps)).rejects.toThrow(/^suggestion sg_[0-9a-f]{12} is not applied \(status proposed\)$/)
    await expect(measureCohortEffect(appliedRecord({ status: 'verified', appliedAt: undefined }), [], deps)).rejects.toThrow(/application time is unknown/)
  })
})

describe('verificationPatch', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orangu-cohort-'))
  })

  it('produces a receipt the store accepts, for session and repo scope', async () => {
    for (const scope of ['session', 'repo'] as const) {
      const store = new SuggestionStore({ home: join(home, scope), now: () => T })
      const { record } = await store.upsertNew(
        { ruleId: 'reread-files', title: 't', scope, sessionIds: [uuid(900)], ...(scope === 'repo' ? { cohortFingerprint: '1111111111111111' } : {}), evidence: { estimated: true } },
        'report',
      )
      await store.transition(record.id, 'kicked-off')
      await store.transition(record.id, 'proposed', { proposal: appliedRecord().proposal! })
      const applied = await store.transition(record.id, 'applied', { application: { ...appliedRecord().application!, files: ['src/a.ts'] } })
      expect(applied.appliedAt).toBe(T)
      const effect = await measureCohortEffect(applied, [], fakeDeps(separated(3)))
      const verified = await store.transition(record.id, 'verified', verificationPatch(effect))
      expect(verified.verificationTrust).toBe('computed-v2')
      expect(verified.verificationReceipt).toMatchObject({ v: 2, baselineSessionIds: [uuid(0), uuid(1), uuid(2)], measuredSessionIds: [uuid(100), uuid(101), uuid(102)] })
      expect(verified.effect).toEqual({ before: { avgToolCalls: 21 }, after: { avgToolCalls: 2 }, measuredSessionIds: [uuid(100), uuid(101), uuid(102)] })
    }
  })
})

const DECREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'decreased' }
const NOT_INCREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'not-increased' }
const ID = 'sg_aaaaaaaaaaaa'
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index)
const zeroSkips = (): Record<CohortSkipReason, number> => Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>

/** The metrics that fakeDeps gives a session with this many tool calls. */
function metricsOf(toolCalls: number): Record<SuggestionVerificationMetric, number> {
  return { avgTotalTokens: 100, avgToolCalls: toolCalls, avgToolErrors: 0, avgActiveMs: 1_000, avgContextPeak: 10, avgTestRunsFailed: 0, avgBuildRunsFailed: 0, avgInterruptions: 0 }
}

/** Baseline sessions, 1 for each tool-call value, each ended before T. */
function baselineOf(values: number[]): FakeSession[] {
  return values.map((toolCalls, index) => ({ id: uuid(index), startedAt: T - 50_000 + index * 1_000, endedAt: T - 40_000 + index * 1_000, toolCalls }))
}

/** Later sessions in start order, 1 for each tool-call value. */
function laterOf(values: number[]): FakeSession[] {
  return values.map((toolCalls, index) => ({ id: uuid(100 + index), startedAt: T + 1_000 + index * 1_000, endedAt: T + 2_000 + index * 1_000, toolCalls }))
}

/** The frozen form of baselineOf(values): what freezeBaseline stores for those sessions at the cut T. */
function frozenOf(values: number[]): SuggestionFrozenBaseline {
  return {
    v: 1,
    cutAt: T,
    sessions: baselineOf(values).map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, metrics: metricsOf(s.toolCalls) })),
    skipped: zeroSkips(),
  }
}

describe('measureCohortEffect: the 2 checkpoints', () => {
  it('keeps the first verdict between the checkpoints: 5 later sessions, the first 3 within noise and the next 2 much lower', async () => {
    // All 5 would beat the baseline (p = 2/56). Orangu grades only the first 3 (p = 2/20) until the cohort is complete.
    expect(overallVerdict([evaluateCheck(DECREASED, [10, 11, 12], [8, 9, 10.5, 0, 0])], 3, 5)).toBe('verified')
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps([...baselineOf([10, 11, 12]), ...laterOf([8, 9, 10.5, 0, 0])]))
    expect(effect.verdict).toBe('within-noise')
    expect(effect.later.map((s) => s.id)).toEqual([uuid(100), uuid(101), uuid(102)])
    expect(effect.laterCount).toBe(5)
    expect(effect.laterComplete).toBe(false)
    expect(effectFinality(effect)).toEqual({ checkpoint: 'first', final: false })
    expect(() => verificationPatch(effect)).toThrow(/not verified: within-noise/)
  })

  it('keeps the graded set and the first verdict when a resume moves a later session to the newest file time', async () => {
    // Claude Code appends a resumed session to its own file, so its mtime moves past the later sessions after it.
    // Its start time does not move, so the first checkpoint still grades sessions 1 to 3.
    const record = appliedRecord({ frozenBaseline: frozenOf([10, 11, 12]) })
    const later = laterOf([10.5, 8, 9, 0, 0])
    const look1 = await measureCohortEffect(record, [], fakeDeps(later))
    expect(look1.later.map((s) => s.id)).toEqual([uuid(100), uuid(101), uuid(102)])
    expect(look1.verdict).toBe('within-noise')
    expect(effectFinality(look1)).toEqual({ checkpoint: 'first', final: false })
    // Sessions 2 to 4 alone would beat the baseline, so a graded set by file time would give a final win.
    expect(overallVerdict([evaluateCheck(DECREASED, [10, 11, 12], [8, 9, 0])], 3, 3)).toBe('verified')
    const resumed = later.map((s, index) => (index === 0 ? { ...s, endedAt: T + 20_000 } : s))
    const look2 = await measureCohortEffect(record, [], fakeDeps(resumed))
    expect(look2.later.map((s) => s.id)).toEqual([uuid(100), uuid(101), uuid(102)])
    expect(look2.checks).toEqual(look1.checks)
    expect(look2.verdict).toBe('within-noise')
    expect(effectFinality(look2)).toEqual({ checkpoint: 'first', final: false })
    expect(() => verificationPatch(look2)).toThrow(/not verified: within-noise/)
  })

  it('records a first-checkpoint win with the first 3 later sessions only', async () => {
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps([...baselineOf([20, 21, 22]), ...laterOf([1, 2, 3, 30, 31])]))
    expect(effect.verdict).toBe('verified')
    expect(effectFinality(effect)).toEqual({ checkpoint: 'first', final: true })
    const { verificationReceipt } = verificationPatch(effect)
    expect(verificationReceipt.measuredSessionIds).toEqual([uuid(100), uuid(101), uuid(102)])
    expect(verificationReceipt.checks[0]).toMatchObject({ before: 21, after: 2 })
  })

  it('grades the complete cohort at 10 later sessions, also when the first verdict was verified', async () => {
    const values = [1, 2, 3, 30, 31, 32, 33, 34, 35, 36]
    const first = await measureCohortEffect(appliedRecord(), [], fakeDeps([...baselineOf([20, 21, 22]), ...laterOf(values.slice(0, 3))]))
    expect(first.verdict).toBe('verified')
    const complete = await measureCohortEffect(appliedRecord(), [], fakeDeps([...baselineOf([20, 21, 22]), ...laterOf(values)]))
    expect(complete.later).toHaveLength(10)
    expect(effectFinality(complete)).toEqual({ checkpoint: 'complete', final: true })
    expect(complete.verdict).toBe(overallVerdict([evaluateCheck(DECREASED, [20, 21, 22], values)], 3, 10))
    expect(complete.verdict).toBe('within-noise')
  })

  it('names the confounders of the graded sessions only', async () => {
    // A change applied after the 3rd later session ended confounds sessions 4 and 5, which the first checkpoint does not grade.
    const other = appliedRecord({ id: 'sg_bbbbbbbbbbbb', appliedAt: T + 4_500 })
    const effect = await measureCohortEffect(appliedRecord(), [other], fakeDeps([...baselineOf([10, 11, 12]), ...laterOf([8, 9, 10.5, 0, 0])]))
    expect(effect.confoundedBy).toEqual([])
    const complete = await measureCohortEffect(appliedRecord(), [other], fakeDeps([...baselineOf([10, 11, 12]), ...laterOf(range(0, 10))]))
    expect(complete.confoundedBy).toEqual(['sg_bbbbbbbbbbbb'])
  })
})

describe('measureCohortEffect: a later session that still settles', () => {
  // S0 starts first and settles last: its transcript is the newest, so the read takes it last.
  const s0 = (toolCalls: number): FakeSession => ({ id: uuid(164), startedAt: T + 500, endedAt: T + 30_000, toolCalls })
  /** sessions 65, 66 and 67, in start order, each settled */
  const after = (values: number[]): FakeSession[] =>
    values.map((toolCalls, index) => ({ id: uuid(165 + index), startedAt: T + 1_000 + index * 1_000, endedAt: T + 2_000 + index * 1_000, toolCalls }))
  const settling = (s: FakeSession): FakeSession => ({ ...s, skip: 'still-settling' })
  const record = (): SuggestionRecord => appliedRecord({ frozenBaseline: frozenOf([10, 11, 12]) })

  it('holds the first checkpoint while a session that started before the third graded one settles', async () => {
    // Look 1 grades 65, 66 and 67 while S0 settles. Look 2 grades 64, 65 and 66 after S0 settles, and that is a win.
    expect(overallVerdict([evaluateCheck(DECREASED, [10, 11, 12], [8, 9, 10.5])], 3, 3)).toBe('within-noise')
    const look1 = await measureCohortEffect(record(), [], fakeDeps([settling(s0(0)), ...after([8, 9, 10.5])]))
    expect(look1.firstWaits).toBe(true)
    expect(look1.laterCount).toBe(3)
    // No later session starts before S0, so no later session is graded yet.
    expect(look1.later).toEqual([])
    expect(look1.verdict).toBe('not-enough-sessions')
    expect(effectFinality(look1)).toEqual({ checkpoint: null, final: false })
    expect(nextStep(look1)).toBe('the first checkpoint waits until a later session that started before the third one settles (has 3 before, 3 after)')
    expect(() => verificationPatch(look1)).toThrow(/^not verified: not-enough-sessions/)
    expect(() => outcomePatch(look1)).toThrow(/^not final: /)

    const look2 = await measureCohortEffect(record(), [], fakeDeps([s0(0), ...after([8, 9, 10.5])]))
    expect(look2.firstWaits).toBe(false)
    expect(look2.later.map((s) => s.id)).toEqual([uuid(164), uuid(165), uuid(166)])
    expect(look2.verdict).toBe('verified')
    expect(effectFinality(look2)).toEqual({ checkpoint: 'first', final: true })
  })

  it('gives no early win that the settling session would take back', async () => {
    // 65, 66 and 67 alone beat the baseline, and S0 with them does not.
    expect(overallVerdict([evaluateCheck(DECREASED, [10, 11, 12], [0, 1, 2])], 3, 3)).toBe('verified')
    expect(overallVerdict([evaluateCheck(DECREASED, [10, 11, 12], [30, 0, 1])], 3, 3)).toBe('within-noise')
    const look1 = await measureCohortEffect(record(), [], fakeDeps([settling(s0(30)), ...after([0, 1, 2])]))
    expect(effectFinality(look1)).toEqual({ checkpoint: null, final: false })
    expect(() => verificationPatch(look1)).toThrow(/^not verified: /)
    const look2 = await measureCohortEffect(record(), [], fakeDeps([s0(30), ...after([0, 1, 2])]))
    expect(look2.verdict).toBe('within-noise')
    expect(effectFinality(look2)).toEqual({ checkpoint: 'first', final: false })
  })

  it('grades the sessions that start before the settling one', async () => {
    // S0 starts after 65 and before 66: only 65 is fixed, so the graded set is 65 alone.
    const late = { ...s0(0), startedAt: T + 1_500 }
    const effect = await measureCohortEffect(record(), [], fakeDeps([settling(late), ...after([8, 9, 10.5])]))
    expect(effect.later.map((s) => s.id)).toEqual([uuid(165)])
    expect(effectFinality(effect)).toEqual({ checkpoint: null, final: false })
  })

  it('does not wait for a session that started after the third graded one, or before the application', async () => {
    const afterThird = { ...s0(0), startedAt: T + 3_500 }
    const live = await measureCohortEffect(record(), [], fakeDeps([settling(afterThird), ...after([0, 1, 2])]))
    expect(live.firstWaits).toBe(false)
    expect(effectFinality(live)).toEqual({ checkpoint: 'first', final: true })
    // A session that started before the change spans it, so it can never join the later side.
    const spans = { ...s0(0), startedAt: T - 500 }
    const old = await measureCohortEffect(record(), [], fakeDeps([settling(spans), ...after([0, 1, 2])]))
    expect(old.firstWaits).toBe(false)
    expect(effectFinality(old)).toEqual({ checkpoint: 'first', final: true })
  })

  it('waits for a settling session whose start time the loader could not read', async () => {
    const unknown = { ...settling(s0(0)), startedAt: T + 9_000, startUnknown: true }
    const effect = await measureCohortEffect(record(), [], fakeDeps([unknown, ...after([0, 1, 2])]))
    expect(effect.firstWaits).toBe(true)
    expect(effectFinality(effect)).toEqual({ checkpoint: null, final: false })
  })

  it('does not wait at the complete checkpoint', async () => {
    // S0 was last written before the 5th later session, so the read reaches it before the cohort holds 10.
    const early = { ...settling(s0(0)), endedAt: T + 5_500 }
    const effect = await measureCohortEffect(record(), [], fakeDeps([early, ...after(range(0, 10))]))
    expect(effect.skipped['still-settling']).toBe(1)
    expect(effect.laterComplete).toBe(true)
    expect(effect.firstWaits).toBe(false)
    expect(effect.later).toHaveLength(10)
    expect(effectFinality(effect).checkpoint).toBe('complete')
  })

  it('spends no later budget on a settling session, so its bytes cannot complete the cohort', async () => {
    // 65 and 66 take 128 MiB. A crashed session with a partial last line (S) is read for 64 MiB and skipped as
    // settling. 67 and 68 take the rest of the 256 MiB. S started after 67, so it does not hold the first checkpoint.
    const mib64 = (s: FakeSession): FakeSession => ({ ...s, bytes: 64 * MiB })
    const [a, b, c, fourth] = after([8, 9, 10.5, 0]).map(mib64)
    // S was last written between 66 and 67, so the read reaches it before 67.
    const s = mib64({ id: uuid(170), startedAt: T + 3_500, endedAt: T + 3_600, toolCalls: 0 })
    const look1 = await measureCohortEffect(record(), [], fakeDeps([a!, b!, settling(s), c!, fourth!]))
    expect(look1.skipped['still-settling']).toBe(1)
    // The 64 MiB of S count toward the 256 MiB that the side reads, so 68 is not read. A stop on them is not complete.
    expect(look1.skipped['budget-spent']).toBe(1)
    expect(look1.laterComplete).toBe(false)
    expect(look1.later.map((x) => x.id)).toEqual([uuid(165), uuid(166), uuid(167)])
    expect(effectFinality(look1)).toEqual({ checkpoint: 'first', final: false })
    expect(() => outcomePatch(look1)).toThrow(/^not final: /)
    // After S settles, the budget is spent before 68, and the complete cohort holds S.
    const look2 = await measureCohortEffect(record(), [], fakeDeps([a!, b!, s, c!, fourth!]))
    expect(look2.laterComplete).toBe(true)
    expect(look2.later.map((x) => x.id)).toEqual([uuid(165), uuid(166), uuid(167), uuid(170)])
  })

  it('reads at most 256 MiB on each side, settling sessions included', async () => {
    // 40 settling sessions on each side, each read for 64 MiB, then 3 settled ones on each side.
    const heavy = (s: FakeSession): FakeSession => ({ ...s, bytes: 64 * MiB, skip: 'still-settling' })
    const before = range(0, 40).map((i) => heavy({ id: uuid(300 + i), startedAt: T - 90_000 + i * 1_000, endedAt: T - 50_000 + i * 1_000, toolCalls: 0 }))
    const laterHeavy = range(0, 40).map((i) => heavy({ id: uuid(400 + i), startedAt: T + 500 + i, endedAt: T + 1_000 + i * 10, toolCalls: 0 }))
    const laterSessions = [...laterHeavy, ...laterOf([1, 2, 3])]
    const laterIds = new Set(laterSessions.map((s) => s.id))
    const deps = fakeDeps([...before, ...baselineOf([10, 11, 12]), ...laterSessions])
    const read = { baseline: 0, later: 0 }
    const load = deps.loadCandidate.bind(deps)
    deps.loadCandidate = async (candidate, maxBytes) => {
      const loaded = await load(candidate, maxBytes)
      read[laterIds.has(candidate.sessionId) ? 'later' : 'baseline'] += loaded.bytesRead
      return loaded
    }
    const effect = await measureCohortEffect(appliedRecord(), [], deps)
    expect(read.baseline).toBeLessThanOrEqual(COHORT_SIDE_BYTES)
    expect(read.later).toBeLessThanOrEqual(COHORT_SIDE_BYTES)
    expect(read.later).toBeGreaterThan(0)
    // The stops come from settling bytes, so neither side is complete and nothing is final.
    expect(effect.laterComplete).toBe(false)
    expect(effectFinality(effect).final).toBe(false)
  })
})

describe('measureCohortEffect: the frozen baseline', () => {
  it('grades against the frozen sessions and reads no baseline transcript', async () => {
    // The transcripts before the change now hold other numbers: the frozen ones decide, and none of them is read.
    const deps = fakeDeps([...baselineOf([1, 1, 1]), ...laterOf([1, 2, 3])])
    const frozen = { ...frozenOf([20, 21, 22]), skipped: { ...zeroSkips(), 'still-settling': 2 } }
    const effect = await measureCohortEffect(appliedRecord({ frozenBaseline: frozen }), [], deps)
    expect(effect.baselineFrozen).toBe(true)
    expect(effect.baseline).toEqual(frozen.sessions)
    expect(deps.loaded).toEqual([uuid(100), uuid(101), uuid(102)])
    expect(effect.checks[0]).toMatchObject({ before: 21, beforeMedian: 21, after: 2 })
    expect(effect.verdict).toBe('verified')
    expect(effect.skipped['still-settling']).toBe(2)
    // The record is not changed by the read.
    expect(frozen.sessions).toEqual(frozenOf([20, 21, 22]).sessions)
  })

  it('takes the confounder window from the stored times of the frozen sessions', async () => {
    const frozen = frozenOf([20, 21, 22])
    // The frozen sessions start at 5,000. A change applied at 6,000 falls inside their window and before any later session.
    frozen.sessions = frozen.sessions.map((s) => ({ ...s, startedAt: s.startedAt - 45_000, endedAt: s.endedAt - 45_000 }))
    const other = appliedRecord({ id: 'sg_bbbbbbbbbbbb', appliedAt: 6_000 })
    const effect = await measureCohortEffect(appliedRecord({ frozenBaseline: frozen }), [other], fakeDeps(laterOf([1, 2, 3])))
    expect(effect.confoundedBy).toEqual(['sg_bbbbbbbbbbbb'])
  })

  it('never counts a frozen session on the later side', async () => {
    // A frozen session id among the later candidates (a transcript resumed after the change) is skipped.
    const resumed = { ...laterOf([1])[0]!, id: uuid(0) }
    const effect = await measureCohortEffect(appliedRecord({ frozenBaseline: frozenOf([20, 21, 22]) }), [], fakeDeps([resumed, ...laterOf([1, 2, 3])]))
    expect(effect.later.map((s) => s.id)).toEqual([uuid(100), uuid(101), uuid(102)])
  })

  it('refuses a stored frozen baseline that fails its own check, before it reads a transcript', async () => {
    const good = frozenOf([20, 21, 22])
    const bad: Array<[string, unknown]> = [
      ['a cut after the application time', { ...good, cutAt: T + 1 }],
      ['a metric that is not a number', { ...good, sessions: [{ ...good.sessions[0]!, metrics: { ...good.sessions[0]!.metrics, avgToolCalls: 'many' } }, ...good.sessions.slice(1)] }],
      ['an extra key', { ...good, note: 'text' }],
      ['an uppercase id', { ...good, sessions: [{ ...good.sessions[0]!, id: good.sessions[0]!.id.toUpperCase() }, ...good.sessions.slice(1)] }],
    ]
    for (const [label, frozenBaseline] of bad) {
      const deps = fakeDeps(laterOf([1, 2, 3]))
      await expect(measureCohortEffect(appliedRecord({ frozenBaseline: frozenBaseline as SuggestionFrozenBaseline }), [], deps), label).rejects.toThrow(
        /^suggestion sg_aaaaaaaaaaaa: its frozen baseline is not valid \(/,
      )
      expect(deps.loaded, label).toEqual([])
    }
  })
})

describe('freezeBaseline', () => {
  const proposedRecord = (over: Partial<SuggestionRecord> = {}): SuggestionRecord => {
    const { application, appliedAt, ...rest } = appliedRecord({ status: 'proposed', statusAt: T - 10, ...over })
    void application
    void appliedAt
    return rest
  }

  it('freezes the 10 most recent settled baseline sessions before the cut with the take rules, sorted by id', async () => {
    const sessions: FakeSession[] = [
      ...separated(12),
      { id: uuid(900), startedAt: T - 9_000, endedAt: T - 8_000, toolCalls: 99 },
      { id: uuid(501), startedAt: T - 7_000, endedAt: T - 6_000, toolCalls: 0, skip: 'still-settling' },
      { id: uuid(502), startedAt: T - 5_000, endedAt: T - 4_000, toolCalls: 0, cwd: '/w-other' },
      { id: uuid(503), startedAt: T - 3_000, endedAt: T - 2_000, toolCalls: 0, ranOrangu: true },
    ]
    const deps = { ...fakeDeps(sessions), now: () => T }
    const frozen = await freezeBaseline(proposedRecord(), [], deps)
    expect(Object.keys(frozen)).toEqual(['v', 'cutAt', 'sessions', 'skipped'])
    expect(frozen.v).toBe(1)
    expect(frozen.cutAt).toBe(T)
    // The 10 most recent of uuid(0) to uuid(11), stored sorted by id.
    expect(frozen.sessions.map((s) => s.id)).toEqual(range(2, 10).map(uuid))
    expect(frozen.sessions[0]).toEqual({ id: uuid(2), startedAt: T - 48_000, endedAt: T - 38_000, metrics: metricsOf(22) })
    expect(frozen.skipped).toEqual({ ...zeroSkips(), 'evidence-session': 1, 'still-settling': 1, 'other-workspace': 1, 'orangu-session': 1 })
    // Newest first, as the take rules read: no session after the cut, not the finding's own session, and nothing past the 10th.
    expect(deps.loaded).toEqual([uuid(503), uuid(502), uuid(501), ...range(2, 10).reverse().map(uuid)])
  })

  it('stores exactly the 8 verification metrics of each session, whatever the loader adds', async () => {
    const base = fakeDeps(baselineOf([5, 6, 7]))
    const deps: CohortDeps & { now: () => number } = {
      ...base,
      now: () => T,
      async loadCandidate(candidate, maxBytes) {
        const loaded = await base.loadCandidate(candidate, maxBytes)
        if ('skip' in loaded) return loaded
        return { ...loaded, session: { ...loaded.session, metrics: { ...loaded.session.metrics, avgSecretTokens: 7 } as CohortSession['metrics'] } }
      },
    }
    const frozen = await freezeBaseline(proposedRecord(), [], deps)
    expect(frozen.sessions.map((s) => s.metrics)).toEqual([metricsOf(5), metricsOf(6), metricsOf(7)])
  })

  it('freezes 0 sessions as a valid baseline, and takes the cut from the clock by default', async () => {
    const before = Date.now()
    const frozen = await freezeBaseline(proposedRecord(), [], fakeDeps([]))
    expect(frozen.sessions).toEqual([])
    expect(frozen.cutAt).toBeGreaterThanOrEqual(before)
    expect(frozen.cutAt).toBeLessThanOrEqual(Date.now())
  })

  it('refuses global scope, a record that is not proposed, a record with no reviewed checks, and a bad clock', async () => {
    const deps = { ...fakeDeps(baselineOf([5, 6, 7])), now: () => T }
    await expect(freezeBaseline(proposedRecord({ scope: 'global' }), [], deps)).rejects.toThrow(/global suggestions are review-only/)
    await expect(freezeBaseline(appliedRecord(), [], deps)).rejects.toThrow(/^suggestion sg_aaaaaaaaaaaa is not proposed \(status applied\), so it has no baseline to freeze$/)
    const noChecks = proposedRecord()
    noChecks.proposal = { ...noChecks.proposal!, verificationChecks: [] }
    await expect(freezeBaseline(noChecks, [], deps)).rejects.toThrow(/has no reviewed verification checks and workspace/)
    for (const now of [Number.NaN, 0, -1]) {
      await expect(freezeBaseline(proposedRecord(), [], { ...deps, now: () => now }), String(now)).rejects.toThrow(/the clock gave no valid cut time/)
    }
    expect(deps.loaded).toEqual([])
  })

  it('refuses a value that fails the frozen-baseline check, so the apply step writes no frozen baseline', async () => {
    const deps = { ...fakeDeps([{ id: uuid(0), startedAt: T - 5_000, endedAt: T - 4_000, toolCalls: Number.NaN }]), now: () => T }
    await expect(freezeBaseline(proposedRecord(), [], deps)).rejects.toThrow(/^suggestion sg_aaaaaaaaaaaa: the baseline cannot be frozen \(.*finite number of 0 or more\)$/)
  })

  it('rechecks the workspace identity after reading the transcripts', async () => {
    const deps = { ...fakeDeps(baselineOf([5, 6, 7])), now: () => T }
    let calls = 0
    deps.canonicalWorkspace = async () => {
      calls++
      if (calls > 1) throw new Error('invalid suggestion artifact: reviewed proposal workspace identity no longer matches')
      return WORKSPACE
    }
    await expect(freezeBaseline(proposedRecord(), [], deps)).rejects.toThrow(/workspace identity no longer matches/)
    expect(calls).toBe(2)
  })
})

/**
 * The 9 rows of the verdict table: the checkpoint, the computed verdict, whether it is final, what `--set verified`
 * gets (verificationPatch) and what `--record` gets (outcomePatch), with the pinned next step of each row.
 */
describe('effectFinality, nextStep, verificationPatch and outcomePatch: the 9 rows of the verdict table', () => {
  interface Row {
    row: string
    frozen?: number[]
    live?: number[]
    later: FakeSession[]
    intent?: SuggestionVerificationIntent
    checkpoint: 'first' | 'complete' | null
    verdict: CohortEffect['verdict']
    final: boolean
    leaning?: 'worse'
    next: string
    /** what verificationPatch gives: a receipt, or the refusal */
    set: 'verified' | RegExp
    /** what outcomePatch gives: the status it closes with, or the refusal */
    record: 'regressed' | 'unproven' | RegExp
  }
  const notFinal = /^not final: /
  const toVerified = /^record it as verified: orangu suggest --set sg_aaaaaaaaaaaa verified$/
  const firstNotFinal = (count: number): string =>
    `the first checkpoint (the first 3 later sessions) did not beat the baseline beyond chance. That is not final. Orangu grades again when the later cohort is complete (${count} of 10 so far)`
  const completeUnproven = (label: string): string =>
    `the complete checkpoint (${label}) did not beat the baseline beyond chance. Record it as unproven: orangu suggest --record sg_aaaaaaaaaaaa`
  const shortFrozen = (count: number): string =>
    `the frozen baseline has ${count} of the 3 sessions that a verdict needs, and it cannot change. Record it as unproven: orangu suggest --record sg_aaaaaaaaaaaa`
  /** Before a checkpoint, the short frozen baseline keeps the phrase of every row that waits for sessions. */
  const shortFrozenEarly = (before: number, after: number): string =>
    `needs at least 3 settled sessions on each side (has ${before} before, ${after} after). The frozen baseline cannot change. Record it as unproven: orangu suggest --record sg_aaaaaaaaaaaa`
  const olderShort = (before: number, after: number): string =>
    `needs at least 3 settled sessions on each side (has ${before} before, ${after} after). This older record has no frozen baseline, so orangu cannot record a verdict. Reject it: orangu suggest --set sg_aaaaaaaaaaaa rejected --reason other`
  /** 2 sessions of 64 MiB fill half the later budget, 2 unreadable ones of 64 MiB spend the rest, and a fifth is never read. */
  const budgetAtTwo: FakeSession[] = laterOf([4, 5, 0, 0, 4]).map((s, index) =>
    index < 2 ? { ...s, bytes: 64 * MiB } : index < 4 ? { ...s, bytes: 64 * MiB, skip: 'unreadable' as const } : s,
  )

  const rows: Row[] = [
    {
      row: '1 none yet: fewer than 3 later sessions',
      frozen: [20, 21, 22], later: laterOf([1, 2]),
      checkpoint: null, verdict: 'not-enough-sessions', final: false,
      next: 'needs at least 3 settled sessions on each side (has 3 before, 2 after). Orangu grades at 3 and at 10 later sessions',
      set: /^not verified: not-enough-sessions/, record: notFinal,
    },
    {
      row: '2 first, verified',
      frozen: [20, 21, 22], later: laterOf([1, 2, 3]),
      checkpoint: 'first', verdict: 'verified', final: true,
      next: 'the first checkpoint (the first 3 later sessions) beat the baseline beyond chance. Record it: orangu suggest --set sg_aaaaaaaaaaaa verified',
      set: 'verified', record: toVerified,
    },
    {
      row: '3 first, regressed: not final, leaning worse',
      frozen: [1, 2, 3], later: laterOf([20, 21, 22, 23]),
      checkpoint: 'first', verdict: 'regressed', final: false, leaning: 'worse',
      next: 'the first checkpoint (the first 3 later sessions) leans worse: a check moved the wrong way beyond chance. That is not final. Orangu grades again when the later cohort is complete (4 of 10 so far)',
      set: /^not verified: regressed/, record: notFinal,
    },
    {
      row: '4 first, within noise',
      frozen: [5, 6, 7], later: laterOf([6, 5, 7]),
      checkpoint: 'first', verdict: 'within-noise', final: false,
      next: firstNotFinal(3), set: /^not verified: within-noise/, record: notFinal,
    },
    {
      row: '4 first, no directional check',
      frozen: [5, 6, 7], later: laterOf([6, 5, 7]), intent: NOT_INCREASED,
      checkpoint: 'first', verdict: 'no-directional-check', final: false,
      next: firstNotFinal(3), set: /^not verified: no-directional-check/, record: notFinal,
    },
    {
      row: '5 complete, verified',
      frozen: range(20, 10), later: laterOf(range(0, 10)),
      checkpoint: 'complete', verdict: 'verified', final: true,
      next: 'the complete checkpoint (10 of 10 later sessions) beat the baseline beyond chance. Record it: orangu suggest --set sg_aaaaaaaaaaaa verified',
      set: 'verified', record: toVerified,
    },
    {
      row: '6 complete, regressed',
      frozen: [1, 2, 3], later: laterOf(range(20, 10)),
      checkpoint: 'complete', verdict: 'regressed', final: true,
      next: 'the complete checkpoint (10 of 10 later sessions) found a check that moved the wrong way beyond chance. Record it as regressed: orangu suggest --record sg_aaaaaaaaaaaa',
      set: /^not verified: regressed/, record: 'regressed',
    },
    {
      row: '7 complete, within noise',
      frozen: [5, 6, 7], later: laterOf([6, 5, 7, 6, 5, 7, 6, 5, 7, 6]),
      checkpoint: 'complete', verdict: 'within-noise', final: true,
      next: completeUnproven('10 of 10 later sessions'), set: /^not verified: within-noise/, record: 'unproven',
    },
    {
      row: '7 complete, no directional check',
      frozen: [5, 6, 7], later: laterOf([6, 5, 7, 6, 5, 7, 6, 5, 7, 6]), intent: NOT_INCREASED,
      checkpoint: 'complete', verdict: 'no-directional-check', final: true,
      next: completeUnproven('10 of 10 later sessions'), set: /^not verified: no-directional-check/, record: 'unproven',
    },
    {
      row: '7 complete, not enough sessions: the byte budget is spent at 2',
      frozen: [5, 6, 7], later: budgetAtTwo,
      checkpoint: 'complete', verdict: 'not-enough-sessions', final: true,
      next: completeUnproven('2 later sessions, the byte budget is spent'), set: /^not verified: not-enough-sessions/, record: 'unproven',
    },
    ...[[], [4], [4, 5, 6, 7, 8], range(4, 10)].map((values): Row => ({
      row: `8 a frozen baseline below 3, ${values.length} later sessions`,
      frozen: [5, 6], later: laterOf(values),
      checkpoint: values.length >= 10 ? 'complete' : values.length >= 3 ? 'first' : null, verdict: 'not-enough-sessions', final: true,
      next: values.length >= 3 ? shortFrozen(2) : shortFrozenEarly(2, values.length), set: /^not verified: not-enough-sessions/, record: 'unproven',
    })),
    {
      row: '8 a frozen baseline of 0 sessions',
      frozen: [], later: laterOf([4]),
      checkpoint: null, verdict: 'not-enough-sessions', final: true,
      next: shortFrozenEarly(0, 1), set: /^not verified: not-enough-sessions/, record: 'unproven',
    },
    ...[[4, 5, 6], range(4, 10)].map((values): Row => ({
      row: `9 an older record with a live baseline below 3, ${values.length} later sessions`,
      live: [5, 6], later: laterOf(values),
      checkpoint: values.length >= 10 ? 'complete' : 'first', verdict: 'not-enough-sessions', final: false,
      next: olderShort(2, values.length), set: /^not verified: not-enough-sessions/, record: notFinal,
    })),
  ]

  it.each(rows)('row $row', async (row) => {
    const record = appliedRecord(row.frozen ? { frozenBaseline: frozenOf(row.frozen) } : {}, [row.intent ?? DECREASED])
    const effect = await measureCohortEffect(record, [], fakeDeps([...baselineOf(row.live ?? []), ...row.later]))
    expect(effect.verdict).toBe(row.verdict)
    expect(effect.baselineFrozen).toBe(row.frozen !== undefined)
    expect(effectFinality(effect)).toEqual({ checkpoint: row.checkpoint, final: row.final, ...(row.leaning ? { leaning: row.leaning } : {}) })
    expect(nextStep(effect)).toBe(row.next)
    // The next step names the record step exactly on the rows where it writes.
    expect(nextStep(effect).includes(`orangu suggest --record ${ID}`)).toBe(row.record === 'regressed' || row.record === 'unproven')
    if (row.set === 'verified') expect(verificationPatch(effect).verificationReceipt.v).toBe(2)
    else expect(() => verificationPatch(effect)).toThrow(row.set)
    if (row.record instanceof RegExp) expect(() => outcomePatch(effect)).toThrow(row.record)
    else {
      const { outcomeReceipt } = outcomePatch(effect)
      expect(outcomeReceipt.verdict === 'regressed' ? 'regressed' : 'unproven').toBe(row.record)
      expect(outcomeReceipt.checkpoint).toBe(effect.laterComplete ? 'complete' : 'first')
    }
  })

  it('names the not-final step in the refusal of outcomePatch', async () => {
    const effect = await measureCohortEffect(appliedRecord(), [], fakeDeps([...baselineOf([5, 6]), ...laterOf([4, 5, 6])]))
    expect(() => outcomePatch(effect)).toThrow(`not final: not-enough-sessions. ${olderShort(2, 3)}`)
  })
})

describe('outcomePatch', () => {
  it('builds an outcome receipt of numbers, ids and enum values only, with exactly 10 keys on each check', async () => {
    const effect = await measureCohortEffect(appliedRecord({ frozenBaseline: frozenOf([1, 2, 3]) }), [], fakeDeps(laterOf(range(20, 10))))
    const patch = outcomePatch(effect)
    expect(Object.keys(patch)).toEqual(['outcomeReceipt'])
    const receipt = patch.outcomeReceipt
    expect(Object.keys(receipt)).toEqual(['v', 'method', 'alpha', 'appliedAt', 'checkpoint', 'verdict', 'laterComplete', 'confoundedBy', 'baselineSessionIds', 'measuredSessionIds', 'checks'])
    const graded = evaluateCheck(DECREASED, [1, 2, 3], range(20, 10))
    expect(receipt).toEqual({
      v: 1,
      method: 'cohort-rank-v1',
      alpha: 0.05,
      appliedAt: T,
      checkpoint: 'complete',
      verdict: 'regressed',
      laterComplete: true,
      confoundedBy: [],
      baselineSessionIds: [uuid(0), uuid(1), uuid(2)],
      measuredSessionIds: range(100, 10).map(uuid),
      checks: [
        {
          metric: 'avgToolCalls', comparison: 'decreased', name: 'avgToolCalls decreased', before: 2, after: 24.5, beforeMedian: 2, afterMedian: 24.5,
          pLower: graded.pLower, pHigher: graded.pHigher, verdict: 'regressed',
        },
      ],
    } satisfies SuggestionOutcomeReceipt)
    expect(Object.keys(receipt.checks[0]!)).toHaveLength(10)
    expect(JSON.stringify(receipt)).not.toMatch(/evidence|summary|leaning/)
  })

  it('refuses a record that is not applied', async () => {
    const effect = await measureCohortEffect(appliedRecord({ status: 'verified', frozenBaseline: frozenOf([1, 2, 3]) }), [], fakeDeps(laterOf(range(20, 10))))
    expect(() => outcomePatch(effect)).toThrow(/^suggestion sg_aaaaaaaaaaaa is not applied \(status verified\)$/)
  })
})

describe('freezeBaseline and outcomePatch through the store', () => {
  let home: string
  let store: SuggestionStore
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orangu-cohort-store-'))
    store = new SuggestionStore({ home, now: () => T })
  })

  /** A record moved to applied through the store, with the baseline that freezeBaseline froze from these sessions. */
  async function appliedThroughStore(ruleId: string, baseline: number[], intent: SuggestionVerificationIntent = DECREASED): Promise<SuggestionRecord> {
    const { record } = await store.upsertNew({ ruleId, title: 't', scope: 'session', sessionIds: [uuid(900)], evidence: { estimated: true } }, 'report')
    await store.transition(record.id, 'kicked-off')
    const proposed = await store.transition(record.id, 'proposed', { proposal: appliedRecord({}, [intent]).proposal! })
    const frozenBaseline = await freezeBaseline(proposed, [], { ...fakeDeps(baselineOf(baseline)), now: () => T })
    return store.transition(record.id, 'applied', { application: appliedRecord().application!, frozenBaseline })
  }

  async function refusedUnchanged(attempt: () => Promise<unknown>, message: RegExp, label: string): Promise<void> {
    const before = readFileSync(store.path)
    await expect(attempt(), label).rejects.toThrow(message)
    expect(readFileSync(store.path), label).toEqual(before)
  }

  /** The receipt with 1 change to its only check. */
  const withCheck = (receipt: SuggestionOutcomeReceipt, change: (check: Record<string, unknown>) => Record<string, unknown>): SuggestionOutcomeReceipt =>
    ({ ...receipt, checks: [change({ ...receipt.checks[0]! }) as never] })

  it('grades the same baseline numbers with every baseline transcript gone', async () => {
    const applied = await appliedThroughStore('e2e-same-numbers', [20, 21, 25])
    expect(applied.frozenBaseline?.sessions.map((s) => s.id)).toEqual([uuid(0), uuid(1), uuid(2)])
    const live = await measureCohortEffect({ ...applied, frozenBaseline: undefined }, [], fakeDeps([...baselineOf([20, 21, 25]), ...laterOf([1, 2, 3])]))
    const frozen = await measureCohortEffect(applied, [], fakeDeps(laterOf([1, 2, 3])))
    expect(frozen.checks).toEqual(live.checks)
    expect(frozen.baseline.map((s) => s.id).sort()).toEqual(live.baseline.map((s) => s.id).sort())
    await expect(store.transition(applied.id, 'verified', verificationPatch(frozen))).resolves.toMatchObject({ status: 'verified', verificationTrust: 'computed-v2' })
  })

  it('writes a complete regressed outcome, and refuses a hostile edit of each store rule with no change to the file', async () => {
    const applied = await appliedThroughStore('e2e-regressed', [1, 2, 3])
    const { outcomeReceipt: good } = outcomePatch(await measureCohortEffect(applied, [], fakeDeps(laterOf(range(20, 10)))))
    const hostile: Array<[string, SuggestionOutcomeReceipt, RegExp]> = [
      // 1. Each check has exactly 10 keys and no evidence key.
      ['an evidence line on a check', withCheck(good, (c) => ({ ...c, evidence: 'avgToolCalls: 2 → 24.5' })), /checks\[0\] must have exactly the keys of an outcome check/],
      [
        'a check with 9 keys',
        withCheck(good, ({ pHigher, ...c }) => {
          void pHigher
          return c
        }),
        /checks\[0\] must have exactly the keys of an outcome check/,
      ],
      // 2. Session ids are lowercase UUIDs.
      ['an uppercase later id', { ...good, measuredSessionIds: [...good.measuredSessionIds.slice(0, 9), good.measuredSessionIds[9]!.toUpperCase()] }, /measuredSessionIds must be 0 to 10 sorted unique session ids/],
      ['an uppercase baseline id', { ...good, baselineSessionIds: good.baselineSessionIds.map((id) => id.toUpperCase()) }, /baselineSessionIds must be 0 to 10 sorted unique session ids/],
      ['a later id that is not a UUID', { ...good, measuredSessionIds: [...good.measuredSessionIds.slice(0, 9), 'zzzzzzzz-0000-4000-8000-000000000000'] }, /measuredSessionIds must be 0 to 10 sorted unique session ids/],
      // 3. The baseline is the frozen baseline: its ids, the mean and the median of its values.
      ['other baseline ids', { ...good, baselineSessionIds: [uuid(0), uuid(1), uuid(7)] }, /baselineSessionIds must equal the frozen baseline session ids/],
      ['another baseline mean', withCheck(good, (c) => ({ ...c, before: 3 })), /checks\[0\] before must be the mean of the frozen baseline, 2/],
      ['another baseline median', withCheck(good, (c) => ({ ...c, beforeMedian: 3 })), /checks\[0\] beforeMedian must be the median of the frozen baseline, 2/],
      // 4. The first checkpoint needs a frozen baseline below 3 sessions, and the checkpoint fits laterComplete.
      ['the first checkpoint on a frozen baseline of 3', { ...good, checkpoint: 'first' }, /checkpoint first needs a frozen baseline below 3 sessions/],
      ['an incomplete later cohort', { ...good, laterComplete: false }, /laterComplete must be true/],
    ]
    for (const [label, outcomeReceipt, message] of hostile) {
      await refusedUnchanged(() => store.transition(applied.id, 'regressed', { outcomeReceipt }), message, label)
    }
    await expect(store.transition(applied.id, 'regressed', { outcomeReceipt: good })).resolves.toMatchObject({ status: 'regressed', outcomeReceipt: good })
  })

  it('writes a complete unproven outcome, and a short frozen baseline closes at the first checkpoint', async () => {
    const noise = await appliedThroughStore('e2e-within-noise', [5, 6, 7])
    const complete = outcomePatch(await measureCohortEffect(noise, [], fakeDeps(laterOf([6, 5, 7, 6, 5, 7, 6, 5, 7, 6]))))
    expect(complete.outcomeReceipt).toMatchObject({ checkpoint: 'complete', verdict: 'within-noise', laterComplete: true })
    await expect(store.transition(noise.id, 'unproven', complete)).resolves.toMatchObject({ status: 'unproven' })

    const short = await appliedThroughStore('e2e-short', [5, 6])
    expect(short.frozenBaseline?.sessions).toHaveLength(2)
    const { outcomeReceipt: early } = outcomePatch(await measureCohortEffect(short, [], fakeDeps(laterOf([4]))))
    expect(early).toMatchObject({ checkpoint: 'first', verdict: 'not-enough-sessions', laterComplete: false, measuredSessionIds: [uuid(100)] })
    const hostile: Array<[string, SuggestionOutcomeReceipt, RegExp]> = [
      ['the complete checkpoint before the cohort is complete', { ...early, checkpoint: 'complete' }, /checkpoint must be complete when the later cohort is complete, and first before it/],
      ['the first checkpoint at a complete cohort', { ...early, laterComplete: true }, /checkpoint must be complete when the later cohort is complete, and first before it/],
      ['other baseline ids', { ...early, baselineSessionIds: [uuid(0), uuid(7)] }, /baselineSessionIds must equal the frozen baseline session ids/],
    ]
    for (const [label, outcomeReceipt, message] of hostile) {
      await refusedUnchanged(() => store.transition(short.id, 'unproven', { outcomeReceipt }), message, label)
    }
    await expect(store.transition(short.id, 'unproven', { outcomeReceipt: early })).resolves.toMatchObject({ status: 'unproven', outcomeReceipt: early })
  })

  it('verifies only against a frozen baseline of 3 or more sessions', async () => {
    const full = await appliedThroughStore('e2e-verify-full', [20, 21, 22])
    const patch = verificationPatch(await measureCohortEffect(full, [], fakeDeps(laterOf([1, 2, 3]))))
    const short = await appliedThroughStore('e2e-verify-short', [20, 21])
    await refusedUnchanged(() => store.transition(short.id, 'verified', patch), /Orangu cannot verify a record with a frozen baseline below 3 sessions/, 'a frozen baseline of 2')
    await expect(store.transition(full.id, 'verified', patch)).resolves.toMatchObject({ status: 'verified', verificationTrust: 'computed-v2' })
  })
})
