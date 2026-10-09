/**
 * The header of the god pane, as items that flow into lines of the pane width (no item is cut):
 * - the brand: the mark in the accent color and `orangu god`;
 * - the live count: every live session but the god session, whatever the mode;
 * - the glyph and the count of each level that wants a look (needs you, your turn, stuck, working), from the same
 *   sessions as the live count. A level with no session shows nothing;
 * - the mode: `all`, or `repos:` and each stored repo name as its own item. The names show whole or not at all.
 *   When they do not all fit 1 line, the names that fit come first, then `+N repos (/god repos)`: the count of
 *   the names left out and the command that prints them all;
 * - a dim chip for each source whose last read failed (`agents off`). A source that is not on the machine (no cmux)
 *   gets no chip: the key row says what it turns off;
 * - the age of the facts in the warn color once they are more than 10 s old (`old 12s`).
 * Before the first refresh ends, the header shows the brand only. The clock comes in as `now`.
 */
import { ACCENT, DIM, LEVEL_PAINT, OLD_FACTS } from '../ui/theme.js'
import type { BoardSnapshot, Level, SourceName } from '../types.js'
import { LEVEL_GLYPH } from './board.js'
import { cellWidth, flowItems } from './cells.js'
import { moreText } from './cut.js'
import type { Line, Segment } from './types.js'

/** The levels whose count the header shows. */
export const HEADER_LEVELS: readonly Level[] = ['needs-you', 'your-turn', 'stuck', 'working']

/** Facts are old after this many milliseconds. */
export const OLD_AFTER_MS = 10_000

const SOURCES: readonly SourceName[] = ['agents', 'registry', 'cmux', 'git']

const BRAND: readonly Segment[] = [{ text: '◉', ...ACCENT }, { text: ' orangu god', bold: true }]

/** The command that prints every stored repo name: the key to the names that the header leaves out. */
export const REPOS_KEY = '/god repos'

const REPO_UNIT = ['repo', 'repos'] as const

/** What the header reads. */
export type HeaderInput = {
  /** absent before the first snapshot */
  snapshot?: BoardSnapshot
  width: number
  now: number
}

/** An age as `12s`, `3m`, `2h` or `1d`. */
function age(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** The items of the mode. The label, the names and the count of the rest fit 1 line of `width`. */
function modeItems(snapshot: BoardSnapshot, width: number): Segment[][] {
  if (snapshot.mode === 'all') return [[{ text: 'all' }]]
  const names = snapshot.repos.map((name) => name.replace(/\s+/g, ' ').trim()).filter((name) => name !== '')
  if (names.length === 0) return [[{ text: 'repos: none' }]]
  const label = 'repos:'
  const room = width - 1
  const all = names.reduce((sum, name) => sum + 2 + cellWidth(name), cellWidth(label))
  const reserve = all <= room ? 0 : 2 + cellWidth(moreText(names.length, REPO_UNIT, REPOS_KEY))
  const kept: string[] = []
  let used = cellWidth(label)
  for (const name of names) {
    if (used + 2 + cellWidth(name) > room - reserve) continue
    kept.push(name)
    used += 2 + cellWidth(name)
  }
  const left = names.length - kept.length
  return [[{ text: label }], ...kept.map((name) => [{ text: name }]), ...(left > 0 ? [[{ text: moreText(left, REPO_UNIT, REPOS_KEY), ...DIM }]] : [])]
}

/** The lines of the header. */
export function headerLines(input: HeaderInput): Line[] {
  const { snapshot, width, now } = input
  if (snapshot === undefined || !snapshot.firstRefreshDone) return flowItems([BRAND], width)
  const items: Segment[][] = [[...BRAND], [{ text: `${snapshot.sessions.length} live` }]]
  for (const level of HEADER_LEVELS) {
    const count = snapshot.sessions.filter((session) => session.level === level).length
    if (count > 0) items.push([{ text: LEVEL_GLYPH[level], ...LEVEL_PAINT[level] }, { text: ` ${count}` }])
  }
  items.push(...modeItems(snapshot, width))
  for (const source of SOURCES) if (snapshot.sources[source].status === 'off') items.push([{ text: `${source} off`, ...DIM }])
  if (snapshot.factsAt !== undefined && now - snapshot.factsAt > OLD_AFTER_MS) items.push([{ text: `old ${age(now - snapshot.factsAt)}`, ...OLD_FACTS }])
  return flowItems(items, width)
}
