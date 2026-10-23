/**
 * Serve only: the queue card of the Overview. It has the look of the harness card (screens/harness.ts) and is 1 link
 * to the Improvements screen. The counts come from the queue read. The title leaves out each count of 0, and it shows
 * no ratio. Only serve-ui.ts imports this file, so the file bundles carry none of it.
 */
import { esc, num } from './format.js'
import type { QueueRead } from './queue-types.js'

/** The title and the hint of the card for a read: undefined while it runs, null when it failed. */
export function queueCardText(q: QueueRead | null | undefined): { title: string; hint: string } {
  if (q === undefined) return { title: 'Improvements', hint: 'orangu counts the queue.' }
  if (q === null) return { title: 'orangu could not compute the queue', hint: 'Open Improvements to see the reason →' }
  const c = q.counts
  if (!c.open) return { title: 'Your queue is empty', hint: 'Open Improvements →' }
  const parts = [c.due ? `${num(c.due)} due` : '', c.regressed ? `${num(c.regressed)} regressed` : '', c.apply ? `${num(c.apply)} to apply` : ''].filter(Boolean)
  return { title: `Improvements: ${parts.length ? parts.join(', ') : `${num(c.open)} open, nothing due`}`, hint: 'Open the queue →' }
}

/** The card. `href` is the Improvements route built by cleanHash; `cls` is `mb16` when the card stands alone. */
export function queueCardHtml(q: QueueRead | null | undefined, href: string, cls = ''): string {
  const { title, hint } = queueCardText(q)
  return `<a class="card pad${cls ? ` ${cls}` : ''} harness-card" href="${esc(href)}"${q === undefined ? ' aria-busy="true"' : ''}><div class="eyebrow">Queue</div><div class="card-title" style="margin:2px 0">${esc(title)}</div><div class="small muted">${esc(hint)}</div></a>`
}
