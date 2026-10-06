/**
 * A deterministic stand-in for the fill step of /orangu:show-me. The skill fills its two templates by the
 * rules in plugin/skills/show-me/references/slots.md; this module applies the same rules in code, so a test
 * can prove that the slot contract is fillable and that a filled file stays offline, and so the reviewed
 * examples come from synthetic data through the same rules. It never writes the words a model writes: the
 * caller passes them in.
 */
import type { SlimAnalysis } from '../../src/suggest/slim.js'
import type { EvidenceBundle } from '../../src/suggest/evidence.js'
import { ms, num, pct, tok, ts } from '../../src/report/client/format.js'

/** Text, a raw number that the element's data-f formats, or null to delete the element (a missing source). */
export type SlotValue = string | { v: number } | null

/** The number formats of the templates: the report's own formatters (slots.md, Number formats). */
export const FORMATS: Readonly<Record<string, (v: number) => string>> = {
  tok,
  ms,
  pct: (v) => pct(v),
  num,
  date: (v) => ts(v).slice(0, 10),
  time: (v) => ts(v),
}

/** One scope of values: the page, or one item of a data-repeat list. */
export interface Scope {
  slots: Record<string, SlotValue>
  conditions: string[]
  lists: Record<string, Item[]>
  charts: Record<string, Chart>
}
export interface Item extends Partial<Scope> {
  /** attributes set on the copied element itself, such as data-sev or a turn marker's x */
  attrs?: Record<string, string>
}
export type Chart =
  | { kind: 'bars'; values: Record<string, number>; label: string }
  | { kind: 'ring'; value: number; of: number; label: string }
  | { kind: 'turns'; turns: number; label: string }

export interface Page extends Scope {
  root: Record<string, string>
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const DIRECTIVE = /<([a-zA-Z][\w-]*)\b[^>]*\bdata-(?:repeat|empty|if|chart|slot)="[^"]*"[^>]*>/g

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/** The index just past the element that opens at `start`, matching nested tags of the same name. */
function elementEnd(html: string, start: number): number {
  const open = /^<([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/.exec(html.slice(start))
  if (!open) throw new Error(`no tag at ${start}`)
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
  throw new Error(`unclosed <${tag}> at ${start}`)
}

const openTagOf = (el: string): string => /^<[^>]*>/.exec(el)![0]
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

function setAttr(el: string, name: string, value: string): string {
  const open = openTagOf(el)
  const next = attr(open, name) !== undefined
    ? open.replace(new RegExp(`(\\s${name}=)"[^"]*"`), `$1"${value}"`)
    : open.replace(/(\/?>)$/, ` ${name}="${value}"$1`)
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
  }
}

function element(el: string, scope: Scope, repeated = false): string {
  const open = openTagOf(el)
  const repeat = attr(open, 'data-repeat')
  if (repeat !== undefined && !repeated) {
    const max = Number(attr(open, 'data-max') ?? Infinity)
    return (scope.lists[repeat] ?? []).slice(0, max).map((item) => {
      let copy = el
      for (const [name, value] of Object.entries(item.attrs ?? {})) copy = setAttr(copy, name, value)
      return element(copy, merge(scope, item), true)
    }).join('')
  }
  const empty = attr(open, 'data-empty')
  if (empty !== undefined && (scope.lists[empty] ?? []).length > 0) return ''
  const condition = attr(open, 'data-if')
  if (condition !== undefined && !scope.conditions.includes(condition)) return ''
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
  if (/</.test(inner)) throw new Error(`a data-slot element holds only text: ${head}`)
  if (typeof value === 'string') return head + escapeHtml(value) + tail
  const format = FORMATS[attr(head, 'data-f') ?? '']
  if (!format) throw new Error(`a number slot needs a data-f format: ${head}`)
  return setAttr(head, 'data-v', String(value.v)) + escapeHtml(format(value.v)) + tail
}

function drawChart(sample: string, chart: Chart): string {
  const el = sample.replace(/ data-sample(?:="[^"]*")?/, '')
  const label = (html: string): string => html.replace(/(<[^>]*\brole="img"[^>]*\baria-label=)"[^"]*"/, `$1"${escapeHtml(chart.label)}"`)
  if (chart.kind === 'bars') {
    let out = el
    for (const [key, value] of Object.entries(chart.values)) {
      out = value > 0
        ? out.replace(new RegExp(`(<i data-k="${key}" style=")--n:[^"]*"`), `$1--n:${value}"`)
        : out.replace(new RegExp(`<i data-k="${key}"[^>]*></i>`), '').replace(new RegExp(`<span data-k="${key}">[^<]*</span>`), '')
    }
    return label(out)
  }
  if (chart.kind === 'ring') {
    return label(el.replaceAll(/pathLength="[^"]*"/g, `pathLength="${chart.of}"`).replace(/stroke-dasharray="[^"]*"/, `stroke-dasharray="${chart.value} ${chart.of}"`))
  }
  return label(el.replace(/viewBox="0 0 [^ ]+ 1"/, `viewBox="0 0 ${chart.turns} 1"`).replace(/(<rect class="trk" width=)"[^"]*"/, `$1"${chart.turns}"`))
}

/** Fill one built template from a page of values. */
export function fillTemplate(html: string, page: Page): string {
  let out = html
  for (const [name, value] of Object.entries(page.root)) out = out.replace(/<html\b[^>]*>/, (tag) => setAttr(tag, name, value))
  const at = out.indexOf('<html')
  const end = out.indexOf('</html>') + '</html>'.length
  const scope: Scope = { slots: page.slots, conditions: page.conditions, lists: page.lists, charts: page.charts }
  // the <title> and the body both carry slots; walk the document once
  return out.slice(0, at) + children(out.slice(at, end), scope) + out.slice(end)
}

// ---------- the rules of slots.md, as code ----------

export interface Words {
  verdict: string
  summary: string
  /** one sentence or two per finding, in finding order */
  whys: string[]
  improvementsTitle: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
const keepsImprovement = (recommendation: string | undefined): boolean => !!recommendation && !/^No change needed/.test(recommendation)

const QUALITY_NOTE: Record<string, string> = {
  clean: 'The last check it ran passed.',
  interrupted: 'You stopped it.',
  failing: 'The last test run failed.',
  unknown: 'No test or build run to judge.',
}

function qualityValue(o: SlimAnalysis['summary']['outcomes']): string {
  const parts: string[] = []
  if (o.prLinks.length) parts.push(plural(o.prLinks.length, 'PR'))
  if (o.gitCommits) parts.push(plural(o.gitCommits, 'commit'))
  if (o.filesEdited) parts.push(`${plural(o.filesEdited, 'file')} edited`)
  if (o.filesWritten) parts.push(`${plural(o.filesWritten, 'file')} written`)
  if (o.buildRunsFailed) parts.push(`${o.buildRunsFailed} of ${plural(o.buildRuns, 'build run')} failed`)
  if (o.testRuns) parts.push(o.testRunsFailed ? `${o.testRunsFailed} of ${plural(o.testRuns, 'test run')} failed` : `${plural(o.testRuns, 'test run')} green`)
  return parts.length ? parts.join(' · ') : 'No commits, PRs or test runs'
}

const REDACTED_DETAIL = 'orangu hides these details because they quote commands and output.'

function savingsOf(tokens: number | undefined, time: number | undefined): { slots: Record<string, SlotValue>; conditions: string[] } {
  const slots: Record<string, SlotValue> = {}
  const conditions: string[] = []
  if (tokens && tokens > 0) {
    slots['f-savings'] = slots['i-savings'] = { v: tokens }
    conditions.push('savings')
  }
  if (time && time > 0) {
    slots["f-savings-ms"] = slots["i-savings-ms"] = { v: time }
    conditions.push('savings-ms')
  }
  return { slots, conditions }
}

/** The page for session scope, from `orangu analyze <session> --json --slim`. */
export function sessionPage(a: SlimAnalysis, words: Words): Page {
  const s = a.summary
  const byId = new Map(a.insights.map((insight) => [insight.id, insight]))
  const top = s.topInsightIds.map((id) => byId.get(id)).filter((insight) => insight !== undefined).slice(0, 3)
  const rest = a.insights.filter((insight) => !top.includes(insight))
  const findings: Item[] = top.map((insight, index) => {
    const saving = savingsOf(insight.savings?.tokens, insight.savings?.ms)
    return {
      attrs: { 'data-sev': insight.severity },
      slots: {
        'f-i': String(index + 1),
        'f-k': String(top.length),
        'f-sev': insight.severity,
        'f-title': insight.title,
        'f-evidence': insight.detail || REDACTED_DETAIL,
        'f-turns': insight.turnIndexes.slice(0, 5).map((t) => `#${t}`).join(', '),
        'f-rule': insight.ruleId,
        'f-why': words.whys[index] ?? '',
        'f-improvement': insight.recommendation,
        ...saving.slots,
      },
      conditions: [...(insight.turnIndexes.length ? ['turns'] : []), ...saving.conditions],
      lists: { turn: insight.turnIndexes.slice(0, 50).map((x) => ({ attrs: { x: String(x) } })) },
      charts: { turns: { kind: 'turns', turns: s.turns, label: `In turns ${insight.turnIndexes.slice(0, 5).map((t) => `#${t}`).join(', ')} of ${s.turns}` } },
    }
  })
  const improvements: Item[] = [...top, ...rest]
    .filter((insight) => keepsImprovement(insight.recommendation))
    .slice(0, 5)
    .map((insight) => {
      const saving = savingsOf(insight.savings?.tokens, insight.savings?.ms)
      return { slots: { 'i-text': firstSentence(insight.recommendation), 'i-rule': insight.ruleId, ...saving.slots }, conditions: saving.conditions }
    })
  const k = a.tokens.byKind
  const ok = a.parse.reconciliation.ok
  const redacted = top.some((insight) => !insight.detail)
  const span = (v: number): SlotValue => ({ v })
  const live = a.session.live
  return {
    root: { 'data-scope': 'session', 'data-live': String(live), 'data-caution': String(!ok), 'data-redacted': String(redacted) },
    conditions: ['session', ...(live ? ['live'] : []), ok ? 'reconciled' : 'caution', ...(redacted ? ['redacted'] : []), ...(improvements.length ? ['improvements'] : []), ...(findings.length ? ['findings'] : [])],
    slots: {
      title: a.session.title || `Session ${a.session.id.slice(0, 8)}`,
      project: a.session.projectSlug ?? null,
      date: a.session.startedAt !== undefined ? { v: a.session.startedAt } : null,
      models: a.session.models.map((m) => m.displayName).join(', '),
      'live-at': { v: a.generator.generatedAt },
      version: a.generator.version,
      generated: { v: a.generator.generatedAt },
      verdict: words.verdict,
      summary: words.summary,
      quality: qualityValue(s.outcomes),
      'quality-note': QUALITY_NOTE[s.ending] ?? QUALITY_NOTE['unknown']!,
      active: span(s.activeMs),
      wall: s.wallMs !== undefined ? span(s.wallMs) : null,
      waiting: span(s.humanWaitMs),
      tokens: { v: s.totalTokens },
      cache: { v: s.cacheHitRatio },
      output: { v: k.output },
      'turn-count': { v: s.turns },
      'turn-noun': s.turns === 1 ? 'turn' : 'turns',
      'caution-pct': String(a.parse.reconciliation.matchesWithinPct),
      'improvements-title': words.improvementsTitle,
      cwd: a.session.cwd ?? 'the project directory',
      'session-id': a.session.id,
    },
    lists: { finding: findings, improvement: improvements },
    charts: {
      time: { kind: 'bars', values: { active: s.activeMs, waiting: s.humanWaitMs }, label: `Working ${ms(s.activeMs)}, waiting for you ${ms(s.humanWaitMs)}` },
      tokens: {
        kind: 'bars',
        values: { read: k.cacheRead, write5m: k.cacheWrite5m, write1h: k.cacheWrite1h, input: k.input, output: k.output },
        label: `Tokens by kind: cache read ${num(k.cacheRead)}, cache write 5m ${num(k.cacheWrite5m)}, cache write 1h ${num(k.cacheWrite1h)}, fresh input ${num(k.input)}, output ${num(k.output)}`,
      },
      cache: { kind: 'ring', value: Number(pct(s.cacheHitRatio).slice(0, -1)), of: 100, label: `${pct(s.cacheHitRatio)} read from cache` },
    },
  }
}

/** The page for repo or global scope, from `orangu evidence <aggregate> --scope repo|global`. */
export function aggregatePage(e: EvidenceBundle, scope: 'repo' | 'global', o: { folder?: string; version: string; words: Words }): Page {
  const n = e.source.sessions
  const seen = (f: EvidenceBundle['findings'][number]): number => f.finding.evidence.sessions ?? 1
  const top = e.findings.slice(0, 3)
  const findings: Item[] = top.map((f, index) => {
    const saving = savingsOf(f.finding.evidence.savingsTokens, f.finding.evidence.savingsMs)
    return {
      attrs: { 'data-sev': f.severity },
      slots: {
        'f-i': String(index + 1),
        'f-k': String(top.length),
        'f-sev': f.severity,
        'f-title': f.finding.title,
        'f-evidence': f.detail || REDACTED_DETAIL,
        'f-shows': { v: seen(f) },
        'f-examples': f.finding.sessionIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', '),
        'f-rule': f.finding.ruleId,
        'f-why': o.words.whys[index] ?? '',
        'f-improvement': f.recommendation ?? 'No improvement text in this evidence.',
        ...saving.slots,
      },
      conditions: saving.conditions,
      charts: { share: { kind: 'ring', value: seen(f), of: n, label: `${seen(f)} of ${n} sessions` } },
    }
  })
  const improvements: Item[] = e.findings
    .filter((f) => keepsImprovement(f.recommendation))
    .slice(0, 5)
    .map((f) => {
      const saving = savingsOf(f.finding.evidence.savingsTokens, f.finding.evidence.savingsMs)
      return { slots: { 'i-text': firstSentence(f.recommendation!), 'i-rule': f.finding.ruleId, ...saving.slots }, conditions: saving.conditions }
    })
  const first = e.findings[0]
  const redacted = top.some((f) => !f.detail)
  return {
    root: { 'data-scope': scope, 'data-live': 'false', 'data-caution': 'false', 'data-redacted': String(redacted) },
    conditions: [scope, 'aggregate', 'reconciled', ...(redacted ? ['redacted'] : []), ...(improvements.length ? ['improvements'] : []), ...(findings.length ? ['findings'] : [])],
    slots: {
      title: scope === 'repo' ? `Recurring patterns in ${o.folder}` : 'Recurring patterns on this machine',
      sessions: { v: n },
      'kpi-sessions': { v: n },
      'session-noun': n === 1 ? 'session' : 'sessions',
      'kpi-findings': { v: e.totalFindings },
      ...(first ? { 'kpi-top-n': { v: seen(first) }, 'kpi-top-rule': first.finding.ruleId } : {}),
      version: o.version,
      verdict: o.words.verdict,
      summary: o.words.summary,
      'improvements-title': o.words.improvementsTitle,
    },
    lists: { finding: findings, improvement: improvements },
    charts: first ? { share: { kind: 'ring', value: seen(first), of: n, label: `${seen(first)} of ${n} sessions` } } : {},
  }
}

// ---------- the post-write check of SKILL.md, as code ----------

export interface ShowMeCheck {
  pattern: string
  expected: number
  caseSensitive: boolean
}

/** The numbered Grep counts in SKILL.md, one per line: a number, the pattern in a code span, then "counts <k>.". The first is case-sensitive. */
export function showMeChecks(skillMd: string): ShowMeCheck[] {
  return [...skillMd.matchAll(/^\d+\. `(.+)` counts (\d+)\.$/gm)].map((m, index) => ({ pattern: m[1]!, expected: Number(m[2]), caseSensitive: index === 0 }))
}

/**
 * One check on one file. Grep in count mode may count lines with a match, or matches: the check must hold either
 * way, so the tests run both. The patterns use only syntax that ripgrep and JavaScript read the same way.
 */
export function countCheck(text: string, check: ShowMeCheck, by: 'lines' | 'matches'): number {
  const flags = check.caseSensitive ? '' : 'i'
  if (by === 'lines') {
    const re = new RegExp(check.pattern, flags)
    return text.split('\n').filter((line) => re.test(line)).length
  }
  return text.match(new RegExp(check.pattern, `${flags}gm`))?.length ?? 0
}
