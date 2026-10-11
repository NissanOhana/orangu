/**
 * The alert loop of the god pane: what the engine does with the turn of each tick of the board loop, as pure code over
 * ports, so the engine shell only connects the ports to `$`.
 *
 * - Each turn reads the alert state (the engine state keeps it, so a reload of the code keeps the 5 min limit) and the
 *   sound and the muted sessions from the store, asks the alert policy (src/god/act/alert-policy.ts) with the turn
 *   and those 2 values, and writes the new state when it changed. The policy itself sends nothing on the first tick
 *   of a load, with no time of the tick before, or after a gap of more than 5 min.
 * - The sound and the muted sessions come from the store on each turn, not from the stored choices of the turn. /god
 *   in a second session runs a second board on the same store, and its s or u writes there after this board read it.
 * - Only after the state is written does it send the alerts, so a refresh never sends an alert twice. A state that it
 *   cannot read or write, or a store that it cannot read, sends nothing.
 * - Each alert plays its tone when the policy says so (TONES of its kind), and an alert of needs-you or stuck sends 1
 *   notification and 1 ring on the cmux tab of the session, through the host of the ring only
 *   (src/god/act/alerts.ts). The name of the session goes through the text cleaner first.
 * - The effects run beside the board: the turn does not wait for a tone to end or for cmux, and a failed effect
 *   stops nothing. The loop counts the tones that played and the notifications that a channel sent, for /god stats.
 */
import { decideAlerts, type AlertDecision, type AlertState } from './act/alert-policy.js'
import { alertNotice, ringArgv, ringHost } from './act/alerts.js'
import { TONES } from './act/tones.js'
import type { RefreshTurn } from './board-loop.js'
import type { Effects, Host } from './host.js'
import type { AlertCounts, StoreState } from './types.js'

/** What the loop reads, writes and sends through. */
export type AlertPorts = {
  /** the alert state in the engine state */
  readState: () => Promise<AlertState>
  writeState: (state: AlertState) => Promise<void>
  /** the sound and the muted sessions in the store now, each checked, else its default */
  readChoices: () => Promise<Pick<StoreState, 'sound' | 'muted'>>
  effects: Pick<Effects, 'play' | 'notify'>
  /** the host port: the ring goes only through ringHost over it */
  host: Host
  /** the text cleaner of the home folder (src/god/sanitize.ts) */
  clean: (text: string) => string
}

export type AlertLoop = {
  /** the decision of 1 turn, its state written, and its alerts sent; it never rejects */
  onRefresh: (turn: RefreshTurn) => Promise<void>
  /** the tones that played and the notifications that a channel sent since the loop started */
  counts: () => AlertCounts
}

const quiet = (work: Promise<unknown>): void => void work.catch(() => undefined)

export function createAlertLoop(ports: AlertPorts): AlertLoop {
  const counts: AlertCounts = { tones: 0, notifications: 0 }
  const ring = ringHost(ports.host)

  /** The decision of the turn with its state written, or false when the loop cannot read the state or the store, or write the state. */
  async function decide(turn: RefreshTurn): Promise<AlertDecision | false> {
    try {
      const [state, store] = await Promise.all([ports.readState(), ports.readChoices()])
      const decision = decideAlerts({ ...turn, store, state })
      if (JSON.stringify(decision.state) !== JSON.stringify(state)) await ports.writeState(decision.state)
      return decision
    } catch {
      return false
    }
  }

  return {
    onRefresh: async (turn) => {
      const decision = await decide(turn)
      if (decision === false) return
      for (const alert of decision.alerts) {
        if (alert.playsTone) quiet(ports.effects.play(TONES[alert.kind]).then(() => void (counts.tones += 1)))
        const session = turn.next.sessions.find((candidate) => candidate.sessionId === alert.sessionId)
        if (!alert.notifies || alert.kind === 'done' || session === undefined) continue
        const notice = alertNotice(session, alert.kind, ports.clean)
        quiet(ports.effects.notify(notice.body, notice.title).then((sent) => void (counts.notifications += sent.isSent ? 1 : 0)))
        const argv = ringArgv(turn.next, session, notice)
        if (argv !== undefined) quiet(ring.run(argv))
      }
    },
    counts: () => ({ ...counts }),
  }
}
