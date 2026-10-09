/**
 * The header of the god pane: the brand, the live count, the count of each level that wants a look, the mode,
 * a dim chip for each source that failed, and the age of old facts in the warn color.
 */
import { describe, expect, it } from 'vitest'
import { SECOND } from '../../../test/fixtures/god/sessions.js'
import { NOW, boardSnapshot, degradedSnapshot, noRepoMatchSnapshot, readingSnapshot } from '../../../test/fixtures/god/snapshots.js'
import { cellWidth } from './cells.js'
import { headerLines } from './header.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const segmentOf = (lines: readonly Line[], value: string) => lines.flatMap((line) => line.segments).find((segment) => segment.text === value)

describe('the header', () => {
  it('shows the brand, the live count, the count of each level that wants a look, and the mode on 1 line', () => {
    const lines = headerLines({ snapshot: boardSnapshot(), width: 110, now: NOW })
    expect(lines.map(text)).toEqual([' ◉ orangu god  8 live  ⚠ 1  ● 1  ✕ 1  ⠋ 2  all'])
    expect(segmentOf(lines, '◉')).toEqual({ text: '◉', token: '--accent' })
    expect(segmentOf(lines, '⚠')).toEqual({ text: '⚠', token: '--bad' })
    expect(segmentOf(lines, '⠋')).toEqual({ text: '⠋', token: '--cat-read' })
  })

  it('shows the repos of the repos mode', () => {
    expect(headerLines({ snapshot: noRepoMatchSnapshot(), width: 110, now: NOW }).map(text).join('')).toMatch(/ {2}repos: shop$/)
  })

  it('shows a dim chip for each source that failed, and none for cmux that is not on the machine', () => {
    const snapshot = degradedSnapshot({ agents: { status: 'off', reason: 'exit 1' }, git: { status: 'off' }, cmux: { status: 'missing' } })
    const lines = headerLines({ snapshot, width: 110, now: NOW })
    expect(lines.map(text).join('')).toMatch(/ {2}agents off {2}git off$/)
    expect(segmentOf(lines, 'agents off')).toEqual({ text: 'agents off', dim: true })
    expect(lines.map(text).join('')).not.toMatch(/cmux/)
  })

  it('shows the age of the facts in the warn color once they are more than 10 s old, and nothing before', () => {
    const old = headerLines({ snapshot: degradedSnapshot({}, 12 * SECOND), width: 110, now: NOW })
    expect(segmentOf(old, 'old 12s')).toEqual({ text: 'old 12s', token: '--warn' })
    expect(headerLines({ snapshot: degradedSnapshot({}, 10 * SECOND), width: 110, now: NOW }).map(text).join('')).not.toMatch(/old/)
    expect(segmentOf(headerLines({ snapshot: degradedSnapshot({}, 3 * 60 * SECOND), width: 110, now: NOW }), 'old 3m')).toBeDefined()
  })

  it('shows only the brand before the first refresh ends', () => {
    expect(headerLines({ snapshot: readingSnapshot(), width: 110, now: NOW }).map(text)).toEqual([' ◉ orangu god'])
    expect(headerLines({ width: 110, now: NOW }).map(text)).toEqual([' ◉ orangu god'])
  })

  it('moves whole items to the next line when they do not fit, and never cuts one', () => {
    const snapshot = degradedSnapshot({ agents: { status: 'off' }, registry: { status: 'off' }, cmux: { status: 'off' }, git: { status: 'off' } }, 40 * SECOND)
    const words = (lines: readonly string[]): string[] => lines.join(' ').split(/\s+/).filter(Boolean).sort()
    const wide = headerLines({ snapshot, width: 200, now: NOW }).map(text)
    expect(wide).toHaveLength(1)
    for (const width of [30, 60, 89]) {
      const lines = headerLines({ snapshot, width, now: NOW }).map(text)
      expect(lines.length, `${width} columns`).toBeGreaterThan(1)
      for (const line of lines) expect(cellWidth(line), `${width} columns: ${line}`).toBeLessThanOrEqual(width)
      expect(words(lines), `${width} columns: every item shows`).toEqual(words(wide))
    }
  })
})
