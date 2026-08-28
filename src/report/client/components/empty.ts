/** Designed empty states: never a blank screen or blank SVG. */
import { esc } from '../format.js'
import { mascotSvg } from '../mascot.js'
import { commandBlock } from './command.js'
import { h } from '../dom.js'

export interface EmptyOpts {
  title: string
  hint?: string
  /** copyable command shown in a --cmd block (e.g. the orangu serve command, policy) */
  command?: string
  mascotSize?: number
}

export function emptyHero(o: EmptyOpts): string {
  return `<div class="card"><div class="empty-hero">
${mascotSvg(o.mascotSize ?? 48)}
<div class="t">${esc(o.title)}</div>
${o.hint ? `<div class="s">${esc(o.hint)}</div>` : ''}
${o.command ? commandBlock(o.command) : ''}
</div></div>`
}

/** small in-card empty row */
export function emptyNote(text: string): string {
  return `<div class="chart-empty">${esc(text)}</div>`
}

/** the session screens' shared guard: nothing selected (file mode always has one; serve mode may not yet) */
export function noSession(): HTMLElement {
  return h(`<section>${emptyHero({ title: 'No session selected.' })}</section>`)
}
