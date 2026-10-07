/**
 * The show-me fill: one built template and one page of values in, one HTML file out. It applies the slot rules
 * as code, so no model writes markup. plugin/skills/show-me/references/slots.md holds only the rules of the 3 values
 * that Claude writes in words.json.
 *
 * Every value reaches the HTML in one of 3 forms, and nothing else in src/show-me writes a value into the HTML:
 * - text: through escapeHtml only, so a value can make a text node and never markup (the node form of textContent)
 * - an attribute: through setAttr only, for the names in ATTRIBUTES, each value checked against its enum or as a
 *   finite number before the write
 * - a chart number: through chartNumber only, a finite number
 * Every `.replace` that inserts a value takes a replacer function: a replacement string would read `$&`, `` $` ``
 * and `$'` in the value as patterns and copy markup from around the match.
 */
import { ms, num, pct, tok, ts } from '../report/client/format.js'

/** Text, a raw number that the element's data-f formats, or null to delete the element (a missing source). */
export type SlotValue = string | { v: number } | null

/** The number formats of the templates (each element's data-f): the report's own formatters. */
export const FORMATS: Readonly<Record<string, (v: number) => string>> = {
  tok,
  ms,
  pct: (v) => pct(v),
  num,
  date: (v) => ts(v).slice(0, 10),
  time: (v) => ts(v),
}

/** The attributes on the copy of a repeated element: a finding's severity, or a turn marker's x. */
export interface ItemAttrs {
  'data-sev'?: string
  x?: number
}

/** The 4 attributes on `<html>`, each an enum. */
export interface RootAttrs {
  'data-scope': string
  'data-live': string
  'data-caution': string
  'data-redacted': string
}

/** One scope of values: the page, or one item of a data-repeat list. */
export interface Scope {
  slots: Record<string, SlotValue>
  conditions: string[]
  lists: Record<string, Item[]>
  charts: Record<string, Chart>
  /** how the session ended: the value of each `data-end` element (the quality card) */
  end?: string
}
export interface Item extends Partial<Omit<Scope, 'end'>> {
  attrs?: ItemAttrs
}
export type Chart =
  | { kind: 'bars'; values: Record<string, number>; label: string }
  | { kind: 'ring'; value: number; of: number; label: string }
  | { kind: 'turns'; turns: number; label: string }

export interface Page extends Scope {
  root: RootAttrs
}

/**
 * The attributes that the fill may set, and the check on each value. No attribute value comes from the words
 * or from transcript text: an enum is a fixed word, and a number is finite.
 */
const ENUM_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  'data-scope': ['session', 'repo', 'global'],
  'data-live': ['true', 'false'],
  'data-caution': ['true', 'false'],
  'data-redacted': ['true', 'false'],
  'data-end': ['clean', 'failing', 'interrupted', 'unknown'],
  'data-sev': ['info', 'low', 'medium', 'high'],
}
const NUMBER_ATTRIBUTES: Readonly<Record<string, (v: number) => boolean>> = {
  'data-v': Number.isFinite,
  // a turn marker's position: a turn index
  x: (v) => Number.isSafeInteger(v) && v >= 0,
}
/** every attribute name that setAttr writes */
export const ATTRIBUTES: readonly string[] = [...Object.keys(ENUM_ATTRIBUTES), ...Object.keys(NUMBER_ATTRIBUTES)]

/** A value that the fill refuses: a name outside ATTRIBUTES, a word outside its enum, or a number that is not finite. */
export class FillError extends Error {
  override readonly name = 'FillError'
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const DIRECTIVE = /<([a-zA-Z][\w-]*)\b[^>]*\bdata-(?:repeat|empty|if|chart|slot|end)="[^"]*"[^>]*>/g
const ENTITY: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * The one text writer. It escapes `&`, `<`, `>`, `"` and `'`, so a value is a text node or an attribute value and
 * never markup. It also writes the colon of an http or https scheme as `&#58;`: a reader sees the same URL, and the
 * file holds no URL scheme that the offline gate (scripts/assert-offline.mjs, which reads the whole file) or a
 * link finder could take for a request.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITY[char]!).replace(/(https?):/gi, (_match, scheme: string) => `${scheme}&#58;`)
}

/** The value of one attribute, checked: the only way a value reaches an attribute. */
function attributeValue(name: string, value: string | number): string {
  const allowed = ENUM_ATTRIBUTES[name]
  if (allowed) {
    if (typeof value !== 'string' || !allowed.includes(value)) throw new FillError(`${name} must be one of ${allowed.join(', ')}`)
    return value
  }
  const valid = NUMBER_ATTRIBUTES[name]
  if (valid) {
    if (typeof value !== 'number' || !valid(value)) throw new FillError(`${name} must be a finite number`)
    return String(value)
  }
  throw new FillError(`the fill sets no ${name} attribute`)
}

/** A number for a chart attribute or style: finite and not negative, else the fill stops. */
function chartNumber(value: number, what: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new FillError(`${what} must be a finite number, 0 or more`)
  return String(value)
}

/** The index just past the element that opens at `start`, matching nested tags of the same name. */
function elementEnd(html: string, start: number): number {
  const open = /^<([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/.exec(html.slice(start))
  if (!open) throw new FillError(`no tag at ${start}`)
  const tag = open[1]!.toLowerCase()
  if (open[2] || VOID.has(tag)) return start + open[0].length
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi')
  re.lastIndex = start + open[0].length
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth -= 1
    else if (!m[2]) depth += 1
    if (depth === 0) return re.lastIndex
  }
  throw new FillError(`unclosed <${tag}> at ${start}`)
}

const openTagOf = (el: string): string => /^<[^>]*>/.exec(el)![0]
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** Set one attribute on the open tag of `el`. The name must be in ATTRIBUTES, and the value passes its check first. */
function setAttr(el: string, name: string, value: string | number): string {
  const checked = attributeValue(name, value)
  const open = openTagOf(el)
  const next = attr(open, name) !== undefined
    ? open.replace(new RegExp(`(\\s${name}=)"[^"]*"`), (_match, before: string) => `${before}"${checked}"`)
    : open.replace(/(\/?>)$/, (end: string) => ` ${name}="${checked}"${end}`)
  return next + el.slice(open.length)
}

/** Split an element into its open tag, its children and its close tag. */
function parts(el: string): [string, string, string] {
  const open = openTagOf(el)
  if (open.endsWith('/>') || el.length === open.length) return [open, '', '']
  const close = /<\/[a-zA-Z][\w-]*>$/.exec(el)![0]
  return [open, el.slice(open.length, el.length - close.length), close]
}

function children(html: string, scope: Scope): string {
  let out = ''
  let at = 0
  for (;;) {
    DIRECTIVE.lastIndex = at
    const m = DIRECTIVE.exec(html)
    if (!m) return out + html.slice(at)
    const end = elementEnd(html, m.index)
    out += html.slice(at, m.index) + element(html.slice(m.index, end), scope)
    at = end
  }
}

function merge(scope: Scope, item: Item): Scope {
  return {
    slots: { ...scope.slots, ...item.slots },
    conditions: [...scope.conditions, ...(item.conditions ?? [])],
    lists: { ...scope.lists, ...item.lists },
    charts: { ...scope.charts, ...item.charts },
    ...(scope.end !== undefined ? { end: scope.end } : {}),
  }
}

function element(el: string, scope: Scope, repeated = false): string {
  const repeat = attr(openTagOf(el), 'data-repeat')
  if (repeat !== undefined && !repeated) {
    const max = Number(attr(openTagOf(el), 'data-max') ?? Infinity)
    return (scope.lists[repeat] ?? []).slice(0, max).map((item) => {
      let copy = el
      if (item.attrs?.['data-sev'] !== undefined) copy = setAttr(copy, 'data-sev', item.attrs['data-sev'])
      if (item.attrs?.x !== undefined) copy = setAttr(copy, 'x', item.attrs.x)
      return element(copy, merge(scope, item), true)
    }).join('')
  }
  const open = openTagOf(el)
  const empty = attr(open, 'data-empty')
  if (empty !== undefined && (scope.lists[empty] ?? []).length > 0) return ''
  const condition = attr(open, 'data-if')
  if (condition !== undefined && !scope.conditions.includes(condition)) return ''
  if (attr(open, 'data-end') !== undefined && scope.end !== undefined) el = setAttr(el, 'data-end', scope.end)
  const chart = attr(open, 'data-chart')
  if (chart !== undefined && scope.charts[chart]) el = drawChart(el, scope.charts[chart]!)
  const slot = attr(open, 'data-slot')
  if (slot !== undefined && scope.slots[slot] !== undefined) return fillSlot(el, scope.slots[slot]!)
  const [head, inner, tail] = parts(el)
  return head + children(inner, scope) + tail
}

function fillSlot(el: string, value: SlotValue): string {
  if (value === null) return ''
  const [head, inner, tail] = parts(el)
  if (/</.test(inner)) throw new FillError(`a data-slot element holds only text: ${head}`)
  if (typeof value === 'string') return head + escapeHtml(value) + tail
  const format = FORMATS[attr(head, 'data-f') ?? '']
  if (!format) throw new FillError(`a number slot needs a data-f format: ${head}`)
  return setAttr(head, 'data-v', value.v) + escapeHtml(format(value.v)) + tail
}

/** The keys of a bars chart are the data-k names of the template: a word, so a key never changes the pattern. */
const CHART_KEY = /^[a-z0-9]+$/

function drawChart(sample: string, chart: Chart): string {
  const el = sample.replace(/ data-sample(?:="[^"]*")?/, () => '')
  const label = (html: string): string => html.replace(/(<[^>]*\brole="img"[^>]*\baria-label=)"[^"]*"/, (_match, before: string) => `${before}"${escapeHtml(chart.label)}"`)
  if (chart.kind === 'bars') {
    let out = el
    for (const [key, value] of Object.entries(chart.values)) {
      if (!CHART_KEY.test(key)) throw new FillError('a bars chart key is one word')
      const n = chartNumber(value, `the ${key} bar`)
      out = value > 0
        ? out.replace(new RegExp(`(<i data-k="${key}" style=")--n:[^"]*"`), (_match, before: string) => `${before}--n:${n}"`)
        : out.replace(new RegExp(`<i data-k="${key}"[^>]*></i>`), () => '').replace(new RegExp(`<span data-k="${key}">[^<]*</span>`), () => '')
    }
    return label(out)
  }
  if (chart.kind === 'ring') {
    const of = chartNumber(chart.of, 'the ring total')
    const value = chartNumber(chart.value, 'the ring value')
    return label(el.replaceAll(/pathLength="[^"]*"/g, () => `pathLength="${of}"`).replace(/stroke-dasharray="[^"]*"/, () => `stroke-dasharray="${value} ${of}"`))
  }
  const turns = chartNumber(chart.turns, 'the turn count')
  return label(el.replace(/viewBox="0 0 [^ ]+ 1"/, () => `viewBox="0 0 ${turns} 1"`).replace(/(<rect class="trk" width=)"[^"]*"/, (_match, before: string) => `${before}"${turns}"`))
}

/** Fill one built template from a page of values. */
export function fillTemplate(html: string, page: Page): string {
  let out = html
  for (const name of ['data-scope', 'data-live', 'data-caution', 'data-redacted'] as const) {
    out = out.replace(/<html\b[^>]*>/, (tag) => setAttr(tag, name, page.root[name]))
  }
  const at = out.indexOf('<html')
  const end = out.indexOf('</html>') + '</html>'.length
  const scope: Scope = { slots: page.slots, conditions: page.conditions, lists: page.lists, charts: page.charts, ...(page.end !== undefined ? { end: page.end } : {}) }
  // the <title> and the body both carry slots; walk the document once
  return out.slice(0, at) + children(out.slice(at, end), scope) + out.slice(end)
}
