/**
 * The collector of orangu god over a fake machine: a home folder in memory (the registry files, the transcripts and
 * their subagent files), the commands as the engine runs them (claude agents, cmux, ps, git, stat, tail, head), and a
 * clock that only the test and the host calls move. A held call waits until the test releases it, a failing call
 * rejects as a call that did not start or ran too long, and a delay moves the clock while the call is in flight.
 * Every value is synthetic. The control characters are built from their code points, so this file spells no escape
 * sequence.
 */
import { describe, expect, it } from 'vitest'
import { SETTINGS, STORE } from '../../test/fixtures/god/sessions.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { createCollector, LOOP_MS, stopwatch, TICK_MS, type Collector } from './collector.js'
import type { DirEntry, FileStat, Host, RunOptions, RunResult } from './host.js'
import { hasOldFacts, isSnapshotChanged, makeSnapshot } from './snapshot.js'
import { reduceRecords } from './source/records.js'
import { transcriptPath, type TranscriptRecord } from './source/transcript.js'
import type { BoardSnapshot, Facts, Level, SessionFacts } from './types.js'

const HOME = '/Users/test'
const REGISTRY = `${HOME}/.claude/sessions`
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const MINUTE = 60_000
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI = String.fromCharCode(0x9b)
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKE'

type Identity = { pid: number; sessionId: string; cwd: string; name: string; kind: string; startedAt: number }
const A: Identity = { pid: 41001, sessionId: '00000000-0000-4000-8000-00000000000a', cwd: '/Users/test/code/alpha', name: 'alpha main', kind: 'interactive', startedAt: T0 - 60 * MINUTE }
const B: Identity = { pid: 41002, sessionId: '00000000-0000-4000-8000-00000000000b', cwd: '/Users/test/code/beta', name: 'beta docs', kind: 'interactive', startedAt: T0 - 30 * MINUTE }
const LSTART: Readonly<Record<number, string>> = { 41001: 'Fri Oct  9 11:00:00 2026', 41002: 'Fri Oct  9 11:30:00 2026' }
const PATH_A = transcriptPath(HOME, A.cwd, A.sessionId)
const SUBAGENTS_A = `${PATH_A.replace(/\.jsonl$/, '')}/subagents`

const agentRow = (who: Identity, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...who, status: 'busy', waitingFor: null, ...over })
const registryRow = (who: Identity, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...agentRow(who),
  procStart: LSTART[who.pid],
  version: '2.1.295',
  statusUpdatedAt: T0 - MINUTE,
  ...over,
})
const treeOf = (title: string): unknown => ({
  windows: [{ ref: 'window:1', workspaces: [{ ref: 'workspace:1', title, panes: [{ ref: 'pane:1', surfaces: [{ ref: 'surface:1', tty: 'ttys001', title: 'claude' }] }] }] }],
})
const transcriptOf = (who: Identity, build: (b: SessionBuilder) => void): string => {
  const b = new SessionBuilder({ sessionId: who.sessionId, cwd: who.cwd, startAt: new Date(T0 - 5 * MINUTE).toISOString() })
  build(b)
  return b.toJsonl()
}
const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type FakeFile = { bytes: Uint8Array; mtimeMs: number; inode: number }
type Gate = { prefix: string; opened: Promise<void> }

/** A machine in memory, as the host port sees it. */
class FakeMachine {
  clock = T0
  agents: readonly unknown[] | 'fails' = []
  tree: unknown = { windows: [] }
  treeFails = false
  ps: Readonly<Record<number, { tty?: string; lstart: string }>> = {}
  git: Record<string, readonly string[]> = {}
  readonly delays: Array<[prefix: string, ms: number]> = []
  readonly calls: string[] = []
  readonly runs: Array<{ argv: string; options?: RunOptions }> = []
  private readonly files = new Map<string, FakeFile>()
  private readonly dirs = new Set<string>()
  private readonly gates: Gate[] = []
  private readonly failing = new Set<string>()
  private inode = 100

  readonly host: Host = {
    run: (argv, options) => this.call(`run ${argv.join(' ')}`, () => this.run(argv, options)),
    list: (path) => this.call(`list ${path}`, () => this.list(path)),
    read: (path) => this.call(`read ${path}`, () => this.file(path, (file) => decoder.decode(file.bytes))),
    stat: (path) => this.call(`stat ${path}`, () => this.stat(path)),
    now: async () => this.clock,
  }

  advance(ms: number): void {
    this.clock += ms
  }
  /** Each later call whose name starts with the prefix waits until the release. */
  hold(prefix: string): () => void {
    let open = (): void => undefined
    const gate: Gate = { prefix, opened: new Promise<void>((resolve) => (open = resolve)) }
    this.gates.push(gate)
    return () => {
      this.gates.splice(this.gates.indexOf(gate), 1)
      open()
    }
  }
  /** Each later call whose name starts with the prefix rejects, as a call that did not start or ran too long. */
  fail(prefix: string): void {
    this.failing.add(prefix)
  }
  heal(prefix: string): void {
    this.failing.delete(prefix)
  }
  mkdir(path: string): void {
    this.dirs.add(path)
  }
  /** A new file, with a new inode, written now. */
  write(path: string, data: string): void {
    this.files.set(path, { bytes: encoder.encode(data), mtimeMs: this.clock, inode: (this.inode += 1) })
  }
  /** More bytes at the end of a file, now: the inode stays. */
  append(path: string, data: string): void {
    const file = this.files.get(path)
    if (!file) throw new Error(`no file ${path}`)
    const more = encoder.encode(data)
    const bytes = new Uint8Array(file.bytes.length + more.length)
    bytes.set(file.bytes)
    bytes.set(more, file.bytes.length)
    Object.assign(file, { bytes, mtimeMs: this.clock })
  }
  register(row: Record<string, unknown>): void {
    this.write(`${REGISTRY}/${String(row['pid'])}.json`, JSON.stringify(row))
  }
  remove(path: string): void {
    this.files.delete(path)
  }
  /** The commands that ran to their answer. */
  commands(): string[] {
    return this.runs.map((run) => run.argv)
  }
  /** The commands that started, a held one too. */
  count(argv: string): number {
    return this.calls.filter((call) => call === `run ${argv}`).length
  }

  private async call<T>(name: string, answer: () => T): Promise<T> {
    this.calls.push(name)
    const startedAt = this.clock
    for (const gate of this.gates.filter((item) => name.startsWith(item.prefix))) await gate.opened
    await Promise.resolve()
    const delay = this.delays.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 0
    this.clock = Math.max(this.clock, startedAt + delay)
    if ([...this.failing].some((prefix) => name.startsWith(prefix))) throw new Error(`${name} did not run`)
    return answer()
  }

  private file<T>(path: string, take: (file: FakeFile) => T): T {
    const file = this.files.get(path)
    if (!file) throw new Error(`no file ${path}`)
    return take(file)
  }

  private run(argv: readonly string[], options?: RunOptions): RunResult {
    this.runs.push({ argv: argv.join(' '), ...(options ? { options } : {}) })
    const out = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
    const [name = '', flag = '', arg = '', ...rest] = argv
    if (name === 'claude') return this.agents === 'fails' ? out('', 1) : out(JSON.stringify(this.agents))
    if (name === 'cmux' && flag === 'capabilities') return out(JSON.stringify({ methods: ['workspace.select', 'surface.focus'] }))
    if (name === 'cmux' && flag === 'tree') return this.treeFails ? out('', 1) : out(JSON.stringify(this.tree))
    if (name === 'ps') {
      const lines = (rest[1] ?? '').split(',').flatMap((pid) => {
        const row = this.ps[Number(pid)]
        return row ? [`${pid} ${row.tty ?? '??'}  ${row.lstart}\n`] : []
      })
      return out(lines.join(''), lines.length > 0 ? 0 : 1)
    }
    if (name === 'git') {
      const lines = this.git[options?.cwd ?? '']
      return lines ? out(`${lines.join('\n')}\n`) : out('', 128)
    }
    if (name === 'stat') return out([arg, ...rest].flatMap((path) => (this.files.has(path) ? [`${this.files.get(path)?.inode} ${path}\n`] : [])).join(''))
    if (name === 'tail') return this.file(rest[0] ?? '', (file) => out(decoder.decode(file.bytes.subarray(Number(arg.slice(1)) - 1))))
    if (name === 'head') return this.file(rest[0] ?? '', (file) => out(decoder.decode(file.bytes.subarray(0, Number(arg)))))
    throw new Error(`the fake machine has no command ${argv.join(' ')}`)
  }

  private list(dir: string): DirEntry[] {
    const entries = new Map<string, DirEntry>()
    for (const [path, file] of this.files) {
      if (!path.startsWith(`${dir}/`)) continue
      const [name = '', ...deeper] = path.slice(dir.length + 1).split('/')
      entries.set(name, deeper.length ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : { name, kind: 'file', size: file.bytes.length, mtimeMs: file.mtimeMs, isLink: false })
    }
    if (entries.size === 0) throw new Error(`no folder ${dir}`)
    return [...entries.values()]
  }

  private stat(path: string): FileStat {
    const file = this.files.get(path)
    if (file) return { kind: 'file', size: file.bytes.length, mtimeMs: file.mtimeMs, isLink: false }
    if (this.dirs.has(path)) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
    throw new Error(`no path ${path}`)
  }
}

/** Session A on a whole machine: in the agents list and the registry, busy, with a transcript, a cmux tab and a repo. */
function alpha(): FakeMachine {
  const m = new FakeMachine()
  m.advance(-MINUTE)
  m.register(registryRow(A))
  m.advance(MINUTE)
  m.agents = [agentRow(A)]
  m.ps = { [A.pid]: { tty: 'ttys001', lstart: LSTART[A.pid] ?? '' } }
  m.tree = treeOf('alpha')
  m.mkdir(A.cwd)
  m.git = { [A.cwd]: [`${A.cwd}/.git`, `${A.cwd}/.git`, A.cwd] }
  m.write(PATH_A, transcriptOf(A, (b) => b.userPrompt('Fix the parser.').tick(1000).assistant([text('The parser test passes.')])))
  return m
}

const collectorOf = (m: FakeMachine): Collector => createCollector({ host: m.host, home: HOME, clock: () => m.clock })

/** Lets every microtask run: the fake machine answers in microtasks only, so 1 macrotask turn runs them all. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The value of a promise that must settle while a held call still waits. */
async function settles<T>(promise: Promise<T>): Promise<T> {
  const state: { done: boolean; value?: T } = { done: false }
  void promise.then((value) => Object.assign(state, { done: true, value }))
  await flush()
  if (!state.done) throw new Error('the refresh waits for the held call')
  return state.value as T
}

const board = (facts: Facts, now: number, previous?: BoardSnapshot): BoardSnapshot =>
  makeSnapshot({ facts, store: STORE, settings: SETTINGS, selfId: 'god-self', paneStartedAt: T0 - 30 * MINUTE, now, ...(previous ? { previous } : {}) }).snapshot
/** Every string value in a value, in any depth: JSON text would hide a C0 control behind its escape. */
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
const levelOf = (snapshot: BoardSnapshot, sessionId: string): Level | undefined => snapshot.sessions.find((row) => row.sessionId === sessionId)?.level
const only = (facts: Facts): SessionFacts => {
  const [row, ...more] = facts.sessions
  if (!row || more.length) throw new Error(`expected 1 session, got ${facts.sessions.length}`)
  return row
}
/** Runs the refresh that starts a 15 s loop, lets that loop end, then runs the next tick. */
async function afterLoop(m: FakeMachine, c: Collector): Promise<Facts> {
  m.advance(LOOP_MS)
  await c.refresh()
  await flush()
  m.advance(TICK_MS)
  return c.refresh()
}

describe('the 2 s tick and the 15 s loop', () => {
  it('the first refresh reads every source before it gives its facts, so the first board is whole', async () => {
    const m = alpha()
    const facts = await collectorOf(m).refresh()
    expect(Object.values(facts.sources).map((state) => state.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(only(facts)).toMatchObject({
      sessionId: A.sessionId,
      name: 'alpha main',
      status: 'busy',
      statusSince: T0 - MINUTE,
      repo: { commonDir: `${A.cwd}/.git`, topLevel: A.cwd, name: 'alpha', isWorktree: false },
      tab: { pid: A.pid, tty: 'ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'alpha' },
      transcript: { lastPrompt: 'Fix the parser.', lastReply: 'The parser test passes.' },
      lastWriteAt: T0,
      subagents: [],
    })
    expect(m.commands()).toEqual(expect.arrayContaining(['claude agents --json', 'cmux capabilities', 'cmux tree --all --json', 'ps -o pid=,tty=,lstart= -p 41001']))
    expect(m.runs.find((run) => run.argv.startsWith('ps '))?.options).toEqual({ env: { TZ: 'UTC' } })
    expect(m.runs.find((run) => run.argv.startsWith('git '))?.options).toEqual({ cwd: A.cwd })
  })

  it('a registry change shows in the snapshot on the next 2 s tick, and the tick runs no claude agents', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const first = board(await c.refresh(), m.clock)
    expect(levelOf(first, A.sessionId)).toBe('working')
    m.advance(1000)
    m.register(registryRow(A, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: m.clock }))
    m.advance(TICK_MS - 1000)
    const before = m.runs.length
    const next = board(await c.refresh(), m.clock, first)
    expect(levelOf(next, A.sessionId)).toBe('needs-you')
    expect(next.sessions[0]).toMatchObject({ waitingFor: 'input needed', levelSince: T0 + 1000 })
    expect(m.commands().slice(before)).not.toContain('claude agents --json')
  })

  it('a slow claude agents does not hold the 2 s tick, and its list shows on the first tick after it ends', async () => {
    const m = alpha()
    const c = collectorOf(m)
    await c.refresh()
    m.advance(LOOP_MS)
    const release = m.hold('run claude agents')
    m.agents = [agentRow(A, { name: 'alpha renamed' })]
    m.register(registryRow(A, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: m.clock }))
    const during = await settles(c.refresh())
    expect(only(during)).toMatchObject({ status: 'waiting', name: 'alpha main' })
    release()
    await flush()
    m.advance(TICK_MS)
    expect(only(await c.refresh())).toMatchObject({ status: 'waiting', name: 'alpha renamed' })
  })

  it('a tick during a refresh is dropped: it reads nothing and gets the facts of the last refresh', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const first = await c.refresh()
    m.advance(TICK_MS)
    const release = m.hold(`list ${REGISTRY}`)
    const running = c.refresh()
    await flush()
    m.advance(TICK_MS)
    const before = m.calls.length
    expect(await settles(c.refresh())).toBe(first)
    expect(m.calls.slice(before)).toEqual([])
    release()
    const ended = await running
    expect(ended).not.toBe(first)
    expect(ended.stats.at).toBe(T0 + TICK_MS * 2)
  })

  it('before the first refresh ends, a second tick reads nothing and gets the first refresh', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const release = m.hold(`list ${REGISTRY}`)
    const first = c.refresh()
    await flush()
    const before = m.calls.length
    expect(c.refresh()).toBe(first)
    expect(m.calls.length).toBe(before)
    release()
    expect(only(await first).sessionId).toBe(A.sessionId)
  })

  it('runs the 15 s loop again 15 s after it started, and never while a loop runs', async () => {
    const m = alpha()
    const c = collectorOf(m)
    await c.refresh()
    for (let at = TICK_MS; at < LOOP_MS; at += TICK_MS) {
      m.advance(TICK_MS)
      await c.refresh()
    }
    expect(m.count('claude agents --json')).toBe(1)
    m.advance(TICK_MS)
    const release = m.hold('run claude agents')
    await settles(c.refresh())
    expect(m.count('claude agents --json')).toBe(2)
    m.advance(LOOP_MS + TICK_MS)
    await settles(c.refresh())
    expect(m.count('claude agents --json')).toBe(2)
    release()
    await flush()
    m.advance(TICK_MS)
    await c.refresh()
    await flush()
    expect(m.count('claude agents --json')).toBe(3)
  })
})

describe('each source fails alone and keeps its last good facts', () => {
  it('cmux off keeps the other facts and the last good tab', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const first = await c.refresh()
    m.treeFails = true
    const facts = await afterLoop(m, c)
    expect(facts.sources.cmux).toEqual({ status: 'off', reason: 'The cmux tree command stopped with exit code 1.', lastOkAt: first.sources.cmux.lastOkAt })
    expect([facts.sources.agents.status, facts.sources.registry.status, facts.sources.git.status]).toEqual(['ok', 'ok', 'ok'])
    expect(facts.sources.agents.lastOkAt).toBeGreaterThan(first.sources.agents.lastOkAt ?? Infinity)
    expect(only(facts).tab).toEqual(only(first).tab)
    expect(only(facts)).toMatchObject({ status: 'busy', repo: only(first).repo, transcript: only(first).transcript })
  })

  it('a registry read that fails keeps the last good rows, and its state says off', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const first = await c.refresh()
    m.fail(`list ${REGISTRY}`)
    m.advance(TICK_MS)
    const facts = await c.refresh()
    expect(facts.sources.registry).toEqual({ status: 'off', reason: 'The mod cannot read the registry folder.', lastOkAt: first.sources.registry.lastOkAt })
    expect(facts.sessions).toEqual(first.sessions)
  })

  it('git that does not run keeps the repos it knew and asks again on the next loop', async () => {
    const m = alpha()
    const c = collectorOf(m)
    await c.refresh()
    m.advance(TICK_MS)
    m.register(registryRow(B, { statusUpdatedAt: m.clock }))
    m.agents = [agentRow(A), agentRow(B)]
    m.mkdir(B.cwd)
    m.fail('run git')
    const failed = await afterLoop(m, c)
    expect(failed.sources.git).toMatchObject({ status: 'off', reason: 'The git command did not run.' })
    expect(failed.sessions.map((row) => row.repo?.name)).toEqual(['alpha', undefined])
    m.heal('run git')
    m.git = { ...m.git, [B.cwd]: [`${B.cwd}/.git`, `${B.cwd}/.git`, B.cwd] }
    const healed = await afterLoop(m, c)
    expect(healed.sources.git.status).toBe('ok')
    expect(healed.sessions.map((row) => row.repo?.name)).toEqual(['alpha', 'beta'])
  })
})

describe('the liveness inputs', () => {
  it('reads the agents list after a good read with no ps check, and ps in UTC over the registry PIDs when it fails', async () => {
    const m = alpha()
    m.fail('run cmux capabilities')
    m.advance(-MINUTE)
    m.register(registryRow(B))
    m.advance(MINUTE)
    m.agents = [agentRow(A), agentRow(B)]
    m.ps = { ...m.ps, [B.pid]: { tty: 'ttys002', lstart: 'Fri Oct  9 11:59:00 2026' } } // B's PID runs another process now
    const c = collectorOf(m)
    const first = await c.refresh()
    expect(first.sessions.map((row) => row.sessionId)).toEqual([A.sessionId, B.sessionId])
    expect(m.commands().filter((run) => run.startsWith('ps '))).toEqual([])
    m.agents = 'fails'
    const facts = await afterLoop(m, c)
    expect(facts.sources.agents).toMatchObject({ status: 'off', reason: 'The claude agents command stopped with exit code 1.' })
    expect(facts.sessions.map((row) => row.sessionId)).toEqual([A.sessionId])
    expect(m.runs.filter((run) => run.argv.startsWith('ps '))).toEqual([{ argv: 'ps -o pid=,tty=,lstart= -p 41001,41002', options: { env: { TZ: 'UTC' } } }])
  })

  it('keeps the last agents list until the ps read returns, so a tick during that read keeps each session and its record state', async () => {
    const m = alpha()
    m.fail('run cmux capabilities')
    const c = collectorOf(m)
    expect(only(await c.refresh()).transcript?.lastPrompt).toBe('Fix the parser.')
    m.agents = 'fails'
    m.advance(LOOP_MS)
    const release = m.hold('run ps')
    await settles(c.refresh())
    m.advance(TICK_MS)
    const during = await settles(c.refresh())
    expect(during.sessions.map((row) => [row.sessionId, row.transcript?.lastPrompt])).toEqual([[A.sessionId, 'Fix the parser.']])
    release()
    await flush()
    m.advance(TICK_MS)
    const after = await c.refresh()
    expect(after.sources.agents.status).toBe('off')
    expect(after.sessions.map((row) => row.sessionId)).toEqual([A.sessionId])
    expect(m.calls.filter((call) => call === `run tail -c +1 ${PATH_A}`)).toHaveLength(1)
  })
})

describe('the repo cache', () => {
  it('keeps only the repos of the live cwds, so a cwd that comes back is asked again', async () => {
    const m = alpha()
    m.advance(-MINUTE)
    m.register(registryRow(B))
    m.advance(MINUTE)
    m.agents = [agentRow(A), agentRow(B)]
    m.mkdir(B.cwd)
    m.git = { ...m.git, [B.cwd]: [`${B.cwd}/.git`, `${B.cwd}/.git`, B.cwd] }
    const gitRuns = (): number => m.calls.filter((call) => call.startsWith('run git ')).length
    const c = collectorOf(m)
    await c.refresh()
    expect(gitRuns()).toBe(2)
    m.remove(`${REGISTRY}/${B.pid}.json`)
    m.agents = [agentRow(A)]
    expect((await afterLoop(m, c)).sessions.map((row) => row.repo?.name)).toEqual(['alpha'])
    expect(gitRuns()).toBe(2)
    m.register(registryRow(B, { statusUpdatedAt: m.clock }))
    m.agents = [agentRow(A), agentRow(B)]
    expect((await afterLoop(m, c)).sessions.map((row) => row.repo?.name)).toEqual(['alpha', 'beta'])
    expect(gitRuns()).toBe(3)
  })
})

describe('a clock that moves back', () => {
  it('makes the 15 s loop and the subagent list due, and gives no negative time', async () => {
    const m = alpha()
    const c = collectorOf(m)
    await c.refresh()
    const lists = (): number => m.calls.filter((call) => call === `list ${SUBAGENTS_A}`).length
    expect([m.count('claude agents --json'), lists()]).toEqual([1, 1])
    m.advance(-60 * MINUTE)
    const facts = await c.refresh()
    await flush()
    expect([m.count('claude agents --json'), lists()]).toEqual([2, 2])
    expect(facts.stats.computeMs).toBeGreaterThanOrEqual(0)
    expect(facts.stats.waitMs).toBeGreaterThanOrEqual(0)
  })

  it('stopwatch: a clock that moves back while a call is in flight gives a wait of 0, not less', async () => {
    let now = 100
    let resolve = (): void => undefined
    const pending = <T>(): Promise<T> => new Promise<T>((done) => (resolve = () => done(undefined as T)))
    const watch = stopwatch({ run: pending, list: pending, read: pending, stat: pending, now: pending }, () => now)
    const call = watch.host.list('/a')
    now = 40
    resolve()
    await call
    expect(watch.time(100, 40)).toEqual({ computeMs: 0, waitMs: 0 })
  })
})

describe('cmux', () => {
  it('while cmux is missing, each 15 s loop asks cmux capabilities again, and a timeout reads missing', async () => {
    const m = alpha()
    m.fail('run cmux capabilities')
    const c = collectorOf(m)
    const first = await c.refresh()
    expect(first.sources.cmux).toEqual({ status: 'missing', reason: 'The cmux command did not start.' })
    expect(only(first).tab).toBeUndefined()
    expect(m.commands()).not.toContain('cmux tree --all --json')
    m.heal('run cmux capabilities')
    const found = await afterLoop(m, c)
    expect(found.sources.cmux.status).toBe('ok')
    expect(only(found).tab).toMatchObject({ workspaceRef: 'workspace:1', surfaceRef: 'surface:1' })
    await afterLoop(m, c)
    expect([m.count('cmux capabilities'), m.count('cmux tree --all --json')]).toEqual([2, 2])
  })
})

describe('the transcripts', () => {
  it('keeps 1 record state per transcript: each read adds to it with its parse errors, and a fresh read starts it again', async () => {
    const m = alpha()
    const c = collectorOf(m)
    expect(only(await c.refresh()).transcript).toMatchObject({ title: 'Fix the parser.', lastPrompt: 'Fix the parser.', parseErrors: 0 })
    m.advance(1000)
    m.append(PATH_A, `${transcriptOf(A, (b) => b.userPrompt('Run the tests.'))}not json\n`)
    m.advance(1000)
    expect(only(await c.refresh()).transcript).toMatchObject({ title: 'Fix the parser.', lastPrompt: 'Run the tests.', parseErrors: 1 })
    m.advance(1000)
    m.append(PATH_A, '{bad\n')
    m.advance(1000)
    expect(only(await c.refresh()).transcript).toMatchObject({ lastPrompt: 'Run the tests.', parseErrors: 2 })
    m.advance(1000)
    m.write(PATH_A, transcriptOf(A, (b) => b.userPrompt('Start again.')))
    m.advance(1000)
    const fresh = only(await c.refresh()).transcript
    expect(fresh).toMatchObject({ title: 'Start again.', lastPrompt: 'Start again.', parseErrors: 0 })
    expect(fresh?.history.map((turn) => turn.prompt)).toEqual(['Start again.'])
  })

  it('passes the head records apart: a question in the head gives the title and never opens', async () => {
    const m = alpha()
    const head = transcriptOf(A, (b) =>
      b.userPrompt('Pick a color.').assistant([
        { type: 'tool_use', id: 'toolu_head1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] } },
      ]),
    )
    const pad = Array.from({ length: 64 }, (_, n) => transcriptOf(A, (b) => b.assistant([text(`Part ${n}. ${'x'.repeat(9000)}`)]))).join('')
    m.write(PATH_A, head + pad + transcriptOf(A, (b) => b.assistant([text('The tail reply.')])))
    const facts = only(await collectorOf(m).refresh()).transcript
    expect(m.commands().some((run) => run.startsWith('head -c '))).toBe(true)
    expect(facts).toMatchObject({ title: 'Pick a color.', lastReply: 'The tail reply.' })
    expect(facts?.openQuestion).toBeUndefined()
    expect(facts?.activity).toBeUndefined()
  })

  it('cleans every outside text: the agents name, the registry wait reason, the cmux title and the subagent meta', async () => {
    const m = alpha()
    m.agents = [agentRow(A, { name: `alpha${ESC}[31m API_KEY=abcdef123456` })]
    m.register(registryRow(A, { status: 'waiting', waitingFor: `input${BEL} needed` }))
    m.tree = treeOf(`${HOME}/code/alpha${CSI}`)
    m.write(`${SUBAGENTS_A}/agent-ab12.jsonl`, '')
    m.write(`${SUBAGENTS_A}/agent-ab12.meta.json`, JSON.stringify({ toolUseId: 'toolu_agent1', agentType: `Explore${ESC}`, description: `Read the ${KEY} file.` }))
    m.write(`${SUBAGENTS_A}/agent-cd34.jsonl`, '{}\n')
    m.write(`${SUBAGENTS_A}/agent-cd34.meta.json`, JSON.stringify({ toolUseId: 'toolu/../x', description: 'Plan.' }))
    const facts = await collectorOf(m).refresh()
    const row = only(facts)
    expect(row.name).not.toContain('abcdef123456')
    expect(row.waitingFor).toBe('input needed')
    expect(row.tab?.workspaceTitle).toBe('~/code/alpha')
    expect(row.subagents).toEqual([
      { agentId: 'ab12', size: 0, mtimeMs: T0, toolUseId: 'toolu_agent1', agentType: 'Explore', description: 'Read the ‹anthropic-key› file.' },
      { agentId: 'cd34', size: 3, mtimeMs: T0, description: 'Plan.' },
    ])
    expect(strings(facts).filter((value) => CONTROL.test(value))).toEqual([])
    expect(strings(facts).filter((value) => value.includes(KEY))).toEqual([])
  })

  it('keeps the record state inside: the collector gives only refresh, and the facts hold no raw transcript text', async () => {
    const m = alpha()
    const jsonl = transcriptOf(A, (b) =>
      b.userPrompt('Deploy it.').assistant([{ type: 'tool_use', id: 'toolu_open1', name: 'Bash', input: { command: 'deploy', env: { API_TOKEN: 'raw-token-value-123' } } }]),
    )
    m.write(PATH_A, jsonl)
    const c = collectorOf(m)
    expect(Object.keys(c)).toEqual(['refresh'])
    const facts = await c.refresh()
    const records = jsonl.trim().split('\n').map((line) => JSON.parse(line) as TranscriptRecord)
    expect(only(facts).transcript).toStrictEqual(reduceRecords(records, { home: HOME }))
    expect(only(facts).transcript?.activity).toMatchObject({ tool: 'Bash', isOpen: true })
    expect(JSON.stringify(facts)).not.toContain('raw-token-value-123')
  })
})

describe('the facts age', () => {
  it('a refresh that hangs for more than 10 s shows the last facts as old, and that is a change', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const first = await c.refresh()
    const firstBoard = board(first, m.clock)
    m.advance(TICK_MS)
    const release = m.hold(`list ${REGISTRY}`)
    const hung = c.refresh()
    await flush()
    m.advance(8000)
    const at10 = board(await settles(c.refresh()), m.clock, firstBoard)
    expect([hasOldFacts(at10), isSnapshotChanged(firstBoard, at10)]).toEqual([false, false])
    m.advance(TICK_MS)
    const at12 = board(await settles(c.refresh()), m.clock, firstBoard)
    expect([hasOldFacts(at12), isSnapshotChanged(firstBoard, at12)]).toEqual([true, true])
    release()
    await hung
  })

  it('an unchanged snapshot is not written again: a tick with no change gives the same board', async () => {
    const m = alpha()
    const c = collectorOf(m)
    const first = board(await c.refresh(), m.clock)
    m.advance(TICK_MS)
    const same = board(await c.refresh(), m.clock, first)
    expect(isSnapshotChanged(first, same)).toBe(false)
    m.register(registryRow(A, { status: 'idle', statusUpdatedAt: m.clock }))
    m.advance(TICK_MS)
    expect(isSnapshotChanged(same, board(await c.refresh(), m.clock, same))).toBe(true)
  })
})

describe('the refresh stats', () => {
  it('counts the time with a host call in flight as wait and the rest as compute, as the engine times a hook', async () => {
    const m = alpha()
    m.delays.push(['run claude agents', 400], ['run ps', 300], ['run', 20], ['list', 5], ['read', 5], ['stat', 5])
    const startedAt = m.clock
    const facts = await collectorOf(m).refresh()
    expect(facts.stats).toEqual({ at: m.clock, computeMs: 0, waitMs: m.clock - startedAt, sessions: 1 })
    expect(facts.stats.waitMs).toBeGreaterThanOrEqual(400 + 300)
  })

  it('adds the time of a 15 s loop that ran in the background to the refresh that ends after it, once', async () => {
    const m = alpha()
    const c = collectorOf(m)
    await c.refresh()
    m.advance(LOOP_MS)
    m.delays.push(['run claude agents', 400])
    const release = m.hold('run claude agents')
    expect((await settles(c.refresh())).stats.waitMs).toBeLessThan(400)
    release()
    await flush()
    m.advance(TICK_MS)
    expect((await c.refresh()).stats.waitMs).toBeGreaterThanOrEqual(400)
    m.advance(TICK_MS)
    expect((await c.refresh()).stats.waitMs).toBeLessThan(400)
  })

  it('stopwatch: calls that overlap count once, a failed call ends its wait, and the rest of the time is compute', async () => {
    let now = 0
    const pending: Array<{ resolve: () => void; reject: () => void }> = []
    const deferred = <T>(): Promise<T> => new Promise<T>((resolve, reject) => pending.push({ resolve: () => resolve(undefined as T), reject: () => reject(new Error('failed')) }))
    const host: Host = { run: deferred, list: deferred, read: deferred, stat: deferred, now: deferred }
    const watch = stopwatch(host, () => now)
    now = 10
    const first = watch.host.list('/a')
    now = 20
    const second = watch.host.read('/b').catch(() => 'failed')
    now = 50
    pending[0]?.resolve()
    await first
    now = 80
    pending[1]?.reject()
    expect(await second).toBe('failed')
    now = 100
    const third = watch.host.stat('/c')
    now = 130
    pending[2]?.resolve()
    await third
    expect(watch.time(0, 150)).toEqual({ computeMs: 50, waitMs: 100 })
  })

  it('stopwatch: a call that throws before it returns a promise rejects and ends its wait', async () => {
    let now = 0
    const refuse = (): never => {
      throw new Error('refused')
    }
    const watch = stopwatch({ run: refuse, list: refuse, read: refuse, stat: refuse, now: refuse }, () => now)
    now = 5
    await expect(watch.host.run(['claude', '-p'])).rejects.toThrow('refused')
    now = 9
    expect(watch.time(0, 9)).toEqual({ computeMs: 9, waitMs: 0 })
  })
})
