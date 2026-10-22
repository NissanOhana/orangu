import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { MIN_VERIFICATION_QUIET_MS } from '../adapters/claude-code/discovered-analysis.js'
import { projectSlug } from '../discover/discover.js'
import { measureCohortEffect, type CohortDeps } from './cohort.js'
import { COHORT_FACTS_DIR, CohortFactsCache } from './cohort-cache.js'
import { createCachedCohortDeps, createCohortDeps, partialTail, readTail, settlingStartedAt } from './cohort-deps.js'
import type { SuggestionRecord } from './types.js'

const ENV_KEYS = ['ORANGU_CLAUDE_ROOTS', 'CLAUDE_CONFIG_DIR', 'HOME'] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const APPLIED_AT = Date.parse('2026-08-05T00:00:00.000Z')
const id = (n: number): string => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function writeSession(project: string, sessionId: string, cwd: string, startAt: string, toolCalls: number, oranguCheck?: 'skill' | 'cli'): void {
  const b = new SessionBuilder({ sessionId, cwd, startAt })
  b.userPrompt('Make the change')
  for (let i = 0; i < toolCalls; i++) b.toolCall('Read', { file_path: `${cwd}/src/f${i}.ts` }, 'ok')
  if (oranguCheck === 'skill') b.toolCall('Skill', { skill: 'orangu:improve', args: '--verify sg_aaaaaaaaaaaa' }, 'Launching skill: orangu:improve')
  if (oranguCheck === 'cli') b.toolCall('Bash', { command: "orangu suggest --effect 'sg_aaaaaaaaaaaa' --json --quiet" }, '{}')
  b.assistant([{ type: 'text', text: 'Done.' }])
  const path = join(project, `${sessionId}.jsonl`)
  writeFileSync(path, b.toJsonl())
  const end = new Date(Date.parse(startAt) + 60 * 60_000)
  utimesSync(path, end, end)
}

function workspaceWithSessions(): { cwd: string; identity: { cwd: string; device: string; inode: string } } {
  const root = mkdtempSync(join(tmpdir(), 'orangu-cohort-root-'))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-cohort-ws-')))
  const project = join(root, 'projects', projectSlug(cwd))
  mkdirSync(project, { recursive: true })
  const baseline = [['2026-08-01T10:00:00.000Z', 7], ['2026-08-02T10:00:00.000Z', 8], ['2026-08-03T10:00:00.000Z', 9]] as const
  const later = [['2026-08-10T10:00:00.000Z', 1], ['2026-08-11T10:00:00.000Z', 2], ['2026-08-12T10:00:00.000Z', 3]] as const
  baseline.forEach(([start, calls], i) => writeSession(project, id(i), cwd, start, calls))
  later.forEach(([start, calls], i) => writeSession(project, id(100 + i), cwd, start, calls))
  // A session from another cwd whose slug lands in the same project directory is read and skipped.
  writeSession(project, id(200), `${cwd}-elsewhere`, '2026-08-13T10:00:00.000Z', 0)
  process.env['ORANGU_CLAUDE_ROOTS'] = root
  process.env['CLAUDE_CONFIG_DIR'] = root
  // claudeRoots always appends the home roots; an empty temp HOME keeps the machine's sessions out.
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'orangu-cohort-home-'))
  const st = statSync(cwd, { bigint: true })
  return { cwd, identity: { cwd, device: String(st.dev), inode: String(st.ino) } }
}

function applied(identity: { cwd: string; device: string; inode: string }): SuggestionRecord {
  return {
    id: 'sg_aaaaaaaaaaaa',
    v: 2,
    createdAt: 1,
    source: 'report',
    scope: 'repo',
    sessionIds: [id(0)],
    ruleId: 'reread-files',
    title: 't',
    evidence: { estimated: true },
    proposal: {
      v: 1,
      title: 'Reviewed change',
      change: 'c',
      effort: 'S',
      files: ['CLAUDE.md'],
      proposalPath: '/p/a.md',
      manifestPath: '/p/a.json',
      changeClass: 'instruction',
      evidence: 'e',
      expectedEffect: 'x',
      risk: 'r',
      verification: 'v',
      verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
      workspace: identity,
    },
    application: { v: 1, summary: 's', files: ['CLAUDE.md'], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.applied.json' },
    appliedAt: APPLIED_AT,
    status: 'applied',
    statusAt: APPLIED_AT,
  }
}

describe('createCohortDeps over real transcripts', () => {
  it('skips later sessions that only ran orangu to check the change', async () => {
    const { cwd, identity } = workspaceWithSessions()
    const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
    writeSession(project, id(300), cwd, '2026-08-14T10:00:00.000Z', 0, 'skill')
    writeSession(project, id(301), cwd, '2026-08-15T10:00:00.000Z', 0, 'cli')
    const deps = createCohortDeps({ now: () => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000 })
    const effect = await measureCohortEffect(applied(identity), [], deps)
    expect(effect.later.map((s) => s.id)).toEqual([id(100), id(101), id(102)])
    expect(effect.skipped['orangu-session']).toBe(2)
  })

  it('reads settled sessions through the evidence manifest and cuts them at the application', async () => {
    const { identity } = workspaceWithSessions()
    const deps = createCohortDeps({ now: () => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000 })
    const effect = await measureCohortEffect(applied(identity), [], deps)
    expect(effect.baseline.map((s) => s.id).sort()).toEqual([id(1), id(2)])
    expect(effect.skipped['evidence-session']).toBe(1)
    expect(effect.later.map((s) => s.id)).toEqual([id(100), id(101), id(102)])
    expect(effect.skipped['other-workspace']).toBe(1)
    expect(effect.checks[0]).toMatchObject({ before: 8.5, after: 2 })
    expect(effect.verdict).toBe('not-enough-sessions')
  })

  it('counts sessions that changed inside the quiet window as still settling', async () => {
    const { identity } = workspaceWithSessions()
    const effect = await measureCohortEffect(applied(identity), [], createCohortDeps({ now: () => Date.now() }))
    expect(effect.baseline).toHaveLength(0)
    expect(effect.later).toHaveLength(0)
    expect(effect.skipped['still-settling']).toBe(6)
  })

  it('refuses a workspace whose identity no longer matches', async () => {
    const { identity } = workspaceWithSessions()
    const deps = createCohortDeps({ now: () => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000 })
    await expect(measureCohortEffect(applied({ ...identity, inode: '1' }), [], deps)).rejects.toThrow(/workspace identity no longer matches/)
  })
})

describe('createCohortDeps: a settling session', () => {
  it('reports the start time from the head of the transcript', async () => {
    const { cwd } = workspaceWithSessions()
    const deps = createCohortDeps({ now: () => Date.now() })
    const candidate = (await deps.listCandidates(cwd)).find((c) => c.sessionId === id(100))!
    // The bytes that the read took count: the last byte of the transcript, then its head (the whole small file).
    const size = statSync(candidate.path).size
    expect(size).toBeLessThan(64_000)
    expect(await deps.loadCandidate(candidate, 64 * 1024 * 1024)).toEqual({ skip: 'still-settling', bytesRead: 1 + size, startedAt: Date.parse('2026-08-10T10:00:00.000Z') })
  })

  it('reads the earliest time of the head, and nothing from a missing file or a file with no time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-settling-'))
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, ['{"type":"summary"}', '{"timestamp":"2026-08-10T10:00:05.000Z"}', '{"timestamp":"2026-08-10T10:00:01.000Z"}', '{"timestamp":17'].join('\n'))
    expect(await settlingStartedAt(path)).toBe(Date.parse('2026-08-10T10:00:01.000Z'))
    writeFileSync(join(dir, 'none.jsonl'), '{"type":"summary"}\n')
    expect(await settlingStartedAt(join(dir, 'none.jsonl'))).toBeUndefined()
    expect(await settlingStartedAt(join(dir, 'missing.jsonl'))).toBeUndefined()
  })
})

describe('createCohortDeps: a transcript that ends in a partial line', () => {
  const settledNow = (): number => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000
  /** Append text with no newline to a later session, and keep its file time. */
  function endWith(text: string): { cwd: string; path: string } {
    const { cwd } = workspaceWithSessions()
    const path = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd), `${id(100)}.jsonl`)
    const { mtime } = statSync(path)
    appendFileSync(path, text)
    utimesSync(path, mtime, mtime)
    return { cwd, path }
  }

  it('finds the partial line from the end of a quiet transcript, reads only the probes and counts their bytes', async () => {
    const { cwd, path } = endWith(`{"type":"user","message":{"content":"${'x'.repeat(200_000)}`)
    const deps = createCohortDeps({ now: settledNow })
    const candidate = (await deps.listCandidates(cwd)).find((c) => c.sessionId === id(100))!
    // The tail probe reads 64,000 B (no newline in them) and the head read 64,000 B: not the 200 KB of the file.
    expect(await deps.loadCandidate(candidate, 64 * 1024 * 1024)).toEqual({ skip: 'still-settling', bytesRead: 2 * 64_000, startedAt: Date.parse('2026-08-10T10:00:00.000Z') })
    expect(statSync(path).size).toBeGreaterThan(200_000)
  })

  it('finds a partial line in a subagent sidecar of a whole main transcript, also in a nested folder', async () => {
    for (const nested of [false, true]) {
      const { cwd } = workspaceWithSessions()
      const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
      const folder = nested ? join(project, id(100), 'subagents', 'team') : join(project, id(100), 'subagents')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'agent-a1.jsonl'), `{"type":"user","message":{"content":"${'y'.repeat(300_000)}`)
      const deps = createCohortDeps({ now: settledNow })
      const candidate = (await deps.listCandidates(cwd)).find((c) => c.sessionId === id(100))!
      const loaded = await deps.loadCandidate(candidate, 64 * 1024 * 1024)
      expect(loaded, `nested ${nested}`).toMatchObject({ skip: 'still-settling', startedAt: Date.parse('2026-08-10T10:00:00.000Z') })
      // The main tail (1 B), the sidecar tail (64,000 B) and the head read: not the 300 KB of the sidecar.
      expect(loaded.bytesRead, `nested ${nested}`).toBeLessThanOrEqual(1 + 64_000 + 64_000)
    }
  })

  it('reads a last line with no newline that is a whole record, as the reader does', async () => {
    const { cwd } = endWith('{"type":"summary","summary":"done"}')
    const deps = createCohortDeps({ now: settledNow })
    const candidate = (await deps.listCandidates(cwd)).find((c) => c.sessionId === id(100))!
    expect(await deps.loadCandidate(candidate, 64 * 1024 * 1024)).toMatchObject({ session: { id: id(100) } })
  })

  it('follows the rule of the reader, and counts an open last line longer than the tail window as partial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-tail-'))
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, `{"a":1}\n{"b":"${'y'.repeat(100_000)}"}`)
    expect(await partialTail(path)).toBe(true)
    // The tail read is 64,000 B at most for 1 file, the last byte included, and less when the caller has less.
    expect(await readTail(path, 1_000_000)).toEqual({ partial: true, bytesRead: 64_000 })
    expect(await readTail(path, 10)).toEqual({ partial: true, bytesRead: 10 })
    writeFileSync(join(dir, 'b.jsonl'), '{"a":1}\n')
    expect(await readTail(join(dir, 'b.jsonl'), 1_000_000)).toEqual({ partial: false, bytesRead: 1 })
    writeFileSync(path, '{"a":1}\n{"b":2}\n')
    expect(await partialTail(path)).toBe(false)
    writeFileSync(path, '{"a":1}\n   ')
    expect(await partialTail(path)).toBe(true)
    writeFileSync(path, '')
    expect(await partialTail(path)).toBe(false)
  })

  it('never waits on a FIFO in place of a transcript, for the head read and for the tail read', async () => {
    const fifo = join(mkdtempSync(join(tmpdir(), 'orangu-fifo-')), 'agent.jsonl')
    execFileSync('mkfifo', [fifo])
    for (const read of [() => settlingStartedAt(fifo), () => partialTail(fifo)]) {
      const outcome = await Promise.race([read().then((value) => ({ value })), new Promise<'blocked'>((done) => setTimeout(() => done('blocked'), 1_000))])
      // A blocked read waits for a writer: open one, so the read ends and the test can report it.
      if (outcome === 'blocked') closeSync(openSync(fifo, 'w'))
      expect(outcome).toEqual({ value: undefined })
    }
  })
})

describe('createCachedCohortDeps over real transcripts', () => {
  const settled = (): number => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000
  /** The trusted loaders, with each transcript load counted. */
  function counting(now: () => number): { deps: CohortDeps; calls: string[] } {
    const base = createCohortDeps({ now })
    const calls: string[] = []
    return {
      calls,
      deps: {
        ...base,
        loadCandidate: async (candidate, maxBytes) => {
          calls.push(candidate.sessionId)
          return base.loadCandidate(candidate, maxBytes)
        },
      },
    }
  }
  const cached = (dir: string | null, base: CohortDeps, now = settled, budgetBytes = 256 * 1024 * 1024) =>
    createCachedCohortDeps({ now, budgetBytes, cache: dir === null ? null : new CohortFactsCache({ version: 'test', dir }), base })

  it('reads no transcript on a warm read and gives the same effect', async () => {
    const { identity } = workspaceWithSessions()
    const dir = mkdtempSync(join(tmpdir(), 'orangu-cohort-facts-'))
    const cold = counting(settled)
    const first = await measureCohortEffect(applied(identity), [], cached(dir, cold.deps))
    // 2 baseline sessions (the evidence session is never read), the 3 later ones and the one of another cwd.
    expect(cold.calls).toHaveLength(6)
    const warm = counting(settled)
    const deps = cached(dir, warm.deps)
    const second = await measureCohortEffect(applied(identity), [], deps)
    expect(warm.calls).toEqual([])
    expect(deps.stats()).toMatchObject({ loaderCalls: 0, missBytes: 0, cacheHits: 6 })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(second.skipped['other-workspace']).toBe(1)
  })

  it('spends the same side budget on a hit as the trusted read, so a warm read takes the same sessions', async () => {
    const { cwd, identity } = workspaceWithSessions()
    const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
    writeSession(project, id(103), cwd, '2026-08-14T10:00:00.000Z', 4)
    writeSession(project, id(104), cwd, '2026-08-15T10:00:00.000Z', 5)
    const MiB = 1024 * 1024
    // Each transcript counts as 64 MiB, so 4 later reads spend the later budget of 256 MiB.
    const big = (deps: CohortDeps): CohortDeps => ({
      ...deps,
      loadCandidate: async (candidate, maxBytes) => {
        const loaded = await deps.loadCandidate(candidate, maxBytes)
        return 'session' in loaded ? { ...loaded, bytesRead: 64 * MiB } : loaded
      },
    })
    const trusted = await measureCohortEffect(applied(identity), [], big(createCohortDeps({ now: settled })))
    expect(trusted.laterComplete).toBe(true)
    expect(trusted.later.map((s) => s.id)).toEqual([id(100), id(101), id(102)])
    const dir = mkdtempSync(join(tmpdir(), 'orangu-cohort-facts-'))
    // The read budget holds both sides, so only the side budget can stop the read.
    const cold = await measureCohortEffect(applied(identity), [], cached(dir, big(counting(settled).deps), settled, 1024 * MiB))
    const warm = counting(settled)
    const second = await measureCohortEffect(applied(identity), [], cached(dir, big(warm.deps), settled, 1024 * MiB))
    expect(warm.calls).toEqual([])
    expect(JSON.stringify(cold)).toBe(JSON.stringify(trusted))
    expect(JSON.stringify(second)).toBe(JSON.stringify(trusted))
  })

  it('counts a cached session only after 30 minutes quiet at the injected now', async () => {
    const { identity } = workspaceWithSessions()
    const dir = mkdtempSync(join(tmpdir(), 'orangu-cohort-facts-'))
    await measureCohortEffect(applied(identity), [], cached(dir, counting(settled).deps))
    // The files changed a moment ago (their ctime), so at the real clock each one still settles, also from the cache.
    const early = counting(() => Date.now())
    const effect = await measureCohortEffect(applied(identity), [], cached(dir, early.deps, () => Date.now()))
    expect(early.calls).toEqual([])
    expect(effect.baseline).toHaveLength(0)
    expect(effect.later).toHaveLength(0)
    expect(effect.skipped['still-settling']).toBe(6)
  })

  it('misses on a changed transcript, and loads every time with no cache', async () => {
    const { cwd, identity } = workspaceWithSessions()
    const dir = mkdtempSync(join(tmpdir(), 'orangu-cohort-facts-'))
    await measureCohortEffect(applied(identity), [], cached(dir, counting(settled).deps))
    const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
    writeSession(project, id(101), cwd, '2026-08-11T10:00:00.000Z', 5)
    const again = counting(settled)
    const effect = await measureCohortEffect(applied(identity), [], cached(dir, again.deps))
    expect(again.calls).toEqual([id(101)])
    expect(effect.checks[0]).toMatchObject({ after: 3 })
    const off = counting(settled)
    await measureCohortEffect(applied(identity), [], cached(null, off.deps))
    await measureCohortEffect(applied(identity), [], cached(null, off.deps))
    expect(off.calls).toHaveLength(12)
  })

  it('loads a skipped session once in 1 read, and again only when its files change', async () => {
    const { cwd, identity } = workspaceWithSessions()
    const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
    writeSession(project, id(103), cwd, '2026-08-14T10:00:00.000Z', 4)
    // The trusted loader refuses id(103) as over the evidence cap, as it refuses a session of more than 64 MiB.
    const trusted = createCohortDeps({ now: settled })
    const calls: string[] = []
    const base: CohortDeps = {
      ...trusted,
      loadCandidate: async (candidate, maxBytes) => {
        calls.push(candidate.sessionId)
        return candidate.sessionId === id(103) ? { skip: 'over-budget', bytesRead: 7 } : trusted.loadCandidate(candidate, maxBytes)
      },
    }
    const deps = cached(mkdtempSync(join(tmpdir(), 'orangu-cohort-facts-')), base)
    const records = ['sg_aaaaaaaaaaaa', 'sg_bbbbbbbbbbbb', 'sg_cccccccccccc'].map((recordId) => ({ ...applied(identity), id: recordId }))
    const effects: string[] = []
    for (const record of records) effects.push(JSON.stringify({ ...(await measureCohortEffect(record, [], deps)), id: '' }))
    // 1 load for each of the 6 sessions of the first test, and 1 for id(103): not 1 for each record.
    expect(calls.filter((call) => call === id(103))).toHaveLength(1)
    expect(deps.stats().loaderCalls).toBe(7)
    // Each record gets the same effect, with the skip counted once on its side.
    expect(new Set(effects).size).toBe(1)
    expect(JSON.parse(effects[0]!).skipped['over-budget']).toBe(1)
    // A changed file moves its key, so the next record of the same read loads it again.
    appendFileSync(join(project, `${id(103)}.jsonl`), '\n')
    await measureCohortEffect({ ...applied(identity), id: 'sg_dddddddddddd' }, [], deps)
    expect(calls.filter((call) => call === id(103))).toHaveLength(2)
  })

  it('reuses a skip over the evidence cap at a smaller cap above its probe bytes, and no other skip', async () => {
    const { cwd } = workspaceWithSessions()
    const trusted = createCohortDeps({ now: settled })
    const calls: Array<[string, number]> = []
    const base: CohortDeps = {
      ...trusted,
      loadCandidate: async (candidate, maxBytes) => {
        calls.push([candidate.sessionId, maxBytes])
        if (candidate.sessionId === id(100)) return { skip: 'over-budget', bytesRead: 7 }
        if (candidate.sessionId === id(101)) return { skip: 'unreadable', bytesRead: 7 }
        return trusted.loadCandidate(candidate, maxBytes)
      },
    }
    const deps = cached(null, base)
    const candidates = await deps.listCandidates(cwd)
    const over = candidates.find((c) => c.sessionId === id(100))!
    const unreadable = candidates.find((c) => c.sessionId === id(101))!
    const MiB = 1024 * 1024
    // Over the cap at 64 MiB: over the cap at any smaller cap that its 7 probe bytes leave room for.
    for (const cap of [64 * MiB, 3 * MiB, 8]) expect(await deps.loadCandidate(over, cap)).toEqual({ skip: 'over-budget', bytesRead: 7 })
    // A larger cap, or a cap that its probe bytes fill, loads again.
    await deps.loadCandidate(over, 64 * MiB + 1)
    await deps.loadCandidate(over, 7)
    // The skip of the largest cap stays.
    await deps.loadCandidate(over, 3 * MiB)
    expect(calls.filter(([session]) => session === id(100)).map(([, cap]) => cap)).toEqual([64 * MiB, 64 * MiB + 1, 7])
    // Any other skip is kept for its own cap only.
    await deps.loadCandidate(unreadable, 64 * MiB)
    await deps.loadCandidate(unreadable, 64 * MiB)
    await deps.loadCandidate(unreadable, 3 * MiB)
    expect(calls.filter(([session]) => session === id(101)).map(([, cap]) => cap)).toEqual([64 * MiB, 3 * MiB])
  })

  it('keeps the trusted loaders off the cache: a planted entry changes no measure of the record steps', async () => {
    const { identity } = workspaceWithSessions()
    const dir = mkdtempSync(join(tmpdir(), 'orangu-cohort-facts-'))
    await measureCohortEffect(applied(identity), [], cached(dir, counting(settled).deps))
    const folder = join(dir, readdirSync(dir)[0]!, COHORT_FACTS_DIR)
    for (const name of readdirSync(folder)) {
      const entry = JSON.parse(readFileSync(join(folder, name), 'utf8')) as { metrics: Record<string, number> }
      writeFileSync(join(folder, name), JSON.stringify({ ...entry, metrics: { ...entry.metrics, avgToolCalls: 99 } }), { mode: 0o600 })
    }
    const trusted = await measureCohortEffect(applied(identity), [], createCohortDeps({ now: settled }))
    expect(trusted.checks[0]).toMatchObject({ before: 8.5, after: 2 })
  })
})
