/**
 * The board column of the god pane, as lines:
 * - 1 heading for each group of the snapshot, in board order. A group that starts closed (the stale group) shows
 *   its count and a `▸`, and opens when the person opens it (`openGroups`). Its heading is a row that the person
 *   can select, with the key groupKey(<group key>);
 * - 1 row for each session of an open group: the selection mark, the glyph of the level, the name of the row
 *   (src/god/view/names.ts: the cmux tab title, else the transcript title, else the session name), the `same file`
 *   chip while another session wrote a file that this one wrote, the summary, and the time in the level at the right
 *   edge. The same tree and the same repo get no chip: the detail names the working sessions of the folder. A
 *   summary that only says the name again shows nothing. The row key is the session id;
 * - every row is exactly `width` cells. The names share 1 column of up to 60% of the row and NAME_MAX cells, so a
 *   title shows whole in most cases. While a shown row has a chip, the column leaves the room of the chip. A text that does not fit is cut with its count (src/god/view/cut.ts): the
 *   detail of the session shows it whole;
 * - only `rows` lines: the window keeps the selected row in view, and a line above and below counts the sessions
 *   that it leaves out. Each count line is a row that the person presses (key MORE_KEYS.up or MORE_KEYS.down), and
 *   it names the key that presses it: `+3 sessions (Enter)`. The arrows only walk the drawn Buttons, so a press is
 *   what shows the rest: it selects the first hidden row on its side, and the window moves, so the person reaches
 *   every row, also in a pane too short for the ring to reach a row out of view.
 * The glyph tells the level with no color, for a reader who cannot tell the colors apart. Outside text (a name, a
 * summary, a repo name) shows on 1 line: each run of white space becomes 1 space. The clock comes in as `now`.
 * The motion frame (src/god/view/motion.ts) comes in as `frame`: a WORKING row shows its spinner frame, and while
 * the pulse is on, the glyph and the name of a NEEDS YOU row draw bold in the level color. No frame: the static frame.
 */
import { ACCENT, DIM, FLAG_PAINT, LEVEL_PAINT } from '../ui/theme.js'
import type { BoardGroup, BoardSnapshot, FlagKind, GodSession, Level } from '../types.js'
import { cellWidth } from './cells.js'
import { cutInline, fitSegments, moreText, type Part } from './cut.js'
import { spinnerGlyph, type MotionFrame } from './motion.js'
import { rowName } from './names.js'
import type { Line, Segment } from './types.js'

/** The narrowest board that the row layout fits, and the narrowest board of the wide layout. */
export const BOARD_COLUMNS = 30

/** The widest board of the wide layout: the detail takes the rest of the body. */
export const BOARD_MAX_COLUMNS = 60

/** The share of the body that the board takes in the wide layout, from BOARD_COLUMNS to BOARD_MAX_COLUMNS cells. */
export const BOARD_SHARE = 0.4

/** True when a group of the board holds the session `key`. The snapshot holds every session, also those that the repos mode hides. */
export const isOnBoard = (snapshot: BoardSnapshot, key: string | undefined): boolean => key !== undefined && snapshot.groups.some((group) => group.sessionIds.includes(key))

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

/** The overlap flags that a board row shows as a chip: only the same files. */
export type ChipKind = Extract<FlagKind, 'same-files'>

/** The chip of each overlap flag that a board row shows. */
export const FLAG_CHIP: Readonly<Record<ChipKind, string>> = { 'same-files': 'same file' }

/** The heading of the repo group of the sessions that have no repo. */
export const NO_REPO = 'No repo'

const CHIP_KINDS: readonly ChipKind[] = ['same-files']
const SESSION_UNIT = ['session', 'sessions'] as const
/** the name column: at least this many cells when a name needs it, NAME_SHARE of the row at most, and never more than NAME_MAX */
const NAME_MIN = 6
const NAME_MAX = 40
const NAME_SHARE = 0.6
/**
 * The cells of a row that the name column leaves while a shown row has a chip: the mark, the glyph and its space,
 * the space and the time (4 cells at most), then the space and the chip, the 2 spaces and a cut mark of the summary
 * for up to 999 cut characters (`…+999`). So a long name does not push the chip into the cut count. A name keeps
 * CHIP_NAME_MIN cells, so on a board of fewer than about 37 cells the chip can still go into the count.
 */
const CHIP_ROW_ROOM = 3 + 1 + 4 + 1 + cellWidth(FLAG_CHIP['same-files']) + 2 + 5
const CHIP_NAME_MIN = 12
/** the fewest lines that a window needs: the count above, the selected row, the count below */
export const MIN_WINDOW_ROWS = 3

/** The keys of the count lines above and below the window: each is a row that a press moves past the window. */
export const MORE_KEYS = { up: 'more-up', down: 'more-down' } as const

/** The key that presses a count line, as its line names it. */
const PRESS_KEY = 'Enter'

/** The board column and, for each count line, the key of the row that a press on it selects. */
export type BoardWindow = { lines: Line[]; more: Readonly<Record<string, string>> }

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
  /** the motion frame of the draw; absent, the static frame */
  frame?: MotionFrame
}

/** The time since `since`: `now` under 1 min, then `12m`, `3h`, `9d` (999d at most), in 4 cells or less. */
export function levelTime(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.min(999, Math.floor(minutes / (24 * 60)))}d`
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

/** The chips of the flags of 1 session, each kind once, in the chip order. */
const chipKinds = (session: GodSession): ChipKind[] => CHIP_KINDS.filter((kind) => session.flags.some((flag) => flag.kind === kind))

function sessionLine(session: GodSession, input: BoardViewInput, nameColumn: number): Line {
  const time = levelTime(session.levelSince, input.now)
  const middleRoom = input.width - 4 - cellWidth(time)
  const name = rowName(session)
  const shownName = cutInline(name, nameColumn) ?? name
  const summary = flat(session.summary) === name ? '' : flat(session.summary)
  const pulse = session.level === 'needs-you' && input.frame?.isPulseOn === true ? { ...LEVEL_PAINT[session.level], bold: true } : {}
  const glyph = session.level === 'working' && input.frame !== undefined ? spinnerGlyph(input.frame) : LEVEL_GLYPH[session.level]
  const parts: Part[] = [{ segment: { text: shownName, ...pulse } }]
  if (cellWidth(shownName) < nameColumn) parts.push({ segment: { text: ' '.repeat(nameColumn - cellWidth(shownName)) } })
  for (const kind of chipKinds(session)) parts.push({ segment: { text: ' ' } }, { segment: { text: FLAG_CHIP[kind], ...FLAG_PAINT[kind] }, isWhole: true })
  if (summary !== '') parts.push({ segment: { text: '  ' } }, { segment: { text: summary } })
  const middle = fitSegments(parts, middleRoom)
  const fill = middleRoom - middle.reduce((sum, segment) => sum + cellWidth(segment.text), 0)
  return {
    key: session.sessionId,
    segments: [
      mark(input.selectedKey === session.sessionId),
      { text: glyph, ...LEVEL_PAINT[session.level], ...pulse },
      { text: ' ' },
      ...middle,
      { text: ' '.repeat(fill + 1) },
      { text: time, ...DIM },
    ],
  }
}

/**
 * The lines that fit `rows`, with the selected line in view and a count line for each side that it leaves out.
 * A count line is keyed when a hidden row on its side has a key: the nearest one is its target.
 */
function windowOf(items: readonly Item[], rows: number, selected: number): BoardWindow {
  if (items.length <= rows) return { lines: items.map((item) => item.line), more: {} }
  const room = Math.max(MIN_WINDOW_ROWS, rows)
  const sessions = (from: number, to: number): number => items.slice(from, to).reduce((sum, item) => sum + item.sessions, 0)
  const more: Record<string, string> = {}
  const countLine = (count: number, key: string, hidden: readonly Item[]): Line => {
    const target = hidden.find((item) => item.line.key !== undefined)?.line.key
    if (target !== undefined) more[key] = target
    return { ...(target === undefined ? {} : { key }), segments: [{ text: ' ' }, { text: moreText(count, SESSION_UNIT, PRESS_KEY), ...DIM }] }
  }
  let start = 0
  let end = room - 1
  if (selected >= end) {
    end = selected + 1
    start = end - (room - 1 - (end < items.length ? 1 : 0))
    // a count line for a heading alone would count 0 sessions: show the heading in its place
    if (start === 1 && items[0]!.sessions === 0) start = 0
  }
  const lines = [
    ...(start > 0 ? [countLine(sessions(0, start), MORE_KEYS.up, items.slice(0, start).reverse())] : []),
    ...items.slice(start, end).map((item) => item.line),
    ...(end < items.length ? [countLine(sessions(end, items.length), MORE_KEYS.down, items.slice(end))] : []),
  ]
  return { lines, more }
}

/** The lines of the board column. */
export function boardLines(input: BoardViewInput): Line[] {
  return boardWindow(input).lines
}

/** The lines of the board column, and the row that a press on each count line selects. */
export function boardWindow(input: BoardViewInput): BoardWindow {
  const { snapshot, width } = input
  const byId = new Map(snapshot.sessions.map((session) => [session.sessionId, session]))
  const shown = snapshot.groups.map((group) => ({
    group,
    sessions: isOpen(group, input.openGroups) ? group.sessionIds.flatMap((id) => byId.get(id) ?? []) : [],
  }))
  const rows = shown.flatMap(({ sessions }) => sessions)
  const longest = Math.max(0, ...rows.map((session) => cellWidth(rowName(session))))
  const share = Math.floor((width - 3) * NAME_SHARE)
  const room = rows.some((session) => chipKinds(session).length > 0) ? Math.min(share, Math.max(CHIP_NAME_MIN, width - CHIP_ROW_ROOM)) : share
  const nameColumn = Math.min(longest, NAME_MAX, Math.max(NAME_MIN, room))
  const items: Item[] = shown.flatMap(({ group, sessions }) => [headingItem(group, input), ...sessions.map((session) => ({ line: sessionLine(session, input, nameColumn), sessions: 1 }))])
  const selected = items.findIndex((item) => item.line.key !== undefined && item.line.key === input.selectedKey)
  return windowOf(items, input.rows, Math.max(0, selected))
}
