/** Banners: one-line info/warn strips. The degraded-parse banner appears on EVERY screen. */
import type { Analysis } from '../../../model/analysis.js'
import type { Audience } from '../strings.js'
import { esc, num } from '../format.js'

export function banner(kind: 'info' | 'warn', html: string): string {
  return `<div class="banner ${kind}">${html}</div>`
}

/** '' when the parse is clean. */
export function degradedBanner(a: Analysis, audience: Audience): string {
  const rec = a.parse.reconciliation
  const degraded = a.parse.badLines > 0 || !rec.ok
  if (!degraded) return ''
  if (audience === 'plain')
    return banner('warn', `Some of the transcript could not be read (${num(a.parse.badLines)} lines); the numbers may be low.`)
  const offPct = rec.matchesWithinPct.toFixed(2)
  return banner(
    'warn',
    `Parsed ${esc(num(a.parse.totalLines - a.parse.badLines))} of ${esc(num(a.parse.totalLines))} records · token totals off by ${esc(offPct)}% · <a href="#coverage">see Coverage</a>`,
  )
}
