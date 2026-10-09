/**
 * Each state of the board pane, drawn through the whole pane view: what the person sees before the first refresh,
 * with no other session, with a failed source, with old facts, with no cmux, for a session with no transcript, in
 * a repos mode that keeps no session, and when the pane cannot draw. The detail states (a dialog with more than 1
 * question, the confirm bar, a changed screen, a message that did not arrive) belong to the detail view.
 */
import { describe, expect, it } from 'vitest'
import { SECOND } from '../../../test/fixtures/god/sessions.js'
import { NOW, boardSnapshot, degradedSnapshot, emptySnapshot, noRepoMatchSnapshot, readingSnapshot } from '../../../test/fixtures/god/snapshots.js'
import type { BoardSnapshot } from '../types.js'
import { cellWidth } from './cells.js'
import { cannotDrawView, paneView, type PaneInput } from './pane.js'
import { CANNOT_DRAW, STATE_TEXT } from './states.js'
import type { Line, PaneView } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const pane = (snapshot: BoardSnapshot | undefined, over: Partial<PaneInput> = {}): PaneView =>
  paneView({ ...(snapshot === undefined ? {} : { snapshot }), bodyColumns: 110, bodyRows: 30, now: NOW, openGroups: [], promptHoldsKeys: false, ...over })
const all = (view: PaneView): string[] => (view.kind === 'cannot-draw' ? view.lines : [...view.header, view.topRule, ...view.body, ...(view.kind === 'board' ? [view.bottomRule, ...view.keys] : [])]).map(text)
const bodyOf = (view: PaneView): string[] => (view.kind === 'cannot-draw' ? [] : view.body.map(text))

describe('the states of the board pane', () => {
  it('first refresh not done: the header, a rule and 1 line that says the pane reads the sessions', () => {
    for (const view of [pane(undefined), pane(readingSnapshot())]) {
      expect(view.kind).toBe('message')
      expect(all(view)).toEqual([' ◉ orangu god', '─'.repeat(110), ' Reading sessions.'])
    }
    expect(STATE_TEXT.reading).toBe('Reading sessions.')
  })

  it('no live session but this one: the line says so', () => {
    expect(bodyOf(pane(emptySnapshot()))).toEqual([' No other Claude Code session runs now.'])
  })

  it('the repos mode keeps no session: the line says so and names the key that shows every session', () => {
    expect(bodyOf(pane(noRepoMatchSnapshot()))).toEqual([` ${STATE_TEXT['no-repo-match']}`])
    expect(STATE_TEXT['no-repo-match']).toBe('No session of the selected repos runs now. Press f to show every session.')
  })

  it('a source failed: a dim chip in the header for each one, and the board keeps its rows', () => {
    const view = pane(degradedSnapshot({ agents: { status: 'off' }, cmux: { status: 'off' }, git: { status: 'off' } }))
    expect(view.kind).toBe('board')
    if (view.kind !== 'board') return
    expect(view.header.map(text).join('')).toMatch(/agents off {2}cmux off {2}git off/)
    expect(view.body.filter((line) => line.key === 's-wait')).toHaveLength(1)
  })

  it('facts older than 10 s: the header shows their age in the warn color', () => {
    const view = pane(degradedSnapshot({}, 12 * SECOND))
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.header.flatMap((line) => line.segments).find((segment) => segment.text === 'old 12s')).toEqual({ text: 'old 12s', token: '--warn' })
  })

  it('no cmux: jump, the digits and reply show dim, and the key row says why', () => {
    const view = pane(degradedSnapshot({ cmux: { status: 'missing' } }))
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.hints.filter((hint) => hint.isOff).map((hint) => hint.keys)).toEqual(['j', '1-9', 'r'])
    expect(view.keys.map(text).at(-1)).toBe(' Jump, answer and reply are off: cmux is not on this machine.')
  })

  it('a session with no transcript: its row shows the registry facts and says so, cut with its count on the 30-column board', () => {
    const row = (bodyColumns: number): string => {
      const view = pane(boardSnapshot(), { bodyColumns })
      if (view.kind !== 'board') throw new Error(view.kind)
      return text(view.body.find((line) => line.key === 's-new')!)
    }
    expect(row(60)).toMatch(/^ ⠋ docs-1 {2}No transcript yet\. +2m$/)
    expect(row(110)).toBe(' ⠋ docs-1  No transcript…+5 2m')
  })

  it('the pane cannot draw: 1 message with the reason and nothing else', () => {
    const narrow = pane(boardSnapshot(), { bodyColumns: 24 })
    expect(narrow.kind).toBe('cannot-draw')
    expect(all(narrow).join(' ').replace(/\s+/g, ' ').trim()).toBe(CANNOT_DRAW['too-narrow'])
    const short = pane(boardSnapshot(), { bodyRows: 5 })
    expect(all(short).join(' ').replace(/\s+/g, ' ').trim()).toBe(CANNOT_DRAW['too-short'])
    expect(all(cannotDrawView('failed', 60))).toEqual([` ${CANNOT_DRAW.failed}`])
    for (const reason of ['too-narrow', 'too-short', 'failed'] as const) {
      for (const line of all(cannotDrawView(reason, 24))) expect(cellWidth(line), `${reason}: ${line}`).toBeLessThanOrEqual(24)
    }
    expect(CANNOT_DRAW).toEqual({
      'too-narrow': 'The pane is too narrow. Make it 30 columns or wider.',
      'too-short': 'The pane is too short. Make it taller.',
      failed: 'The pane cannot draw the board. Run /god to open it again.',
    })
  })
})
