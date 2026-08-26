// Hand-rolled inline-SVG charts. No dependencies. One <path> per series where possible.
import { esc } from './format.js'

const NS = 'http://www.w3.org/2000/svg'

export interface StackSeg {
  value: number
  color: string
  label: string
}

/** Horizontal proportional bar of segments (token stack, cost split). */
export function stackedBar(segs: StackSeg[], opts: { height?: number; title?: string } = {}): string {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1
  const h = opts.height ?? 14
  let x = 0
  const parts = segs
    .filter((s) => s.value > 0)
    .map((s) => {
      const w = (s.value / total) * 100
      const seg = `<rect x="${x}%" y="0" width="${w}%" height="${h}" fill="${s.color}"><title>${esc(s.label)}</title></rect>`
      x += w
      return seg
    })
    .join('')
  return `<svg width="100%" height="${h}" viewBox="0 0 100 ${h}" preserveAspectRatio="none" role="img"${opts.title ? ` aria-label="${esc(opts.title)}"` : ''}>${parts}</svg>`
}

export interface AreaPoint {
  x: number
  y: number
}

/**
 * Multi-series stacked area over an index axis (context growth). Emits ONE path per series.
 * series[i] is an array of y-values aligned to the same x indices (0..n-1).
 */
export function stackedArea(
  seriesValues: number[][],
  colors: string[],
  opts: { width?: number; height?: number; markers?: Array<{ x: number; label: string; color?: string }>; labels?: string[]; yMaxOverride?: number } = {},
): string {
  const w = opts.width ?? 720
  const h = opts.height ?? 160
  const pad = { l: 4, r: 4, t: 8, b: 16 }
  const n = seriesValues[0]?.length ?? 0
  if (n === 0) return `<div class="chart-empty">no data points yet</div>`
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  // cumulative stacks
  const cum: number[] = new Array(n).fill(0)
  let yMax = 0
  for (const s of seriesValues) for (let i = 0; i < n; i++) yMax = Math.max(yMax, cum[i]! + (s[i] ?? 0))
  const stackTotals = new Array(n).fill(0)
  for (const s of seriesValues) for (let i = 0; i < n; i++) stackTotals[i]! += s[i] ?? 0
  yMax = opts.yMaxOverride ?? Math.max(...stackTotals, 1)
  const xAt = (i: number) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
  const yAt = (v: number) => pad.t + ih - (v / yMax) * ih
  const base = new Array(n).fill(0)
  const paths: string[] = []
  seriesValues.forEach((s, si) => {
    const top = s.map((v, i) => base[i]! + (v ?? 0))
    let d = `M ${xAt(0).toFixed(1)} ${yAt(base[0]!).toFixed(1)}`
    for (let i = 0; i < n; i++) d += ` L ${xAt(i).toFixed(1)} ${yAt(top[i]!).toFixed(1)}`
    for (let i = n - 1; i >= 0; i--) d += ` L ${xAt(i).toFixed(1)} ${yAt(base[i]!).toFixed(1)}`
    d += ' Z'
    paths.push(`<path d="${d}" fill="${colors[si] ?? 'var(--cat-other)'}" opacity="0.85"><title>${esc(opts.labels?.[si] ?? '')}</title></path>`)
    for (let i = 0; i < n; i++) base[i] = top[i]!
  })
  const markers = (opts.markers ?? [])
    .map((m) => {
      const x = xAt(m.x)
      return `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${pad.t + ih}" stroke="${m.color ?? 'var(--bad)'}" stroke-width="1.5" stroke-dasharray="3 2"><title>${esc(m.label)}</title></line>`
    })
    .join('')
  const axis = `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}" stroke="var(--border2)" stroke-width="1"/>`
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-label="stacked area">${paths.join('')}${markers}${axis}</svg>`
}

/** Line chart for a single series with optional threshold, markers, and y-axis tick labels. */
export function lineChart(values: number[], opts: { width?: number; height?: number; color?: string; threshold?: { y: number; label: string }; markers?: Array<{ x: number; label: string }>; yMax?: number; fmtY?: (v: number) => string } = {}): string {
  const w = opts.width ?? 720
  const h = opts.height ?? 150
  const pad = { l: 4, r: 4, t: 8, b: 14 }
  const n = values.length
  if (!n) return `<div class="chart-empty">no data points yet</div>`
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const yMax = opts.yMax ?? Math.max(...values, 1)
  const xAt = (i: number) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
  const yAt = (v: number) => pad.t + ih - (v / yMax) * ih
  let d = ''
  values.forEach((v, i) => {
    d += (i === 0 ? 'M' : 'L') + ' ' + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1) + ' '
  })
  const color = opts.color ?? 'var(--accent-ink)'
  const thr = opts.threshold
    ? `<line x1="${pad.l}" y1="${yAt(opts.threshold.y).toFixed(1)}" x2="${pad.l + iw}" y2="${yAt(opts.threshold.y).toFixed(1)}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 3"><title>${esc(opts.threshold.label)}</title></line>`
    : ''
  const markers = (opts.markers ?? [])
    .map((m) => `<line x1="${xAt(m.x).toFixed(1)}" y1="${pad.t}" x2="${xAt(m.x).toFixed(1)}" y2="${pad.t + ih}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 2"><title>${esc(m.label)}</title></line>`)
    .join('')
  const fy = opts.fmtY
  const ticks = fy
    ? `<text x="${pad.l + 2}" y="${pad.t + 8}" font-size="9" fill="var(--ink3)" font-family="var(--mono)">${esc(fy(yMax))}</text><text x="${pad.l + 2}" y="${pad.t + ih - 3}" font-size="9" fill="var(--ink3)" font-family="var(--mono)">${esc(fy(0))}</text>`
    : ''
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-label="line chart">${thr}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${markers}<line x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}" stroke="var(--border2)"/><line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}" stroke="var(--border2)"/>${ticks}</svg>`
}

/** Gantt-style capsules for agent swimlanes. rows: {t0,t1,label,color,depth}. */
export function ganttRow(t0: number, t1: number, min: number, max: number, color: string, title: string): string {
  const span = max - min || 1
  const x = ((t0 - min) / span) * 100
  const w = Math.max(0.6, ((t1 - t0) / span) * 100)
  return `<svg width="100%" height="14" viewBox="0 0 100 14" preserveAspectRatio="none"><rect x="${x.toFixed(2)}" y="3" width="${w.toFixed(2)}" height="8" rx="3" fill="${color}"><title>${esc(title)}</title></rect></svg>`
}

/** A donut is overkill; a simple category bar list is clearer. Returns rows of proportional bars. */
export function proportionRows(items: Array<{ label: string; value: number; color: string; sub?: string }>, fmt: (v: number) => string): string {
  const max = Math.max(...items.map((i) => i.value), 1)
  return items
    .map(
      (i) => `<div class="proprow" style="display:grid;grid-template-columns:130px 1fr 72px;gap:10px;align-items:center;padding:3px 0">
      <div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.label)}${i.sub ? ` <span class="muted">${esc(i.sub)}</span>` : ''}</div>
      <span class="trough"><i style="width:${((i.value / max) * 100).toFixed(1)}%;background:${i.color}"></i></span>
      <div class="right mono small">${esc(fmt(i.value))}</div>
    </div>`,
    )
    .join('')
}

export { NS }
