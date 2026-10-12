/**
 * What 1 alert sends outside the tone: the notice (the title and a body that starts with words of the pane, with the
 * cleaned name of the session on 1 line), and the ring on the cmux tab of the session. The ring is exactly
 * `cmux notify --title <t> --body <b> --workspace <ws> --surface <s>`, only with a cmux read that worked and the
 * refs of the mapped tab in the forms that the key guard takes. The host of the ring refuses any other argv.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, session, transcript } from '../../../test/fixtures/god/sessions.js'
import { degradedSnapshot } from '../../../test/fixtures/god/snapshots.js'
import { PANE_TITLE } from '../copy.js'
import type { Host, RunOptions } from '../host.js'
import { textCleaner } from '../sanitize.js'
import type { BoardSnapshot, GodSession, TabRef } from '../types.js'
import { REFUSED_RING_ARGV, alertNotice, isRingArgv, ringArgv, ringHost } from './alerts.js'

const HOME = '/tmp/god-home'
const clean = textCleaner(HOME)
const WS = '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const SF = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'
const ESC = String.fromCharCode(0x1b)
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE'
const FAKE_VALUE = 'FAKEVALUENL123'
/** a bidirectional override, an isolate, a zero-width space, a soft hyphen, a word joiner, a byte order mark, a tag and a variation selector */
const HIDDEN = ['\u202e', '\u2066', '\u200b', '\u00ad', '\u2060', '\ufeff', '\u{e0041}', '\ufe0f']

const ringOf = (title: string, body: string): string[] => ['cmux', 'notify', '--title', title, '--body', body, '--workspace', WS, '--surface', SF]

const tab = (workspaceRef = WS, surfaceRef = SF): TabRef => ({ pid: 4200, tty: 'ttys009', workspaceRef, surfaceRef, workspaceTitle: 'api' })

/** 1 board row that needs you, with the given name and tab */
function row(name: string, over: Partial<GodSession> = {}): GodSession {
  return { ...session('s-ring', 'waiting', { name }), seenAt: NOW - 30 * MINUTE, level: 'needs-you', levelSince: NOW - MINUTE, summary: '', flags: [], muted: false, tab: tab(), ...over }
}

/** the board with the row, and the cmux state */
function board(one: GodSession, cmux: BoardSnapshot['sources']['cmux'] = { status: 'ok' }): BoardSnapshot {
  const base = degradedSnapshot({ cmux })
  return { ...base, sessions: [one] }
}

function hostOf() {
  const runs: Array<{ argv: readonly string[]; options?: RunOptions }> = []
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
  return { host, runs }
}

describe('the notice of an alert', () => {
  it('has the pane title and a body that starts with words of the pane', () => {
    expect(alertNotice(row('api-7'), 'needs-you', clean)).toEqual({ title: PANE_TITLE, body: 'The session api-7 needs you.' })
    expect(alertNotice(row('api-3'), 'stuck', clean)).toEqual({ title: PANE_TITLE, body: 'The session api-3 is stuck.' })
    expect(alertNotice(row('-x --surface s'), 'needs-you', clean).body.startsWith('The session ')).toBe(true)
  })

  it('names the session by the name of its row: the cmux tab title with no status glyph, else the transcript title', () => {
    expect(alertNotice(row('api-7', { tab: { ...tab(), surfaceTitle: '✳ Fix the parser' } }), 'needs-you', clean).body).toBe('The session Fix the parser needs you.')
    expect(alertNotice(row('api-7', { transcript: transcript({ title: 'Pick the set' }) }), 'stuck', clean).body).toBe('The session Pick the set is stuck.')
  })

  it('cleans the name: no control character, no line break, the secret masked, the home folder as ~', () => {
    const { body } = alertNotice(row(`a${ESC}[31m\n${KEY}\u202e ${HOME}/x`), 'needs-you', clean)
    expect(body).not.toContain(KEY)
    expect(body).not.toContain(ESC)
    expect(body).not.toContain('\n')
    expect(body).not.toContain('\u202e')
    expect(body).not.toContain(HOME)
    expect(body).toContain('~/x')
  })

  it('puts the name on 1 line before it cleans it, so a secret that line breaks split is masked whole', () => {
    const one = row(`api\n"password":\n"${FAKE_VALUE}"`)
    const notice = alertNotice(one, 'needs-you', clean)
    expect(notice.body).toMatch(/^The session api "password": "‹[a-z-]+›" needs you\.$/)
    expect(JSON.stringify(ringArgv(board(one), one, notice))).not.toContain(FAKE_VALUE)
  })
})

describe('the ring on the cmux tab', () => {
  it('is exactly cmux notify with the title, the body and the UUIDs of the mapped tab', () => {
    const one = row('api-7')
    const notice = alertNotice(one, 'needs-you', clean)
    expect(ringArgv(board(one), one, notice)).toEqual(['cmux', 'notify', '--title', PANE_TITLE, '--body', 'The session api-7 needs you.', '--workspace', WS, '--surface', SF])
    expect(ringArgv(board(row('api-7', { tab: tab('workspace:2', 'surface:5') })), row('api-7', { tab: tab('workspace:2', 'surface:5') }), notice)).toEqual(['cmux', 'notify', '--title', PANE_TITLE, '--body', notice.body, '--workspace', 'workspace:2', '--surface', 'surface:5'])
  })

  it('is absent with no cmux read that worked, no tab, or a ref that the key guard does not take', () => {
    const one = row('api-7')
    const notice = alertNotice(one, 'needs-you', clean)
    for (const status of ['off', 'missing', 'unread'] as const) expect(ringArgv(board(one, { status }), one, notice), status).toBeUndefined()
    const { tab: _tab, ...noTab } = one
    expect(ringArgv(board(noTab), noTab, notice)).toBeUndefined()
    for (const refs of [['3', SF], [WS, '5'], ['--all', SF], [WS, `${SF} x`]] as const) {
      const bad = row('api-7', { tab: tab(refs[0], refs[1]) })
      expect(ringArgv(board(bad), bad, notice), refs.join(' ')).toBeUndefined()
    }
  })

  it('is absent when the title or the body is empty, starts with -, or holds a control character', () => {
    const one = row('api-7')
    for (const notice of [{ title: '', body: 'b' }, { title: 't', body: '' }, { title: '-t', body: 'b' }, { title: 't', body: '--surface x' }, { title: 't', body: 'a\nb' }, { title: 't', body: `a${ESC}b` }, { title: 't', body: 'a\u2028b' }]) {
      expect(ringArgv(board(one), one, notice), JSON.stringify(notice)).toBeUndefined()
    }
  })

  it('takes only the exact ring argv', () => {
    const good = ['cmux', 'notify', '--title', 't', '--body', 'The session a needs you.', '--workspace', WS, '--surface', SF]
    expect(isRingArgv(good)).toBe(true)
    const bad: string[][] = [
      ['cmux', 'send', '--title', 't', '--body', 'b', '--workspace', WS, '--surface', SF],
      ['cmux', 'notify', '--subtitle', 't', '--body', 'b', '--workspace', WS, '--surface', SF],
      [...good, '--window', 'window:1'],
      good.slice(0, 8),
      ['cmux', 'notify', '--title', 't', '--body', '-b', '--workspace', WS, '--surface', SF],
      ['cmux', 'notify', '--title', 't', '--body', 'b', '--workspace', '1', '--surface', SF],
      ['claude', 'notify', '--title', 't', '--body', 'b', '--workspace', WS, '--surface', SF],
      ['cmux', 'notify', '--title', 't', '--body', 'b', '--surface', SF, '--workspace', WS],
    ]
    for (const argv of bad) expect(isRingArgv(argv), argv.join(' ')).toBe(false)
  })

  it('goes through a host that refuses any other argv and any environment variable', async () => {
    const { host, runs } = hostOf()
    const ring = ringHost(host)
    const good = ['cmux', 'notify', '--title', 't', '--body', 'b', '--workspace', WS, '--surface', SF]
    await ring.run(good)
    expect(runs).toEqual([{ argv: good }])
    await expect(ring.run(['cmux', 'send', '--workspace', WS, '--surface', SF, '--', 'x'])).rejects.toThrow(REFUSED_RING_ARGV)
    await expect(ring.run(good, { env: { TZ: 'UTC' } })).rejects.toThrow(REFUSED_RING_ARGV)
    await expect(ring.run(['git', 'push'])).rejects.toThrow(REFUSED_RING_ARGV)
    expect(runs).toHaveLength(1)
  })

  it('refuses a title or a body with a character that draws nothing, in the argv check and in the host of the ring', async () => {
    const { host, runs } = hostOf()
    const ring = ringHost(host)
    for (const hidden of HIDDEN) {
      for (const argv of [ringOf('t', `The session a${hidden}b needs you.`), ringOf(`orangu${hidden} god`, 'b')]) {
        const name = JSON.stringify(argv.slice(3, 6))
        expect(isRingArgv(argv), name).toBe(false)
        await expect(ring.run(argv), name).rejects.toThrow(REFUSED_RING_ARGV)
      }
    }
    expect(runs).toEqual([])
  })
})
