/**
 * The whole pane: the header, a rule, the body, a rule, the key row. At 90 columns or more the body is the board
 * column of 30 cells, left of the detail. Below 90 the board takes the whole body. No line is wider than the body,
 * and the pane takes no more rows than the body has.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, busy, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { NOW, boardSessions, boardSnapshot, byRepoSnapshot, degradedSnapshot, emptySnapshot, noRepoMatchSnapshot, readingSnapshot, snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import { INTENTS, OUTCOMES, detailSnapshot } from '../../../test/fixtures/god/detail.js'
import type { BoardSnapshot } from '../types.js'
import { cellWidth } from './cells.js'
import { BOARD_COLUMNS, MORE_KEYS } from './board.js'
import { DEFAULT_DETAIL, NO_DETAIL, paneDetailLines } from './detail-pane.js'
import { JUMP_NOTE } from './keys.js'
import { layoutOf, paneLines, paneView, type PaneInput } from './pane.js'
import type { Line, PaneView } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const pane = (snapshot: BoardSnapshot, over: Partial<PaneInput> = {}): PaneView =>
  paneView({ snapshot, bodyColumns: 110, bodyRows: 40, now: NOW, openGroups: [], promptHoldsKeys: false, ...over })
/** the rows that a view takes on the screen: in the wide body the board and the detail sit side by side */
const rowsOf = (view: PaneView): number => {
  const bar = view.kind === 'board' || view.kind === 'detail' ? (view.bar === undefined ? 0 : view.bar.lines.length + (view.bar.field === undefined ? 0 : 1)) : 0
  if (view.kind === 'board') return view.header.length + 2 + Math.max(view.body.length, view.detail === undefined ? 0 : paneDetailLines(view.detail).length) + bar + view.keys.length
  return paneLines(view).length + (view.kind === 'detail' && view.bar?.field !== undefined ? 1 : 0)
}

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
    const detail = view.detail === undefined ? [] : paneDetailLines(view.detail)
    expect(paneLines(view).map(text)).toEqual([...view.header, view.topRule, ...view.body, ...detail, view.bottomRule, ...view.keys].map(text))
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
          expect(rowsOf(view), `${bodyRows} rows at ${columns}`).toBeLessThanOrEqual(bodyRows)
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

describe('the detail', () => {
  const detailRoom = (view: Extract<PaneView, { kind: 'board' | 'detail' }>): number => 30 - view.header.length - 2 - view.keys.length

  it('shows the detail of the selected session right of the board from 90 columns, in the rows of the board', () => {
    for (const columns of [90, 110]) {
      const view = pane(detailSnapshot(), { bodyColumns: columns, bodyRows: 30, selectedKey: 's-wait' })
      if (view.kind !== 'board' || view.detail?.kind !== 'session') throw new Error(`${columns}: ${view.kind}`)
      const lines = paneDetailLines(view.detail).map(text)
      expect(lines[0]).toBe(' api-7 · Eval set › tab 2')
      expect(lines.length).toBeLessThanOrEqual(detailRoom(view))
      for (const line of lines) expect(cellWidth(line), line).toBeLessThanOrEqual(columns - BOARD_COLUMNS - 1)
      expect(rowsOf(view)).toBeLessThanOrEqual(30)
    }
  })

  it('asks for a selection in the detail column when no session is selected', () => {
    const view = pane(detailSnapshot())
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.detail).toEqual({ kind: 'none', lines: [{ segments: [{ text: ` ${NO_DETAIL}` }] }] })
  })

  it('shows the board alone below 90 columns, and the detail in its place once the detail is open', () => {
    const closed = pane(detailSnapshot(), { bodyColumns: 89, selectedKey: 's-wait' })
    if (closed.kind !== 'board') throw new Error(closed.kind)
    expect(closed.detail).toBeUndefined()
    for (const columns of [60, 89]) {
      const view = pane(detailSnapshot(), { bodyColumns: columns, bodyRows: 30, selectedKey: 's-wait', detail: { ...DEFAULT_DETAIL, isOpen: true } })
      if (view.kind !== 'detail') throw new Error(`${columns}: ${view.kind}`)
      expect(text(view.topRule)).toBe('─'.repeat(columns))
      expect(paneLines(view).map(text)).toEqual([...view.header, view.topRule, ...paneDetailLines(view.detail), view.bottomRule, ...view.keys].map(text))
      expect(paneDetailLines(view.detail).map(text)[0]).toBe(' api-7 · Eval set › tab 2')
      expect(paneLines(view).length).toBeLessThanOrEqual(30)
      for (const line of paneLines(view)) expect(cellWidth(text(line)), line.segments.map((segment) => segment.text).join('')).toBeLessThanOrEqual(columns)
      const keys = view.keys.map(text).join('')
      expect(keys).toMatch(/^ b: back {2}j: jump/)
      expect(keys).not.toContain('↑↓')
    }
  })

  it('keeps the board and the detail side by side from 90 columns, open or not', () => {
    const view = pane(detailSnapshot(), { bodyColumns: 90, selectedKey: 's-wait', detail: { ...DEFAULT_DETAIL, isOpen: true } })
    expect(view.kind).toBe('board')
  })

  it('opens the detail of the selected session only: with no selection the narrow detail asks for one', () => {
    const view = pane(detailSnapshot(), { bodyColumns: 60, detail: { ...DEFAULT_DETAIL, isOpen: true } })
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(view.detail.kind).toBe('none')
    expect(view.keys.map(text).join('')).toMatch(/^ b: back/)
  })

  it('gives each count line of the board its target, so a press moves the selection past the window', () => {
    const many = snapshotOf([...boardSessions(), ...Array.from({ length: 20 }, (_, index) => busy(`s-more-${index}`, { name: `more-${index}`, statusSince: NOW - (index + 1) * MINUTE }))])
    const view = pane(many, { bodyRows: 10, bodyColumns: 60 })
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.body.some((line) => line.key === MORE_KEYS.down)).toBe(true)
    expect(view.more[MORE_KEYS.down]).toBeDefined()
    expect(view.body.some((line) => line.key === view.more[MORE_KEYS.down])).toBe(false)
  })
})

describe('the jump note and the screen read', () => {
  it('shows the jump note of the selected session under the key row, and no note for another session', () => {
    for (const bodyColumns of [60, 110]) {
      const noted = paneLines(pane(detailSnapshot(), { bodyColumns, selectedKey: 's-wait', jumpNote: { sessionId: 's-wait', reason: 'no-tab' } })).map(text)
      expect(noted.at(-1), noted.join('\n')).toBe(` ${JUMP_NOTE['no-tab']}`)
      const other = paneLines(pane(detailSnapshot(), { bodyColumns, selectedKey: 's-work', jumpNote: { sessionId: 's-wait', reason: 'no-tab' } })).map(text)
      expect(other.join('\n')).not.toContain(JUMP_NOTE['no-tab'])
    }
  })

  it('takes the room of the note from the board, so the pane still fits its rows', () => {
    for (const bodyRows of [12, 20, 40]) {
      const view = pane(detailSnapshot(), { bodyColumns: 110, bodyRows, selectedKey: 's-wait', jumpNote: { sessionId: 's-wait', reason: 'failed' } })
      expect(rowsOf(view)).toBeLessThanOrEqual(bodyRows)
    }
  })

  it('shows the screen read of the selected session in its Screen tab', () => {
    const screen = { sessionId: 's-wait', read: { sessionId: 's-wait', workspaceRef: 'workspace:7', surfaceRef: 'surface:12', text: 'The screen of the session.', readAt: NOW }, isFailed: false }
    const lines = paneLines(pane(detailSnapshot(), { selectedKey: 's-wait', detail: { ...DEFAULT_DETAIL, tab: 'screen' }, screen })).map(text)
    expect(lines.some((line) => line.endsWith('The screen of the session.')), lines.join('\n')).toBe(true)
  })
})


describe('the bar of the key path', () => {
  it('sits under the bottom rule and above the key row, and the board gives it its rows', () => {
    for (const bodyColumns of [80, 110]) {
      for (const bodyRows of [16, 20, 40]) {
        const view = pane(detailSnapshot(), { bodyColumns, bodyRows, selectedKey: 's-wait', deliver: { scroll: 0, intent: INTENTS.prompt } })
        if (view.kind !== 'board') throw new Error(view.kind)
        const lines = paneLines(view).map(text)
        const at = lines.indexOf(' Send this prompt to api-7?  y: send  c: cancel')
        expect(at, lines.join('\n')).toBeGreaterThan(0)
        expect(lines[at - 1]).toBe(text(view.bottomRule))
        expect(lines[at + view.bar!.lines.length]).toBe(text(view.keys[0]!))
        expect(rowsOf(view), `${bodyRows} rows at ${bodyColumns}`).toBeLessThanOrEqual(bodyRows)
      }
    }
  })

  it('draws the bar in the narrow detail too, and a draft with its text field', () => {
    const draft = { kind: 'prompt' as const, target: { sessionId: 's-wait', name: 'api-7' }, lines: ['Run the tests.'] }
    const view = pane(detailSnapshot(), { bodyColumns: 80, bodyRows: 30, selectedKey: 's-wait', detail: { ...DEFAULT_DETAIL, isOpen: true }, deliver: { scroll: 0, draft } })
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(view.bar?.field?.key).toBe('draft:1')
    expect(paneLines(view).map(text)).toContain(' Write the prompt for api-7. It has 1 line.  c: cancel')
    expect(rowsOf(view)).toBeLessThanOrEqual(30)
  })

  it('gives w and z to the bar while its text is cut, so the detail draws its count lines as text', () => {
    const long = { ...INTENTS.prompt, text: Array.from({ length: 40 }, (_, index) => `Line ${index + 1}.`).join('\n') } as typeof INTENTS.prompt
    const cut = pane(detailSnapshot(), { bodyRows: 30, selectedKey: 's-wait', deliver: { scroll: 0, intent: long } })
    if (cut.kind !== 'board' || cut.detail?.kind !== 'session' || cut.detail.view.kind !== 'detail') throw new Error(cut.kind)
    expect(Object.keys(cut.bar!.scrollTo)).toEqual(['z'])
    expect(cut.detail.view.window.shown).toBeLessThan(cut.detail.view.window.total)
    expect(cut.detail.scrollTo).toEqual({})
    const short = pane(detailSnapshot(), { bodyRows: 20, selectedKey: 's-wait', deliver: { scroll: 0, intent: INTENTS.answer } })
    if (short.kind !== 'board') throw new Error(short.kind)
    expect(short.bar!.scrollTo).toEqual({})
  })

  it('shows the note of the last outcome of the selected session, and not in its open Screen tab', () => {
    const noted = paneLines(pane(detailSnapshot(), { selectedKey: 's-wait', deliver: { scroll: 0, outcome: OUTCOMES.refused } })).map(text)
    expect(noted.filter((line) => line.endsWith('The screen or the session changed, so the pane sent nothing.'))).toHaveLength(1)
    const screen = paneLines(pane(detailSnapshot(), { selectedKey: 's-wait', detail: { ...DEFAULT_DETAIL, tab: 'screen' }, deliver: { scroll: 0, outcome: OUTCOMES.refused } })).map(text)
    expect(screen.filter((line) => line.includes('The screen or the session changed, so the pane sent nothing.'))).toHaveLength(1)
  })

  it('counts 1-2 in the key row for the Yes and No of a Bash request', () => {
    const view = pane(detailSnapshot(), { selectedKey: 's-perm' })
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.hints.find((hint) => hint.label === 'answer')?.keys).toBe('1-2')
  })
})
