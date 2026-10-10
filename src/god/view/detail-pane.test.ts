/**
 * The detail that the pane shows: the detail of the selected session (src/god/view/detail.ts), or 1 line that asks
 * for a selection. The Screen and the Recap tab show 1 line that says that they are not in this build. The view
 * gives the scroll that w and z go to, only for a side that the window cuts.
 */
import { describe, expect, it } from 'vitest'
import { busy, transcript } from '../../../test/fixtures/god/sessions.js'
import { NOW, snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import { detailSnapshot } from '../../../test/fixtures/god/detail.js'
import type { BoardSnapshot, DetailTab } from '../types.js'
import { STALE_GROUP_KEY } from './board.js'
import { cellWidth } from './cells.js'
import { DETAIL_TABS, scrollBy } from './detail.js'
import { DEFAULT_DETAIL, NO_DETAIL, TAB_NOT_IN_BUILD, paneDetail, paneDetailLines, type PaneDetail, type PaneDetailInput } from './detail-pane.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const detailOf = (snapshot: BoardSnapshot, over: Partial<PaneDetailInput> = {}): PaneDetail =>
  paneDetail({ snapshot, selectedKey: 's-wait', width: 79, rows: 40, now: NOW, state: DEFAULT_DETAIL, ...over })
const sessionDetail = (detail: PaneDetail): Extract<PaneDetail, { kind: 'session' }> => {
  if (detail.kind !== 'session') throw new Error(detail.kind)
  return detail
}

describe('the detail of the selected session', () => {
  it('shows the detail of the selected session in the open tab', () => {
    const detail = sessionDetail(detailOf(detailSnapshot()))
    expect(detail.sessionId).toBe('s-wait')
    const lines = paneDetailLines(detail).map(text)
    expect(lines[0]).toBe(' api-7 · Eval set › tab 2')
    expect(lines).toContain(' [Now]  History  Agents  Screen  Recap')
    expect(lines.some((line) => line.includes('Which eval set'))).toBe(true)
  })

  it('asks for a selection when no session is selected, a heading is selected, or the selected session is gone', () => {
    for (const selectedKey of [undefined, STALE_GROUP_KEY, 's-gone']) {
      const detail = paneDetail({ snapshot: detailSnapshot(), ...(selectedKey === undefined ? {} : { selectedKey }), width: 79, rows: 40, now: NOW, state: DEFAULT_DETAIL })
      expect(detail).toEqual({ kind: 'none', lines: [{ segments: [{ text: ` ${NO_DETAIL}` }] }] })
    }
    expect(NO_DETAIL).toBe('Select a session on the board to show its detail.')
  })

  it('shows 1 line in the Screen and the Recap tab, which are not in this build, and the other tabs as they are', () => {
    expect(TAB_NOT_IN_BUILD).toEqual({ screen: 'The Screen tab is not in this build.', recap: 'The Recap tab is not in this build.' })
    for (const tab of ['screen', 'recap'] as const) {
      const detail = sessionDetail(detailOf(detailSnapshot(), { state: { ...DEFAULT_DETAIL, tab } }))
      if (detail.view.kind !== 'detail') throw new Error(detail.view.kind)
      expect(detail.view.body.map(text)).toEqual([` ${TAB_NOT_IN_BUILD[tab]}`])
    }
    const history = sessionDetail(detailOf(detailSnapshot(), { state: { ...DEFAULT_DETAIL, tab: 'history' } }))
    if (history.view.kind !== 'detail') throw new Error(history.view.kind)
    expect(history.view.body.map(text).join('\n')).toContain('Read the parser.')
  })

  it('holds every line to the width and the rows, in every tab of every session', () => {
    const snapshot = detailSnapshot()
    for (const session of snapshot.sessions) {
      for (const tab of DETAIL_TABS) {
        for (const [width, rows] of [[59, 12], [79, 40], [60, 9]] as const) {
          const lines = paneDetailLines(detailOf(snapshot, { selectedKey: session.sessionId, width, rows, state: { ...DEFAULT_DETAIL, tab } })).map(text)
          expect(lines.length, `${session.sessionId} ${tab}`).toBeLessThanOrEqual(rows)
          for (const line of lines) expect(cellWidth(line), `${session.sessionId} ${tab}: ${line}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})

describe('the scroll of w and z', () => {
  const long = (): BoardSnapshot => snapshotOf([busy('s-long', { name: 'long-1', transcript: transcript({ lastReply: Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the reply.`).join('\n') }) })])
  const at = (scroll: number, tab: DetailTab = 'now') => sessionDetail(detailOf(long(), { selectedKey: 's-long', rows: 16, state: { tab, scroll, isOpen: false } }))

  it('gives z the next page at the top, and no w', () => {
    const top = at(0)
    if (top.view.kind !== 'detail') throw new Error(top.view.kind)
    expect(top.scrollTo).toEqual({ z: scrollBy(top.view.window, 'down') })
  })

  it('gives w the page above and z the page below in the middle, and only w at the end', () => {
    const middle = at(at(0).scrollTo.z!)
    if (middle.view.kind !== 'detail') throw new Error(middle.view.kind)
    expect(middle.scrollTo).toEqual({ w: scrollBy(middle.view.window, 'up'), z: scrollBy(middle.view.window, 'down') })
    const end = at(999)
    if (end.view.kind !== 'detail') throw new Error(end.view.kind)
    expect(end.scrollTo).toEqual({ w: scrollBy(end.view.window, 'up') })
  })

  it('draws the count line of each cut side as the key Button that the engine paints: the key, a colon, the count', () => {
    const middle = at(at(0).scrollTo.z!)
    if (middle.view.kind !== 'detail') throw new Error(middle.view.kind)
    const [first, last] = [middle.view.body[0]!, middle.view.body.at(-1)!]
    expect(text(first)).toMatch(/^ w: \+\d+ lines$/)
    expect(text(last)).toMatch(/^ z: \+\d+ lines$/)
    expect(first.segments.find((segment) => segment.press !== undefined)?.press).toEqual({ hotkey: 'w', label: text(first).slice(4) })
    expect(last.segments.find((segment) => segment.press !== undefined)?.press).toEqual({ hotkey: 'z', label: text(last).slice(4) })
  })

  it('gives no scroll key to a tab that fits, or to a session with no detail', () => {
    expect(sessionDetail(detailOf(detailSnapshot())).scrollTo).toEqual({})
  })
})
