/**
 * SuggestionStore: append-only JSONL at <oranguHome>/suggestions.jsonl; proposal bodies live at
 * <oranguHome>/proposals/<id>.md. The current state of an id is the LAST line with that id; we never
 * rewrite history. Corrupt lines are skipped (a bad line is never an error, same ethos as the parser).
 * State machine enforced via TRANSITIONS; illegal moves throw.
 *
 * Writes are serialized: concurrent replay→check→append races could otherwise resurrect a
 * terminal state (e.g. rejected → kicked-off). In-process, every mutation runs through a promise
 * queue; cross-process (serve + an explicitly invoked CLI are two designed writers to the same file), each
 * mutation holds a zero-dep advisory lock (a `suggestions.jsonl.lock` directory, since mkdir is atomic,
 * with a stale-lock timeout) and re-replays + re-validates INSIDE the lock before appending.
 */
import { appendFile, chmod, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { oranguHome } from '../util/home.js'
import { redactValue } from '../redact/redact.js'
import { isChangeClass } from './change-classes.js'
import { isSuggestionId, normalizeSessionIds, suggestionId, suggestionIdV2, suggestionKey } from './id.js'
import { canonicalReviewedPath, reviewedPathKey, reviewedPathViolation } from './reviewed-path.js'
import { proposalSourcesAreCanonical } from './source-provenance.js'
import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  TRANSITIONS,
  type Finding,
  type SuggestionApplicationReceipt,
  type SuggestionProposal,
  type SuggestionRecord,
  type SuggestionSource,
  type SuggestionStatus,
  type SuggestionStoreLike,
  type SuggestionVerificationIntent,
  type SuggestionVerificationReceipt,
} from './types.js'
import {
  hasUniqueVerificationIntents,
  sameVerificationIntentSequence,
  verificationCheckName,
  verificationReceiptSummary,
} from './verification-policy.js'

/** lock older than this is a dead writer's leftover and may be broken */
const LOCK_STALE_MS = 10_000
/** give up acquiring after this long; a mutation is a few fs calls, never seconds */
const LOCK_TIMEOUT_MS = 5_000

type TransitionPatch = Partial<Pick<SuggestionRecord, 'proposal' | 'application' | 'verificationReceipt' | 'kickoff' | 'effect'>>
type PatchField = keyof TransitionPatch

const PATCH_FIELDS: PatchField[] = ['proposal', 'application', 'verificationReceipt', 'kickoff', 'effect']
const ALLOWED_PATCH_FIELDS: Record<SuggestionStatus, PatchField[]> = {
  new: [],
  'kicked-off': ['kickoff'],
  proposed: ['proposal'],
  applied: ['application'],
  verified: ['verificationReceipt', 'effect'],
  rejected: [],
  failed: ['kickoff'],
}

function recordMatchesFinding(record: SuggestionRecord, finding: Finding, source: SuggestionSource): boolean {
  return (
    record.source === source &&
    record.scope === finding.scope &&
    record.ruleId === finding.ruleId &&
    (record.insightId ?? '') === (finding.insightId ?? '') &&
    (record.cohortFingerprint ?? record.key?.cohortFingerprint ?? '') === (finding.cohortFingerprint ?? '') &&
    JSON.stringify(normalizeSessionIds(record.sessionIds)) === JSON.stringify(normalizeSessionIds(finding.sessionIds))
  )
}

function assertSafeFindingIdentity(finding: Finding): void {
  const values = [finding.ruleId, finding.insightId, ...finding.sessionIds].filter((value): value is string => typeof value === 'string')
  if (values.some((value) => redactValue(value, { scrub: true }) !== value)) {
    throw new Error('suggestion identity contains sensitive material; redact the identifier before creating it')
  }
}

function lifecycleError(to: SuggestionStatus, message: string): Error {
  return new Error(`invalid transition patch for ${to}: ${message}`)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function safeReviewedFile(value: unknown): value is string {
  return nonEmptyString(value) && reviewedPathViolation(value) === undefined && canonicalReviewedPath(value) === value
}

function hasUniqueReviewedFiles(files: string[]): boolean {
  const keys = files.map((file) => reviewedPathKey(file))
  return keys.every((key): key is string => key !== undefined) && new Set(keys).size === keys.length
}

function assertProposal(value: unknown, to: SuggestionStatus): asserts value is SuggestionProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw lifecycleError(to, 'proposal is required')
  const proposal = value as Partial<SuggestionProposal>
  if (!nonEmptyString(proposal.title) || !nonEmptyString(proposal.change) || !nonEmptyString(proposal.proposalPath)) {
    throw lifecycleError(to, 'proposal must include title, change, and proposalPath')
  }
  if (proposal.effort !== 'S' && proposal.effort !== 'M' && proposal.effort !== 'L') {
    throw lifecycleError(to, 'proposal effort must be S, M, or L')
  }
}

function assertStructuredProposal(
  value: unknown,
  to: SuggestionStatus,
): asserts value is SuggestionProposal & { v: 1; files: string[]; verificationChecks: SuggestionVerificationIntent[] } {
  assertProposal(value, to)
  if (
    value.v !== 1 ||
    !nonEmptyString(value.manifestPath) ||
    !value.changeClass ||
    !isChangeClass(value.changeClass) ||
    !nonEmptyString(value.evidence) ||
    !nonEmptyString(value.expectedEffect) ||
    !nonEmptyString(value.risk) ||
    !nonEmptyString(value.verification) ||
    !value.workspace ||
    !isAbsolute(value.workspace.cwd) ||
    !/^\d+$/.test(value.workspace.device) ||
    !/^\d+$/.test(value.workspace.inode) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 64 ||
    !value.files.every(safeReviewedFile) ||
    !hasUniqueReviewedFiles(value.files) ||
    !proposalSourcesAreCanonical(value.sources) ||
    !Array.isArray(value.verificationChecks) ||
    value.verificationChecks.length === 0 ||
    value.verificationChecks.length > 32 ||
    !value.verificationChecks.every(
      (check) =>
        check &&
        typeof check === 'object' &&
        SUGGESTION_VERIFICATION_METRICS.includes(check.metric) &&
        SUGGESTION_VERIFICATION_COMPARISONS.includes(check.comparison),
    ) ||
    !hasUniqueVerificationIntents(value.verificationChecks)
  ) {
    throw lifecycleError(to, 'a structured proposal with a manifest, reviewed files, and bounded unique verificationChecks is required')
  }
}

function assertApplication(value: unknown, to: SuggestionStatus): asserts value is SuggestionApplicationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw lifecycleError(to, 'application receipt is required')
  const application = value as Partial<SuggestionApplicationReceipt>
  if (
    application.v !== 1 ||
    !nonEmptyString(application.summary) ||
    !nonEmptyString(application.receiptPath) ||
    !Array.isArray(application.files) ||
    application.files.length === 0 ||
    application.files.length > 64 ||
    !application.files.every(safeReviewedFile) ||
    !hasUniqueReviewedFiles(application.files) ||
    !Array.isArray(application.checks) ||
    application.checks.length === 0 ||
    application.checks.length > 32 ||
    !application.checks.every(
      (check) =>
        check &&
        typeof check === 'object' &&
        check.ok === true &&
        nonEmptyString(check.name) &&
        (check.command === undefined || nonEmptyString(check.command)),
    )
  ) {
    throw lifecycleError(to, 'application receipt must be structured, name changed files, and contain successful checks')
  }
}

function assertVerification(value: unknown, to: SuggestionStatus): asserts value is SuggestionVerificationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw lifecycleError(to, 'verification receipt is required')
  const verification = value as Partial<SuggestionVerificationReceipt>
  if (
    verification.v !== 1 ||
    !nonEmptyString(verification.summary) ||
    !nonEmptyString(verification.receiptPath) ||
    !Array.isArray(verification.measuredSessionIds) ||
    verification.measuredSessionIds.length === 0 ||
    verification.measuredSessionIds.length > 50 ||
    !verification.measuredSessionIds.every(nonEmptyString) ||
    new Set(verification.measuredSessionIds).size !== verification.measuredSessionIds.length ||
    !Array.isArray(verification.checks) ||
    verification.checks.length === 0 ||
    verification.checks.length > 32 ||
    !verification.checks.every(
      (check) =>
        check &&
        typeof check === 'object' &&
        check.ok === true &&
        nonEmptyString(check.name) &&
        SUGGESTION_VERIFICATION_METRICS.includes(check.metric) &&
        SUGGESTION_VERIFICATION_COMPARISONS.includes(check.comparison) &&
        typeof check.before === 'number' &&
        Number.isFinite(check.before) &&
        typeof check.after === 'number' &&
        Number.isFinite(check.after) &&
        nonEmptyString(check.evidence),
    )
  ) {
    throw lifecycleError(to, 'verification receipt must be structured and contain measured sessions and successful checks')
  }
  if (
    !hasUniqueVerificationIntents(verification.checks) ||
    verification.checks.some((check) => check.name !== verificationCheckName(check)) ||
    verification.summary !== verificationReceiptSummary(verification.checks)
  ) {
    throw lifecycleError(to, 'verification receipt summary and check names must be deterministic from unique metric/comparison pairs')
  }
}

function assertVerificationEffect(
  value: unknown,
  receipt: SuggestionVerificationReceipt,
  to: SuggestionStatus,
): asserts value is NonNullable<SuggestionRecord['effect']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw lifecycleError(to, 'computed verification effect is required')
  const effect = value as Partial<NonNullable<SuggestionRecord['effect']>>
  if (!effect.before || typeof effect.before !== 'object' || Array.isArray(effect.before) || !effect.after || typeof effect.after !== 'object' || Array.isArray(effect.after)) {
    throw lifecycleError(to, 'computed verification effect must contain before and after maps')
  }
  if (!Array.isArray(effect.measuredSessionIds) || JSON.stringify(effect.measuredSessionIds) !== JSON.stringify(receipt.measuredSessionIds)) {
    throw lifecycleError(to, 'verification effect session ids must exactly match the receipt')
  }
  const expectedBefore = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.before]))
  const expectedAfter = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.after]))
  const canonical = (record: Record<string, number>) => JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
  if (canonical(effect.before as Record<string, number>) !== canonical(expectedBefore) || canonical(effect.after as Record<string, number>) !== canonical(expectedAfter)) {
    throw lifecycleError(to, 'verification effect values must exactly match the computed receipt checks')
  }
}

function validateTransitionPatch(current: SuggestionRecord, to: SuggestionStatus, rawPatch?: TransitionPatch): TransitionPatch {
  if (rawPatch !== undefined && (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch))) {
    throw lifecycleError(to, 'patch must be an object')
  }
  const patch = rawPatch ?? {}
  const keys = Object.keys(patch)
  const unknown = keys.find((key) => !PATCH_FIELDS.includes(key as PatchField))
  if (unknown) throw lifecycleError(to, `field "${unknown}" is not a lifecycle artifact`)
  const allowed = ALLOWED_PATCH_FIELDS[to]
  const unrelated = keys.find((key) => !allowed.includes(key as PatchField))
  if (unrelated) throw lifecycleError(to, `field "${unrelated}" is not valid for this transition`)

  if (to === 'proposed') {
    assertProposal(patch.proposal, to)
    if (patch.proposal.v === 1) assertStructuredProposal(patch.proposal, to)
  } else if (to === 'applied') {
    if (current.scope === 'global') {
      throw lifecycleError(to, 'global suggestions cannot be applied; create a repo- or session-scoped suggestion for a concrete change instead')
    }
    assertStructuredProposal(current.proposal, to)
    assertApplication(patch.application, to)
    const reviewed = [...new Set(current.proposal.files)].sort()
    const changed = [...new Set(patch.application.files)].sort()
    if (JSON.stringify(reviewed) !== JSON.stringify(changed)) {
      throw lifecycleError(to, 'application files must exactly match the reviewed proposal files')
    }
  } else if (to === 'verified') {
    if (current.scope !== 'session') {
      throw lifecycleError(to, 'repo/global suggestions cannot be verified; verify a session-scoped suggestion against later supported sessions instead')
    }
    assertStructuredProposal(current.proposal, to)
    assertApplication(current.application, to)
    assertVerification(patch.verificationReceipt, to)
    if (!sameVerificationIntentSequence(current.proposal.verificationChecks, patch.verificationReceipt.checks)) {
      throw lifecycleError(to, 'verification receipt checks must exactly match the reviewed proposal verificationChecks')
    }
    assertVerificationEffect(patch.effect, patch.verificationReceipt, to)
  }
  return patch
}

export class SuggestionStore implements SuggestionStoreLike {
  readonly path: string
  readonly proposalsDir: string
  private readonly now: () => number
  /** in-process write queue: mutations run strictly one after another */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(o: { home?: string; now?: () => number } = {}) {
    const home = o.home ?? oranguHome()
    this.path = join(home, 'suggestions.jsonl')
    this.proposalsDir = join(home, 'proposals')
    this.now = o.now ?? Date.now
  }

  private get lockPath(): string {
    return this.path + '.lock'
  }

  /** cross-process advisory lock: an atomic mkdir beside the jsonl, stale locks broken by mtime */
  private async acquireLock(): Promise<void> {
    await this.ensurePrivateDir(dirname(this.path))
    const t0 = Date.now()
    for (;;) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 })
        return
      } catch {
        /* held; check staleness below */
      }
      try {
        const st = await stat(this.lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(this.lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue // vanished between attempts; retry immediately
      }
      if (Date.now() - t0 > LOCK_TIMEOUT_MS) throw new Error(`suggestion store lock timed out: ${this.lockPath}`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await rm(this.lockPath, { recursive: true, force: true })
    } catch {
      /* nothing to release */
    }
  }

  /** every mutation = in-process queue → cross-process lock → replay+validate+append inside */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.acquireLock()
      try {
        return await fn()
      } finally {
        await this.releaseLock()
      }
    }
    const p = this.chain.then(run, run)
    this.chain = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  /**
   * Replay the log; last line per canonical id wins; corrupt lines are skipped.
   * A migrated v2 record is also indexed by each legacy id so old links and CLI
   * commands keep resolving without duplicating it in `all()`.
   */
  private async replay(): Promise<Map<string, SuggestionRecord>> {
    const canonical = new Map<string, SuggestionRecord>()
    let text: string
    if (process.platform !== 'win32') {
      await Promise.all([this.hardenExistingDir(dirname(this.path)), this.hardenExistingDir(this.proposalsDir)])
      try {
        await chmod(this.path, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return canonical
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed) as SuggestionRecord
        if (rec && typeof rec === 'object' && isSuggestionId(rec.id) && typeof rec.status === 'string') canonical.set(rec.id, rec)
      } catch {
        /* corrupt line: skip, keep going */
      }
    }
    const byId = new Map(canonical)
    for (const rec of canonical.values()) {
      for (const legacyId of rec.legacyIds ?? []) {
        if (isSuggestionId(legacyId)) byId.set(legacyId, rec)
      }
    }
    return byId
  }

  private async append(rec: SuggestionRecord): Promise<void> {
    await this.ensurePrivateDir(dirname(this.path))
    await this.ensurePrivateDir(this.proposalsDir)
    if (process.platform !== 'win32') {
      try {
        await chmod(this.path, 0o600)
      } catch (error) {
        // The first append creates the file with the private mode below.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await appendFile(this.path, JSON.stringify(rec) + '\n', { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') await chmod(this.path, 0o600)
  }

  private async ensurePrivateDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(path, 0o700)
  }

  private async hardenExistingDir(path: string): Promise<void> {
    try {
      await chmod(path, 0o700)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async all(): Promise<SuggestionRecord[]> {
    const unique = new Map<string, SuggestionRecord>()
    for (const rec of (await this.replay()).values()) unique.set(rec.id, rec)
    return [...unique.values()].sort((a, b) => b.statusAt - a.statusAt)
  }

  async get(id: string): Promise<SuggestionRecord | undefined> {
    return (await this.replay()).get(id)
  }

  /**
   * Create-or-get: a re-click refreshes a still-new record; once lifecycle work
   * starts, statusAt remains the transition timestamp. An explicit file-handoff
   * id must hash to the canonical identity or the exact legacy report identity.
   */
  async upsertNew(f: Finding, source: SuggestionSource, explicitId?: string): Promise<{ record: SuggestionRecord; created: boolean }> {
    return this.serialized(() => this.upsertNewLocked(f, source, explicitId))
  }

  private async upsertNewLocked(f: Finding, source: SuggestionSource, explicitId?: string): Promise<{ record: SuggestionRecord; created: boolean }> {
    assertSafeFindingIdentity(f)
    const key = suggestionKey(f, source)
    const canonicalId = suggestionIdV2(key)
    const legacyId = suggestionId(source, f.ruleId, f.sessionIds)
    const acceptsLegacyId = source === 'report' && !f.cohortFingerprint
    if (explicitId && explicitId !== canonicalId && !(acceptsLegacyId && explicitId === legacyId)) {
      throw new Error(`suggestion id identity mismatch: expected ${canonicalId}${acceptsLegacyId ? ` or legacy ${legacyId}` : ''}, got ${explicitId}`)
    }
    const id = explicitId ?? canonicalId
    const records = await this.replay()
    const existing = records.get(id)
    const ts = this.now()
    if (existing) {
      if (!recordMatchesFinding(existing, f, source)) {
        throw new Error(`suggestion id identity mismatch: ${id} belongs to a different finding`)
      }
      // `statusAt` is the timestamp of the current lifecycle state (not a
      // last-viewed timestamp). In particular, later verification uses the
      // applied timestamp, so a repeated handoff must not move it forward.
      if (existing.status !== 'new') return { record: existing, created: false }
      const refreshed: SuggestionRecord = { ...existing, title: f.title, evidence: f.evidence, statusAt: ts }
      await this.append(refreshed)
      return { record: refreshed, created: false }
    }

    // On the first v2 write for a finding, migrate an addressable v1 record instead
    // of starting its lifecycle over. The append preserves history and the alias
    // keeps old URLs/flags working; lifecycle artifacts, effect, and kickoff survive intact.
    if (id === canonicalId && !f.cohortFingerprint) {
      const legacy = records.get(legacyId)
      const sameLegacyFinding = legacy?.v === 1 && recordMatchesFinding(legacy, f, source)
      if (legacy && sameLegacyFinding) {
        const migrated: SuggestionRecord = {
          ...legacy,
          id: canonicalId,
          v: 2,
          key,
          legacyIds: [...new Set([...(legacy.legacyIds ?? []), legacy.id])].sort(),
          source,
          scope: f.scope,
          sessionIds: key.sessionIds,
          ruleId: f.ruleId,
          title: f.title,
          ...(f.insightId ? { insightId: f.insightId } : {}),
          ...(f.cohortFingerprint ? { cohortFingerprint: f.cohortFingerprint } : {}),
          evidence: f.evidence,
          // Migration changes identity, not lifecycle state. Preserve the
          // applied timestamp because later verification is ordered against it.
          statusAt: Number.isFinite(legacy.statusAt) && legacy.statusAt > 0 ? legacy.statusAt : ts,
        }
        await this.append(migrated)
        return { record: migrated, created: false }
      }
    }

    const isCanonical = id === canonicalId
    const record: SuggestionRecord = {
      id,
      v: isCanonical ? 2 : 1,
      ...(isCanonical ? { key } : {}),
      createdAt: ts,
      source,
      scope: f.scope,
      sessionIds: isCanonical ? key.sessionIds : [...f.sessionIds].sort(),
      ruleId: f.ruleId,
      title: f.title,
      ...(f.insightId ? { insightId: f.insightId } : {}),
      ...(f.cohortFingerprint ? { cohortFingerprint: f.cohortFingerprint } : {}),
      evidence: f.evidence,
      status: 'new',
      statusAt: ts,
    }
    await this.append(record)
    return { record, created: true }
  }

  async transition(
    id: string,
    to: SuggestionStatus,
    patch?: TransitionPatch,
  ): Promise<SuggestionRecord> {
    return this.serialized(() => this.transitionLocked(id, to, patch))
  }

  private async transitionLocked(
    id: string,
    to: SuggestionStatus,
    patch?: TransitionPatch,
  ): Promise<SuggestionRecord> {
    // replayed INSIDE the lock: another writer's append since our caller last looked is now visible
    const current = (await this.replay()).get(id)
    if (!current) throw new Error(`suggestion ${id} not found in ${this.path}`)
    const allowed = TRANSITIONS[current.status] ?? []
    if (!allowed.includes(to)) {
      throw new Error(`illegal transition ${current.status} → ${to} for ${id} (allowed: ${allowed.join(', ') || 'none'})`)
    }
    const safePatch = validateTransitionPatch(current, to, patch)
    const next: SuggestionRecord = {
      ...current,
      ...safePatch,
      ...(to === 'verified' ? { verificationTrust: 'computed-v1' as const } : {}),
      status: to,
      statusAt: this.now(),
    }
    await this.append(next)
    return next
  }
}
