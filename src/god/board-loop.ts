/**
 * The board loop of the god pane: what the engine does on each tick, as pure code over ports, so the engine shell
 * (src/god/register.tsx) only connects the ports to `$`.
 *
 * - A tick reads the session id of the god session and refreshes the facts through the collector, then publishes. The
 *   id can change with no session start (a /clear), so the board reads it on each tick and leaves out the new one.
 *   A tick that comes while a refresh runs gets the last facts again, and still publishes, so facts that stop moving
 *   show as old after 10 s.
 * - A publish makes a snapshot from the newest facts that any refresh gave (a slow refresh that ends after a faster
 *   one never takes the board back), the stored choices and the settings, with the last written snapshot as
 *   `previous`. It adds the first-sight times to the store, and writes the snapshot only when isSnapshotChanged
 *   says so. Publishes run 1 at a time. The stored seenAt keeps only the sessions of the board, so the store (4 MiB
 *   at most) does not grow with each session that ever ran.
 * - When the snapshot did not change, but a time that the open pane shows moved (the time in a level, the age of
 *   old facts), the loop asks the pane to draw again: the pane reads the clock while it draws.
 * - The status line counts the sessions that need you while the pane is not on the screen, and changes only when
 *   its text changes.
 * - A choice (a /god form, the f or g key) goes to the store, field by field, and publishes at once.
 * - A jump to a session and an open of its row mark it seen: its seenAt takes that time, goes to the store with the
 *   seenAt of the other sessions of the board, and the loop publishes at once, so YOUR TURN turns to IDLE. A session
 *   that is not on the board is not marked. The mark runs in the queue of the publishes, after the one that runs.
 * - The loop keeps the stats of the last RECENT_STATS refreshes for /god stats, each refresh once: a tick that the
 *   collector dropped gives the last facts again, with the same time.
 * - After the publish of each tick, a dropped one too, the alert decision (src/god/alert-loop.ts) reads the turn: the
 *   snapshot of the tick before and its time, the new snapshot, the stored choices and whether the pane is on the
 *   screen. The snapshot of the tick before, not the last written one: a choice or a seen mark can write a snapshot
 *   between 2 ticks (a session that crossed the stuck limit), and that change must still count once. The first tick
 *   of a load has no tick before, so it decides nothing. The decision runs in the queue of the publishes.
 * - A failed port does not stop the loop: a store write that fails leaves the choice in memory, and a snapshot that
 *   the engine did not take is written on the next tick.
 */
import { statusText, type BoardChoice, type StoreKey } from './control.js'
import { hasOldFacts, isSnapshotChanged, makeSnapshot } from './snapshot.js'
import type { BoardSnapshot, Facts, RefreshStats, Settings, StoreState } from './types.js'
import { levelTime } from './view/board.js'

/** What the loop asks of the engine. */
export type BoardPorts = {
  /** 1 refresh of the collector */
  refresh: () => Promise<Facts>
  /** the time now, with no wait */
  clock: () => number
  /** the session id of the god session now */
  selfId: () => Promise<string>
  writeSnapshot: (snapshot: BoardSnapshot) => Promise<void>
  writeStore: (key: StoreKey, value: unknown) => Promise<void>
  /** sets the status line; undefined clears it */
  showStatus: (text: string | undefined) => void
  /** asks the pane to draw again */
  redraw: () => void
  /** the alert decision of 1 tick; a failure stops nothing */
  onRefresh: (turn: RefreshTurn) => Promise<void>
}

/** What the alert decision of 1 tick reads. */
export type RefreshTurn = {
  /** the snapshot of the tick before; absent on the first tick of the load */
  last?: BoardSnapshot
  next: BoardSnapshot
  /** the time of the tick before, whatever it changed; absent on the first tick of the load */
  lastRefreshAt?: number
  store: StoreState
  /** true when the pane is on the screen of this session */
  isPaneOpen: boolean
  /** the time of this tick: the time of `next` */
  now: number
}

export type BoardLoopOptions = {
  ports: BoardPorts
  /** the stored choices when the loop starts */
  store: StoreState
  settings: Settings
  /** when the pane started: the first-sight time of a session that the store does not hold */
  paneStartedAt: number
  /** true when the pane is on the screen */
  isPaneOpen: boolean
}

export type BoardLoop = {
  /** 1 tick: a refresh, then a publish. It never rejects. */
  tick: () => Promise<void>
  /** keeps a choice in the store and publishes at once */
  choose: (choice: BoardChoice) => Promise<void>
  /** says whether the pane is on the screen, for the status line */
  setPaneOpen: (isOpen: boolean) => void
  store: () => StoreState
  /** the last snapshot that the engine took */
  snapshot: () => BoardSnapshot | undefined
  /** the newest facts, for /god stats */
  facts: () => Facts | undefined
  /** the stats of the last refreshes, oldest first, for /god stats */
  recentStats: () => readonly RefreshStats[]
  /** marks a session of the board seen at `at` (a jump, or an open of its row), and publishes at once */
  seen: (sessionId: string, at: number) => Promise<void>
}

/** /god stats reads the stats of this many refreshes. */
export const RECENT_STATS = 10

/** The times that the pane shows of a snapshot: the time in the level of each row, and the age of old facts. */
function shownTimes(snapshot: BoardSnapshot): string {
  const rows = snapshot.sessions.map((session) => levelTime(session.levelSince, snapshot.at)).join(' ')
  const oldAge = hasOldFacts(snapshot) && snapshot.factsAt !== undefined ? Math.floor((snapshot.at - snapshot.factsAt) / 1000) : -1
  return `${rows}|${oldAge}`
}

export function createBoardLoop(options: BoardLoopOptions): BoardLoop {
  const { ports, settings, paneStartedAt } = options
  let store = options.store
  let isPaneOpen = options.isPaneOpen
  let selfId = ''
  let latest: Facts | undefined
  let written: BoardSnapshot | undefined
  let drawnTimes: string | undefined
  let shownStatus: string | undefined
  let queue: Promise<void> = Promise.resolve()
  let recent: RefreshStats[] = []
  let lastTick: BoardSnapshot | undefined

  /** Runs 1 publish after the ones before it. */
  const serial = (work: () => Promise<unknown>): Promise<void> => {
    const run = queue.then(work).then(() => undefined)
    queue = run.catch(() => undefined)
    return run
  }

  function updateStatus(): void {
    const text = statusText(written, isPaneOpen)
    if (text === shownStatus) return
    shownStatus = text
    ports.showStatus(text)
  }

  /** Writes the first-sight times with the stored times of the sessions that the board still has. */
  async function keepFirstSight(snapshot: BoardSnapshot, firstSight: Record<string, number>): Promise<void> {
    if (Object.keys(firstSight).length === 0) return
    const kept = snapshot.sessions.flatMap(({ sessionId }) => (Object.hasOwn(store.seenAt, sessionId) ? [[sessionId, store.seenAt[sessionId]!] as const] : []))
    const seenAt = { ...Object.fromEntries(kept), ...firstSight }
    try {
      await ports.writeStore('seenAt', seenAt)
      store = { ...store, seenAt }
    } catch {
      // the next publish gives the same entries again and tries once more
    }
  }

  async function publish(): Promise<BoardSnapshot> {
    const now = ports.clock()
    const { snapshot, firstSight } = makeSnapshot({
      ...(latest === undefined ? {} : { facts: latest }),
      store,
      settings,
      selfId,
      paneStartedAt,
      now,
      ...(written === undefined ? {} : { previous: written }),
    })
    await keepFirstSight(snapshot, firstSight)
    const times = shownTimes(snapshot)
    if (isSnapshotChanged(written, snapshot)) {
      await ports.writeSnapshot(snapshot)
      written = snapshot
      drawnTimes = times
    } else if (isPaneOpen && times !== drawnTimes) {
      drawnTimes = times
      ports.redraw()
    }
    updateStatus()
    return snapshot
  }

  /** The publish of a tick, then the alert decision of its turn. */
  async function publishTick(): Promise<void> {
    const next = await publish()
    const last = lastTick
    lastTick = next
    const before = last === undefined ? {} : { last, lastRefreshAt: last.at }
    await ports.onRefresh({ ...before, next, store, isPaneOpen, now: next.at }).catch(() => undefined)
  }

  return {
    tick: async () => {
      try {
        selfId = await ports.selfId()
        const facts = await ports.refresh()
        if (latest === undefined || facts.stats.at >= latest.stats.at) latest = facts
        if (recent.length === 0 || facts.stats.at > recent.at(-1)!.at) recent = [...recent, facts.stats].slice(-RECENT_STATS)
        await serial(publishTick)
      } catch {
        // a refresh never rejects, and a failed write tries again on the next tick
      }
    },
    choose: async (choice) => {
      store = { ...store, ...choice }
      for (const key of Object.keys(choice) as Array<keyof BoardChoice>) await ports.writeStore(key, store[key]).catch(() => undefined)
      await serial(publish).catch(() => undefined)
    },
    setPaneOpen: (isOpen) => {
      isPaneOpen = isOpen
      updateStatus()
    },
    store: () => store,
    snapshot: () => written,
    facts: () => latest,
    recentStats: () => recent,
    // in the queue of the publishes: a first-sight write that runs builds its seenAt before its await, so a mark made
    // beside it would be lost
    seen: (sessionId, at) =>
      serial(async () => {
        const sessions = written?.sessions ?? []
        if (!sessions.some((session) => session.sessionId === sessionId)) return
        const kept = sessions.flatMap(({ sessionId: id }) => (Object.hasOwn(store.seenAt, id) ? [[id, store.seenAt[id]!] as const] : []))
        store = { ...store, seenAt: { ...Object.fromEntries(kept), [sessionId]: at } }
        await ports.writeStore('seenAt', store.seenAt).catch(() => undefined)
        await publish()
      }).catch(() => undefined),
  }
}
