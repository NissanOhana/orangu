import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { MIN_VERIFICATION_QUIET_MS } from '../adapters/claude-code/discovered-analysis.js'
import { projectSlug } from '../discover/discover.js'
import { CohortFactsCache } from './cohort-cache.js'
import {
  APPLIED_AT,
  NOW,
  OTHER_WORKSPACE,
  WORKSPACE,
  appliedOf,
  frozenOf,
  metricsOf,
  proposalOf,
  recordOf,
  sg,
  uuid,
} from '../../test/fixtures/suggestion-records.js'
import type { SessionRef } from '../discover/discover.js'
import type { CohortCandidate, CohortDeps, CohortLoad } from './cohort.js'
import { COHORT_SIDE_BYTES } from './cohort.js'
import { createCachedCohortDeps } from './cohort-deps.js'
import { QUEUE_GROUPS, type QueueItem, type SuggestionQueue } from './queue.js'
import {
  createQueueReadDeps,
  QUEUE_CHECK_BYTES,
  readHistory,
  readLessons,
  readQueue,
  readTodo,
  workspaceMembership,
  type QueueReadDeps,
  type QueueReadStore,
} from './queue-read.js'
import { SuggestionStore } from './store.js'
import type { SuggestionRecord, SuggestionWorkspaceIdentity } from './types.js'

interface FakeSession {
  id: string
  cwd: string
  startedAt: number
  endedAt: number
  toolCalls: number
  ranOrangu?: boolean
}

/** Later sessions of 1 workspace in start order, 1 for each tool-call value, with ids from `base`. */
const laterOf = (values: number[], cwd = WORKSPACE, base = 100): FakeSession[] =>
  values.map((toolCalls, index) => ({ id: uuid(base + index), cwd, startedAt: APPLIED_AT + 1_000 + index * 1_000, endedAt: APPLIED_AT + 2_000 + index * 1_000, toolCalls }))

/** Cohort loaders over a fixed session list, each settled; the canonical workspace is the identity's own path. */
function fakeCohort(sessions: FakeSession[]): CohortDeps & { loads: string[] } {
  const loads: string[] = []
  return {
    loads,
    async listCandidates(cwd: string): Promise<CohortCandidate[]> {
      return sessions.filter((s) => s.cwd === cwd).map((s) => ({ sessionId: s.id, path: `/c/${s.id}.jsonl`, mtimeMs: s.endedAt }))
    },
    async loadCandidate(candidate): Promise<CohortLoad> {
      loads.push(candidate.sessionId)
      const s = sessions.find((x) => x.id === candidate.sessionId)!
      return { session: { id: s.id, path: candidate.path, cwd: s.cwd, ranOrangu: s.ranOrangu ?? false, startedAt: s.startedAt, endedAt: s.endedAt, metrics: metricsOf(s.toolCalls) }, bytesRead: 1_000 }
    },
    async canonicalWorkspace(identity: SuggestionWorkspaceIdentity) {
      return identity.cwd
    },
  }
}

function depsOf(cohort: CohortDeps, sessionIds: string[] = [uuid(900)]): QueueReadDeps {
  return {
    now: NOW,
    cohort,
    async canonical(dir: string) {
      return dir
    },
    async workspaceSessionIds() {
      return sessionIds
    },
  }
}

const storeOf = (records: SuggestionRecord[]): QueueReadStore => ({
  async all() {
    return records
  },
  async lines() {
    return records
  },
})

const items = (queue: SuggestionQueue): QueueItem[] => QUEUE_GROUPS.flatMap((group) => queue.groups[group])
const itemOf = async (record: SuggestionRecord, sessions: FakeSession[]): Promise<QueueItem> => {
  const all = items(await readQueue(storeOf([record]), { cwd: WORKSPACE }, depsOf(fakeCohort(sessions))))
  expect(all).toHaveLength(1)
  return all[0]!
}

describe('readQueue: due comes from the measured check', () => {
  it('holds a record whose first verdict is within noise at 3, 5 and 9 later sessions, and makes it due at the complete one', async () => {
    const values = [8, 9, 10.5, 9, 9, 9, 9, 9, 9, 9]
    for (const count of [3, 5, 9]) {
      const item = await itemOf(appliedOf(sg(1)), laterOf(values.slice(0, count)))
      expect(item, `${count} later sessions`).toMatchObject({ group: 'wait', check: 'ran', checkpoint: 'first', verdict: 'within-noise', final: false, next: null })
    }
    const complete = await itemOf(appliedOf(sg(1)), laterOf(values))
    expect(complete).toMatchObject({ group: 'verdict', checkpoint: 'complete', final: true, next: `claude "/orangu:improve --verify ${sg(1)}"` })
  })

  it('makes a record due when its first verdict is verified', async () => {
    const item = await itemOf(appliedOf(sg(1)), laterOf([1, 2, 3]))
    expect(item).toMatchObject({ group: 'verdict', checkpoint: 'first', verdict: 'verified', final: true })
  })

  it('holds a probe with 10 later candidates, 2 of them orangu sessions: the measured later side is 8', async () => {
    const sessions = laterOf([8, 9, 10.5, 9, 9, 9, 9, 9, 9, 9]).map((s, index) => (index === 3 || index === 6 ? { ...s, ranOrangu: true } : s))
    const item = await itemOf(appliedOf(sg(1)), sessions)
    // Discovery sees 10 later sessions, and the check measures 8 of them.
    expect(item.candidates).toEqual({ baseline: 3, later: 10 })
    expect(item).toMatchObject({ group: 'wait', checkpoint: 'first', verdict: 'within-noise', final: false, next: null })
  })

  it('checks no record of another workspace, and no record that cannot verify', async () => {
    const cohort = fakeCohort([...laterOf([1, 2, 3]), ...laterOf([1, 2, 3], OTHER_WORKSPACE, 200)])
    const records = [
      appliedOf(sg(1), { proposal: proposalOf(OTHER_WORKSPACE), sessionIds: [uuid(1)] }),
      appliedOf(sg(2), { frozenBaseline: frozenOf([1]) }),
      appliedOf(sg(3), { proposal: undefined }),
    ]
    const queue = await readQueue(storeOf(records), { cwd: WORKSPACE }, depsOf(cohort))
    expect(cohort.loads).toEqual([])
    expect(items(queue).map((item) => [item.id, item.cannotVerify, item.check])).toEqual([
      [sg(2), 'few-baseline-sessions', undefined],
      [sg(3), 'legacy-record', undefined],
    ])
  })

  it('leaves an item with no check when the check cannot run, and the read goes on', async () => {
    const cohort = { ...fakeCohort(laterOf([1, 2, 3])), canonicalWorkspace: async () => { throw new Error('the workspace moved') } }
    const queue = await readQueue(storeOf([appliedOf(sg(1)), recordOf(sg(2))]), { cwd: WORKSPACE }, depsOf(cohort))
    const applied = items(queue).find((item) => item.id === sg(1))!
    expect(applied).toMatchObject({ group: 'wait', next: null })
    expect(Object.hasOwn(applied, 'check')).toBe(false)
    expect(Object.hasOwn(applied, 'candidates')).toBe(false)
    expect(queue.counts.review).toBe(1)
  })
})

describe('readQueue: the byte bound of 1 read', () => {
  const MiB = 1024 * 1024
  /** Cached loaders with no cache over fake sessions of 1 MiB each, whose files do not exist. */
  function bounded(sessions: FakeSession[], budgetBytes: number) {
    const base = fakeCohort(sessions)
    const refs = (cwd: string): SessionRef[] =>
      sessions.filter((s) => s.cwd === cwd).map((s) => ({ sessionId: s.id, path: `/c/${s.id}.jsonl`, projectSlug: '-w', projectPath: '/c', sizeBytes: MiB, mtimeMs: s.endedAt, hasSidecarDir: false, subagentFiles: [] }))
    const cohort = createCachedCohortDeps({
      now: () => NOW,
      budgetBytes,
      cache: null,
      base: { ...base, loadCandidate: async (candidate, maxBytes) => ({ ...(await base.loadCandidate(candidate, maxBytes)), bytesRead: MiB }) },
      listSessions: async (cwd) => refs(cwd),
    })
    return { cohort, base }
  }
  const twoWorkspaces = (): FakeSession[] => [...laterOf([1, 2, 3]), ...laterOf([1, 2, 3], OTHER_WORKSPACE, 200)]
  const records = (otherFirst: boolean): SuggestionRecord[] => [
    appliedOf(sg(1), { appliedAt: APPLIED_AT + (otherFirst ? 1 : 0), statusAt: APPLIED_AT + (otherFirst ? 1 : 0) }),
    appliedOf(sg(2), { proposal: proposalOf(OTHER_WORKSPACE), appliedAt: APPLIED_AT + (otherFirst ? 0 : 1), statusAt: APPLIED_AT + (otherFirst ? 0 : 1) }),
  ]

  it('is the later side budget of 1 cohort', () => {
    expect(QUEUE_CHECK_BYTES).toBe(COHORT_SIDE_BYTES)
  })

  it('checks the records oldest application first, and defers each record past the bound with no step', async () => {
    for (const otherFirst of [false, true]) {
      const { cohort, base } = bounded(twoWorkspaces(), 3 * MiB)
      const queue = await readQueue(storeOf(records(otherFirst)), 'all', depsOf(cohort))
      const [ran, deferred] = otherFirst ? [sg(2), sg(1)] : [sg(1), sg(2)]
      const byId = new Map(items(queue).map((item) => [item.id, item]))
      expect(byId.get(ran), String(otherFirst)).toMatchObject({ check: 'ran', group: 'verdict', final: true })
      expect(byId.get(deferred), String(otherFirst)).toMatchObject({ check: 'deferred', group: 'wait', next: null })
      expect(cohort.stats().missBytes).toBe(3 * MiB)
      expect(base.loads).toHaveLength(3)
    }
  })

  it('reads no transcript with a budget of 0 B, and defers each record that misses the cache', async () => {
    const { cohort, base } = bounded(twoWorkspaces(), 0)
    const queue = await readQueue(storeOf(records(false)), 'all', depsOf(cohort))
    expect(base.loads).toEqual([])
    expect(items(queue).map((item) => item.check)).toEqual(['deferred', 'deferred'])
    expect(queue.counts.due).toBe(0)
  })
})

describe('readQueue over real transcripts', () => {
  const ENV_KEYS = ['ORANGU_CLAUDE_ROOTS', 'CLAUDE_CONFIG_DIR', 'HOME', 'ORANGU_HOME'] as const
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

  /** A workspace folder with 3 later sessions of 1, 2 and 3 tool calls, in a private Claude root and orangu home. */
  function workspace(): { cwd: string; identity: SuggestionWorkspaceIdentity } {
    const root = mkdtempSync(join(tmpdir(), 'orangu-queue-root-'))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-queue-ws-')))
    const project = join(root, 'projects', projectSlug(cwd))
    mkdirSync(project, { recursive: true })
    for (const [index, calls] of [1, 2, 3].entries()) {
      const startAt = new Date(APPLIED_AT + (index + 1) * 60 * 60_000).toISOString()
      const b = new SessionBuilder({ sessionId: uuid(100 + index), cwd, startAt })
      b.userPrompt('Make the change')
      for (let i = 0; i < calls; i++) b.toolCall('Read', { file_path: `${cwd}/src/f${i}.ts` }, 'ok')
      b.assistant([{ type: 'text', text: 'Done.' }])
      const path = join(project, `${uuid(100 + index)}.jsonl`)
      writeFileSync(path, b.toJsonl())
      const end = new Date(Date.parse(startAt) + 10 * 60_000)
      utimesSync(path, end, end)
    }
    process.env['ORANGU_CLAUDE_ROOTS'] = root
    process.env['CLAUDE_CONFIG_DIR'] = root
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'orangu-queue-home-'))
    process.env['ORANGU_HOME'] = mkdtempSync(join(tmpdir(), 'orangu-queue-orangu-'))
    const st = statSync(cwd, { bigint: true })
    return { cwd, identity: { cwd, device: String(st.dev), inode: String(st.ino) } }
  }

  it('makes 0 loader calls on a second read, and a read of 0 B then measures from the cache', async () => {
    const { cwd, identity } = workspace()
    const store = storeOf([appliedOf(sg(1), { proposal: { ...proposalOf(cwd), workspace: identity } })])
    // The files changed a moment ago (their ctime), so the read looks 31 minutes later.
    const now = Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000
    const cache = (): CohortFactsCache => new CohortFactsCache({ version: 'test' })
    const cold = createQueueReadDeps({ now, cache: cache() })
    const first = await readQueue(store, { cwd }, cold)
    expect(cold.cohort.stats().loaderCalls).toBe(3)
    expect(first.groups.verdict.map((item) => item.id)).toEqual([sg(1)])
    const warm = createQueueReadDeps({ now, cache: cache() })
    const second = await readQueue(store, { cwd }, warm)
    expect(warm.cohort.stats()).toMatchObject({ loaderCalls: 0, missBytes: 0 })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    const counted = createQueueReadDeps({ now, cache: cache(), budgetBytes: 0 })
    expect(JSON.stringify(await readQueue(store, { cwd }, counted))).toBe(JSON.stringify(first))
    // No cache: the same read of 0 B defers the record.
    const cold0 = createQueueReadDeps({ now, cache: null, budgetBytes: 0 })
    expect((await readQueue(store, { cwd }, cold0)).groups.wait.map((item) => item.check)).toEqual(['deferred'])
  })

  it('finds a crashed transcript from its end, so it defers no record and costs a warm read nothing', async () => {
    const { cwd, identity } = workspace()
    // A crashed session after the 3 others: 2 MiB of whole lines, then a partial line. Its head holds whole records, so
    // the read finds its start time, which is after the third graded session.
    const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
    const crashed = join(project, `${uuid(200)}.jsonl`)
    const b = new SessionBuilder({ sessionId: uuid(200), cwd, startAt: new Date(APPLIED_AT + 4 * 60 * 60_000).toISOString() })
    b.userPrompt('Make the change')
    b.toolCall('Read', { file_path: `${cwd}/big.txt` }, 'x'.repeat(2 * 1024 * 1024))
    writeFileSync(crashed, `${b.toJsonl()}{"type":"assistant","message":{"content":"`)
    const end = new Date(APPLIED_AT + 5 * 60 * 60_000)
    utimesSync(crashed, end, end)
    const store = storeOf(Array.from({ length: 6 }, (_, i) => appliedOf(sg(1 + i), { proposal: { ...proposalOf(cwd), workspace: identity } })))
    const now = Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000
    // 1 MiB holds the 3 small sessions, and not 1 full read of the crashed one.
    const deps = () => createQueueReadDeps({ now, cache: new CohortFactsCache({ version: 'test' }), budgetBytes: 1024 * 1024 })
    const cold = deps()
    const first = await readQueue(store, { cwd }, cold)
    expect(items(first).map((item) => [item.group, item.check])).toEqual(Array.from({ length: 6 }, () => ['verdict', 'ran']))
    expect(cold.cohort.stats().missBytes).toBeLessThan(1024 * 1024)
    const warm = deps()
    expect(JSON.stringify(await readQueue(store, { cwd }, warm))).toBe(JSON.stringify(first))
    expect(warm.cohort.stats().loaderCalls).toBe(0)
  })

  it('finds a crashed subagent sidecar of a whole transcript from its end too', async () => {
    const { cwd, identity } = workspace()
    // A whole main transcript after the 3 others, and a subagent sidecar of 2 MiB that ends in a partial line.
    const project = join(process.env['ORANGU_CLAUDE_ROOTS']!, 'projects', projectSlug(cwd))
    const b = new SessionBuilder({ sessionId: uuid(201), cwd, startAt: new Date(APPLIED_AT + 4 * 60 * 60_000).toISOString() })
    b.userPrompt('Make the change')
    b.assistant([{ type: 'text', text: 'Done.' }])
    const main = join(project, `${uuid(201)}.jsonl`)
    writeFileSync(main, b.toJsonl())
    const subagents = join(project, uuid(201), 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-a1.jsonl'), `{"type":"user","message":{"content":"${'z'.repeat(2 * 1024 * 1024)}`)
    const end = new Date(APPLIED_AT + 5 * 60 * 60_000)
    utimesSync(main, end, end)
    const store = storeOf(Array.from({ length: 6 }, (_, i) => appliedOf(sg(1 + i), { proposal: { ...proposalOf(cwd), workspace: identity } })))
    const now = Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000
    const deps = () => createQueueReadDeps({ now, cache: new CohortFactsCache({ version: 'test' }), budgetBytes: 1024 * 1024 })
    const first = await readQueue(store, { cwd }, deps())
    expect(items(first).map((item) => [item.group, item.check])).toEqual(Array.from({ length: 6 }, () => ['verdict', 'ran']))
    const warm = deps()
    expect(JSON.stringify(await readQueue(store, { cwd }, warm))).toBe(JSON.stringify(first))
    expect(warm.cohort.stats().loaderCalls).toBe(0)
  })
})

describe('the reads around the queue', () => {
  it('canonicalizes the folder and takes the sessions of that workspace', async () => {
    const deps = { ...depsOf(fakeCohort([])), canonical: async (dir: string) => `${dir}-real`, workspaceSessionIds: async (cwd: string) => (cwd === `${WORKSPACE}-real` ? [uuid(5)] : []) }
    expect(await workspaceMembership(WORKSPACE, deps)).toEqual({ cwd: `${WORKSPACE}-real`, sessionIds: [uuid(5)] })
  })

  it('builds the todo read from the same queue', async () => {
    const records = [appliedOf(sg(1)), recordOf(sg(2))]
    const deps = depsOf(fakeCohort(laterOf([1, 2, 3])))
    const queue = await readQueue(storeOf(records), { cwd: WORKSPACE }, deps)
    const todo = await readTodo(storeOf(records), WORKSPACE, deps)
    expect(todo.counts).toEqual(queue.counts)
    expect(todo.items.map((item) => item.id)).toEqual([sg(1), sg(2)])
  })

  it('reads the lessons and the history of a workspace, every workspace or the global records', async () => {
    const records = [
      recordOf(sg(1), { status: 'rejected', workspaceCwd: WORKSPACE, statusAt: APPLIED_AT + 2 }),
      recordOf(sg(2), { status: 'rejected', scope: 'global', statusAt: APPLIED_AT + 3 }),
      appliedOf(sg(3)),
    ]
    const deps = depsOf(fakeCohort([]))
    expect((await readLessons(storeOf(records), { cwd: WORKSPACE }, deps)).lessons.map((lesson) => lesson.id)).toEqual([sg(1)])
    expect((await readLessons(storeOf(records), 'all', deps, { maxBytes: null })).lessons.map((lesson) => lesson.id)).toEqual([sg(1), sg(2)])
    expect((await readLessons(storeOf(records), 'global', deps)).lessons.map((lesson) => lesson.id)).toEqual([sg(2)])
    expect((await readLessons(storeOf(records), 'all', deps, { rules: ['nope'] })).lessons).toEqual([])
    expect((await readHistory(storeOf(records), { cwd: WORKSPACE }, deps)).map((row) => row.id)).toEqual([sg(3)])
  })

  it('changes no store byte and writes no proposal file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-queue-read-'))
    const store = new SuggestionStore({ home, now: () => APPLIED_AT })
    await store.upsertNew({ ruleId: 'reread-files', title: 'Re-read files', scope: 'session', sessionIds: [uuid(900)], evidence: { estimated: true } }, 'report')
    const before = readFileSync(store.path)
    const deps = depsOf(fakeCohort([]))
    const queue = await readQueue(store, { cwd: WORKSPACE }, deps)
    expect(queue.counts.review).toBe(1)
    await readTodo(store, WORKSPACE, deps)
    await readLessons(store, 'all', deps)
    await readHistory(store, 'all', deps)
    expect(readFileSync(store.path).equals(before)).toBe(true)
    expect(readdirSync(store.proposalsDir)).toEqual([])
  })
})
