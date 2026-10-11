/**
 * 2 boards on 1 store: /god in 2 Claude Code sessions runs 2 boards. Each board has its own alert state, and the
 * store of the plugin is 1 for both. Each alert turn reads the sound and the muted sessions from the store before it
 * decides, so a mute, an unmute or a sound off that 1 board writes holds in the other board from its next tick.
 */
import { describe, expect, it } from 'vitest'
import { NOW, PANE_START, SECOND, SETTINGS, busy, facts, waiting } from '../../test/fixtures/god/sessions.js'
import { NO_ALERTS, type AlertState } from './act/alert-policy.js'
import { createAlertLoop } from './alert-loop.js'
import { createBoardLoop, type BoardLoop } from './board-loop.js'
import { storeOf } from './control.js'
import type { Host, ToneClip } from './host.js'
import { textCleaner } from './sanitize.js'
import type { Facts, StoreState, TabRef } from './types.js'

const TAB: TabRef = { pid: 4200, tty: 'ttys009', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'api' }
const QUIET = facts([busy('s-a', { tab: TAB }), busy('s-b', { tab: TAB })])
const ASKS = facts([waiting('s-a', { tab: TAB }), waiting('s-b', { tab: TAB })])

/** What both boards read: the facts of each refresh, the time, and the 1 store of the plugin. */
type Machine = { facts: Facts; now: number; store: Map<string, unknown> }

/** What 1 board sent. */
type Sent = { tones: ToneClip[]; notices: string[]; rings: Array<readonly string[]> }

/** 1 board of 1 session over the machine: its board loop, its alert loop with its own alert state, and what it sent. */
function boardOf(machine: Machine, selfId: string): { loop: BoardLoop; sent: Sent } {
  const sent: Sent = { tones: [], notices: [], rings: [] }
  let state: AlertState = NO_ALERTS
  const stored = (): StoreState => storeOf(Object.fromEntries(machine.store))
  const host: Host = {
    run: async (argv) => {
      sent.rings.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    },
    list: async () => [],
    read: async () => '',
    stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }),
    now: async () => 0,
  }
  const alerts = createAlertLoop({
    readState: async () => state,
    writeState: async (next) => {
      state = next
    },
    readChoices: async () => stored(),
    effects: {
      play: async (clip) => {
        sent.tones.push(clip)
      },
      notify: async (text) => {
        sent.notices.push(text)
        return { isSent: true }
      },
    },
    host,
    clean: textCleaner('/tmp/god-home'),
  })
  const loop = createBoardLoop({
    ports: {
      refresh: async () => machine.facts,
      clock: () => machine.now,
      selfId: async () => selfId,
      writeSnapshot: async () => undefined,
      writeStore: async (key, value) => {
        machine.store.set(key, value)
      },
      showStatus: () => undefined,
      redraw: () => undefined,
      onRefresh: (turn) => alerts.onRefresh(turn),
    },
    store: stored(),
    settings: SETTINGS,
    paneStartedAt: PANE_START,
    isPaneOpen: true,
  })
  return { loop, sent }
}

/** Board A and board B over 1 machine that starts with the stored values, after the first tick of each. */
async function twoBoards(stored: Partial<StoreState> = {}) {
  const machine: Machine = { facts: QUIET, now: NOW, store: new Map(Object.entries(stored)) }
  const a = boardOf(machine, 'god-a')
  const b = boardOf(machine, 'god-b')
  await a.loop.tick()
  await b.loop.tick()
  return { machine, a, b }
}

/** Both sessions go into needs-you, and each board ticks once, with its effects settled. */
async function bothAsk(machine: Machine, boards: ReadonlyArray<{ loop: BoardLoop }>): Promise<void> {
  machine.facts = ASKS
  machine.now = NOW + 2 * SECOND
  for (const { loop } of boards) await loop.tick()
  await new Promise((resolve) => setImmediate(resolve))
}

const shape = ({ tones, notices, rings }: Sent) => ({ tones: tones.length, notices, rings: rings.length })

describe('2 boards on 1 store', () => {
  it('a mute that board A writes holds in board B: no tone, no notification and no ring for that session', async () => {
    const { machine, a, b } = await twoBoards()
    await a.loop.choose({ muted: ['s-a'] })
    await bothAsk(machine, [a, b])
    for (const board of [a, b]) expect(shape(board.sent)).toEqual({ tones: 1, notices: ['The session s-b needs you.'], rings: 1 })
  })

  it('a sound off that board A writes holds in board B: no tone, and the notifications and the rings stay', async () => {
    const { machine, a, b } = await twoBoards()
    await a.loop.choose({ sound: false })
    await bothAsk(machine, [a, b])
    for (const board of [a, b]) expect(shape(board.sent)).toEqual({ tones: 0, notices: ['The session s-a needs you.', 'The session s-b needs you.'], rings: 2 })
  })

  it('an unmute and a sound on that board A writes hold in board B, which started with the old values', async () => {
    const { machine, a, b } = await twoBoards({ muted: ['s-a'], sound: false })
    await a.loop.choose({ muted: [], sound: true })
    await bothAsk(machine, [a, b])
    for (const board of [a, b]) expect(shape(board.sent)).toEqual({ tones: 1, notices: ['The session s-a needs you.', 'The session s-b needs you.'], rings: 2 })
  })
})
