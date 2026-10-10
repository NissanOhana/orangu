/**
 * The body of the wide pane: the board column, the column rule and the detail column, each as tall as the tallest.
 */
import { describe, expect, it } from 'vitest'
import { wideColumns } from './frame.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const line = (value: string): Line => ({ segments: [{ text: value }] })

describe('the wide body', () => {
  it('makes the 3 columns as tall as the tallest, the rule a dim column of │', () => {
    const columns = wideColumns([line('a'), line('b'), line('c')], 1)
    expect(columns.board.map(text)).toEqual(['a', 'b', 'c'])
    expect(columns.rule.map(text)).toEqual(['│', '│', '│'])
    expect(columns.rule.every((rule) => rule.segments.every((segment) => segment.dim === true))).toBe(true)
    expect(columns.detailPad.map(text)).toEqual([' ', ' '])
    const tall = wideColumns([line('a')], 2)
    expect(tall.board.map(text)).toEqual(['a', ' '])
    expect(tall.rule).toHaveLength(2)
    expect(tall.detailPad).toEqual([])
  })

  it('keeps the key of a board row', () => {
    expect(wideColumns([{ key: 's-1', segments: [{ text: 'row' }] }], 0).board[0]!.key).toBe('s-1')
  })
})
