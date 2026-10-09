/**
 * The header of the god pane, as items that flow into lines of the pane width (no item is cut):
 * - the brand: the mark in the accent color and `orangu god`;
 * - the live count: every live session but the god session, whatever the mode;
 * - the glyph and the count of each level that wants a look (needs you, your turn, stuck, working), from the same
 *   sessions as the live count. A level with no session shows nothing;
 * - the mode: `all`, or `repos:` and the stored repo names;
 * - a dim chip for each source whose last read failed (`agents off`). A source that is not on the machine (no cmux)
 *   gets no chip: the key row says what it turns off;
 * - the age of the facts in the warn color once they are more than 10 s old (`old 12s`).
 * Before the first refresh ends, the header shows the brand only. The clock comes in as `now`.
 */
import { ACCENT, DIM, LEVEL_PAINT, OLD_FACTS } from '../ui/theme.js'
import type { BoardSnapshot, Level, SourceName } from '../types.js'
import { LEVEL_GLYPH } from './board.js'
import { flowItems } from './cells.js'
import { cutInline } from './cut.js'
import type { Line, Segment } from './types.js'

/** The levels whose count the header shows. */
export const HEADER_LEVELS: readonly Level[] = ['needs-you', 'your-turn', 'stuck', 'working']

/** Facts are old after this many milliseconds. */
export const OLD_AFTER_MS = 10_000

const SOURCES: readonly SourceName[] = ['agents', 'registry', 'cmux', 'git']

const BRAND: readonly Segment[] = [{ text: '◉', ...ACCENT }, { text: ' orangu god', bold: true }]

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

function modeText(snapshot: BoardSnapshot, width: number): string {
  if (snapshot.mode === 'all') return 'all'
  const names = snapshot.repos.map((name) => name.replace(/\s+/g, ' ').trim()).join(', ')
  const text = `repos: ${names === '' ? 'none' : names}`
  return cutInline(text, width - 1) ?? text
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
  items.push([{ text: modeText(snapshot, width) }])
  for (const source of SOURCES) if (snapshot.sources[source].status === 'off') items.push([{ text: `${source} off`, ...DIM }])
  if (snapshot.factsAt !== undefined && now - snapshot.factsAt > OLD_AFTER_MS) items.push([{ text: `old ${age(now - snapshot.factsAt)}`, ...OLD_FACTS }])
  return flowItems(items, width)
}
