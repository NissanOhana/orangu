/**
 * The layout of the pane at a body width: the board column takes about 40% of a wide body, from 30 to 60 cells, left
 * of the detail, and the board takes the whole body below 90 columns. The header says who holds the keys.
 */
import { describe, expect, it } from 'vitest'
import { NOW, boardSnapshot, readingSnapshot } from '../../../test/fixtures/god/snapshots.js'
import type { BoardSnapshot } from '../types.js'
import { BOARD_COLUMNS } from './board.js'
import { layoutOf, paneLines, paneView, type PaneInput } from './pane.js'
import type { Line, PaneView } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const pane = (snapshot: BoardSnapshot, over: Partial<PaneInput> = {}): PaneView =>
  paneView({ snapshot, bodyColumns: 110, bodyRows: 40, now: NOW, openGroups: [], promptHoldsKeys: false, ...over })

describe('the layout', () => {
  it('gives the board about 40% of the body left of the detail at 90 columns or more, 30 to 60 cells, and the board alone below 90', () => {
    expect(BOARD_COLUMNS).toBe(30)
    expect(layoutOf(89)).toEqual({ kind: 'narrow', boardColumns: 89 })
    expect(layoutOf(90)).toEqual({ kind: 'wide', boardColumns: 36, detailColumns: 53 })
    expect(layoutOf(110)).toEqual({ kind: 'wide', boardColumns: 44, detailColumns: 65 })
    // a dock of the full width of a terminal of 190 columns has 163 body columns
    expect(layoutOf(163)).toEqual({ kind: 'wide', boardColumns: 60, detailColumns: 102 })
    expect(layoutOf(400)).toEqual({ kind: 'wide', boardColumns: 60, detailColumns: 339 })
  })

  it('says in the header who holds the keys, and not in the key row', () => {
    const view = pane(boardSnapshot(), { promptHoldsKeys: true })
    if (view.kind !== 'board') throw new Error(view.kind)
    expect(view.header.map(text).join('')).toContain('keys: prompt · ctrl+x tab: pane')
    expect(view.keys.map(text).join('')).not.toContain('ctrl+x tab')
    expect(paneLines(pane(readingSnapshot())).map(text)[0]).toBe(' ◉ orangu god  keys: pane · Esc: prompt')
  })
})
