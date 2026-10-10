/**
 * The window over lines that do not fit their rows: the detail scrolls its tab content in it, and the confirm bar
 * scrolls a long prompt or tool input in it. It never cuts in silence: a count line above names the key that shows
 * the lines that it leaves out and their count (`w: +N lines`), and a count line below does the same (`z: +N
 * lines`). Each count is 1 key that 1 Button presses, so it shows in the form that the engine paints the Button.
 */
import { DIM } from '../ui/theme.js'
import { countText } from './cut.js'
import { pressSegment } from './keys.js'
import type { Line } from './types.js'

/** The key that shows the lines above the window, and the key that shows the lines below it. */
export const SCROLL_KEYS = { up: 'w', down: 'z' } as const

/** The fewest rows of a window over lines that do not fit: the count above, 1 line, the count below. */
export const MIN_WINDOW = 3

const LINE_UNIT = ['line', 'lines'] as const

/** The window: its first line, the lines it shows, all lines, and the lines of 1 page. */
export type ScrollWindow = { first: number; shown: number; total: number; page: number }

/** The scroll after 1 press of the up or the down key: the next page down, or the page above (the top near it). */
export function scrollBy(window: ScrollWindow, direction: 'up' | 'down'): number {
  if (direction === 'down') return window.first + window.shown
  const first = window.first - window.page
  return first <= 1 ? 0 : first
}

/** The lines that fit `room`, from `scroll`, with a count line for each side that the window leaves out. */
export function windowOf(lines: readonly Line[], room: number, scroll: number): { lines: Line[]; window: ScrollWindow } {
  const total = lines.length
  const page = Math.max(1, room - 2)
  if (total <= room) return { lines: [...lines], window: { first: 0, shown: total, total, page } }
  const first = Math.min(Math.max(0, Number.isFinite(scroll) ? Math.floor(scroll) : 0), total - (room - 1))
  const top = first > 0 ? 1 : 0
  const hasBottom = first + room - top < total
  const shown = room - top - (hasBottom ? 1 : 0)
  const count = (hidden: number, key: string): Line => ({ segments: [{ text: ' ' }, { ...pressSegment(key, countText(hidden, LINE_UNIT)), ...DIM }] })
  return {
    lines: [...(top > 0 ? [count(first, SCROLL_KEYS.up)] : []), ...lines.slice(first, first + shown), ...(hasBottom ? [count(total - first - shown, SCROLL_KEYS.down)] : [])],
    window: { first, shown, total, page },
  }
}
