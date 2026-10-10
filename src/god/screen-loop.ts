/**
 * The screen loop of the Screen tab: it reads the screen of the selected session every SCREEN_MS while the tab is
 * open and a surface draws it, as pure code over ports, so the engine shell (src/god/register.tsx) only connects the
 * ports to `$`.
 *
 * - screenWanted gives the tab that the shared state asks for: the Screen tab is open, a session of the board is
 *   selected, cmux is on the machine, and the session has a mapped tab whose refs the guard takes. Every surface
 *   gives the same answer, because the state is shared.
 * - Each draw of the pane calls want with that answer and whether this draw shows the Screen tab of the session (a
 *   narrow board, a message or a pane that cannot draw shows none). No answer stops the loop at once: the tab
 *   closed, the selection moved to a session with no tab, or cmux left. A new answer reads the new tab at once. A
 *   draw that shows the tab starts the loop, or renews it.
 * - A timer tick reads the screen once, and never while a read of the same tab runs. A tick after more than
 *   SCREEN_LEASE_TICKS ticks with no draw that shows the tab stops the loop: no surface draws the pane, so it hid.
 *   Each read writes the engine state, and the pane that shows it draws again, so a shown tab renews itself. A draw
 *   of a surface that does not show the tab does not renew it, and does not stop it either, so 2 surfaces of 1
 *   session with 2 layouts do not start and stop the reads in turn.
 * - stop ends the loop at once: the engine shell calls it when the pane closes.
 * - A read of a tab that the loop no longer wants is dropped. A failed read marks the tab as failed and keeps the
 *   last good read of the same session under the mark.
 */
import { tabRefs } from './act/jump.js'
import type { ScreenState, ScreenTarget } from './source/screen.js'
import type { BoardSnapshot, DetailTab, ScreenRead } from './types.js'
import type { PaneView } from './view/types.js'

/** The Screen tab reads the screen this often. */
export const SCREEN_MS = 1000

/** The loop stops after this many ticks with no draw that shows the Screen tab. */
export const SCREEN_LEASE_TICKS = 2

/** What the loop asks of the engine. */
export type ScreenPorts = {
  /** 1 read of the tab, cleaned, or undefined when it failed */
  read: (target: ScreenTarget) => Promise<ScreenRead | undefined>
  write: (state: ScreenState) => Promise<void>
  /** a timer of the engine clock that calls fn every ms until it is cancelled */
  every: (ms: number, fn: () => void) => { cancel: () => void }
}

export type ScreenLoop = {
  /** 1 draw of the pane: the tab that the shared state asks for, and whether this draw shows it */
  want: (target: ScreenTarget | undefined, isShown: boolean) => void
  /** ends the loop at once: the pane closed */
  stop: () => void
}

/** The tab that the shared state asks the Screen tab to read, the same on every surface. */
export function screenWanted(snapshot: BoardSnapshot | undefined, selectedKey: string | undefined, tab: DetailTab): ScreenTarget | undefined {
  if (tab !== 'screen' || snapshot === undefined || snapshot.sources.cmux.status === 'missing') return undefined
  const session = snapshot.sessions.find((candidate) => candidate.sessionId === selectedKey)
  const refs = tabRefs(session?.tab)
  return session === undefined || refs === undefined ? undefined : { sessionId: session.sessionId, ...refs }
}

/** True when the view draws the detail of the target session in full: the board beside it, or the narrow detail. */
export function isScreenShown(view: PaneView, target: ScreenTarget | undefined): boolean {
  const detail = view.kind === 'board' || view.kind === 'detail' ? view.detail : undefined
  return target !== undefined && detail?.kind === 'session' && detail.sessionId === target.sessionId && detail.view.kind === 'detail'
}

const keyOf = (target: ScreenTarget): string => `${target.sessionId} ${target.workspaceRef} ${target.surfaceRef}`

export function createScreenLoop(ports: ScreenPorts): ScreenLoop {
  let target: ScreenTarget | undefined
  let timer: { cancel: () => void } | undefined
  let idleTicks = 0
  let reading: string | undefined
  let last: ScreenState | undefined

  const isWanted = (read: ScreenTarget): boolean => target !== undefined && keyOf(target) === keyOf(read)

  function stop(): void {
    timer?.cancel()
    timer = undefined
    target = undefined
  }

  /** The state after 1 read of `of`: the new read, or the failed mark over the last good read of that session. */
  function stateAfter(of: ScreenTarget, read: ScreenRead | undefined): ScreenState {
    if (read !== undefined) return { sessionId: of.sessionId, read, isFailed: false }
    const kept = last?.sessionId === of.sessionId ? last.read : undefined
    return { sessionId: of.sessionId, ...(kept === undefined ? {} : { read: kept }), isFailed: true }
  }

  function readOnce(of: ScreenTarget): void {
    const key = keyOf(of)
    if (reading === key) return
    reading = key
    void ports
      .read(of)
      .then(async (read) => {
        if (!isWanted(of)) return
        last = stateAfter(of, read)
        await ports.write(last)
      })
      // a write that the engine did not take is made again by the next read
      .catch(() => undefined)
      .finally(() => {
        if (reading === key) reading = undefined
      })
  }

  function tick(): void {
    if (target === undefined) return
    idleTicks += 1
    if (idleTicks > SCREEN_LEASE_TICKS) stop()
    else readOnce(target)
  }

  return {
    want: (next, isShown) => {
      if (next === undefined) return stop()
      if (target !== undefined && keyOf(target) !== keyOf(next)) stop()
      if (!isShown) return
      idleTicks = 0
      if (target !== undefined) return
      target = next
      timer = ports.every(SCREEN_MS, tick)
      readOnce(next)
    },
    stop,
  }
}
