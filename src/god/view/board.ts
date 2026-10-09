/**
 * The board column of the god pane, as lines:
 * - 1 heading for each group of the snapshot, in board order. A group that starts closed (the stale group) shows
 *   its count and a `▸`, and opens when the person opens it (`openGroups`). Its heading is a row that the person
 *   can select, with the key groupKey(<group key>);
 * - 1 row for each session of an open group: the selection mark, the glyph of the level, the name, 1 chip for
 *   each kind of overlap flag, the summary, and the time in the level at the right edge. The row key is the
 *   session id;
 * - every row is exactly `width` cells. The names share 1 column. A text that does not fit is cut with its count
 *   (src/god/view/cut.ts): the detail of the session shows it whole;
 * - only `rows` lines: the window keeps the selected row in view, and a line above and below counts the sessions
 *   that it leaves out and names the arrow key that shows them.
 * The glyph tells the level with no color, for a reader who cannot tell the colors apart. Outside text (a name, a
 * summary, a repo name) shows on 1 line: each run of white space becomes 1 space. The clock comes in as `now`.
 */
import { ACCENT, DIM, FLAG_PAINT, LEVEL_PAINT } from '../ui/theme.js'
import type { BoardGroup, BoardSnapshot, FlagKind, GodSession, Level } from '../types.js'
import { cellWidth } from './cells.js'
import { cutInline, fitSegments, moreText, type Part } from './cut.js'
import type { Line, Segment } from './types.js'

/** The board width in the wide layout, and the narrowest board that the row layout fits. */
export const BOARD_COLUMNS = 30

/** The glyph of each level. WORKING shows a frame of the braille spinner. */
export const LEVEL_GLYPH: Readonly<Record<Level, string>> = { 'needs-you': '⚠', 'your-turn': '●', stuck: '✕', working: '⠋', idle: '·', stale: '○' }

/** The heading of each level group. */
export const LEVEL_HEADING: Readonly<Record<Level, string>> = {
  'needs-you': 'NEEDS YOU',
  'your-turn': 'YOUR TURN',
  stuck: 'STUCK',
  working: 'WORKING',
  idle: 'IDLE',
  stale: 'STALE',
}

/** The chip of each overlap flag. */
export const FLAG_CHIP: Readonly<Record<FlagKind, string>> = { 'same-tree': 'TREE', 'same-files': 'FILES', 'same-repo': 'REPO' }

/** The heading of the repo group of the sessions that have no repo. */
export const NO_REPO = 'No repo'

const FLAG_KINDS: readonly FlagKind[] = ['same-tree', 'same-files', 'same-repo']
const SESSION_UNIT = ['session', 'sessions'] as const
/** the name column: at least this many cells when a name needs it, and never more than NAME_MAX */
const NAME_MIN = 6
const NAME_MAX = 24
/** the fewest lines that a window needs: the count above, the selected row, the count below */
export const MIN_WINDOW_ROWS = 3

/** The key of a group heading that the person opens and closes. */
export const groupKey = (key: string): string => `group:${key}`

/** The key of the heading of the stale group. */
export const STALE_GROUP_KEY = groupKey('stale')

/** What the board column reads. */
export type BoardViewInput = {
  snapshot: BoardSnapshot
  /** the board width in cells */
  width: number
  /** the most lines that the board may take: MIN_WINDOW_ROWS or more when the board does not fit */
  rows: number
  now: number
  /** the key of the selected row: a session id or a group key */
  selectedKey?: string
  /** the keys of the groups that the person opened */
  openGroups: readonly string[]
}

/** The time since `since`: `now` under 1 min, then `12m`, `3h`, `9d` (99d at most), in 4 cells or less. */
export function levelTime(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.min(99, Math.floor(minutes / (24 * 60)))}d`
}

/** Outside text on 1 line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** 1 line of the board and the count of sessions that it stands for. */
type Item = { line: Line; sessions: number }

const mark = (isSelected: boolean): Segment => (isSelected ? { text: '▌', ...ACCENT } : { text: ' ' })

const isOpen = (group: BoardGroup, openGroups: readonly string[]): boolean => !group.startsClosed || openGroups.includes(group.key)

function headingItem(group: BoardGroup, input: BoardViewInput): Item {
  const repoName = flat(group.repo?.name ?? '') || NO_REPO
  const title: Segment =
    group.level === undefined ? { text: cutInline(repoName, input.width - 1) ?? repoName, bold: true } : { text: LEVEL_HEADING[group.level], ...LEVEL_PAINT[group.level], bold: true }
  if (!group.startsClosed) return { line: { segments: [mark(false), title] }, sessions: 0 }
  const key = groupKey(group.key)
  const open = isOpen(group, input.openGroups)
  return {
    line: { key, segments: [mark(input.selectedKey === key), title, { text: ` ${group.sessionIds.length} ${open ? '▾' : '▸'}` }] },
    sessions: open ? 0 : group.sessionIds.length,
  }
}

/** The kinds of the flags of 1 session, each once, in the kind order. */
const chipKinds = (session: GodSession): FlagKind[] => FLAG_KINDS.filter((kind) => session.flags.some((flag) => flag.kind === kind))

function sessionLine(session: GodSession, input: BoardViewInput, nameColumn: number): Line {
  const time = levelTime(session.levelSince, input.now)
  const middleRoom = input.width - 4 - cellWidth(time)
  const name = flat(session.name)
  const shownName = cutInline(name, nameColumn) ?? name
  const summary = flat(session.summary)
  const parts: Part[] = [{ segment: { text: shownName } }]
  if (cellWidth(shownName) < nameColumn) parts.push({ segment: { text: ' '.repeat(nameColumn - cellWidth(shownName)) } })
  for (const kind of chipKinds(session)) parts.push({ segment: { text: ' ' } }, { segment: { text: FLAG_CHIP[kind], ...FLAG_PAINT[kind] }, isWhole: true })
  if (summary !== '') parts.push({ segment: { text: '  ' } }, { segment: { text: summary } })
  const middle = fitSegments(parts, middleRoom)
  const fill = middleRoom - middle.reduce((sum, segment) => sum + cellWidth(segment.text), 0)
  return {
    key: session.sessionId,
    segments: [
      mark(input.selectedKey === session.sessionId),
      { text: LEVEL_GLYPH[session.level], ...LEVEL_PAINT[session.level] },
      { text: ' ' },
      ...middle,
      { text: ' '.repeat(fill + 1) },
      { text: time, ...DIM },
    ],
  }
}

/** The lines that fit `rows`, with the selected line in view and a count line for each side that it leaves out. */
function windowOf(items: readonly Item[], rows: number, selected: number): Line[] {
  if (items.length <= rows) return items.map((item) => item.line)
  const room = Math.max(MIN_WINDOW_ROWS, rows)
  const sessions = (from: number, to: number): number => items.slice(from, to).reduce((sum, item) => sum + item.sessions, 0)
  const countLine = (count: number, key: string): Line => ({ segments: [{ text: ' ' }, { text: moreText(count, SESSION_UNIT, key), ...DIM }] })
  let start = 0
  let end = room - 1
  if (selected >= end) {
    end = selected + 1
    start = end - (room - 1 - (end < items.length ? 1 : 0))
    // a count line for a heading alone would count 0 sessions: show the heading in its place
    if (start === 1 && items[0]!.sessions === 0) start = 0
  }
  return [
    ...(start > 0 ? [countLine(sessions(0, start), '↑')] : []),
    ...items.slice(start, end).map((item) => item.line),
    ...(end < items.length ? [countLine(sessions(end, items.length), '↓')] : []),
  ]
}

/** The lines of the board column. */
export function boardLines(input: BoardViewInput): Line[] {
  const { snapshot, width } = input
  const byId = new Map(snapshot.sessions.map((session) => [session.sessionId, session]))
  const shown = snapshot.groups.map((group) => ({
    group,
    sessions: isOpen(group, input.openGroups) ? group.sessionIds.flatMap((id) => byId.get(id) ?? []) : [],
  }))
  const longest = Math.max(0, ...shown.flatMap(({ sessions }) => sessions.map((session) => cellWidth(flat(session.name)))))
  const nameColumn = Math.min(longest, NAME_MAX, Math.max(NAME_MIN, Math.floor((width - 3) * 0.4)))
  const items: Item[] = shown.flatMap(({ group, sessions }) => [headingItem(group, input), ...sessions.map((session) => ({ line: sessionLine(session, input, nameColumn), sessions: 1 }))])
  const selected = items.findIndex((item) => item.line.key !== undefined && item.line.key === input.selectedKey)
  return windowOf(items, input.rows, Math.max(0, selected))
}
