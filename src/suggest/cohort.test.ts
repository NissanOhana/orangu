import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COHORT_SIDE_BYTES, measureCohortEffect, nextStep, ranOranguLifecycle, verificationPatch, type CohortCandidate, type CohortDeps, type CohortSession } from './cohort.js'
import { SuggestionStore } from './store.js'
import type { SuggestionRecord, SuggestionVerificationIntent } from './types.js'

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
      { id: uuid(502), startedAt: T + 500, endedAt: T + 600, toolCalls: 0, skip: 'still-settling' as const },
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
    expect(nextStep(full)).toBe('the later cohort is complete (10 of 10) and did not beat the baseline beyond chance: keep the change without a verified claim, or reject the proposal')
    const partial = await measureCohortEffect(appliedRecord(), [], fakeDeps(overlap.filter((s) => s.startedAt < T || s.startedAt < T + 5_000)))
    expect(partial.verdict).toBe('within-noise')
    expect(nextStep(partial)).toBe(`${partial.later.length} of 10 later sessions counted: later sessions can still join, or reject the proposal`)
    const done = await measureCohortEffect(appliedRecord({ status: 'verified' }), [], fakeDeps(separated(3)))
    expect(nextStep(done)).toBe('already recorded as verified')
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
    await expect(measureCohortEffect(appliedRecord({ status: 'proposed', appliedAt: undefined }), [], deps)).rejects.toThrow(/has not been applied/)
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
