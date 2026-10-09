/**
 * The board loop of the god pane: what the engine does on each tick, as pure code over ports, so the engine shell
 * (src/god/register.tsx) only connects the ports to `$`.
 *
 * - A tick refreshes the facts through the collector, then publishes. A tick that comes while a refresh runs gets
 *   the last facts again, and still publishes, so facts that stop moving show as old after 10 s.
 * - A publish makes a snapshot from the newest facts that any refresh gave (a slow refresh that ends after a faster
 *   one never takes the board back), the stored choices and the settings, with the last written snapshot as
 *   `previous`. It adds the first-sight times to the store, and writes the snapshot only when isSnapshotChanged
 *   says so. Publishes run 1 at a time.
 * - When the snapshot did not change, but a time that the open pane shows moved (the time in a level, the age of
 *   old facts), the loop asks the pane to draw again: the pane reads the clock while it draws.
 * - The status line counts the sessions that need you while the pane is not on the screen, and changes only when
 *   its text changes.
 * - A choice (a /god form, the f or g key) goes to the store, field by field, and publishes at once.
 * - A failed port does not stop the loop: a store write that fails leaves the choice in memory, and a snapshot that
 *   the engine did not take is written on the next tick.
 */
import { statusText, type BoardChoice, type StoreKey } from './control.js'
import { hasOldFacts, isSnapshotChanged, makeSnapshot } from './snapshot.js'
import type { BoardSnapshot, Facts, Settings, StoreState } from './types.js'
import { levelTime } from './view/board.js'

/** What the loop asks of the engine. */
export type BoardPorts = {
  /** 1 refresh of the collector */
  refresh: () => Promise<Facts>
  /** the time now, with no wait */
  clock: () => number
  writeSnapshot: (snapshot: BoardSnapshot) => Promise<void>
  writeStore: (key: StoreKey, value: unknown) => Promise<void>
  /** sets the status line; undefined clears it */
  showStatus: (text: string | undefined) => void
  /** asks the pane to draw again */
  redraw: () => void
}

export type BoardLoopOptions = {
  ports: BoardPorts
  /** the stored choices when the loop starts */
  store: StoreState
  settings: Settings
  /** the session id of the god session */
  selfId: string
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
}

/** The times that the pane shows of a snapshot: the time in the level of each row, and the age of old facts. */
function shownTimes(snapshot: BoardSnapshot): string {
  const rows = snapshot.sessions.map((session) => levelTime(session.levelSince, snapshot.at)).join(' ')
  const oldAge = hasOldFacts(snapshot) && snapshot.factsAt !== undefined ? Math.floor((snapshot.at - snapshot.factsAt) / 1000) : -1
  return `${rows}|${oldAge}`
}

export function createBoardLoop(options: BoardLoopOptions): BoardLoop {
  const { ports, settings, selfId, paneStartedAt } = options
  let store = options.store
  let isPaneOpen = options.isPaneOpen
  let latest: Facts | undefined
  let written: BoardSnapshot | undefined
  let drawnTimes: string | undefined
  let shownStatus: string | undefined
  let queue: Promise<void> = Promise.resolve()

  /** Runs 1 publish after the ones before it. */
  const serial = (work: () => Promise<void>): Promise<void> => {
    const run = queue.then(work)
    queue = run.catch(() => undefined)
    return run
  }

  function updateStatus(): void {
    const text = statusText(written, isPaneOpen)
    if (text === shownStatus) return
    shownStatus = text
    ports.showStatus(text)
  }

  async function keepFirstSight(firstSight: Record<string, number>): Promise<void> {
    if (Object.keys(firstSight).length === 0) return
    const seenAt = { ...store.seenAt, ...firstSight }
    try {
      await ports.writeStore('seenAt', seenAt)
      store = { ...store, seenAt }
    } catch {
      // the next publish gives the same entries again and tries once more
    }
  }

  async function publish(): Promise<void> {
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
    await keepFirstSight(firstSight)
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
  }

  return {
    tick: async () => {
      try {
        const facts = await ports.refresh()
        if (latest === undefined || facts.stats.at >= latest.stats.at) latest = facts
        await serial(publish)
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
  }
}
