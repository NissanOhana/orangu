/**
 * The attention level of 1 session: 1 test for each level rule, at each limit (stuck after 10 min, stale after
 * 24 h), the first-sight seenAt rule, and the time since the session is at its level.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, NOW, PANE_START, SECOND, SETTINGS, busy, idle, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { classify, firstSightEntries, seenAtOf } from './classify.js'

const at = (session: Parameters<typeof classify>[0]['session'], seenAt = PANE_START, settings = SETTINGS) => classify({ session, seenAt, settings, now: NOW })

describe('seenAt: the stored time, else the pane start', () => {
  it('takes the stored time of the session', () => {
    expect(seenAtOf('s1', { s1: NOW - HOUR }, PANE_START)).toBe(NOW - HOUR)
  })

  it('gives a session that the store does not hold the start time of the pane', () => {
    expect(seenAtOf('s2', { s1: NOW - HOUR }, PANE_START)).toBe(PANE_START)
  })

  it('reads only the own keys of the store, so a session id like a built-in name gets the pane start', () => {
    expect(seenAtOf('constructor', {}, PANE_START)).toBe(PANE_START)
    expect(seenAtOf('toString', {}, PANE_START)).toBe(PANE_START)
  })

  it('gives the store entries to add for the sessions that it sees for the first time', () => {
    expect(firstSightEntries(['s1', 's2', 's3'], { s1: NOW - HOUR }, PANE_START)).toEqual({ s2: PANE_START, s3: PANE_START })
    expect(firstSightEntries(['s1'], { s1: NOW - HOUR }, PANE_START)).toEqual({})
  })
})

describe('NEEDS YOU: the status is waiting', () => {
  it('is needs-you since the status changed, whatever else the facts say', () => {
    const session = waiting('w1', { lastWriteAt: NOW - 3 * HOUR, transcript: transcript({ errorTail: { kind: 'api-error', text: 'Overloaded.' } }) })
    expect(at(session)).toEqual({ level: 'needs-you', levelSince: NOW - 5 * MINUTE })
  })
})

describe('YOUR TURN: idle, and the last turn ended after seenAt', () => {
  it('is your-turn since the turn ended, when the turn ended after the pane start', () => {
    const session = idle('i1', { statusSince: NOW - 10 * MINUTE, transcript: transcript({ lastTurnEndedAt: NOW - 10 * MINUTE }) })
    expect(at(session)).toEqual({ level: 'your-turn', levelSince: NOW - 10 * MINUTE })
  })

  it('is idle when the turn ended before the pane start (the first-sight rule)', () => {
    const session = idle('i2', { statusSince: PANE_START - MINUTE, transcript: transcript({ lastTurnEndedAt: PANE_START - MINUTE }) })
    expect(at(session).level).toBe('idle')
  })

  it('is idle when the turn ended at the same time as seenAt, and your-turn 1 ms after it', () => {
    const ended = (endedAt: number) => idle('i3', { statusSince: endedAt, transcript: transcript({ lastTurnEndedAt: endedAt }) })
    expect(at(ended(PANE_START)).level).toBe('idle')
    expect(at(ended(PANE_START + 1)).level).toBe('your-turn')
  })

  it('takes the stored seenAt over the pane start', () => {
    const session = idle('i4', { statusSince: NOW - 2 * HOUR, transcript: transcript({ lastTurnEndedAt: NOW - 2 * HOUR }) })
    expect(at(session, NOW - 3 * HOUR).level).toBe('your-turn')
    expect(at(session, NOW - HOUR).level).toBe('idle')
  })

  it('needs an ended turn: an idle session with no turn end is idle', () => {
    const session = idle('i5', { statusSince: NOW - MINUTE, transcript: transcript() })
    expect(at(session).level).toBe('idle')
  })

  it('stays your-turn after the stale limit, because the person did not see the turn', () => {
    const session = idle('i6', { statusSince: NOW - 30 * HOUR, transcript: transcript({ lastTurnEndedAt: NOW - 30 * HOUR }) })
    expect(at(session, NOW - 40 * HOUR)).toEqual({ level: 'your-turn', levelSince: NOW - 30 * HOUR })
  })
})

describe('STUCK: busy, and no transcript write for 10 min, or an API error or retry at the end', () => {
  it('is working at 9 min 59 s with no write, and stuck at 10 min', () => {
    const silent = (ms: number) => busy('b1', { lastWriteAt: NOW - ms })
    expect(at(silent(10 * MINUTE - SECOND))).toEqual({ level: 'working', levelSince: NOW - 20 * MINUTE })
    expect(at(silent(10 * MINUTE))).toEqual({ level: 'stuck', levelSince: NOW - 10 * MINUTE })
  })

  it('reads the limit from the settings', () => {
    const session = busy('b2', { lastWriteAt: NOW - 5 * MINUTE })
    expect(at(session).level).toBe('working')
    expect(at(session, PANE_START, { ...SETTINGS, stuckAfterMin: 5 }).level).toBe('stuck')
  })

  it('is stuck since the error when the transcript ends with an API error or retry', () => {
    for (const kind of ['api-error', 'api-retry'] as const) {
      const session = busy('b3', { transcript: transcript({ errorTail: { kind, text: 'Overloaded.', at: NOW - 2 * MINUTE } }) })
      expect(at(session), kind).toEqual({ level: 'stuck', levelSince: NOW - 2 * MINUTE })
    }
  })

  it('is working when the session has no transcript, because a missing file proves no silence', () => {
    const { lastWriteAt: _dropped, transcript: _none, ...rest } = busy('b4', { statusSince: NOW - 3 * HOUR })
    expect(at(rest)).toEqual({ level: 'working', levelSince: NOW - 3 * HOUR })
  })
})

describe('WORKING: busy', () => {
  it('is working since the status changed', () => {
    expect(at(busy('b5'))).toEqual({ level: 'working', levelSince: NOW - 20 * MINUTE })
  })
})

describe('IDLE and STALE: idle, the person saw the last turn, and less than 24 h, else stale', () => {
  it('is idle at 23 h 59 min, and stale at 24 h, both since the status changed', () => {
    const quiet = (ms: number) => idle('i7', { statusSince: NOW - ms, transcript: transcript({ lastTurnEndedAt: NOW - ms }) })
    expect(at(quiet(23 * HOUR + 59 * MINUTE))).toEqual({ level: 'idle', levelSince: NOW - (23 * HOUR + 59 * MINUTE) })
    expect(at(quiet(24 * HOUR))).toEqual({ level: 'stale', levelSince: NOW - 24 * HOUR })
  })

  it('reads the limit from the settings', () => {
    const session = idle('i8', { statusSince: NOW - 3 * HOUR })
    expect(at(session).level).toBe('idle')
    expect(at(session, PANE_START, { ...SETTINGS, staleAfterH: 3 }).level).toBe('stale')
  })

  it('measures the idle time from the turn end when no registry file gives the status time', () => {
    const { statusSince: _dropped, ...rest } = idle('i9', { transcript: transcript({ lastTurnEndedAt: NOW - 25 * HOUR }) })
    expect(at(rest)).toEqual({ level: 'stale', levelSince: NOW - 25 * HOUR })
  })
})

describe('levelSince when the facts give no time', () => {
  const bare = () => {
    const { statusSince: _status, lastWriteAt: _write, transcript: _transcript, ...rest } = waiting('w2')
    return rest
  }

  it('keeps the time of the last snapshot when the level did not change', () => {
    expect(classify({ session: bare(), seenAt: PANE_START, settings: SETTINGS, now: NOW, previous: { level: 'needs-you', levelSince: NOW - 7 * MINUTE } })).toEqual({
      level: 'needs-you',
      levelSince: NOW - 7 * MINUTE,
    })
  })

  it('starts the time now when the level changed or no snapshot came before', () => {
    expect(classify({ session: bare(), seenAt: PANE_START, settings: SETTINGS, now: NOW, previous: { level: 'working', levelSince: NOW - 7 * MINUTE } }).levelSince).toBe(NOW)
    expect(classify({ session: bare(), seenAt: PANE_START, settings: SETTINGS, now: NOW }).levelSince).toBe(NOW)
  })

  it('takes the time of the open question before the snapshot time', () => {
    const asked = { ...bare(), transcript: transcript({ openQuestion: { toolUseId: 'toolu_q1', askedAt: NOW - 3 * MINUTE, questions: [] } }) }
    expect(classify({ session: asked, seenAt: PANE_START, settings: SETTINGS, now: NOW, previous: { level: 'needs-you', levelSince: NOW - 7 * MINUTE } }).levelSince).toBe(
      NOW - 3 * MINUTE,
    )
  })

  it('never takes the process start as the start of a level', () => {
    expect(classify({ session: { ...bare(), startedAt: NOW - HOUR }, seenAt: PANE_START, settings: SETTINGS, now: NOW }).levelSince).toBe(NOW)
  })
})
