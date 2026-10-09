/**
 * The whole pane: the header, a rule, the body, a rule, the key row. At 90 columns or more the body is the board
 * column of 30 cells, left of the detail. Below 90 the board takes the whole body. No line is wider than the body,
 * and the pane takes no more rows than the body has.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, busy, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { NOW, boardSessions, boardSnapshot, byRepoSnapshot, degradedSnapshot, emptySnapshot, noRepoMatchSnapshot, readingSnapshot, snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import type { BoardSnapshot } from '../types.js'
import { cellWidth } from './cells.js'
import { BOARD_COLUMNS } from './board.js'
import { layoutOf, paneLines, paneView, type PaneInput } from './pane.js'
import type { Line, PaneView } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const pane = (snapshot: BoardSnapshot, over: Partial<PaneInput> = {}): PaneView =>
  paneView({ snapshot, bodyColumns: 110, bodyRows: 40, now: NOW, openGroups: [], promptHoldsKeys: false, ...over })

/** every snapshot of the fixtures, and 1 with wide characters, a long name and a long summary */
function snapshots(): Array<[string, BoardSnapshot]> {
  const stress = snapshotOf([
    ...boardSessions(),
    waiting('s-cjk', { name: '日本語のセッション名', transcript: transcript({ openQuestion: { toolUseId: 'tu', questions: [{ text: '日本語の質問はここにあります。', header: 'h', multiSelect: false, options: [] }] } }) }),
    busy('s-emoji', { name: 'emoji-\u{1F600}', transcript: transcript({ activity: { toolUseId: 'tu', tool: 'Edit', text: 'Edit \u{1F468}‍\u{1F469}‍\u{1F467} é.md', isOpen: true } }) }),
    busy('s-long', { name: 'x'.repeat(80), statusSince: NOW - 400 * 24 * HOUR, transcript: transcript({ activity: { toolUseId: 'tu', tool: 'Bash', text: 'Bash '.repeat(40), isOpen: true } }) }),
  ])
  return [
    ['board', boardSnapshot()],
    ['by repo', byRepoSnapshot()],
    ['reading', readingSnapshot()],
    ['empty', emptySnapshot()],
    ['no repo match', noRepoMatchSnapshot()],
    ['every source off, old facts', degradedSnapshot({ agents: { status: 'off' }, registry: { status: 'off' }, cmux: { status: 'off' }, git: { status: 'off' } }, 90 * 1000)],
    ['no cmux', degradedSnapshot({ cmux: { status: 'missing' } })],
    ['stress', stress],
  ]
}

describe('the layout', () => {
  it('puts the 30-column board left of the detail at 90 columns or more, and the board alone below 90', () => {
    expect(BOARD_COLUMNS).toBe(30)
    expect(layoutOf(89)).toEqual({ kind: 'narrow', boardColumns: 89 })
    expect(layoutOf(90)).toEqual({ kind: 'wide', boardColumns: 30, detailColumns: 59 })
    expect(layoutOf(110)).toEqual({ kind: 'wide', boardColumns: 30, detailColumns: 79 })
  })

  it('draws the header, a rule, the board, a rule and the key row, and the rules meet the column rule at the board width', () => {
    const view = pane(boardSnapshot())
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(text(view.topRule)).toBe(`${'─'.repeat(30)}┬${'─'.repeat(79)}`)
    expect(text(view.bottomRule)).toBe(`${'─'.repeat(30)}┴${'─'.repeat(79)}`)
    expect(view.topRule.segments.every((segment) => segment.dim === true)).toBe(true)
    expect(paneLines(view).map(text)).toEqual([...view.header, view.topRule, ...view.body, view.bottomRule, ...view.keys].map(text))
    const narrow = pane(boardSnapshot(), { bodyColumns: 89 })
    if (narrow.kind !== 'board') throw new Error(narrow.kind)
    expect(text(narrow.topRule)).toBe('─'.repeat(89))
  })

  it('names the digits of the open question of the selected session in the key row', () => {
    const view = pane(boardSnapshot(), { selectedKey: 's-wait' })
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.keys.map(text).join('')).toMatch(/ {2}1-3 answer {2}/)
  })

  it('ends the key row with the ctrl+x tab line while the prompt holds the keys', () => {
    const view = pane(boardSnapshot(), { promptHoldsKeys: true })
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.keys.map(text).join('')).toMatch(/ctrl\+x tab: keys to the pane$/)
  })
})

describe('no line is wider than the body', () => {
  it.each([60, 89, 90, 110])('holds every line of every state to %i columns, and the board to 30 columns from 90', (columns) => {
    for (const [name, snapshot] of snapshots()) {
      for (const openGroups of [[], ['stale']]) {
        for (const promptHoldsKeys of [false, true]) {
          const view = pane(snapshot, { bodyColumns: columns, openGroups, promptHoldsKeys, selectedKey: 's-long' })
          expect(view.kind, `${name} at ${columns}`).not.toBe('cannot-draw')
          for (const line of paneLines(view)) expect(cellWidth(text(line)), `${name} at ${columns}: ${text(line)}`).toBeLessThanOrEqual(columns)
          if (view.kind === 'board') {
            const room = columns >= 90 ? 30 : columns
            for (const line of view.body) expect(cellWidth(text(line)), `${name} board at ${columns}: ${text(line)}`).toBeLessThanOrEqual(room)
          }
        }
      }
    }
  })
})

describe('only the rows that fit', () => {
  const many = (): BoardSnapshot =>
    snapshotOf([...boardSessions(), ...Array.from({ length: 20 }, (_, index) => busy(`s-more-${index}`, { name: `more-${index}`, statusSince: NOW - (index + 1) * MINUTE }))])

  it('takes no more rows than the body has, and keeps the selected row in view', () => {
    for (const bodyRows of [8, 12, 20]) {
      for (const columns of [60, 110]) {
        for (const selectedKey of ['s-wait', 's-more-10', 's-idle']) {
          const view = pane(many(), { bodyRows, bodyColumns: columns, selectedKey })
          expect(paneLines(view).length, `${bodyRows} rows at ${columns}`).toBeLessThanOrEqual(bodyRows)
          if (view.kind !== 'board') throw new Error(`${bodyRows} rows at ${columns}: ${view.kind}`)
          expect(view.body.some((line) => line.key === selectedKey), `${bodyRows} rows at ${columns}: ${selectedKey}`).toBe(true)
        }
      }
    }
  })

  it('says the pane is too short when the board does not fit and fewer than 3 rows are left for it', () => {
    expect(pane(many(), { bodyRows: 6 }).kind).toBe('cannot-draw')
    expect(pane(many(), { bodyRows: 7 }).kind).toBe('board')
  })
})
