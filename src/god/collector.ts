/**
 * The collector of orangu god: the facts of the live sessions, read through the host port in 2 loops.
 *
 * - The 2 s tick (refresh) reads the registry files that changed and the transcripts that grew. It makes the facts
 *   from them and from the last results of the 15 s loop. `claude agents --json` waits 330 to 630 ms, so it never
 *   runs in the tick, and the 2 s registry read shows a new wait first.
 * - The 15 s loop reads `claude agents --json`, the cmux tab map (`cmux tree --all --json`, and `ps` in UTC for the
 *   TTY of each PID) and git for each new cwd. A refresh starts it when LOOP_MS passed since the last one started,
 *   and does not wait for it, so a slow command never holds the tick. Only the first refresh waits for it, so the
 *   first board is whole. While cmux is missing (a timeout reads missing too), each loop asks `cmux capabilities`
 *   again: cmux can start after the pane.
 * - A tick that comes while a refresh runs does not start: it reads nothing, and it gets the facts of the last
 *   refresh, or the running refresh before the first one ends. A loop that is due while a loop runs does not start.
 * - Each source fails alone and keeps its last good facts, and its state says off or missing with a reason. The
 *   liveness rule reads the agents list only after a good agents read. When that read failed, it reads the start
 *   times of the last good ps read, which runs over the registry PIDs. ps runs only when cmux is there or the agents
 *   read failed.
 * - Each transcript has 1 record state. Each read adds to it with its parse errors, and a read that starts again
 *   from the end starts it again. The head records give the title only. The record state holds raw transcript text,
 *   so it stays in this closure, and only transcriptFacts output leaves.
 * - Every outside text goes through the text cleaner of the home folder: the sources clean their own, and the
 *   subagent meta fields are cleaned here. A subagent tool use id that is not safe is left out.
 * - The stats time a refresh as the engine times the own work of a hook. waitMs is the time with at least 1 host
 *   call in flight, and computeMs is the rest of the wall time. A loop that ran in the background adds its own 2
 *   times to the refresh that ends after it.
 * The clock is a parameter that reads with no wait, and this file reads no other clock.
 */
import type { Host } from './host.js'
import { textCleaner } from './sanitize.js'
import { liveSessions, readAgents, readRegistry, type AgentsList, type RegistryCache, type SourceFailure, type SourceResult } from './source/agents.js'
import { mapTabs, readCmuxCapabilities, readCmuxTree, readPs, type CmuxSurface, type CmuxTree, type PsRow } from './source/cmux.js'
import { emptyRecordState, readRecords, transcriptFacts, type RecordState } from './source/records.js'
import { readRepos, repoOf, type RepoCache } from './source/repo.js'
import { listSubagents, readTranscripts, type SubagentEntry, type TranscriptCursor, type TranscriptRead } from './source/transcript.js'
import type { Facts, LiveSession, RefreshStats, RegistryRow, SessionFacts, SourceName, SourceState, SubagentFile, TabRef, TranscriptFacts } from './types.js'

/** The engine calls refresh this often. */
export const TICK_MS = 2_000
/** A refresh starts the 15 s loop when this many milliseconds passed since the last loop started. */
export const LOOP_MS = 15_000

/** A clock that reads with no wait: milliseconds since the epoch. The engine passes its own. */
export type Clock = () => number

export type CollectorOptions = {
  host: Host
  /** the home folder that the engine gives */
  home: string
  clock: Clock
}

/** The collectors behind 1 interface. */
export type Collector = {
  /** 1 tick: the facts of this refresh, or of the last one when a refresh still runs */
  refresh: () => Promise<Facts>
}

/** The 2 times of a refresh. */
export type RefreshTime = Pick<RefreshStats, 'computeMs' | 'waitMs'>

const NO_TIME: RefreshTime = { computeMs: 0, waitMs: 0 }
const UNREAD: SourceState = { status: 'unread' }
/** A subagent tool use id that may enter the facts, as the record reducer reads a call id. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/

const addTimes = (a: RefreshTime, b: RefreshTime): RefreshTime => ({ computeMs: a.computeMs + b.computeMs, waitMs: a.waitMs + b.waitMs })

/**
 * A host whose calls are timed, and the 2 times of a span: waitMs is the time with at least 1 call in flight (calls
 * that overlap count once), and computeMs is the rest of the span. The engine bounds the own work of a hook the same
 * way: its clock stops while a call of the hook is in flight.
 */
export function stopwatch(host: Host, clock: Clock): { host: Host; time: (startedAt: number, endedAt: number) => RefreshTime } {
  let inFlight = 0
  let since = 0
  let waitMs = 0
  const timed = <T>(call: () => Promise<T>): Promise<T> => {
    if (inFlight++ === 0) since = clock()
    return new Promise<T>((resolve) => resolve(call())).finally(() => {
      if (--inFlight === 0) waitMs += clock() - since
    })
  }
  return {
    host: {
      run: (argv, options) => timed(() => host.run(argv, options)),
      list: (path) => timed(() => host.list(path)),
      read: (path) => timed(() => host.read(path)),
      stat: (path) => timed(() => host.stat(path)),
      now: () => timed(() => host.now()),
    },
    time: (startedAt, endedAt) => ({ computeMs: Math.max(0, endedAt - startedAt - waitMs), waitMs }),
  }
}

/** What the collector keeps for 1 transcript between ticks. `records` holds raw transcript text: it never leaves. */
type TranscriptMemory = {
  cursor?: TranscriptCursor
  records?: RecordState
  facts?: TranscriptFacts
  lastWriteAt?: number
  /** the subagent files of the last list, with their raw meta fields, for the next list */
  entries: SubagentEntry[]
  /** the same files, cleaned */
  subagents: SubagentFile[]
  listedAt?: number
}

/** 1 subagent file with its meta fields cleaned, and its tool use id only when it is safe. */
function subagentFile(entry: SubagentEntry, clean: (text: string) => string): SubagentFile {
  const { toolUseId, agentType, rawDescription } = entry.meta ?? {}
  return {
    agentId: clean(entry.agentId),
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ...(toolUseId !== undefined && TOOL_USE_ID.test(toolUseId) ? { toolUseId } : {}),
    ...(agentType !== undefined ? { agentType: clean(agentType) } : {}),
    ...(rawDescription !== undefined ? { description: clean(rawDescription) } : {}),
  }
}

/** The collector over the host port, with the home folder and the clock of the engine. */
export function createCollector({ host, home, clock }: CollectorOptions): Collector {
  const clean = textCleaner(home)
  const sources: Record<SourceName, SourceState> = { agents: UNREAD, registry: UNREAD, cmux: UNREAD, git: UNREAD }
  let registryRows: readonly RegistryRow[] = []
  let registryCache: RegistryCache = {}
  /** the last agents list, only while the last agents read was good */
  let agents: AgentsList | undefined
  let psRows: readonly PsRow[] = []
  let surfaces: readonly CmuxSurface[] = []
  let isCmuxFound = false
  let tabs: readonly TabRef[] = []
  let repos: RepoCache = {}
  const transcripts = new Map<string, TranscriptMemory>()
  let last: Facts | undefined
  let running: Promise<Facts> | undefined
  let loopStartedAt: number | undefined
  let isLoopRunning = false
  let loopTime = NO_TIME

  const good = (): SourceState => ({ status: 'ok', lastOkAt: clock() })
  const failed = (name: SourceName, failure: SourceFailure): SourceState => {
    const { lastOkAt } = sources[name]
    return { status: failure.status, reason: failure.reason, ...(lastOkAt === undefined ? {} : { lastOkAt }) }
  }

  /** The live sessions: by the agents list after a good agents read, else by the start times of the last good ps read. */
  function live(): LiveSession[] {
    return agents ? liveSessions({ agents, registry: registryRows }) : liveSessions({ registry: registryRows, procStarts: psRows })
  }

  async function readCmux(h: Host): Promise<SourceResult<CmuxTree>> {
    if (!isCmuxFound) {
      const capabilities = await readCmuxCapabilities(h)
      if (!capabilities.ok && capabilities.status === 'missing') return capabilities
      isCmuxFound = true
    }
    return readCmuxTree(h, clean)
  }

  /** The 15 s loop: the agents list, the cmux tab map, then git for each new cwd of the live sessions. */
  async function runLoop(h: Host): Promise<void> {
    const [listed, tree] = await Promise.all([readAgents(h, clean), readCmux(h)])
    agents = listed.ok ? listed.value : undefined
    sources.agents = listed.ok ? good() : failed('agents', listed)
    if (tree.ok) surfaces = tree.value.surfaces
    const pids = [...(agents?.rows ?? []), ...registryRows].map((row) => row.pid)
    const ps = isCmuxFound || !listed.ok ? await readPs(h, pids) : undefined
    if (ps?.ok) psRows = ps.value.rows
    const cmuxFailure = !tree.ok ? tree : ps && !ps.ok ? ps : undefined
    sources.cmux = cmuxFailure ? failed('cmux', cmuxFailure) : good()
    tabs = isCmuxFound ? mapTabs(psRows, surfaces) : []
    const read = await readRepos(h, live().map((session) => session.cwd), repos)
    repos = read.cache
    sources.git = read.failure ? failed('git', read.failure) : good()
  }

  /** Starts the loop with its own timed host. Its 2 times go to the refresh that ends after it. */
  function startLoop(): void {
    const watch = stopwatch(host, clock)
    const startedAt = clock()
    isLoopRunning = true
    void runLoop(watch.host)
      .then(() => {
        loopTime = addTimes(loopTime, watch.time(startedAt, clock()))
      })
      // No read of the loop throws. If a bug does, each loop source keeps what the last good read left, the error
      // does not reach the engine as a rejection that no one handles, and the next due tick starts the loop again.
      .catch(() => undefined)
      .finally(() => {
        isLoopRunning = false
      })
  }

  /** Keeps 1 transcript read: the cursor, then the record state and its facts. */
  function keepRead(memory: TranscriptMemory, read: TranscriptRead): void {
    memory.cursor = read.cursor
    if (read.status === 'missing') {
      delete memory.records
      delete memory.facts
      delete memory.lastWriteAt
      return
    }
    memory.lastWriteAt = read.mtimeMs
    if (read.status !== 'read') return
    const state = read.isFresh || memory.records === undefined ? emptyRecordState(home) : memory.records
    memory.records = readRecords(state, read.records, { headRecords: read.headRecords, parseErrors: read.parseErrors })
    memory.facts = transcriptFacts(memory.records)
  }

  /** Lists the subagent files of a transcript when it grew, or when its last list is LOOP_MS old. */
  async function keepSubagents(h: Host, memory: TranscriptMemory, read: TranscriptRead): Promise<void> {
    const path = memory.cursor?.path
    if (read.status === 'missing' || path === undefined) {
      Object.assign(memory, { entries: [], subagents: [] })
      delete memory.listedAt
      return
    }
    if (read.status !== 'read' && memory.listedAt !== undefined && clock() - memory.listedAt < LOOP_MS) return
    memory.entries = await listSubagents(h, path, memory.entries)
    memory.subagents = memory.entries.map((entry) => subagentFile(entry, clean))
    memory.listedAt = clock()
  }

  /** Reads the transcript of each live session, and forgets the transcripts of the sessions that ended. */
  async function readSessions(h: Host, sessions: readonly LiveSession[]): Promise<void> {
    const ids = new Set(sessions.map((session) => session.sessionId))
    for (const id of transcripts.keys()) if (!ids.has(id)) transcripts.delete(id)
    const memories = sessions.map((session) => {
      const memory = transcripts.get(session.sessionId) ?? { entries: [], subagents: [] }
      transcripts.set(session.sessionId, memory)
      return memory
    })
    const targets = sessions.map(({ sessionId, cwd }, index) => {
      const cursor = memories[index]?.cursor
      return cursor === undefined ? { sessionId, cwd } : { sessionId, cwd, cursor }
    })
    const reads = await readTranscripts(h, home, targets)
    reads.forEach((read, index) => keepRead(memories[index]!, read))
    await Promise.all(reads.map((read, index) => keepSubagents(h, memories[index]!, read)))
  }

  function factsOf(session: LiveSession, tabOf: ReadonlyMap<number, TabRef>): SessionFacts {
    const memory = transcripts.get(session.sessionId)
    const repo = repoOf(repos, session.cwd)
    const tab = tabOf.get(session.pid)
    return {
      ...session,
      ...(repo === undefined ? {} : { repo }),
      ...(tab === undefined ? {} : { tab }),
      ...(memory?.facts === undefined ? {} : { transcript: memory.facts }),
      ...(memory?.lastWriteAt === undefined ? {} : { lastWriteAt: memory.lastWriteAt }),
      subagents: memory?.subagents ?? [],
    }
  }

  async function tick(): Promise<Facts> {
    const watch = stopwatch(host, clock)
    const startedAt = clock()
    const read = await readRegistry(watch.host, home, registryCache, clean)
    if (read.ok) ({ rows: registryRows, cache: registryCache } = read.value)
    sources.registry = read.ok ? good() : failed('registry', read)
    if (!isLoopRunning && (loopStartedAt === undefined || startedAt - loopStartedAt >= LOOP_MS)) {
      loopStartedAt = startedAt
      if (last === undefined) await runLoop(watch.host)
      else startLoop()
    }
    const sessions = live()
    await readSessions(watch.host, sessions)
    const tabOf = new Map(tabs.map((tab) => [tab.pid, tab]))
    const rows = sessions.map((session) => factsOf(session, tabOf))
    const endedAt = clock()
    const time = addTimes(watch.time(startedAt, endedAt), loopTime)
    loopTime = NO_TIME
    last = { sessions: rows, sources: { ...sources }, stats: { at: endedAt, ...time, sessions: rows.length } }
    return last
  }

  return {
    refresh: () => {
      if (running) return last ? Promise.resolve(last) : running
      running = tick().finally(() => {
        running = undefined
      })
      return running
    },
  }
}
