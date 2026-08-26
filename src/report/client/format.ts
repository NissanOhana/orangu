// Formatting helpers shared by the client renderer. Deterministic, locale-independent.
export function tok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'k'
  return String(Math.round(n))
}
export function ms(v: number | undefined): string {
  if (v === undefined || !isFinite(v)) return '–'
  if (v < 1000) return Math.round(v) + 'ms'
  const s = v / 1000
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + Math.round(s % 60) + 's'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}
export function pct(n: number, digits = 0): string {
  return (n * 100).toFixed(digits) + '%'
}
export function num(n: number): string {
  return n.toLocaleString('en-US')
}
export function ts(v: number | undefined): string {
  if (v === undefined) return '–'
  const d = new Date(v)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}
export function timeOnly(v: number | undefined): string {
  if (v === undefined) return '--:--:--'
  return new Date(v).toISOString().slice(11, 19)
}
export function bytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + ' KB'
  return n + ' B'
}
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
export const CAT_LABEL: Record<string, string> = {
  read: 'Read',
  search: 'Search',
  edit: 'Edit',
  write: 'Write',
  exec: 'Shell',
  agent: 'Agents',
  skill: 'Skills',
  web: 'Web',
  plan: 'Plan',
  ask: 'Ask',
  mcp: 'MCP',
  task: 'Tasks',
  notebook: 'Notebook',
  other: 'Other',
}
const CAT_TOKENS = ['read', 'search', 'edit', 'write', 'exec', 'agent', 'skill', 'web', 'other']
export function catColor(cat: string): string {
  return `var(--cat-${CAT_TOKENS.includes(cat) ? cat : 'other'}, var(--cat-other))`
}
