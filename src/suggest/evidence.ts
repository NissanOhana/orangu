/**
 * Bounded, deterministic evidence projection for model-facing improvement workflows.
 *
 * This module owns policy, not I/O: it accepts only current Orangu Analysis,
 * SlimAnalysis, or Aggregate values; emits canonical report-source suggestion
 * identities; and copies only the small, redacted fields needed to explain a
 * finding. The CLI adapter is responsible for resolving sessions and reading files.
 */
import { AGGREGATE_SCHEMA_VERSION, compareCrossFindings, type CrossFinding } from '../analyze/aggregate.js'
import { ANALYSIS_SCHEMA_VERSION, type Insight, type InsightSeverity, type Persona } from '../model/analysis.js'
import { redactValue } from '../redact/redact.js'
import { matchRule, type CatalogMatch, type MatchableAnalysis } from './catalog.js'
import { encodeFinding, normalizeSessionIds, sessionCohortFingerprint, suggestionIdV2, suggestionKey } from './id.js'
import { ESTIMATE_TOKEN_THRESHOLD, type Finding, type SuggestionScope } from './types.js'

export const EVIDENCE_SCHEMA_VERSION = '1'
export const DEFAULT_EVIDENCE_LIMIT = 12
export const MAX_EVIDENCE_LIMIT = 50
export const MAX_EVIDENCE_ARTIFACT_BYTES = 8 * 1024 * 1024
const MAX_EVIDENCE_OUTPUT_BYTES = 256 * 1024
export const MAX_EVIDENCE_INPUT_FINDINGS = 500
const MAX_EVIDENCE_INPUT_SESSIONS = 1_000

const MAX_RULE_ID_CHARS = 128
const MAX_INSIGHT_ID_CHARS = 256
const MAX_SESSION_ID_CHARS = 2_048
const MAX_TITLE_CHARS = 1_000
const MAX_INPUT_TEXT_CHARS = 16_384
const MAX_OUTPUT_DETAIL_CHARS = 2_000
const MAX_OUTPUT_CATALOG_TEXT_CHARS = 1_000
const MAX_TURN_INDEXES = 500
const MAX_SESSION_IDS_PER_FINDING = 50
const MAX_CATALOG_MATCHES_PER_FINDING = 16
const MAX_EVIDENCE_VALUE_ITEMS = 500
const MAX_EVIDENCE_VALUE_NODES = 5_000
const MAX_EVIDENCE_VALUE_DEPTH = 8

type AggregateScope = Exclude<SuggestionScope, 'session'>
type EvidenceInputKind = 'analysis' | 'slim-analysis' | 'aggregate'

interface EvidenceCatalogMatch {
  suggestionId: string
  id: string
  changeClass: CatalogMatch['entry']['changeClass']
  tool?: string
  skill?: string
  feature?: string
  url: string | null
  verifiedAt: string | null
  note: string
  evidence: string
}

interface EvidenceFinding {
  suggestionId: string
  findingToken: string
  finding: Finding
  axis: Insight['axis']
  severity: InsightSeverity
  detail: string
  recommendation?: string
  turnIndexes?: number[]
  catalogMatchIds: string[]
}

export interface EvidenceBundle {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
  source: {
    kind: EvidenceInputKind
    schemaVersion: string
    scope: SuggestionScope
    sessions: number
    /** Present only for repo/global Aggregate evidence. */
    cohortFingerprint?: string
  }
  totalFindings: number
  selectedFindings: number
  truncated: boolean
  /** Curated catalog matches are intentionally before findings for catalog-first consumers. */
  catalogMatches: EvidenceCatalogMatch[]
  findings: EvidenceFinding[]
}

interface EvidenceEstimate {
  bytes: number
  approxTokens: number
  thresholdTokens: number
  overThreshold: boolean
}

export interface ProjectEvidenceOptions {
  limit?: number
  /** Required for Aggregate; forbidden for session Analysis/SlimAnalysis. */
  scope?: AggregateScope
}

interface ProjectedRow {
  finding: Finding
  axis: Insight['axis']
  severity: InsightSeverity
  detail: string
  recommendation?: string
  turnIndexes?: number[]
  catalogMatches: CatalogMatch[]
}

interface ValidatedAnalysis {
  kind: 'analysis' | 'slim-analysis'
  value: EvidenceAnalysisInput
}

interface ValidatedAggregate {
  kind: 'aggregate'
  value: EvidenceAggregateInput
}

type ValidatedInput = ValidatedAnalysis | ValidatedAggregate

interface EvidenceAnalysisInput extends MatchableAnalysis {
  schemaVersion: string
  session: { id: string }
  insights: Insight[]
}

type ValidatedCrossFinding = Omit<CrossFinding, 'axis' | 'severity'> & { axis: Insight['axis']; severity: InsightSeverity }

interface EvidenceAggregateInput {
  schemaVersion: string
  sessionCount: number
  sessionIds: string[]
  crossFindings: ValidatedCrossFinding[]
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label} must be a non-empty string`)
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`)
  return value
}

function boundedId(value: unknown, label: string, max: number): string {
  const id = boundedString(value, label, max)
  if (!SAFE_ID.test(id)) throw new Error(`${label} contains unsupported characters`)
  // Identifiers feed canonical hashes and finding tokens, so replacing a secret
  // after hashing would make the visible record impossible to reproduce. Reject
  // sensitive identifiers at the boundary instead.
  if (redactValue(id, { scrub: true }) !== id) throw new Error(`${label} contains sensitive material`)
  return id
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`)
  return value
}

function insightAxis(value: unknown, label: string): Insight['axis'] {
  if (value === 'quality' || value === 'time' || value === 'tokens' || value === 'context') return value
  throw new Error(`${label} is unsupported`)
}

function insightSeverity(value: unknown, label: string): InsightSeverity {
  if (value === 'info' || value === 'low' || value === 'medium' || value === 'high') return value
  throw new Error(`${label} is unsupported`)
}

function insightPersona(value: unknown, label: string): Persona {
  if (value === 'developer' || value === 'lead' || value === 'pm' || value === 'qa' || value === 'anyone') return value
  throw new Error(`${label} is unsupported`)
}

function boundedArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > max) throw new Error(`${label} exceeds ${max} items`)
  return value
}

function requireRecords(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) if (!isRecord(value[key])) throw new Error(`${label}.${key} must be an object`)
}

function requireArrays(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) if (!Array.isArray(value[key])) throw new Error(`${label}.${key} must be an array`)
}

function validateBoundedValue(
  value: unknown,
  label: string,
  state: { nodes: number; seen: WeakSet<object> } = { nodes: 0, seen: new WeakSet<object>() },
  depth = 0,
): void {
  state.nodes++
  if (state.nodes > MAX_EVIDENCE_VALUE_NODES) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_NODES} values`)
  if (depth > MAX_EVIDENCE_VALUE_DEPTH) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_DEPTH} levels`)
  if (typeof value === 'string') {
    boundedString(value, label, MAX_INPUT_TEXT_CHARS, true)
    return
  }
  if (value == null || typeof value === 'boolean' || value === undefined) return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite numbers`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${label} contains an unsupported value`)
  if (state.seen.has(value)) throw new Error(`${label} must not contain cycles`)
  state.seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > MAX_EVIDENCE_VALUE_ITEMS) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_ITEMS} items`)
    for (let i = 0; i < value.length; i++) validateBoundedValue(value[i], `${label}[${i}]`, state, depth + 1)
  } else {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_EVIDENCE_VALUE_ITEMS) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_ITEMS} fields`)
    for (const [key, item] of entries) validateBoundedValue(item, `${label}.${key}`, state, depth + 1)
  }
  state.seen.delete(value)
}

function validateSessionIds(value: unknown, label: string): string[] {
  const raw = boundedArray(value, label, MAX_SESSION_IDS_PER_FINDING)
  if (!raw.length) throw new Error(`${label} must not be empty`)
  return normalizeSessionIds(raw.map((id, index) => boundedId(id, `${label}[${index}]`, MAX_SESSION_ID_CHARS)))
}

function validateInsight(value: unknown, index: number): Insight {
  if (!isRecord(value)) throw new Error(`insights[${index}] must be an object`)
  const id = boundedId(value['id'], `insights[${index}].id`, MAX_INSIGHT_ID_CHARS)
  const ruleId = boundedId(value['ruleId'], `insights[${index}].ruleId`, MAX_RULE_ID_CHARS)
  const title = boundedString(value['title'], `insights[${index}].title`, MAX_TITLE_CHARS, true)
  const detail = boundedString(value['detail'], `insights[${index}].detail`, MAX_INPUT_TEXT_CHARS, true)
  const recommendation = boundedString(value['recommendation'], `insights[${index}].recommendation`, MAX_INPUT_TEXT_CHARS, true)
  const axis = insightAxis(value['axis'], `insights[${index}].axis`)
  const severity = insightSeverity(value['severity'], `insights[${index}].severity`)
  const evidence = value['evidence']
  if (!isRecord(evidence)) throw new Error(`insights[${index}].evidence must be an object`)
  validateBoundedValue(evidence, `insights[${index}].evidence`)
  const rawTurns = boundedArray(value['turnIndexes'], `insights[${index}].turnIndexes`, MAX_TURN_INDEXES)
  const turnIndexes: number[] = []
  for (let i = 0; i < rawTurns.length; i++) {
    const turn = rawTurns[i]
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) throw new Error(`insights[${index}].turnIndexes[${i}] must be a non-negative integer`)
    turnIndexes.push(turn)
  }
  const rawPersonas = boundedArray(value['personas'], `insights[${index}].personas`, 32)
  const personas = rawPersonas.map((persona, personaIndex) => insightPersona(persona, `insights[${index}].personas[${personaIndex}]`))
  let savings: Insight['savings']
  const rawSavings = value['savings']
  if (rawSavings !== undefined) {
    if (!isRecord(rawSavings) || typeof rawSavings['estimated'] !== 'boolean') {
      throw new Error(`insights[${index}].savings must include estimated`)
    }
    savings = {
      estimated: rawSavings['estimated'],
      ...(rawSavings['tokens'] !== undefined ? { tokens: finiteNonNegative(rawSavings['tokens'], `insights[${index}].savings.tokens`) } : {}),
      ...(rawSavings['ms'] !== undefined ? { ms: finiteNonNegative(rawSavings['ms'], `insights[${index}].savings.ms`) } : {}),
    }
  }
  return { id, ruleId, title, detail, recommendation, axis, severity, evidence, turnIndexes, ...(savings ? { savings } : {}), personas }
}

function matchableFiles(value: Record<string, unknown>): MatchableAnalysis['files'] {
  const files = value['files']
  if (!isRecord(files)) throw new Error('Analysis.files must be an object')
  const raw = boundedArray(files['mostReRead'], 'Analysis.files.mostReRead', MAX_EVIDENCE_VALUE_ITEMS)
  return {
    mostReRead: raw.map((item, index) => {
      if (!isRecord(item)) throw new Error(`Analysis.files.mostReRead[${index}] must be an object`)
      const path = item['path']
      return path === undefined ? {} : { path: boundedString(path, `Analysis.files.mostReRead[${index}].path`, MAX_INPUT_TEXT_CHARS) }
    }),
  }
}

function matchableContext(value: Record<string, unknown>): MatchableAnalysis['context'] {
  const context = value['context']
  if (!isRecord(context)) throw new Error('Analysis.context must be an object')
  const misses = context['cacheMisses']
  if (misses === undefined) return {}
  const raw = boundedArray(misses, 'Analysis.context.cacheMisses', MAX_EVIDENCE_VALUE_ITEMS)
  return {
    cacheMisses: raw.map((item, index) => {
      if (!isRecord(item)) throw new Error(`Analysis.context.cacheMisses[${index}] must be an object`)
      const type = item['type']
      return type === undefined ? {} : { type: boundedString(type, `Analysis.context.cacheMisses[${index}].type`, MAX_RULE_ID_CHARS) }
    }),
  }
}

function validateAnalysis(value: Record<string, unknown>): ValidatedAnalysis {
  if (value['schemaVersion'] !== ANALYSIS_SCHEMA_VERSION) {
    throw new Error(`Analysis schemaVersion must be current (${ANALYSIS_SCHEMA_VERSION})`)
  }
  if (!isRecord(value['generator']) || value['generator']['name'] !== 'orangu') throw new Error('Analysis.generator.name must be "orangu"')
  if (!isRecord(value['session'])) throw new Error('Analysis.session must be an object')
  const sessionId = boundedId(value['session']['id'], 'Analysis.session.id', MAX_SESSION_ID_CHARS)
  const insights = boundedArray(value['insights'], 'Analysis.insights', MAX_EVIDENCE_INPUT_FINDINGS)
  const validatedInsights = insights.map(validateInsight)

  const slim = value['slim'] === true
  if (slim) {
    requireRecords(value, ['summary', 'tools', 'files', 'tokens', 'agents', 'context', 'quality', 'parse'], 'SlimAnalysis')
  } else {
    if (value['slim'] !== undefined) throw new Error('Analysis.slim must be absent; use true for SlimAnalysis')
    requireRecords(value, ['summary', 'tools', 'files', 'agents', 'skills', 'hooks', 'context', 'tokens', 'time', 'quality', 'parse'], 'Analysis')
    requireArrays(value, ['turns', 'events'], 'Analysis')
  }
  return {
    kind: slim ? 'slim-analysis' : 'analysis',
    value: {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      session: { id: sessionId },
      insights: validatedInsights,
      files: matchableFiles(value),
      context: matchableContext(value),
    },
  }
}

function validateCrossFinding(value: unknown, index: number): ValidatedCrossFinding {
  if (!isRecord(value)) throw new Error(`Aggregate.crossFindings[${index}] must be an object`)
  const ruleId = boundedId(value['ruleId'], `Aggregate.crossFindings[${index}].ruleId`, MAX_RULE_ID_CHARS)
  const title = boundedString(value['title'], `Aggregate.crossFindings[${index}].title`, MAX_TITLE_CHARS, true)
  const sessions = finiteNonNegative(value['sessions'], `Aggregate.crossFindings[${index}].sessions`)
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > MAX_EVIDENCE_INPUT_SESSIONS) {
    throw new Error(`Aggregate.crossFindings[${index}].sessions is out of range`)
  }
  const totalSavingsTokens = finiteNonNegative(value['totalSavingsTokens'], `Aggregate.crossFindings[${index}].totalSavingsTokens`)
  const totalSavingsMs = finiteNonNegative(value['totalSavingsMs'], `Aggregate.crossFindings[${index}].totalSavingsMs`)
  // Additive (aggregate v2): older JSON omits the bounded figures; the raw sum is the honest fallback.
  const boundedSavingsTokens = value['boundedSavingsTokens'] === undefined ? totalSavingsTokens : finiteNonNegative(value['boundedSavingsTokens'], `Aggregate.crossFindings[${index}].boundedSavingsTokens`)
  const boundedSavingsMs = value['boundedSavingsMs'] === undefined ? totalSavingsMs : finiteNonNegative(value['boundedSavingsMs'], `Aggregate.crossFindings[${index}].boundedSavingsMs`)
  const axis = insightAxis(value['axis'], `Aggregate.crossFindings[${index}].axis`)
  const severity = insightSeverity(value['severity'], `Aggregate.crossFindings[${index}].severity`)
  const exampleSessionIds = validateSessionIds(value['exampleSessionIds'], `Aggregate.crossFindings[${index}].exampleSessionIds`)
  return { ruleId, title, sessions, totalSavingsTokens, totalSavingsMs, boundedSavingsTokens, boundedSavingsMs, axis, severity, exampleSessionIds }
}

function validateAggregate(value: Record<string, unknown>): ValidatedAggregate {
  if (value['schemaVersion'] !== AGGREGATE_SCHEMA_VERSION) {
    throw new Error(`Aggregate schemaVersion must be current (${AGGREGATE_SCHEMA_VERSION})`)
  }
  boundedString(value['scope'], 'Aggregate.scope', MAX_INPUT_TEXT_CHARS, true)
  finiteNonNegative(value['generatedAt'], 'Aggregate.generatedAt')
  const sessionCount = finiteNonNegative(value['sessionCount'], 'Aggregate.sessionCount')
  if (!Number.isInteger(sessionCount) || sessionCount > MAX_EVIDENCE_INPUT_SESSIONS) throw new Error('Aggregate.sessionCount is out of range')
  requireRecords(value, ['totals', 'averages'], 'Aggregate')
  requireArrays(value, ['sessions', 'topSessions', 'byWeek'], 'Aggregate')
  const sessions = boundedArray(value['sessions'], 'Aggregate.sessions', MAX_EVIDENCE_INPUT_SESSIONS)
  if (sessions.length !== sessionCount) throw new Error('Aggregate.sessionCount must equal Aggregate.sessions.length')
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    if (!isRecord(session)) throw new Error(`Aggregate.sessions[${i}] must be an object`)
    boundedId(session['id'], `Aggregate.sessions[${i}].id`, MAX_SESSION_ID_CHARS)
  }
  const sessionIds = normalizeSessionIds(sessions.map((session) => (session as Record<string, unknown>)['id'] as string))
  if (sessionIds.length !== sessions.length) throw new Error('Aggregate.sessions ids must be distinct')
  const findings = boundedArray(value['crossFindings'], 'Aggregate.crossFindings', MAX_EVIDENCE_INPUT_FINDINGS).map(validateCrossFinding)
  const cohort = new Set(sessionIds)
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!
    if (finding.sessions > sessionCount) {
      throw new Error(`Aggregate.crossFindings[${index}].sessions must not exceed Aggregate.sessionCount`)
    }
    if (finding.exampleSessionIds.length > finding.sessions) {
      throw new Error(`Aggregate.crossFindings[${index}].exampleSessionIds must not exceed its recurrence count`)
    }
    if (finding.exampleSessionIds.some((id) => !cohort.has(id))) {
      throw new Error(`Aggregate.crossFindings[${index}].exampleSessionIds must belong to Aggregate.sessions`)
    }
  }
  return {
    kind: 'aggregate',
    value: { schemaVersion: AGGREGATE_SCHEMA_VERSION, sessionCount, sessionIds, crossFindings: findings },
  }
}

function validateInput(value: unknown): ValidatedInput {
  if (!isRecord(value)) throw new Error('evidence input must be a JSON object')
  if (Array.isArray(value['crossFindings'])) return validateAggregate(value)
  if (Array.isArray(value['insights'])) return validateAnalysis(value)
  throw new Error('input is not a current Orangu Analysis, SlimAnalysis, or Aggregate')
}

function outputText(value: string, max: number): string {
  const redacted = redactValue(value, { scrub: true })
  return redacted.length <= max ? redacted : redacted.slice(0, Math.max(0, max - 1)) + '…'
}

function titleForRule(ruleId: string): string {
  const words = ruleId.trim().replace(/[-_]+/g, ' ') || 'finding'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function safeTitle(ruleId: string, title: string): string {
  return outputText(title, MAX_TITLE_CHARS).trim() || titleForRule(ruleId)
}

function findingFromInsight(insight: Insight, sessionId: string): Finding {
  return {
    ruleId: insight.ruleId,
    title: safeTitle(insight.ruleId, insight.title),
    scope: 'session',
    sessionIds: normalizeSessionIds([sessionId]),
    insightId: insight.id,
    evidence: {
      estimated: insight.savings?.estimated ?? true,
      sessions: 1,
      ...(insight.savings?.tokens !== undefined ? { savingsTokens: insight.savings.tokens } : {}),
      ...(insight.savings?.ms !== undefined ? { savingsMs: insight.savings.ms } : {}),
    },
  }
}

function findingFromCrossFinding(finding: ValidatedCrossFinding, scope: AggregateScope, cohortFingerprint: string): Finding {
  return {
    ruleId: finding.ruleId,
    title: safeTitle(finding.ruleId, finding.title),
    scope,
    cohortFingerprint,
    sessionIds: validateSessionIds(finding.exampleSessionIds, `Aggregate.crossFindings.${finding.ruleId}.exampleSessionIds`),
    evidence: {
      estimated: true,
      sessions: finding.sessions,
      ...(finding.totalSavingsTokens ? { savingsTokens: finding.totalSavingsTokens } : {}),
      ...(finding.totalSavingsMs ? { savingsMs: finding.totalSavingsMs } : {}),
    },
  }
}

function rowsFromAnalysis(a: EvidenceAnalysisInput): ProjectedRow[] {
  return a.insights.map((insight) => ({
    finding: findingFromInsight(insight, a.session.id),
    axis: insight.axis,
    severity: insight.severity,
    detail: outputText(insight.detail, MAX_OUTPUT_DETAIL_CHARS),
    recommendation: outputText(insight.recommendation, MAX_OUTPUT_DETAIL_CHARS),
    turnIndexes: [...insight.turnIndexes],
    catalogMatches: matchRule(insight.ruleId, [a]).slice(0, MAX_CATALOG_MATCHES_PER_FINDING),
  }))
}

function rowsFromAggregate(a: EvidenceAggregateInput, scope: AggregateScope): ProjectedRow[] {
  const cohortFingerprint = sessionCohortFingerprint(a.sessionIds)
  return [...a.crossFindings].sort(compareCrossFindings).map((finding) => ({
    finding: findingFromCrossFinding(finding, scope, cohortFingerprint),
    axis: finding.axis,
    severity: finding.severity,
    detail: `Recurs in ${finding.sessions} session${finding.sessions === 1 ? '' : 's'}.`,
    catalogMatches: matchRule(finding.ruleId).slice(0, MAX_CATALOG_MATCHES_PER_FINDING),
  }))
}

function catalogOutput(suggestionId: string, match: CatalogMatch): EvidenceCatalogMatch {
  const entry = match.entry
  return {
    suggestionId,
    id: entry.id,
    changeClass: entry.changeClass,
    ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
    ...(entry.skill !== undefined ? { skill: entry.skill } : {}),
    ...(entry.feature !== undefined ? { feature: entry.feature } : {}),
    url: entry.url,
    verifiedAt: entry.verifiedAt,
    note: outputText(entry.note, MAX_OUTPUT_CATALOG_TEXT_CHARS),
    evidence: outputText(match.evidence, MAX_OUTPUT_CATALOG_TEXT_CHARS),
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function evidenceLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EVIDENCE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_EVIDENCE_LIMIT}`)
  }
  return limit
}

/** Validate and project a current in-memory Orangu artifact into bounded evidence. */
export function projectEvidence(value: unknown, options: ProjectEvidenceOptions = {}): EvidenceBundle {
  const input = validateInput(value)
  const limit = evidenceLimit(options.limit)
  if (input.kind === 'aggregate' && options.scope === undefined) throw new Error('Aggregate evidence requires explicit --scope repo|global')
  if (input.kind !== 'aggregate' && options.scope !== undefined) throw new Error('--scope is only valid for Aggregate evidence')

  let scope: SuggestionScope = 'session'
  let rows: ProjectedRow[]
  if (input.kind === 'aggregate') {
    const aggregateScope = options.scope
    if (aggregateScope === undefined) throw new Error('Aggregate evidence requires explicit --scope repo|global')
    scope = aggregateScope
    rows = rowsFromAggregate(input.value, aggregateScope)
  } else {
    rows = rowsFromAnalysis(input.value)
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const id = suggestionIdV2(suggestionKey(row.finding, 'report'))
    if (seen.has(id)) throw new Error(`duplicate canonical suggestion identity ${id}`)
    seen.add(id)
  }

  const sessions = input.kind === 'aggregate' ? input.value.sessionCount : 1
  const bundle: EvidenceBundle = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    source: {
      kind: input.kind,
      schemaVersion: input.value.schemaVersion,
      scope,
      sessions,
      ...(input.kind === 'aggregate' ? { cohortFingerprint: sessionCohortFingerprint(input.value.sessionIds) } : {}),
    },
    totalFindings: rows.length,
    selectedFindings: 0,
    truncated: rows.length > 0,
    catalogMatches: [],
    findings: [],
  }

  for (const row of rows.slice(0, limit)) {
    const suggestionId = suggestionIdV2(suggestionKey(row.finding, 'report'))
    const matches = row.catalogMatches.map((match) => catalogOutput(suggestionId, match))
    const finding: EvidenceFinding = {
      suggestionId,
      findingToken: encodeFinding(row.finding, 'report'),
      finding: row.finding,
      axis: row.axis,
      severity: row.severity,
      detail: row.detail,
      ...(row.recommendation !== undefined ? { recommendation: row.recommendation } : {}),
      ...(row.turnIndexes !== undefined ? { turnIndexes: row.turnIndexes } : {}),
      catalogMatchIds: matches.map((match) => match.id),
    }
    const catalogStart = bundle.catalogMatches.length
    bundle.catalogMatches.push(...matches)
    bundle.findings.push(finding)
    bundle.selectedFindings = bundle.findings.length
    bundle.truncated = bundle.selectedFindings < rows.length
    if (utf8Bytes(JSON.stringify(bundle)) > MAX_EVIDENCE_OUTPUT_BYTES) {
      bundle.catalogMatches.splice(catalogStart)
      bundle.findings.pop()
      bundle.selectedFindings = bundle.findings.length
      bundle.truncated = true
      break
    }
  }
  return bundle
}

/** Parse a bounded JSON artifact, then apply the same validation/projection as in-memory inputs. */
export function parseEvidenceArtifact(text: string, options: ProjectEvidenceOptions = {}): EvidenceBundle {
  const bytes = utf8Bytes(text)
  if (bytes > MAX_EVIDENCE_ARTIFACT_BYTES) throw new Error(`evidence artifact exceeds ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return projectEvidence(value, options)
}

/** Exact compact JSON size of the projected bundle; the bundle itself is not included. */
export function estimateEvidence(bundle: EvidenceBundle): EvidenceEstimate {
  const bytes = utf8Bytes(JSON.stringify(bundle))
  const approxTokens = Math.ceil(bytes / 4)
  return {
    bytes,
    approxTokens,
    thresholdTokens: ESTIMATE_TOKEN_THRESHOLD,
    overThreshold: approxTokens > ESTIMATE_TOKEN_THRESHOLD,
  }
}
