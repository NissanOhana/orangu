/** Chips: filter chips (28px min target) and the Overview quality-signal chips. */
import type { QualitySignal } from '../../../model/analysis.js'
import { esc } from '../format.js'

export interface ChipOpts {
  active?: boolean
  disabled?: boolean
  title?: string
  /** removable cross-filter chip */
  removable?: boolean
  data?: Record<string, string>
}

export function chip(label: string, o: ChipOpts = {}): string {
  const data = Object.entries(o.data ?? {})
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('')
  const cls = 'chip' + (o.active ? ' active' : '')
  const dis = o.disabled ? ' aria-disabled="true" tabindex="-1"' : ''
  const x = o.removable ? '<button class="x" aria-label="remove filter">×</button>' : ''
  return `<button type="button" class="${cls}"${dis}${o.title ? ` title="${esc(o.title)}"` : ''}${data}>${esc(label)}${x}</button>`
}

/** One pill per quality signal; zero-valued signals STAY visible. */
export function signalChips(signals: QualitySignal[]): string {
  return `<div class="chiprow" style="margin-bottom:16px">${signals
    .map((s) => `<span class="sigchip">${esc(s.label)} <b class="${esc(s.tone)}"${s.detail ? ` title="${esc(s.detail)}"` : ''}>${esc(String(s.value))}</b></span>`)
    .join('')}</div>`
}
