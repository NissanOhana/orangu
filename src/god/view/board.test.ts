/**
 * The board column of the god pane: 1 heading for each group, 1 row for each session (the glyph of its level,
 * the name, the flag chips, the summary and the time in the level), rows sized to the board width, only the
 * lines that fit, and the selected row always in view.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, SECOND, busy, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { NOW, QUESTION, boardSessions, boardSnapshot, byRepoSnapshot, snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import { LEVEL_ORDER, type BoardSnapshot, type Level } from '../types.js'
import { STALE_GROUP_KEY, boardLines, levelTime, LEVEL_GLYPH, type BoardViewInput } from './board.js'
import { cellWidth, graphemes } from './cells.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const view = (snapshot: BoardSnapshot, over: Partial<BoardViewInput> = {}): Line[] =>
  boardLines({ snapshot, width: 60, rows: 40, now: NOW, openGroups: [], ...over })
const rowOf = (lines: readonly Line[], sessionId: string): Line => {
  const line = lines.find((candidate) => candidate.key === sessionId)
  if (line === undefined) throw new Error(`no row for ${sessionId}`)
  return line
}

describe('groups and rows', () => {
  it('shows 1 heading for each level that has rows, in the level order, each row under its heading', () => {
    const lines = view(boardSnapshot()).map(text)
    expect(lines.filter((line) => /^ [A-Z]/.test(line))).toEqual([' NEEDS YOU', ' YOUR TURN', ' STUCK', ' WORKING', ' IDLE', ' STALE 2 ▸'])
    expect(lines.filter((line) => /^ [^A-Z ]/.test(line)).map((line) => line.split(/\s+/)[2])).toEqual(['api-7', 'web-2', 'api-3', 'api-9', 'docs-1', 'api-1'])
  })

  it('keys each session row by its session id and each heading by nothing but the stale group', () => {
    const lines = view(boardSnapshot())
    expect(lines.filter((line) => line.key !== undefined).map((line) => line.key)).toEqual(['s-wait', 's-turn', 's-stuck', 's-work', 's-new', 's-idle', STALE_GROUP_KEY])
  })

  it('keeps the stale group closed with its count, and opens it when the person opened it', () => {
    const open = view(boardSnapshot(), { openGroups: ['stale'] })
    expect(open.map(text).slice(-3).map((line) => line.trimEnd().replace(/ {2,}.*/, ''))).toEqual([' STALE 2 ▾', ' ○ old-b', ' ○ old-a'])
    expect(rowOf(open, STALE_GROUP_KEY)).toBeDefined()
  })

  it('shows the repo as the heading when the board groups by repo, and no closed group', () => {
    const headings = view(byRepoSnapshot()).filter((line) => line.key === undefined).map(text)
    expect(headings).toEqual([' api', ' No repo'])
  })

  it('shows each row: the glyph, the name, the flag chips, the summary, then the time in the level', () => {
    const lines = view(boardSnapshot())
    expect(text(rowOf(lines, 's-turn'))).toMatch(/^ ● web-2 {2}FILES {2}Setup is done\. +12m$/)
    expect(text(rowOf(lines, 's-stuck'))).toMatch(/^ ✕ api-3 {2}REPO {2}The API refused the request\. +15m$/)
    expect(text(rowOf(lines, 's-new'))).toMatch(/^ ⠋ docs-1 {2}No transcript yet\. +2m$/)
    expect(text(rowOf(lines, 's-idle'))).toMatch(/^ · api-1 {2}REPO {2}The vendor pick is in the notes\. +2h$/)
  })

  it('colors each flag chip by its kind and draws the idle row dim', () => {
    const segments = rowOf(view(boardSnapshot()), 's-work').segments
    expect(segments.filter((segment) => ['TREE', 'FILES', 'REPO'].includes(segment.text))).toEqual([
      { text: 'TREE', token: '--bad' },
      { text: 'FILES', token: '--cat-edit' },
      { text: 'REPO', dim: true },
    ])
    expect(rowOf(view(boardSnapshot()), 's-idle').segments.find((segment) => segment.text === '·')).toEqual({ text: '·', dim: true })
  })
})

describe('the glyph carries the level with no color', () => {
  it('gives each level its own glyph, so the text alone tells the level', () => {
    expect(LEVEL_GLYPH).toEqual({ 'needs-you': '⚠', 'your-turn': '●', stuck: '✕', working: '⠋', idle: '·', stale: '○' })
    expect(new Set(Object.values(LEVEL_GLYPH)).size).toBe(LEVEL_ORDER.length)
    const byGlyph = new Map(Object.entries(LEVEL_GLYPH).map(([level, glyph]) => [glyph, level as Level]))
    const snapshot = boardSnapshot()
    for (const line of view(snapshot, { openGroups: ['stale'] }).filter((candidate) => candidate.key !== undefined && candidate.key !== STALE_GROUP_KEY)) {
      // read the level from the characters alone: no token, no dim
      const glyph = graphemes(text(line))[1]!
      expect(byGlyph.get(glyph), text(line)).toBe(snapshot.sessions.find((session) => session.sessionId === line.key)!.level)
    }
  })
})

describe('the time in the level', () => {
  it('reads now, then minutes, hours and days, in 4 cells at most', () => {
    expect(levelTime(NOW - 30 * SECOND, NOW)).toBe('now')
    expect(levelTime(NOW - 12 * MINUTE, NOW)).toBe('12m')
    expect(levelTime(NOW - 6 * HOUR, NOW)).toBe('6h')
    expect(levelTime(NOW - 3 * 24 * HOUR, NOW)).toBe('3d')
    expect(levelTime(NOW - 400 * 24 * HOUR, NOW)).toBe('99d')
    expect(levelTime(NOW + MINUTE, NOW)).toBe('now')
  })
})

describe('cuts: no hidden text', () => {
  it('cuts the question of a waiting row with the count of what it cut, and the kept part and the count make the whole question', () => {
    for (const width of [30, 60]) {
      const row = text(rowOf(view(boardSnapshot(), { width }), 's-wait'))
      const match = /^ ⚠ api-7 {2}TREE REPO {2}(.*)…\+(\d+) +6h$/.exec(row)
      expect(match, `${width} columns: ${row}`).not.toBeNull()
      const kept = match![1]!
      expect(kept.length, `${width} columns: some of the question shows`).toBeGreaterThan(0)
      expect(QUESTION.startsWith(kept), row).toBe(true)
      expect(graphemes(kept).length + Number(match![2]), row).toBe(graphemes(QUESTION).length)
    }
  })

  it('cuts a long name to its column with its count, and the flag chips stay whole or leave with a count', () => {
    const long = 'a-very-long-session-name-for-the-board'
    const snapshot = snapshotOf([...boardSessions(), busy('s-long', { name: long })])
    for (const width of [30, 60]) {
      const row = text(rowOf(view(snapshot, { width }), 's-long'))
      expect(row, `${width} columns`).toMatch(/ a-very[^ ]*…\+\d+ /)
      const work = text(rowOf(view(snapshot, { width }), 's-work'))
      expect(work.split(/\s+/).filter((word) => /^(?:TREE|FILES|REPO)$/.test(word) || /…\+\d+$/.test(word)).length, `${width} columns: ${work}`).toBeGreaterThan(0)
    }
  })
})

describe('widths: every line fits the board width', () => {
  it('holds every line to the width at 30, 59, 60 and 89 columns, with wide characters, long names and every chip', () => {
    const wide = [
      waiting('s-cjk', { name: '日本語のセッション名', transcript: transcript({ openQuestion: { toolUseId: 'tu', questions: [{ text: '日本語の質問はここにあります。', header: 'h', multiSelect: false, options: [] }] } }) }),
      busy('s-emoji', { name: 'emoji-\u{1F600}', transcript: transcript({ activity: { toolUseId: 'tu', tool: 'Edit', text: 'Edit \u{1F468}‍\u{1F469}‍\u{1F467} é.md', isOpen: true } }) }),
      busy('s-long', { name: 'x'.repeat(80), statusSince: NOW - 400 * 24 * HOUR }),
    ]
    const snapshot = snapshotOf([...boardSessions(), ...wide])
    for (const width of [30, 59, 60, 89]) {
      for (const openGroups of [[], ['stale']]) {
        for (const line of view(snapshot, { width, openGroups })) expect(cellWidth(text(line)), `${width} columns: ${text(line)}`).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe('only the lines that fit, with the selected row in view', () => {
  const sessions = (): ReturnType<typeof boardSessions> => [
    ...boardSessions(),
    ...Array.from({ length: 8 }, (_, index) => busy(`s-more-${index}`, { name: `more-${index}`, statusSince: NOW - (index + 1) * MINUTE })),
  ]

  it('shows every line when they fit, and no count line', () => {
    const lines = view(snapshotOf(sessions()), { rows: 40 }).map(text)
    expect(lines.some((line) => /sessions? \(/.test(line))).toBe(false)
  })

  it('shows no more lines than the rows, counts the sessions above and below, and keeps the selected row in view', () => {
    const snapshot = snapshotOf(sessions())
    const keys = view(snapshot, { rows: 40 }).flatMap((line) => (line.key === undefined ? [] : [line.key]))
    const total = snapshot.sessions.length
    for (const rows of [3, 5, 8]) {
      for (const selectedKey of keys) {
        const lines = view(snapshot, { rows, selectedKey })
        expect(lines.length, `${rows} rows, ${selectedKey}`).toBeLessThanOrEqual(rows)
        const selected = lines.find((line) => line.key === selectedKey)
        expect(selected, `${rows} rows: ${selectedKey} shows`).toBeDefined()
        expect(selected!.segments[0], `${rows} rows: ${selectedKey} is marked`).toEqual({ text: '▌', token: '--accent' })
        const counted = lines.map(text).flatMap((line) => {
          const match = /^ \+(\d+) sessions? \((↑|↓)\)$/.exec(line)
          return match === null ? [] : [Number(match[1])]
        })
        const shown = lines.filter((line) => line.key !== undefined && line.key !== STALE_GROUP_KEY).length
        const staleShown = lines.some((line) => line.key === STALE_GROUP_KEY) ? 2 : 0
        expect(shown + staleShown + counted.reduce((sum, count) => sum + count, 0), `${rows} rows, ${selectedKey}: each session shows or counts`).toBe(total)
      }
    }
  })

  it('marks no row when the selected session is not on the board', () => {
    const lines = view(boardSnapshot(), { selectedKey: 'gone' })
    expect(lines.filter((line) => line.segments[0]?.text === '▌')).toEqual([])
  })
})
