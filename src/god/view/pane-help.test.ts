/**
 * The help view in the pane: h shows it in place of the detail, beside the board from 90 columns and in place of
 * the board below 90. It shows only while the pane holds the keys, because Esc gives the keys to the prompt and
 * closes it. A help taller than its rows scrolls with w and z.
 */
import { describe, expect, it } from 'vitest'
import { NOW, boardSnapshot } from '../../../test/fixtures/god/snapshots.js'
import type { BoardSnapshot } from '../types.js'
import { DEFAULT_DETAIL, paneDetailLines } from './detail-pane.js'
import { helpLines } from './help.js'
import { paneLines, paneView, type PaneInput } from './pane.js'
import type { Line, PaneView } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const HELP = { ...DEFAULT_DETAIL, isHelp: true }
const pane = (snapshot: BoardSnapshot, over: Partial<PaneInput> = {}): PaneView =>
  paneView({ snapshot, bodyColumns: 160, bodyRows: 40, now: NOW, openGroups: [], promptHoldsKeys: false, selectedKey: 's-wait', detail: HELP, ...over })

describe('the help in the pane', () => {
  it('names h in the key row as a key that 1 Button presses', () => {
    const view = pane(boardSnapshot(), { detail: DEFAULT_DETAIL })
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.hints.at(-1)).toEqual({ keys: 'h', label: 'help', hotkey: 'h', isOff: false })
    expect(view.keys.map(text).join('')).toMatch(/ {2}g: group {2}h: help$/)
  })

  it('shows the help in place of the detail beside the board from 90 columns', () => {
    const view = pane(boardSnapshot())
    if (view.kind !== 'board' || view.detail?.kind !== 'help') throw new Error(`${view.kind} ${view.kind === 'board' ? view.detail?.kind : ''}`)
    expect(paneDetailLines(view.detail).map(text)).toEqual(helpLines(102).map(text))
    expect(view.body.some((line) => line.key === 's-wait')).toBe(true)
  })

  it('shows the help in place of the board below 90 columns, with b to go back, also with no session selected', () => {
    for (const selectedKey of ['s-wait', undefined]) {
      const view = pane(boardSnapshot(), { bodyColumns: 60, ...(selectedKey === undefined ? { selectedKey: '' } : {}) })
      if (view.kind !== 'detail' || view.detail.kind !== 'help') throw new Error(view.kind)
      expect(paneDetailLines(view.detail).map(text)[0]).toBe(text(helpLines(60)[0]!))
      expect(view.keys.map(text).join('')).toMatch(/^ b: back/)
    }
  })

  it('shows no help while the prompt holds the keys: Esc gave them back and closed it', () => {
    for (const bodyColumns of [60, 160]) {
      const lines = paneLines(pane(boardSnapshot(), { bodyColumns, promptHoldsKeys: true })).map(text)
      expect(lines.join('\n'), `${bodyColumns}`).not.toContain('Press h or Esc to close this help.')
    }
  })

  it('shows a help taller than its rows in a window: z shows the lines below, and w the lines above', () => {
    const view = pane(boardSnapshot(), { bodyRows: 16 })
    if (view.kind !== 'board' || view.detail?.kind !== 'help') throw new Error(view.kind)
    const lines = paneDetailLines(view.detail).map(text)
    expect(lines.at(-1)).toMatch(/^ z: \+\d+ lines$/)
    expect(Object.keys(view.detail.scrollTo)).toEqual(['z'])
    const below = pane(boardSnapshot(), { bodyRows: 16, detail: { ...HELP, scroll: view.detail.scrollTo['z']! } })
    if (below.kind !== 'board' || below.detail?.kind !== 'help') throw new Error(below.kind)
    expect(paneDetailLines(below.detail).map(text)[0]).toMatch(/^ w: \+\d+ lines$/)
  })
})
