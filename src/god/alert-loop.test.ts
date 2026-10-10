/**
 * The alert loop: on each refresh it reads the alert state, asks the alert policy, writes the new state, and then
 * sends what each alert holds: 1 tone (only when the policy plays it), 1 notification and 1 ring on the cmux tab of
 * the session (only for needs-you and stuck). It counts the tones that played and the notifications that a channel
 * sent, for /god stats. A failed state read or write sends nothing, and a failed effect stops nothing.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, SECOND, STORE, facts, session } from '../../test/fixtures/god/sessions.js'
import { TONES } from './act/tones.js'
import { NO_ALERTS, type AlertState } from './act/alert-policy.js'
import { createAlertLoop, type AlertPorts } from './alert-loop.js'
import type { RefreshTurn } from './board-loop.js'
import { PANE_TITLE } from './copy.js'
import type { Host, NotifyOutcome, RunOptions, ToneClip } from './host.js'
import { textCleaner } from './sanitize.js'
import type { BoardSnapshot, GodSession, Level, SessionStatus, StoreState } from './types.js'

const WS = '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const SF = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE'
const STATUS_OF: Readonly<Record<Level, SessionStatus>> = { 'needs-you': 'waiting', 'your-turn': 'idle', stuck: 'busy', working: 'busy', idle: 'idle', stale: 'idle' }

/** 1 board row at the given level, with a mapped cmux tab */
function row(sessionId: string, level: Level, name = sessionId): GodSession {
  const tab = { pid: 4200, tty: 'ttys009', workspaceRef: WS, surfaceRef: SF, workspaceTitle: 'api' }
  return { ...session(sessionId, STATUS_OF[level], { name, tab }), seenAt: NOW - 30 * MINUTE, level, levelSince: NOW - MINUTE, summary: '', flags: [], muted: false }
}

function board(at: number, rows: readonly GodSession[]): BoardSnapshot {
  const base = facts(rows)
  return { at, selfId: 'god-self', firstRefreshDone: true, sessions: rows, groups: [], mode: 'all', repos: [], groupBy: 'level', sources: base.sources, stats: base.stats }
}

/** What a test changes in a turn: any field, and any field of the stored choices. */
type TurnChange = Omit<Partial<RefreshTurn>, 'store'> & { store?: Partial<StoreState> }

/** A turn of the board loop: the tick before 2 s ago, sound on, nothing muted, the pane open. */
function turn(last: BoardSnapshot | undefined, next: BoardSnapshot, over: TurnChange = {}): RefreshTurn {
  const { store, ...rest } = over
  return { ...(last === undefined ? {} : { last, lastRefreshAt: next.at - 2 * SECOND }), next, store: { ...STORE, ...store }, isPaneOpen: true, now: next.at, ...rest }
}

/** An alert loop over fake ports that record each effect. */
function loopOf(over: { notify?: NotifyOutcome; play?: 'reject'; state?: AlertState; readFails?: boolean; writeFails?: boolean } = {}) {
  const tones: ToneClip[] = []
  const notices: Array<{ text: string; title: string }> = []
  const runs: Array<{ argv: readonly string[]; options?: RunOptions }> = []
  const writes: AlertState[] = []
  let state = over.state ?? NO_ALERTS
  const host: Host = {
    run: async (argv, options) => {
      runs.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    },
    list: async () => [],
    read: async () => '',
    stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }),
    now: async () => 0,
  }
  const ports: AlertPorts = {
    readState: async () => {
      if (over.readFails === true) throw new Error('state read refused')
      return state
    },
    writeState: async (next) => {
      if (over.writeFails === true) throw new Error('state write refused')
      writes.push(next)
      state = next
    },
    effects: {
      play: async (clip) => {
        tones.push(clip)
        if (over.play === 'reject') throw new Error('no player')
      },
      notify: async (text, title) => {
        notices.push({ text, title })
        return over.notify ?? { isSent: true }
      },
    },
    host,
    clean: textCleaner('/tmp/god-home'),
  }
  return { loop: createAlertLoop(ports), tones, notices, runs, writes }
}

/** Lets the effects that the loop started settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const T1 = NOW
const T2 = NOW + 2 * SECOND
const T3 = NOW + 4 * SECOND
const T4 = NOW + 6 * SECOND

describe('the alert loop', () => {
  it('sends 1 tone, 1 notification and 1 ring for a change into needs-you, and counts them', async () => {
    const { loop, tones, notices, runs } = loopOf()
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working', 'api-7')]), board(T2, [row('s-a', 'needs-you', 'api-7')])))
    await settle()
    expect(tones).toEqual([TONES['needs-you']])
    expect(notices).toEqual([{ text: 'The session api-7 needs you.', title: PANE_TITLE }])
    expect(runs).toEqual([{ argv: ['cmux', 'notify', '--title', PANE_TITLE, '--body', 'The session api-7 needs you.', '--workspace', WS, '--surface', SF] }])
    expect(loop.counts()).toEqual({ tones: 1, notifications: 1 })
  })

  it('sends nothing more for a second change within 5 min, and keeps the state from 1 refresh to the next', async () => {
    const { loop, tones, notices, runs, writes } = loopOf()
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), board(T2, [row('s-a', 'needs-you')])))
    await loop.onRefresh(turn(board(T2, [row('s-a', 'needs-you')]), board(T3, [row('s-a', 'working')])))
    await loop.onRefresh(turn(board(T3, [row('s-a', 'working')]), board(T4, [row('s-a', 'needs-you')])))
    await settle()
    expect(tones).toHaveLength(1)
    expect(notices).toHaveLength(1)
    expect(runs).toHaveLength(1)
    expect(writes[0]).toEqual({ alertAt: { 's-a': T2 }, doneAt: {} })
    expect(loop.counts()).toEqual({ tones: 1, notifications: 1 })
  })

  it('sends nothing on the first refresh of a load, or with no time of the refresh before', async () => {
    const { loop, tones, notices, runs } = loopOf()
    await loop.onRefresh(turn(undefined, board(T2, [row('s-a', 'needs-you')])))
    const { lastRefreshAt: _gone, ...noTime } = turn(board(T1, [row('s-b', 'working')]), board(T2, [row('s-b', 'needs-you')]))
    await loop.onRefresh(noTime)
    await settle()
    expect([tones, notices, runs]).toEqual([[], [], []])
  })

  it('stops the tone and keeps the notification and the ring with sound off or with no pane in this session', async () => {
    const changes: TurnChange[] = [{ store: { sound: false } }, { isPaneOpen: false }]
    for (const over of changes) {
      const { loop, tones, notices, runs } = loopOf()
      await loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), board(T2, [row('s-a', 'stuck', 'api-3')]), over))
      await settle()
      expect(tones, JSON.stringify(over)).toEqual([])
      expect(notices).toEqual([{ text: 'The session api-3 is stuck.', title: PANE_TITLE }])
      expect(runs).toHaveLength(1)
      expect(loop.counts()).toEqual({ tones: 0, notifications: 1 })
    }
  })

  it('sends nothing for a muted session', async () => {
    const { loop, tones, notices, runs } = loopOf()
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), board(T2, [row('s-a', 'needs-you')]), { store: { muted: ['s-a'] } }))
    await settle()
    expect([tones, notices, runs]).toEqual([[], [], []])
  })

  it('plays only the done tone for a change into your turn: no notification and no ring', async () => {
    const { loop, tones, notices, runs } = loopOf()
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), board(T2, [row('s-a', 'your-turn')])))
    await settle()
    expect(tones).toEqual([TONES.done])
    expect([notices, runs]).toEqual([[], []])
  })

  it('plays 1 tone for 1 refresh, in the order needs-you, stuck, done', async () => {
    const { loop, tones, notices } = loopOf()
    const last = board(T1, [row('s-a', 'working'), row('s-b', 'working'), row('s-c', 'working')])
    await loop.onRefresh(turn(last, board(T2, [row('s-a', 'your-turn'), row('s-b', 'stuck'), row('s-c', 'needs-you')])))
    await settle()
    expect(tones).toEqual([TONES['needs-you']])
    expect(notices.map((notice) => notice.text)).toEqual(['The session s-c needs you.', 'The session s-b is stuck.'])
  })

  it('rings no tab when the last cmux read failed, and none for a session with no tab', async () => {
    const { loop, notices, runs } = loopOf()
    const next = board(T2, [row('s-a', 'needs-you')])
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), { ...next, sources: { ...next.sources, cmux: { status: 'off' } } }))
    const { tab: _tab, ...noTab } = row('s-b', 'needs-you')
    await loop.onRefresh(turn(board(T1, [row('s-b', 'working')]), board(T2, [noTab])))
    await settle()
    expect(notices).toHaveLength(2)
    expect(runs).toEqual([])
  })

  it('sends the cleaned name: the secret masked and no line break', async () => {
    const { loop, notices, runs } = loopOf()
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working', 'x')]), board(T2, [row('s-a', 'needs-you', `api\n${KEY}`)])))
    await settle()
    expect(JSON.stringify([notices, runs])).not.toContain(KEY)
    expect(notices[0]!.text).not.toContain('\n')
  })

  it('counts only a notification that a channel sent, and only a tone that played, and stops at no failed effect', async () => {
    const { loop, tones, notices, runs } = loopOf({ notify: { isSent: false, reason: 'disabled' }, play: 'reject' })
    await loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), board(T2, [row('s-a', 'needs-you')])))
    await settle()
    expect([tones.length, notices.length, runs.length]).toEqual([1, 1, 1])
    expect(loop.counts()).toEqual({ tones: 0, notifications: 0 })
  })

  it('sends nothing when it cannot read or write the alert state, so a refresh never sends an alert twice', async () => {
    for (const over of [{ readFails: true }, { writeFails: true }]) {
      const { loop, tones, notices, runs } = loopOf(over)
      await expect(loop.onRefresh(turn(board(T1, [row('s-a', 'working')]), board(T2, [row('s-a', 'needs-you')])))).resolves.toBeUndefined()
      await settle()
      expect([tones, notices, runs], JSON.stringify(over)).toEqual([[], [], []])
    }
  })

  it('writes the state only when it changed', async () => {
    const { loop, writes } = loopOf()
    await loop.onRefresh(turn(board(T1, [row('s-a', 'idle')]), board(T2, [row('s-a', 'idle')])))
    await loop.onRefresh(turn(board(T2, [row('s-a', 'idle')]), board(T3, [row('s-a', 'idle')])))
    expect(writes).toEqual([])
  })
})
