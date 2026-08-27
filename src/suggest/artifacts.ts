/**
 * Validation boundary for skill-authored lifecycle artifacts.
 *
 * The append-only suggestion store never trusts a Markdown path or arbitrary JSON.
 * Every artifact must be a small regular (non-symlink) file inside this store's
 * proposals directory, use the record's exact id, and satisfy the versioned shape
 * below before any lifecycle transition is recorded.
 */
import { constants, type BigIntStats } from 'node:fs'
import { chmod, lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { isChangeClass } from './change-classes.js'
import { canonicalReviewedPath, reviewedPathKey, reviewedPathViolation } from './reviewed-path.js'
import { normalizeProposalSources } from './source-provenance.js'
import type {
  SuggestionApplicationCheck,
  SuggestionApplicationReceipt,
  SuggestionProposal,
  SuggestionWorkspaceIdentity,
  SuggestionVerificationComparison,
  SuggestionVerificationCheck,
  SuggestionVerificationIntent,
  SuggestionVerificationMetric,
  SuggestionVerificationReceipt,
} from './types.js'
import { SUGGESTION_VERIFICATION_COMPARISONS, SUGGESTION_VERIFICATION_METRICS } from './types.js'
import {
  hasUniqueVerificationIntents,
  sameVerificationIntentSet,
  verificationCheckName,
  verificationReceiptSummary,
} from './verification-policy.js'

const MAX_JSON_BYTES = 64 * 1024
const MAX_MARKDOWN_BYTES = 256 * 1024
const MAX_FILES = 64
const MAX_CHECKS = 32
const MAX_VERIFICATION_SESSIONS = 50
const ID_RE = /^sg_[0-9a-f]{12}$/

type JsonObject = Record<string, unknown>

interface LoadedVerification {
  receipt: SuggestionVerificationReceipt
  effect: { before: Record<string, number>; after: Record<string, number>; measuredSessionIds: string[] }
}

interface VerificationAnalysis {
  session: { id: string; source: string; cwd?: string; startedAt?: number; endedAt?: number; live: boolean }
  summary: {
    totalTokens: number
    toolCalls: number
    toolErrors: number
    activeMs: number
    contextPeak: number
    outcomes: { testRunsFailed: number; buildRunsFailed: number }
  }
  turns: Array<{ interrupted: boolean }>
}

interface VerificationContext {
  baselineSessionIds: string[]
  applicationStatusAt: number
  expectedChecks: SuggestionVerificationIntent[]
  /** Canonical path and filesystem identity captured with the reviewed proposal. */
  workspace: SuggestionWorkspaceIdentity
  loadAnalysis: (selector: string) => Promise<VerificationAnalysis | undefined>
}

interface ResolvedAnalysis {
  id: string
  startedAt: number
  endedAt?: number
  live: boolean
  metrics: Record<SuggestionVerificationMetric, number>
}

function artifactError(message: string): Error {
  return new Error(`invalid suggestion artifact: ${message}`)
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw artifactError(`${label} must be an object`)
  return value as JsonObject
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw artifactError(`${label} must be a string`)
  const result = value.trim()
  if (!result || result.length > max || result.includes('\0')) throw artifactError(`${label} must contain 1-${max} safe characters`)
  return result
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, label, max)
}

function versionAndId(value: JsonObject, id: string): void {
  if (value['v'] !== 1) throw artifactError('v must be 1')
  if (!ID_RE.test(id) || value['id'] !== id) throw artifactError(`id must exactly match ${id}`)
}

function safeRepoFile(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || value.includes('\0')) {
    throw artifactError(`${label} must contain 1-500 safe characters`)
  }
  // Do not trim paths: a trailing dot/space is security-significant on Windows.
  const violation = reviewedPathViolation(value)
  if (violation) throw artifactError(`${label} ${violation}`)
  const canonical = canonicalReviewedPath(value)
  if (!canonical) throw artifactError(`${label} could not be canonicalized`)
  return canonical
}

function files(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > MAX_FILES || (required && value.length === 0)) {
    throw artifactError(`${label} must contain ${required ? '1-' : '0-'}${MAX_FILES} file paths`)
  }
  const result = value.map((item, index) => safeRepoFile(item, `${label}[${index}]`))
  if (new Set(result.map((file) => reviewedPathKey(file))).size !== result.length) {
    throw artifactError(`${label} must not contain duplicate or platform-aliased paths`)
  }
  return result
}

function checks<T>(value: unknown, parse: (item: JsonObject, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    throw artifactError(`checks must contain 1-${MAX_CHECKS} successful checks`)
  }
  return value.map((item, index) => parse(object(item, `checks[${index}]`), index))
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

interface ArtifactSnapshot {
  dev: bigint
  ino: bigint
  mode: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function artifactSnapshot(stat: BigIntStats): ArtifactSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

function sameArtifactSnapshot(a: ArtifactSnapshot, b: ArtifactSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

async function readArtifact(proposalsDir: string, path: string, expectedName: string, maxBytes: number): Promise<{ path: string; body: string }> {
  const root = resolve(proposalsDir)
  const candidate = resolve(path)
  if (!inside(root, candidate) || basename(candidate) !== expectedName) {
    throw artifactError(`${expectedName} must be inside ${root}`)
  }
  let rootStat: BigIntStats
  let stat: BigIntStats
  try {
    ;[rootStat, stat] = await Promise.all([lstat(root, { bigint: true }), lstat(candidate, { bigint: true })])
  } catch {
    throw artifactError(`${expectedName} does not exist`)
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw artifactError(`proposals directory must be a regular directory`)
  if (!stat.isFile() || stat.isSymbolicLink()) throw artifactError(`${expectedName} must be a regular, non-symlink file`)
  if (stat.nlink !== 1n) throw artifactError(`${expectedName} must have exactly one hard link`)
  if (stat.size > BigInt(maxBytes)) throw artifactError(`${expectedName} exceeds ${maxBytes} bytes`)
  if (process.platform !== 'win32') await chmod(root, 0o700)
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  if (!inside(realRoot, realCandidate)) throw artifactError(`${expectedName} resolves outside ${realRoot}`)
  const initial = artifactSnapshot(stat)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(realCandidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    throw artifactError(`${expectedName} changed before it was read`)
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || !sameArtifactSnapshot(initial, artifactSnapshot(before))) {
      throw artifactError(`${expectedName} changed before it was read`)
    }
    if (process.platform !== 'win32') await handle.chmod(0o600)
    const [secured, securedPath, securedReal] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(candidate, { bigint: true }),
      realpath(candidate),
    ])
    if (
      secured.nlink !== 1n ||
      securedPath.nlink !== 1n ||
      securedPath.isSymbolicLink() ||
      securedReal !== realCandidate ||
      !sameArtifactSnapshot(artifactSnapshot(secured), artifactSnapshot(securedPath))
    ) {
      throw artifactError(`${expectedName} changed before it was read`)
    }
    const expected = artifactSnapshot(secured)
    const buffer = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const [after, pathAfter, realAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(candidate, { bigint: true }),
      realpath(candidate),
    ])
    if (
      offset !== buffer.length ||
      after.nlink !== 1n ||
      pathAfter.nlink !== 1n ||
      pathAfter.isSymbolicLink() ||
      realAfter !== realCandidate ||
      !sameArtifactSnapshot(expected, artifactSnapshot(after)) ||
      !sameArtifactSnapshot(expected, artifactSnapshot(pathAfter))
    ) {
      throw artifactError(`${expectedName} changed while it was being read`)
    }
    return { path: candidate, body: buffer.toString('utf8') }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid suggestion artifact:')) throw error
    throw artifactError(`${expectedName} changed while it was being read`)
  } finally {
    await handle.close()
  }
}

async function readJsonArtifact(proposalsDir: string, path: string, expectedName: string): Promise<{ path: string; value: JsonObject }> {
  const loaded = await readArtifact(proposalsDir, path, expectedName, MAX_JSON_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(loaded.body)
  } catch {
    throw artifactError(`${expectedName} is not valid JSON`)
  }
  return { path: loaded.path, value: object(parsed, expectedName) }
}

export async function loadProposalArtifacts(
  proposalsDir: string,
  id: string,
  proposalPath: string,
  manifestPath?: string,
  workspace?: SuggestionWorkspaceIdentity,
): Promise<SuggestionProposal> {
  const markdown = await readArtifact(proposalsDir, proposalPath, `${id}.md`, MAX_MARKDOWN_BYTES)
  if (!manifestPath) {
    // Backward compatibility for proposals produced by orangu <= 0.4.2. New skills
    // always write the manifest and therefore receive the stronger contract below.
    return { title: id, change: `see ${markdown.path}`, effort: 'M', proposalPath: markdown.path }
  }

  const { path, value } = await readJsonArtifact(proposalsDir, manifestPath, `${id}.json`)
  if (!workspace || !isAbsolute(workspace.cwd) || !/^\d+$/.test(workspace.device) || !/^\d+$/.test(workspace.inode)) {
    throw artifactError('structured proposals require a canonical workspace identity')
  }
  versionAndId(value, id)
  const changeClass = text(value['changeClass'], 'changeClass', 50)
  if (!isChangeClass(changeClass)) throw artifactError(`changeClass "${changeClass}" is not supported`)
  const effort = value['effort']
  if (effort !== 'S' && effort !== 'M' && effort !== 'L') throw artifactError('effort must be S, M, or L')
  const proposalFiles = files(value['files'], 'files', true)
  const verificationChecks = verificationPairs(value['verificationChecks'], 'verificationChecks')
  const rank = value['rank']
  if (rank !== undefined && (!Number.isInteger(rank) || (rank as number) < 1 || (rank as number) > 100)) {
    throw artifactError('rank must be an integer from 1-100')
  }
  const normalizedSources = normalizeProposalSources(value['sources'])
  if (normalizedSources.error) throw artifactError(normalizedSources.error)
  const sources = normalizedSources.sources
  return {
    v: 1,
    title: text(value['title'], 'title', 200),
    change: text(value['change'], 'change', 8_000),
    effort,
    files: proposalFiles,
    proposalPath: markdown.path,
    manifestPath: path,
    changeClass,
    evidence: text(value['evidence'], 'evidence', 12_000),
    expectedEffect: text(value['expectedEffect'], 'expectedEffect', 4_000),
    risk: text(value['risk'], 'risk', 4_000),
    verification: text(value['verification'], 'verification', 4_000),
    verificationChecks,
    ...(sources ? { sources } : {}),
    ...(rank !== undefined ? { rank: rank as number } : {}),
    workspace,
  }
}

export async function loadApplicationReceipt(
  proposalsDir: string,
  id: string,
  receiptPath: string,
  reviewedFiles: string[],
): Promise<SuggestionApplicationReceipt> {
  const { path, value } = await readJsonArtifact(proposalsDir, receiptPath, `${id}.applied.json`)
  versionAndId(value, id)
  const applicationChecks = checks<SuggestionApplicationCheck>(value['checks'], (item, index) => {
    if (item['ok'] !== true) throw artifactError(`checks[${index}].ok must be true`)
    return {
      name: text(item['name'], `checks[${index}].name`, 300),
      ...(item['command'] !== undefined ? { command: text(item['command'], `checks[${index}].command`, 2_000) } : {}),
      ok: true,
    }
  })
  const appliedFiles = files(value['files'], 'files', true)
  if (JSON.stringify([...appliedFiles].sort()) !== JSON.stringify([...reviewedFiles].sort())) {
    throw artifactError('application files must exactly match the reviewed proposal files')
  }
  return {
    v: 1,
    summary: text(value['summary'], 'summary', 4_000),
    files: appliedFiles,
    checks: applicationChecks,
    receiptPath: path,
  }
}

export async function loadVerificationReceipt(
  proposalsDir: string,
  id: string,
  receiptPath: string,
  context: VerificationContext,
): Promise<LoadedVerification> {
  const { path, value } = await readJsonArtifact(proposalsDir, receiptPath, `${id}.verified.json`)
  versionAndId(value, id)
  if (!Number.isFinite(context.applicationStatusAt) || context.applicationStatusAt <= 0) {
    throw artifactError('application status timestamp is missing or invalid')
  }
  optionalText(value['summary'], 'summary', 4_000)
  const baselineSelectors = sessionSelectors(context.baselineSessionIds, 'baselineSessionIds')
  const laterSelectors = sessionSelectors(value['measuredSessionIds'], 'measuredSessionIds')
  const intents = verificationIntents(value, context.expectedChecks)
  const workspaceCwd = await canonicalWorkspace(context.workspace)

  // The loader owns one aggregate transcript-byte budget. Keep resolution
  // sequential so at most one bounded raw session is resident at a time.
  const baseline = await resolveAnalyses(baselineSelectors, 'baselineSessionIds', workspaceCwd, context.loadAnalysis)
  const later = await resolveAnalyses(laterSelectors, 'measuredSessionIds', workspaceCwd, context.loadAnalysis)
  // Recheck after transcript I/O so replacing the directory during resolution
  // cannot preserve trust merely because the canonical path stayed the same.
  await canonicalWorkspace(context.workspace)
  const measuredSessionIds = validateVerificationTimeline(baseline, later, context.applicationStatusAt)
  const computed = computeVerificationChecks(intents, baseline, later)
  return {
    receipt: {
      v: 1,
      summary: verificationReceiptSummary(computed.checks),
      measuredSessionIds,
      checks: computed.checks,
      receiptPath: path,
    },
    effect: { before: computed.before, after: computed.after, measuredSessionIds },
  }
}

function verificationPairs(value: unknown, label: string): SuggestionVerificationIntent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    throw artifactError(`${label} must contain 1-${MAX_CHECKS} metric/comparison pairs`)
  }
  const result = value.map((raw, index) => {
    const item = object(raw, `${label}[${index}]`)
    const metric = item['metric']
    if (!isVerificationMetric(metric)) throw artifactError(`${label}[${index}].metric is not supported`)
    const comparison = item['comparison']
    if (!isVerificationComparison(comparison)) throw artifactError(`${label}[${index}].comparison is not supported`)
    return { metric, comparison }
  })
  if (!hasUniqueVerificationIntents(result)) throw artifactError(`${label} must not contain duplicate metric/comparison pairs`)
  return result
}

function verificationIntents(value: JsonObject, expectedChecks: SuggestionVerificationIntent[]): SuggestionVerificationIntent[] {
  if (value['before'] !== undefined || value['after'] !== undefined) {
    throw artifactError('before and after must be omitted; Orangu computes metrics from resolved sessions')
  }
  if (Array.isArray(value['checks'])) {
    value['checks'].forEach((raw, index) => {
      const item = object(raw, `checks[${index}]`)
      const selfAttested = ['ok', 'before', 'after', 'evidence'].find((field) => item[field] !== undefined)
      if (selfAttested) throw artifactError(`checks[${index}] must omit ok, before, after, and evidence; Orangu computes them`)
      optionalText(item['name'], `checks[${index}].name`, 300)
    })
  }
  const intents = verificationPairs(value['checks'], 'checks')
  const reviewed = verificationPairs(expectedChecks, 'expected verificationChecks')
  if (!sameVerificationIntentSet(intents, reviewed)) {
    throw artifactError('checks must exactly match the reviewed proposal verificationChecks')
  }
  // The reviewed proposal owns canonical order; receipt order is not model-controlled.
  return reviewed
}

function validateVerificationTimeline(baseline: ResolvedAnalysis[], later: ResolvedAnalysis[], applicationStatusAt: number): string[] {
  if (new Set(baseline.map((entry) => entry.id)).size !== baseline.length) {
    throw artifactError('baselineSessionIds must resolve to distinct sessions')
  }
  const baselineIds = new Set(baseline.map((entry) => entry.id))
  if (later.some((entry) => baselineIds.has(entry.id))) {
    throw artifactError('measuredSessionIds must resolve to later evidence, not a baseline session')
  }
  if (new Set(later.map((entry) => entry.id)).size !== later.length) {
    throw artifactError('measuredSessionIds must resolve to distinct sessions')
  }
  const baselineEndTimes = baseline.map((entry) => completedSessionEnd(entry, 'baseline'))
  later.forEach((entry) => completedSessionEnd(entry, 'measured'))
  const baselineMaxStartedAt = Math.max(...baseline.map((entry) => entry.startedAt))
  if (baselineMaxStartedAt > applicationStatusAt) {
    throw artifactError('baseline sessions must start no later than the application transition')
  }
  const baselineMaxEndedAt = Math.max(...baselineEndTimes)
  if (baselineMaxEndedAt > applicationStatusAt) {
    throw artifactError('baseline sessions must end no later than the application transition')
  }
  const notLater = later.find((entry) => entry.startedAt <= Math.max(applicationStatusAt, baselineMaxEndedAt))
  if (notLater) {
    throw artifactError(`measured session ${notLater.id} must start after the application transition and every baseline session`)
  }
  return later.map((entry) => entry.id).sort()
}

function completedSessionEnd(entry: ResolvedAnalysis, label: 'baseline' | 'measured'): number {
  if (entry.live !== false) {
    throw artifactError(`${label} session ${entry.id} is live and cannot be used for verification`)
  }
  if (typeof entry.endedAt !== 'number' || !Number.isFinite(entry.endedAt) || entry.endedAt <= 0) {
    throw artifactError(`${label} session ${entry.id} has no valid session end timestamp`)
  }
  if (entry.endedAt < entry.startedAt) {
    throw artifactError(`${label} session ${entry.id} ends before it starts`)
  }
  return entry.endedAt
}

function computeVerificationChecks(
  intents: SuggestionVerificationIntent[],
  baseline: ResolvedAnalysis[],
  later: ResolvedAnalysis[],
): { checks: SuggestionVerificationCheck[]; before: Record<string, number>; after: Record<string, number> } {
  const entries = intents.map((intent, index) => {
    const before = averageMetric(baseline, intent.metric)
    const after = averageMetric(later, intent.metric)
    if (!compareMetric(before, after, intent.comparison)) {
      throw artifactError(`checks[${index}] did not pass: ${intent.metric} ${intent.comparison} (before ${before}, after ${after})`)
    }
    const check: SuggestionVerificationCheck = {
      name: verificationCheckName(intent),
      metric: intent.metric,
      comparison: intent.comparison,
      before,
      after,
      evidence: `${intent.metric}: ${before} → ${after} (${intent.comparison})`,
      ok: true,
    }
    return check
  })
  return {
    checks: entries,
    before: Object.fromEntries(entries.map((check) => [check.metric, check.before])),
    after: Object.fromEntries(entries.map((check) => [check.metric, check.after])),
  }
}

function sessionSelectors(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VERIFICATION_SESSIONS) {
    throw artifactError(`${label} must contain 1-${MAX_VERIFICATION_SESSIONS} session selectors`)
  }
  const selectors = value.map((selector, index) => text(selector, `${label}[${index}]`, 2_048))
  if (new Set(selectors).size !== selectors.length) throw artifactError(`${label} must not contain duplicate selectors`)
  return selectors
}

function isVerificationMetric(value: unknown): value is SuggestionVerificationMetric {
  return SUGGESTION_VERIFICATION_METRICS.some((metric) => metric === value)
}

function isVerificationComparison(value: unknown): value is SuggestionVerificationComparison {
  return SUGGESTION_VERIFICATION_COMPARISONS.some((comparison) => comparison === value)
}

async function resolveAnalyses(
  selectors: string[],
  label: string,
  workspaceCwd: string,
  loadAnalysis: VerificationContext['loadAnalysis'],
): Promise<ResolvedAnalysis[]> {
  const loaded: ResolvedAnalysis[] = []
  for (let index = 0; index < selectors.length; index++) {
    const selector = selectors[index]!
    let analysis: VerificationAnalysis | undefined
    try {
      analysis = await loadAnalysis(selector)
    } catch {
      throw artifactError(`${label}[${index}] could not be resolved and analyzed`)
    }
    if (!analysis) throw artifactError(`${label}[${index}] could not be resolved and analyzed`)
    if (analysis.session.source !== 'claude-code') throw artifactError(`${label}[${index}] is not a supported Claude session`)
    let analysisCwd: string
    try {
      if (typeof analysis.session.cwd !== 'string' || !isAbsolute(analysis.session.cwd)) throw new Error('missing cwd')
      analysisCwd = await realpath(analysis.session.cwd)
    } catch {
      throw artifactError(`${label}[${index}] has no resolvable workspace cwd`)
    }
    if (analysisCwd !== workspaceCwd) throw artifactError(`${label}[${index}] belongs to a different workspace`)
    const id = text(analysis.session.id, `${label}[${index}] canonical id`, 500).toLowerCase()
    const startedAt = analysis.session.startedAt
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) {
      throw artifactError(`${label}[${index}] has no valid session start timestamp`)
    }
    loaded.push({
      id,
      startedAt,
      endedAt: analysis.session.endedAt,
      live: analysis.session.live,
      metrics: Object.fromEntries(SUGGESTION_VERIFICATION_METRICS.map((metric) => [metric, metricValue(analysis, metric)])) as Record<
        SuggestionVerificationMetric,
        number
      >,
    })
  }
  return loaded
}

async function canonicalWorkspace(value: SuggestionWorkspaceIdentity): Promise<string> {
  try {
    if (
      !value ||
      typeof value.cwd !== 'string' ||
      !isAbsolute(value.cwd) ||
      !/^\d+$/.test(value.device) ||
      !/^\d+$/.test(value.inode)
    ) {
      throw new Error('invalid identity')
    }
    const cwd = await realpath(value.cwd)
    const current = await stat(cwd, { bigint: true })
    if (
      !current.isDirectory() ||
      cwd !== value.cwd ||
      String(current.dev) !== value.device ||
      String(current.ino) !== value.inode
    ) {
      throw new Error('identity mismatch')
    }
    return cwd
  } catch {
    throw artifactError('reviewed proposal workspace identity no longer matches the current workspace')
  }
}

function averageMetric(analyses: ResolvedAnalysis[], metric: SuggestionVerificationMetric): number {
  const total = analyses.reduce((sum, entry) => sum + entry.metrics[metric], 0)
  return Number((total / analyses.length).toFixed(6))
}

function metricValue(analysis: VerificationAnalysis, metric: SuggestionVerificationMetric): number {
  const values: Record<SuggestionVerificationMetric, number> = {
    avgTotalTokens: analysis.summary.totalTokens,
    avgToolCalls: analysis.summary.toolCalls,
    avgToolErrors: analysis.summary.toolErrors,
    avgActiveMs: analysis.summary.activeMs,
    avgContextPeak: analysis.summary.contextPeak,
    avgTestRunsFailed: analysis.summary.outcomes.testRunsFailed,
    avgBuildRunsFailed: analysis.summary.outcomes.buildRunsFailed,
    avgInterruptions: analysis.turns.filter((turn) => turn.interrupted).length,
  }
  const value = values[metric]
  if (!Number.isFinite(value) || value < 0) throw artifactError(`resolved Analysis has an invalid ${metric} value`)
  return value
}

function compareMetric(before: number, after: number, comparison: SuggestionVerificationComparison): boolean {
  if (comparison === 'decreased') return after < before
  if (comparison === 'not-increased') return after <= before
  if (comparison === 'increased') return after > before
  if (comparison === 'not-decreased') return after >= before
  return after === before
}
