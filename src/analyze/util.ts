import type { Usage } from '../model/session.js'
import { emptyUsage, addUsage } from '../model/session.js'

export function sum(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x
  return s
}
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const a = [...xs].sort((x, y) => x - y)
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))
  return a[idx] as number
}
export function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}
/**
 * "How many tokens" has exactly one definition in the product: `usageTotal` in the session model,
 * everything the model read plus everything it wrote. Re-exported under the name the analyzer and the
 * rules use so there is never a second copy of the formula to drift.
 */
export { usageTotal as totalTokens } from '../model/session.js'
export function sumUsage(list: Usage[]): Usage {
  let u = emptyUsage()
  for (const x of list) u = addUsage(u, x)
  return u
}
export function shortPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
  return p
}
export function topN<T>(xs: T[], n: number, key: (x: T) => number): T[] {
  return [...xs].sort((a, b) => key(b) - key(a)).slice(0, n)
}
export function fmtTokens(n: number): string {
  // the B tier mirrors tok() in src/report/client/format.ts so fleet-wide totals never print as "1180.16M"
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}
export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "–"
  if (!Number.isFinite(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
