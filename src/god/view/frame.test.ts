/**
 * The body of the wide pane: the board column, the column rule and the detail column, each as tall as the tallest,
 * and the short line that the detail column shows until the detail view lands.
 */
import { describe, expect, it } from 'vitest'
import { cellWidth } from './cells.js'
import { DETAIL_PLACEHOLDER, detailPlaceholder, wideColumns } from './frame.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const line = (value: string): Line => ({ segments: [{ text: value }] })

describe('the wide body', () => {
  it('makes the 3 columns as tall as the tallest, the rule a dim column of │', () => {
    const columns = wideColumns([line('a'), line('b'), line('c')], [line('d')])
    expect(columns.board.map(text)).toEqual(['a', 'b', 'c'])
    expect(columns.rule.map(text)).toEqual(['│', '│', '│'])
    expect(columns.rule.every((rule) => rule.segments.every((segment) => segment.dim === true))).toBe(true)
    expect(columns.detail.map(text)).toEqual(['d', ' ', ' '])
    const tall = wideColumns([line('a')], [line('d'), line('e')])
    expect(tall.board.map(text)).toEqual(['a', ' '])
    expect(tall.rule).toHaveLength(2)
  })

  it('keeps the key of a board row', () => {
    expect(wideColumns([{ key: 's-1', segments: [{ text: 'row' }] }], []).board[0]!.key).toBe('s-1')
  })

  it('shows 1 short line in the detail column, never wider than the column', () => {
    expect(DETAIL_PLACEHOLDER).toBe('The detail of the selected session is not in this build.')
    expect(detailPlaceholder(79).map(text)).toEqual([` ${DETAIL_PLACEHOLDER}`])
    for (const width of [59, 79]) for (const row of detailPlaceholder(width)) expect(cellWidth(text(row))).toBeLessThanOrEqual(width)
  })
})
