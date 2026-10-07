/**
 * data.json: the orangu data of one show-me run. Prepare writes it, and the model reads it to write its 3 words.
 * A process or a person can change the file between the 2 steps, so the render validates it again here and builds
 * the page only from the fields that passed: each string becomes escaped text, each number is finite, and each
 * attribute value is a fixed word. A changed value can change only escaped text or a finite number.
 *
 * The validation copies the fields that the page reads into a new object. A key that the page does not read is
 * dropped, so no other key can reach the fill. It caps no text: the size bound of the whole file is the read bound.
 */
import { ANALYSIS_SCHEMA_VERSION, type InsightSeverity, type SessionEnding } from '../model/analysis.js'
import { EVIDENCE_SCHEMA_VERSION } from '../suggest/evidence.js'
import { ShowMeInputError } from './words.js'

/** The fields of a SlimAnalysis that a session page reads. */
export interface SessionData {
  slim: true
  generator: { version: string; generatedAt: number }
  session: {
    id: string
    title?: string
    projectSlug?: string
    startedAt?: number
    models: Array<{ displayName: string }>
    live: boolean
    cwd?: string
  }
  summary: {
    topInsightIds: string[]
    turns: number
    outcomes: {
      prLinks: readonly unknown[]
      gitCommits: number
      filesEdited: number
      filesWritten: number
      buildRuns: number
      buildRunsFailed: number
      testRuns: number
      testRunsFailed: number
    }
    ending: SessionEnding
    activeMs: number
    wallMs?: number
    humanWaitMs: number
    totalTokens: number
    cacheHitRatio: number
  }
  insights: Array<{
    id: string
    ruleId: string
    severity: InsightSeverity
    title: string
    detail: string
    turnIndexes: number[]
    improvement?: string
    why?: string
    recommendation?: string
    savings?: { tokens?: number; ms?: number }
  }>
  tokens: { byKind: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } }
  parse: { reconciliation: { ok: boolean; matchesWithinPct: number } }
}

/** The fields of an EvidenceBundle that a repo or global page reads. */
export interface AggregateData {
  source: { scope: string; sessions: number }
  totalFindings: number
  findings: Array<{
    severity: InsightSeverity
    detail: string
    finding: { ruleId: string; title: string; sessionIds: string[]; evidence: { sessions?: number; savingsTokens?: number; savingsMs?: number } }
    improvement?: string
    recommendation?: string
    why?: string
    exampleTitle?: string
  }>
}

/** A validated data.json: the session slim analysis, or the evidence bundle with the folder and the version. */
export type ShowMeData =
  | { kind: 'session'; value: SessionData }
  | { kind: 'aggregate'; scope: 'repo' | 'global'; value: AggregateData; folder?: string; version: string }

const SEVERITIES: readonly InsightSeverity[] = ['info', 'low', 'medium', 'high']
const ENDINGS: readonly SessionEnding[] = ['clean', 'interrupted', 'failing', 'unknown']
/** the range of a JavaScript Date in milliseconds: an epoch outside it has no date to print */
const MAX_EPOCH_MS = 8.64e15

const fail = (label: string, rule: string): never => {
  throw new ShowMeInputError(`data.json: ${label} ${rule}.`)
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function record(value: unknown, label: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(label, 'must be an object')
}
function list(value: unknown, label: string): unknown[] {
  return Array.isArray(value) ? value : fail(label, 'must be an array')
}
function text(value: unknown, label: string): string {
  return typeof value === 'string' ? value : fail(label, 'must be a string')
}
function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label)
}
function finite(value: unknown, label: string): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fail(label, 'must be a finite number')
}
/** a count, a duration or a token total: finite and not negative */
function amount(value: unknown, label: string): number {
  const n = finite(value, label)
  return n >= 0 ? n : fail(label, 'must not be negative')
}
function optionalAmount(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : amount(value, label)
}
/** a turn index or a turn count: a whole number, 0 or more */
function whole(value: unknown, label: string): number {
  const n = amount(value, label)
  return Number.isSafeInteger(n) ? n : fail(label, 'must be a whole number')
}
function epoch(value: unknown, label: string): number {
  const n = finite(value, label)
  return Math.abs(n) <= MAX_EPOCH_MS ? n : fail(label, 'must be a time in milliseconds')
}
function bool(value: unknown, label: string): boolean {
  return typeof value === 'boolean' ? value : fail(label, 'must be true or false')
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail(label, `must be one of ${allowed.join(', ')}`)
}
/** Copy a key only when it is present, so an absent optional field stays absent. */
const maybe = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>))

function sessionInsight(value: unknown, index: number): SessionData['insights'][number] {
  const at = `insights[${index}]`
  const i = record(value, at)
  const savings = i['savings'] === undefined ? undefined : record(i['savings'], `${at}.savings`)
  return {
    id: text(i['id'], `${at}.id`),
    ruleId: text(i['ruleId'], `${at}.ruleId`),
    severity: oneOf(i['severity'], SEVERITIES, `${at}.severity`),
    title: text(i['title'], `${at}.title`),
    detail: text(i['detail'], `${at}.detail`),
    turnIndexes: list(i['turnIndexes'], `${at}.turnIndexes`).map((turn, t) => whole(turn, `${at}.turnIndexes[${t}]`)),
    ...maybe('improvement', optionalText(i['improvement'], `${at}.improvement`)),
    ...maybe('why', optionalText(i['why'], `${at}.why`)),
    ...maybe('recommendation', optionalText(i['recommendation'], `${at}.recommendation`)),
    ...maybe(
      'savings',
      savings && {
        ...maybe('tokens', optionalAmount(savings['tokens'], `${at}.savings.tokens`)),
        ...maybe('ms', optionalAmount(savings['ms'], `${at}.savings.ms`)),
      },
    ),
  }
}

function sessionData(raw: Record<string, unknown>): SessionData {
  if (raw['schemaVersion'] !== ANALYSIS_SCHEMA_VERSION) fail('schemaVersion', `must be ${ANALYSIS_SCHEMA_VERSION}`)
  const generator = record(raw['generator'], 'generator')
  const session = record(raw['session'], 'session')
  const summary = record(raw['summary'], 'summary')
  const outcomes = record(summary['outcomes'], 'summary.outcomes')
  const byKind = record(record(raw['tokens'], 'tokens')['byKind'], 'tokens.byKind')
  const reconciliation = record(record(raw['parse'], 'parse')['reconciliation'], 'parse.reconciliation')
  const startedAt = session['startedAt'] === undefined ? undefined : epoch(session['startedAt'], 'session.startedAt')
  const wallMs = optionalAmount(summary['wallMs'], 'summary.wallMs')
  return {
    slim: true,
    generator: { version: text(generator['version'], 'generator.version'), generatedAt: epoch(generator['generatedAt'], 'generator.generatedAt') },
    session: {
      id: text(session['id'], 'session.id'),
      ...maybe('title', optionalText(session['title'], 'session.title')),
      ...maybe('projectSlug', optionalText(session['projectSlug'], 'session.projectSlug')),
      ...maybe('startedAt', startedAt),
      models: list(session['models'], 'session.models').map((m, i) => ({ displayName: text(record(m, `session.models[${i}]`)['displayName'], `session.models[${i}].displayName`) })),
      live: bool(session['live'], 'session.live'),
      ...maybe('cwd', optionalText(session['cwd'], 'session.cwd')),
    },
    summary: {
      topInsightIds: list(summary['topInsightIds'], 'summary.topInsightIds').map((id, i) => text(id, `summary.topInsightIds[${i}]`)),
      turns: whole(summary['turns'], 'summary.turns'),
      outcomes: {
        prLinks: list(outcomes['prLinks'], 'summary.outcomes.prLinks'),
        gitCommits: whole(outcomes['gitCommits'], 'summary.outcomes.gitCommits'),
        filesEdited: whole(outcomes['filesEdited'], 'summary.outcomes.filesEdited'),
        filesWritten: whole(outcomes['filesWritten'], 'summary.outcomes.filesWritten'),
        buildRuns: whole(outcomes['buildRuns'], 'summary.outcomes.buildRuns'),
        buildRunsFailed: whole(outcomes['buildRunsFailed'], 'summary.outcomes.buildRunsFailed'),
        testRuns: whole(outcomes['testRuns'], 'summary.outcomes.testRuns'),
        testRunsFailed: whole(outcomes['testRunsFailed'], 'summary.outcomes.testRunsFailed'),
      },
      ending: oneOf(summary['ending'], ENDINGS, 'summary.ending'),
      activeMs: amount(summary['activeMs'], 'summary.activeMs'),
      ...maybe('wallMs', wallMs),
      humanWaitMs: amount(summary['humanWaitMs'], 'summary.humanWaitMs'),
      totalTokens: amount(summary['totalTokens'], 'summary.totalTokens'),
      cacheHitRatio: amount(summary['cacheHitRatio'], 'summary.cacheHitRatio'),
    },
    insights: list(raw['insights'], 'insights').map(sessionInsight),
    tokens: {
      byKind: {
        input: amount(byKind['input'], 'tokens.byKind.input'),
        output: amount(byKind['output'], 'tokens.byKind.output'),
        cacheRead: amount(byKind['cacheRead'], 'tokens.byKind.cacheRead'),
        cacheWrite5m: amount(byKind['cacheWrite5m'], 'tokens.byKind.cacheWrite5m'),
        cacheWrite1h: amount(byKind['cacheWrite1h'], 'tokens.byKind.cacheWrite1h'),
      },
    },
    parse: { reconciliation: { ok: bool(reconciliation['ok'], 'parse.reconciliation.ok'), matchesWithinPct: finite(reconciliation['matchesWithinPct'], 'parse.reconciliation.matchesWithinPct') } },
  }
}

function aggregateFinding(value: unknown, index: number): AggregateData['findings'][number] {
  const at = `findings[${index}]`
  const f = record(value, at)
  const finding = record(f['finding'], `${at}.finding`)
  const evidence = record(finding['evidence'], `${at}.finding.evidence`)
  const sessions = evidence['sessions'] === undefined ? undefined : whole(evidence['sessions'], `${at}.finding.evidence.sessions`)
  return {
    severity: oneOf(f['severity'], SEVERITIES, `${at}.severity`),
    detail: text(f['detail'], `${at}.detail`),
    finding: {
      ruleId: text(finding['ruleId'], `${at}.finding.ruleId`),
      title: text(finding['title'], `${at}.finding.title`),
      sessionIds: list(finding['sessionIds'], `${at}.finding.sessionIds`).map((id, i) => text(id, `${at}.finding.sessionIds[${i}]`)),
      evidence: {
        ...maybe('sessions', sessions),
        ...maybe('savingsTokens', optionalAmount(evidence['savingsTokens'], `${at}.finding.evidence.savingsTokens`)),
        ...maybe('savingsMs', optionalAmount(evidence['savingsMs'], `${at}.finding.evidence.savingsMs`)),
      },
    },
    ...maybe('improvement', optionalText(f['improvement'], `${at}.improvement`)),
    ...maybe('recommendation', optionalText(f['recommendation'], `${at}.recommendation`)),
    ...maybe('why', optionalText(f['why'], `${at}.why`)),
    ...maybe('exampleTitle', optionalText(f['exampleTitle'], `${at}.exampleTitle`)),
  }
}

function aggregateData(raw: Record<string, unknown>): Extract<ShowMeData, { kind: 'aggregate' }> {
  if (raw['schemaVersion'] !== EVIDENCE_SCHEMA_VERSION) fail('schemaVersion', `must be ${EVIDENCE_SCHEMA_VERSION}`)
  const source = record(raw['source'], 'source')
  const scope = oneOf(source['scope'], ['repo', 'global'] as const, 'source.scope')
  const folder = optionalText(raw['folder'], 'folder')
  if (scope === 'repo' && !folder?.trim()) fail('folder', 'must name the repository folder')
  return {
    kind: 'aggregate',
    scope,
    value: {
      source: { scope, sessions: whole(source['sessions'], 'source.sessions') },
      totalFindings: whole(raw['totalFindings'], 'totalFindings'),
      findings: list(raw['findings'], 'findings').map(aggregateFinding),
    },
    ...maybe('folder', folder),
    version: text(raw['version'], 'version'),
  }
}

/**
 * Validate data.json against the slim analysis shape (session) or the evidence bundle shape (repo and global).
 * It throws a ShowMeInputError on the first field that fails, and it never echoes a value.
 */
export function validateShowMeData(raw: unknown): ShowMeData {
  const value = record(raw, 'the file')
  if (value['slim'] === true) return { kind: 'session', value: sessionData(value) }
  if (isRecord(value['source']) && Array.isArray(value['findings'])) return aggregateData(value)
  return fail('the file', 'must be a slim analysis or an evidence bundle that orangu show-me wrote')
}
