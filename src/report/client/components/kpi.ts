/** KPI tile (design 10px-radius card: uppercase label, mono value, hint). */
import { esc } from '../format.js'

export interface KpiOpts {
  /** value colour class: renders the value in --accent-ink */
  accent?: boolean
  /** hint colour class 'bad' */
  badHint?: boolean
  /** Live tiles render the value at 22px */
  big?: boolean
  /** skeleton tile (connecting state) */
  skeleton?: boolean
  /** trailing ~ marker for derived (not reported) values (title carries the explanation) */
  estimated?: boolean
  title?: string
}

export function kpi(label: string, value: string, hint = '', o: KpiOpts = {}): string {
  const est = o.estimated ? '<span class="est" title="estimated: derived from bytes, not reported by the API">~</span>' : ''
  return `<div class="kpi${o.big ? ' big' : ''}${o.skeleton ? ' skel' : ''}"${o.title ? ` title="${esc(o.title)}"` : ''}>
    <div class="label">${esc(label)}</div>
    <div class="val${o.accent ? ' accent' : ''}">${o.skeleton ? '···' : esc(value) + est}</div>
    ${hint ? `<div class="hint${o.badHint ? ' bad' : ''}">${esc(hint)}</div>` : ''}
  </div>`
}
