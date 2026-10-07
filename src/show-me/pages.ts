/**
 * The rules of plugin/skills/show-me/references/slots.md, as code: one page of values for a session, a repository
 * or the machine. Claude writes only the 3 Words. Every other value comes from orangu data, and the fill writes
 * each one as escaped text, a checked enum or a finite number (src/show-me/fill.ts).
 *
 * The page reads only the fields of SessionData and AggregateData (src/show-me/data.ts). A SlimAnalysis and an
 * EvidenceBundle have those fields, so the same builders fill the pages of the tests.
 */
import { NO_CHANGE } from '../analyze/insights.js'
import { ms, num, pct } from '../report/client/format.js'
import type { AggregateData, SessionData } from './data.js'
import type { Item, Page, SlotValue } from './fill.js'
import type { Words } from './words.js'

/** The finding slides of a page: the template repeats the finding element up to this count (its data-max). */
const FINDINGS_SHOWN = 3
/** "each of the first 5 values of insight.turnIndexes" (slots.md): a list length, not a cut of a text */
const TURNS_NAMED = 5
/** one turn marker for each turn index, up to the data-max of the strip */
const TURN_MARKERS = 50
/** "the first 8 characters of each of the first 5 finding.sessionIds" (slots.md): list length and id prefix */
const EXAMPLE_SESSIONS = 5
const ID_PREFIX = 8

const REDACTED_DETAIL = 'orangu hides these details because they quote commands and output.'
const NO_IMPROVEMENT_TEXT = 'No improvement text in this evidence.'

const QUALITY_NOTE: Readonly<Record<string, string>> = {
  clean: 'The last check it ran passed.',
  interrupted: 'You stopped it.',
  failing: 'The last test run failed.',
  unknown: 'No test or build run to judge.',
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** The change a rule asks for: `improvement`, else the older joined `recommendation`. */
const improvementOf = (o: { improvement?: string; recommendation?: string }): string | undefined => o.improvement ?? o.recommendation

/** The reason of a finding, when it has one: the `why` condition and the f-why slot go together. */
const reasonOf = (o: { why?: string }): string | undefined => (o.why?.trim() ? o.why : undefined)

/** An improvement item names a change: a rule text that starts with the shared verdict "No change needed." is not one. */
const isChange = (text: string | undefined): text is string => text !== undefined && text.trim() !== '' && !text.startsWith(NO_CHANGE)

function qualityValue(o: SessionData['summary']['outcomes']): string {
  const parts: string[] = []
  if (o.prLinks.length) parts.push(plural(o.prLinks.length, 'PR'))
  if (o.gitCommits) parts.push(plural(o.gitCommits, 'commit'))
  if (o.filesEdited) parts.push(`${plural(o.filesEdited, 'file')} edited`)
  if (o.filesWritten) parts.push(`${plural(o.filesWritten, 'file')} written`)
  if (o.buildRunsFailed) parts.push(`${o.buildRunsFailed} of ${plural(o.buildRuns, 'build run')} failed`)
  if (o.testRuns) parts.push(o.testRunsFailed ? `${o.testRunsFailed} of ${plural(o.testRuns, 'test run')} failed` : `${plural(o.testRuns, 'test run')} green`)
  return parts.length ? parts.join(' · ') : 'No commits, PRs or test runs'
}

function savingsOf(tokens: number | undefined, time: number | undefined): { slots: Record<string, SlotValue>; conditions: string[] } {
  const slots: Record<string, SlotValue> = {}
  const conditions: string[] = []
  if (tokens && tokens > 0) {
    slots['f-savings'] = slots['i-savings'] = { v: tokens }
    conditions.push('savings')
  }
  if (time && time > 0) {
    slots['f-savings-ms'] = slots['i-savings-ms'] = { v: time }
    conditions.push('savings-ms')
  }
  return { slots, conditions }
}

const turnList = (turns: readonly number[]): string => turns.slice(0, TURNS_NAMED).map((t) => `#${t}`).join(', ')

/** The page for session scope, from the slim analysis that `orangu show-me <session>` writes to data.json. */
export function sessionPage(a: SessionData, words: Words): Page {
  const s = a.summary
  const byId = new Map(a.insights.map((insight) => [insight.id, insight]))
  const top = s.topInsightIds.map((id) => byId.get(id)).filter((insight) => insight !== undefined).slice(0, FINDINGS_SHOWN)
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
        'f-turns': turnList(insight.turnIndexes),
        'f-rule': insight.ruleId,
        'f-why': reasonOf(insight) ?? null,
        'f-improvement': improvementOf(insight) ?? NO_IMPROVEMENT_TEXT,
        ...saving.slots,
      },
      conditions: [...(insight.turnIndexes.length ? ['turns'] : []), ...(reasonOf(insight) ? ['why'] : []), ...saving.conditions],
      lists: { turn: insight.turnIndexes.slice(0, TURN_MARKERS).map((x) => ({ attrs: { x } })) },
      charts: { turns: { kind: 'turns', turns: s.turns, label: `In turns ${turnList(insight.turnIndexes)} of ${s.turns}` } },
    }
  })
  const improvements: Item[] = [...top, ...rest].flatMap((insight) => {
    const text = improvementOf(insight)
    if (!isChange(text)) return []
    const saving = savingsOf(insight.savings?.tokens, insight.savings?.ms)
    return [{ slots: { 'i-text': text, 'i-rule': insight.ruleId, ...saving.slots }, conditions: saving.conditions }]
  })
  const k = a.tokens.byKind
  const ok = a.parse.reconciliation.ok
  const redacted = top.some((insight) => !insight.detail)
  const live = a.session.live
  return {
    root: { 'data-scope': 'session', 'data-live': String(live), 'data-caution': String(!ok), 'data-redacted': String(redacted) },
    end: s.ending,
    conditions: ['session', ...(live ? ['live'] : []), ok ? 'reconciled' : 'caution', ...(redacted ? ['redacted'] : []), ...(improvements.length ? ['improvements'] : []), ...(findings.length ? ['findings'] : [])],
    slots: {
      title: a.session.title || `Session ${a.session.id.slice(0, ID_PREFIX)}`,
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
      active: { v: s.activeMs },
      wall: s.wallMs !== undefined ? { v: s.wallMs } : null,
      waiting: { v: s.humanWaitMs },
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

/**
 * The page for repo or global scope, from the evidence bundle that `orangu show-me --scope repo|global` writes to
 * data.json. A finding title is the example insight's own title: the fixed "In one session" label above it in
 * both templates says the rest, once per finding.
 */
export function aggregatePage(e: AggregateData, scope: 'repo' | 'global', o: { folder?: string; version: string; words: Words }): Page {
  const n = e.source.sessions
  const seen = (f: AggregateData['findings'][number]): number => f.finding.evidence.sessions ?? 1
  const top = e.findings.slice(0, FINDINGS_SHOWN)
  const findings: Item[] = top.map((f, index) => {
    const saving = savingsOf(f.finding.evidence.savingsTokens, f.finding.evidence.savingsMs)
    return {
      attrs: { 'data-sev': f.severity },
      slots: {
        'f-i': String(index + 1),
        'f-k': String(top.length),
        'f-sev': f.severity,
        'f-title': f.exampleTitle ?? f.finding.title,
        'f-evidence': f.detail || REDACTED_DETAIL,
        'f-shows': { v: seen(f) },
        'f-examples': f.finding.sessionIds.slice(0, EXAMPLE_SESSIONS).map((id) => id.slice(0, ID_PREFIX)).join(', '),
        'f-rule': f.finding.ruleId,
        'f-why': reasonOf(f) ?? null,
        'f-improvement': improvementOf(f) ?? NO_IMPROVEMENT_TEXT,
        ...saving.slots,
      },
      conditions: [...(reasonOf(f) ? ['why'] : []), ...saving.conditions],
      charts: { share: { kind: 'ring', value: seen(f), of: n, label: `${seen(f)} of ${n} sessions` } },
    }
  })
  const improvements: Item[] = e.findings.flatMap((f) => {
    const text = improvementOf(f)
    if (!isChange(text)) return []
    const saving = savingsOf(f.finding.evidence.savingsTokens, f.finding.evidence.savingsMs)
    return [{ slots: { 'i-text': text, 'i-rule': f.finding.ruleId, ...saving.slots }, conditions: saving.conditions }]
  })
  const first = e.findings[0]
  const redacted = top.some((f) => !f.detail)
  return {
    root: { 'data-scope': scope, 'data-live': 'false', 'data-caution': 'false', 'data-redacted': String(redacted) },
    conditions: [scope, 'aggregate', 'reconciled', ...(redacted ? ['redacted'] : []), ...(improvements.length ? ['improvements'] : []), ...(findings.length ? ['findings'] : [])],
    slots: {
      title: scope === 'repo' ? `Recurring patterns in ${o.folder ?? 'this repository'}` : 'Recurring patterns on this machine',
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
