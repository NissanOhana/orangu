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
import { randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises'
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
/** Bound whole-log allocation and prevent appending a record the next replay cannot read. */
const MAX_SUGGESTION_STORE_BYTES = 64 * 1024 * 1024
/** Bound per-record decoding/JSON work and total replay iterations independently of file bytes. */
const MAX_SUGGESTION_RECORD_BYTES = 4 * 1024 * 1024
const MAX_SUGGESTION_STORE_LINES = 100_000
const LOCK_OWNER_FILE = 'owner.json'
const MAX_LOCK_OWNER_BYTES = 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

interface PrivateDirectoryIdentity {
  path: string
  canonicalPath: string
  dev: bigint
  ino: bigint
}

interface PrivateFileSnapshot {
  dev: bigint
  ino: bigint
  mode: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface SuggestionStoreLock {
  parent: PrivateDirectoryIdentity
  lock: PrivateDirectoryIdentity
  owner: PrivateFileIdentity
  pid: number
  token: string
}

interface PrivateFileIdentity {
  path: string
  snapshot: PrivateFileSnapshot
}

interface LockOwnerRecord {
  v: 1
  pid: number
  token: string
  createdAt: number
}

interface InspectedLockOwner {
  identity: PrivateFileIdentity
  owner?: LockOwnerRecord
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function modeBits(stat: BigIntStats): number {
  return Number(stat.mode & 0o777n)
}

function fileSnapshot(stat: BigIntStats): PrivateFileSnapshot {
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

function sameFileSnapshot(a: PrivateFileSnapshot, b: PrivateFileSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

async function securePrivateDirectory(path: string, label: string): Promise<PrivateDirectoryIdentity> {
  const requested = await lstat(path, { bigint: true })
  if (requested.isSymbolicLink() || !requested.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`)

  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isDirectory() || !sameInode(requested, before)) throw new Error(`${label} changed while opening: ${path}`)
    if (process.platform !== 'win32' && modeBits(before) !== PRIVATE_DIRECTORY_MODE) await handle.chmod(PRIVATE_DIRECTORY_MODE)
    const [after, requestedAfter, canonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ])
    if (
      !after.isDirectory() ||
      requestedAfter.isSymbolicLink() ||
      !requestedAfter.isDirectory() ||
      !sameInode(after, requestedAfter) ||
      (process.platform !== 'win32' && (modeBits(after) !== PRIVATE_DIRECTORY_MODE || modeBits(requestedAfter) !== PRIVATE_DIRECTORY_MODE))
    ) {
      throw new Error(`${label} changed while securing: ${path}`)
    }
    return { path, canonicalPath, dev: after.dev, ino: after.ino }
  } finally {
    await handle.close()
  }
}

async function ensurePrivateDirectory(path: string, label: string): Promise<PrivateDirectoryIdentity> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  return securePrivateDirectory(path, label)
}

async function secureExistingPrivateDirectory(path: string, label: string): Promise<PrivateDirectoryIdentity | undefined> {
  try {
    return await securePrivateDirectory(path, label)
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined
    throw error
  }
}

async function assertPrivateDirectoriesStable(directories: PrivateDirectoryIdentity[]): Promise<void> {
  await Promise.all(directories.map(async (expected) => {
    const [current, canonicalPath] = await Promise.all([lstat(expected.path, { bigint: true }), realpath(expected.path)])
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      canonicalPath !== expected.canonicalPath ||
      (process.platform !== 'win32' && modeBits(current) !== PRIVATE_DIRECTORY_MODE)
    ) {
      throw new Error(`suggestion store directory changed during access: ${expected.path}`)
    }
  }))
}

function validLockOwner(value: unknown): value is LockOwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Partial<LockOwnerRecord>
  return (
    owner.v === 1 &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === 'string' &&
    /^[0-9a-f]{64}$/.test(owner.token) &&
    typeof owner.createdAt === 'number' &&
    Number.isFinite(owner.createdAt)
  )
}

async function createLockOwner(lock: PrivateDirectoryIdentity, token: string): Promise<PrivateFileIdentity> {
  const path = join(lock.path, LOCK_OWNER_FILE)
  const bytes = Buffer.from(`${JSON.stringify({ v: 1, pid: process.pid, token, createdAt: Date.now() })}\n`, 'utf8')
  await assertPrivateDirectoriesStable([lock])
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  )
  try {
    await handle.writeFile(bytes)
    if (process.platform !== 'win32') await handle.chmod(PRIVATE_FILE_MODE)
    const [opened, requested] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    await assertPrivateDirectoriesStable([lock])
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      requested.isSymbolicLink() ||
      !requested.isFile() ||
      requested.nlink !== 1n ||
      opened.size !== BigInt(bytes.byteLength) ||
      !sameFileSnapshot(fileSnapshot(opened), fileSnapshot(requested)) ||
      (process.platform !== 'win32' && (modeBits(opened) !== PRIVATE_FILE_MODE || modeBits(requested) !== PRIVATE_FILE_MODE))
    ) {
      throw new Error(`suggestion store lock owner changed while creating: ${path}`)
    }
    return { path, snapshot: fileSnapshot(opened) }
  } finally {
    await handle.close()
  }
}

async function inspectLockOwner(lock: PrivateDirectoryIdentity): Promise<InspectedLockOwner | undefined> {
  const path = join(lock.path, LOCK_OWNER_FILE)
  let requested: BigIntStats
  try {
    requested = await lstat(path, { bigint: true })
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined
    throw error
  }
  if (requested.isSymbolicLink() || !requested.isFile()) throw new Error(`suggestion store lock owner must be a regular, non-symlink file: ${path}`)
  if (requested.nlink !== 1n) throw new Error(`suggestion store lock owner must have exactly one hard link: ${path}`)
  if (requested.size > BigInt(MAX_LOCK_OWNER_BYTES)) throw new Error(`suggestion store lock owner exceeds ${MAX_LOCK_OWNER_BYTES} bytes: ${path}`)

  await assertPrivateDirectoriesStable([lock])
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size > BigInt(MAX_LOCK_OWNER_BYTES) ||
      !sameFileSnapshot(fileSnapshot(requested), fileSnapshot(opened))
    ) {
      throw new Error(`suggestion store lock owner changed while opening: ${path}`)
    }
    const expected = fileSnapshot(opened)
    const bytes = Buffer.allocUnsafe(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    await assertPrivateDirectoriesStable([lock])
    if (
      offset !== bytes.length ||
      after.nlink !== 1n ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1n ||
      !sameFileSnapshot(expected, fileSnapshot(after)) ||
      !sameFileSnapshot(expected, fileSnapshot(pathAfter))
    ) {
      throw new Error(`suggestion store lock owner changed while reading: ${path}`)
    }
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      void error
    }
    return {
      identity: { path, snapshot: expected },
      ...(validLockOwner(value) ? { owner: value } : {}),
    }
  } finally {
    await handle.close()
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errno(error) === 'EPERM'
  }
}

async function assertLockOwned(guard: SuggestionStoreLock): Promise<void> {
  await assertPrivateDirectoriesStable([guard.parent, guard.lock])
  const inspected = await inspectLockOwner(guard.lock)
  if (
    !inspected?.owner ||
    !sameFileSnapshot(guard.owner.snapshot, inspected.identity.snapshot) ||
    inspected.owner.pid !== guard.pid ||
    inspected.owner.token !== guard.token
  ) {
    throw new Error(`suggestion store lock ownership lost: ${guard.lock.path}`)
  }
}

async function unlinkExactPrivateFile(identity: PrivateFileIdentity, label: string): Promise<void> {
  const current = await lstat(identity.path, { bigint: true })
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !sameFileSnapshot(identity.snapshot, fileSnapshot(current))
  ) {
    throw new Error(`${label} changed before removal: ${identity.path}`)
  }
  await unlink(identity.path)
}

async function breakStaleSuggestionLock(
  parent: PrivateDirectoryIdentity,
  lock: PrivateDirectoryIdentity,
  inspected: InspectedLockOwner | undefined,
): Promise<boolean> {
  if (inspected?.owner && processIsAlive(inspected.owner.pid)) return false
  await assertPrivateDirectoriesStable([parent, lock])
  if (inspected) await unlinkExactPrivateFile(inspected.identity, 'suggestion store lock owner')
  await assertPrivateDirectoriesStable([parent, lock])
  await rmdir(lock.path)
  await assertPrivateDirectoriesStable([parent])
  return true
}

async function readPrivateSuggestionStore(path: string, directories: PrivateDirectoryIdentity[]): Promise<Buffer | undefined> {
  let requested: BigIntStats
  try {
    requested = await lstat(path, { bigint: true })
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined
    throw error
  }
  if (requested.isSymbolicLink()) throw new Error(`suggestion store must not be a symbolic link: ${path}`)
  if (!requested.isFile()) throw new Error(`suggestion store must be a regular file: ${path}`)
  if (requested.nlink !== 1n) throw new Error(`suggestion store must have exactly one hard link: ${path}`)
  if (requested.size > BigInt(MAX_SUGGESTION_STORE_BYTES)) {
    throw new Error(`suggestion store exceeds ${MAX_SUGGESTION_STORE_BYTES} bytes: ${path}`)
  }

  await assertPrivateDirectoriesStable(directories)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || !sameInode(requested, opened) || opened.size > BigInt(MAX_SUGGESTION_STORE_BYTES)) {
      throw new Error(`suggestion store changed while opening: ${path}`)
    }
    if (process.platform !== 'win32' && modeBits(opened) !== PRIVATE_FILE_MODE) await handle.chmod(PRIVATE_FILE_MODE)
    const [secured, requestedAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (
      !secured.isFile() ||
      requestedAfter.isSymbolicLink() ||
      !requestedAfter.isFile() ||
      secured.nlink !== 1n ||
      requestedAfter.nlink !== 1n ||
      !sameInode(secured, requestedAfter) ||
      secured.size > BigInt(MAX_SUGGESTION_STORE_BYTES) ||
      (process.platform !== 'win32' && (modeBits(secured) !== PRIVATE_FILE_MODE || modeBits(requestedAfter) !== PRIVATE_FILE_MODE))
    ) {
      throw new Error(`suggestion store changed while securing: ${path}`)
    }
    const expected = fileSnapshot(secured)
    const buffer = Buffer.allocUnsafe(Number(secured.size))
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    await assertPrivateDirectoriesStable(directories)
    if (
      offset !== buffer.length ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      after.nlink !== 1n ||
      pathAfter.nlink !== 1n ||
      !sameFileSnapshot(expected, fileSnapshot(after)) ||
      !sameFileSnapshot(expected, fileSnapshot(pathAfter))
    ) {
      throw new Error(`suggestion store changed while reading: ${path}`)
    }
    return buffer
  } finally {
    await handle.close()
  }
}

async function appendPrivateSuggestionRecord(
  path: string,
  record: SuggestionRecord,
  directories: PrivateDirectoryIdentity[],
  assertOwnership: () => Promise<void>,
): Promise<void> {
  const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  if (recordBytes.byteLength - 1 > MAX_SUGGESTION_RECORD_BYTES) {
    throw new Error(`suggestion record exceeds ${MAX_SUGGESTION_RECORD_BYTES} bytes`)
  }
  let requested: BigIntStats | undefined
  try {
    requested = await lstat(path, { bigint: true })
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
  }
  if (requested?.isSymbolicLink()) throw new Error(`suggestion store must not be a symbolic link: ${path}`)
  if (requested && !requested.isFile()) throw new Error(`suggestion store must be a regular file: ${path}`)
  if (requested && requested.nlink !== 1n) throw new Error(`suggestion store must have exactly one hard link: ${path}`)

  await assertPrivateDirectoriesStable(directories)
  const createFlags = requested ? 0 : constants.O_CREAT | constants.O_EXCL
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_APPEND | createFlags | (constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  )
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || (requested && !sameInode(requested, opened))) {
      throw new Error(`suggestion store changed while opening: ${path}`)
    }
    if (process.platform !== 'win32' && modeBits(opened) !== PRIVATE_FILE_MODE) await handle.chmod(PRIVATE_FILE_MODE)
    const [secured, pathBeforeWrite] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (
      !secured.isFile() ||
      pathBeforeWrite.isSymbolicLink() ||
      !pathBeforeWrite.isFile() ||
      secured.nlink !== 1n ||
      pathBeforeWrite.nlink !== 1n ||
      !sameInode(secured, pathBeforeWrite) ||
      (process.platform !== 'win32' && (modeBits(secured) !== PRIVATE_FILE_MODE || modeBits(pathBeforeWrite) !== PRIVATE_FILE_MODE))
    ) {
      throw new Error(`suggestion store changed before append: ${path}`)
    }
    let needsSeparator = false
    if (secured.size > 0n) {
      const tail = Buffer.allocUnsafe(1)
      const result = await handle.read(tail, 0, 1, Number(secured.size - 1n))
      if (result.bytesRead !== 1) throw new Error(`suggestion store changed while inspecting its tail: ${path}`)
      needsSeparator = tail[0] !== 0x0a
    }
    const bytes = needsSeparator ? Buffer.concat([Buffer.from('\n'), recordBytes]) : recordBytes
    if (secured.size + BigInt(bytes.byteLength) > BigInt(MAX_SUGGESTION_STORE_BYTES)) {
      throw new Error(`suggestion store exceeds ${MAX_SUGGESTION_STORE_BYTES} bytes: ${path}`)
    }
    const beforeWrite = fileSnapshot(secured)
    const [tailAfter, pathAfterTail] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (
      pathAfterTail.isSymbolicLink() ||
      !pathAfterTail.isFile() ||
      tailAfter.nlink !== 1n ||
      pathAfterTail.nlink !== 1n ||
      !sameFileSnapshot(beforeWrite, fileSnapshot(tailAfter)) ||
      !sameFileSnapshot(beforeWrite, fileSnapshot(pathAfterTail))
    ) {
      throw new Error(`suggestion store changed while inspecting its tail: ${path}`)
    }
    const expectedSize = secured.size + BigInt(bytes.byteLength)
    await assertPrivateDirectoriesStable(directories)
    await assertOwnership()
    await handle.writeFile(bytes)
    await assertOwnership()
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    await assertPrivateDirectoriesStable(directories)
    if (
      !after.isFile() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      after.nlink !== 1n ||
      pathAfter.nlink !== 1n ||
      !sameInode(after, pathAfter) ||
      after.size !== expectedSize ||
      pathAfter.size !== expectedSize ||
      (process.platform !== 'win32' && (modeBits(after) !== PRIVATE_FILE_MODE || modeBits(pathAfter) !== PRIVATE_FILE_MODE))
    ) {
      throw new Error(`suggestion store changed during append: ${path}`)
    }
  } finally {
    await handle.close()
  }
}

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

/** Key order is not identity: two evidence objects with the same entries are the same evidence. */
function sameEvidence(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string =>
    JSON.stringify(v, (_k, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
        : item,
    )
  return canonical(a) === canonical(b)
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isPersistedSuggestionRecord(value: unknown): value is SuggestionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SuggestionRecord>
  if (
    typeof record.id !== 'string' ||
    !isSuggestionId(record.id) ||
    (record.v !== 1 && record.v !== 2) ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    (record.source !== 'report' && record.source !== 'skill') ||
    (record.scope !== 'session' && record.scope !== 'repo' && record.scope !== 'global') ||
    !stringArray(record.sessionIds) ||
    !nonEmptyString(record.ruleId) ||
    typeof record.title !== 'string' ||
    !record.evidence ||
    typeof record.evidence !== 'object' ||
    Array.isArray(record.evidence) ||
    typeof record.status !== 'string' ||
    !Object.hasOwn(TRANSITIONS, record.status) ||
    typeof record.statusAt !== 'number' ||
    !Number.isFinite(record.statusAt) ||
    (record.legacyIds !== undefined && (!stringArray(record.legacyIds) || !record.legacyIds.every(isSuggestionId))) ||
    (record.insightId !== undefined && typeof record.insightId !== 'string') ||
    (record.cohortFingerprint !== undefined && typeof record.cohortFingerprint !== 'string')
  ) {
    return false
  }
  if (record.v === 2) {
    const key = record.key
    if (
      !key ||
      typeof key !== 'object' ||
      key.v !== 2 ||
      (key.source !== 'report' && key.source !== 'skill') ||
      (key.scope !== 'session' && key.scope !== 'repo' && key.scope !== 'global') ||
      !nonEmptyString(key.ruleId) ||
      !stringArray(key.sessionIds) ||
      (key.insightId !== undefined && typeof key.insightId !== 'string') ||
      (key.cohortFingerprint !== undefined && typeof key.cohortFingerprint !== 'string')
    ) {
      return false
    }
  }
  return true
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

  /** Atomic directory lock with token/PID ownership; only dead stale owners may be broken. */
  private async acquireLock(): Promise<SuggestionStoreLock> {
    const parent = await ensurePrivateDirectory(dirname(this.path), 'suggestion store directory')
    const t0 = Date.now()
    const token = randomBytes(32).toString('hex')
    for (;;) {
      let created = false
      try {
        await mkdir(this.lockPath, { mode: PRIVATE_DIRECTORY_MODE })
        created = true
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error
      }
      if (created) {
        let lock: PrivateDirectoryIdentity | undefined
        let guard: SuggestionStoreLock | undefined
        try {
          lock = await securePrivateDirectory(this.lockPath, 'suggestion store lock')
          const owner = await createLockOwner(lock, token)
          guard = { parent, lock, owner, pid: process.pid, token }
          await assertLockOwned(guard)
          return guard
        } catch (error) {
          if (guard) await this.releaseLock(guard)
          throw error
        }
      }
      let held: PrivateDirectoryIdentity | undefined
      try {
        held = await secureExistingPrivateDirectory(this.lockPath, 'suggestion store lock')
        if (!held) continue
        const st = await lstat(this.lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await assertPrivateDirectoriesStable([parent, held])
          const inspected = await inspectLockOwner(held)
          if (await breakStaleSuggestionLock(parent, held, inspected)) continue
        }
      } catch (error) {
        if (errno(error) === 'ENOENT') continue
        throw error
      }
      if (Date.now() - t0 > LOCK_TIMEOUT_MS) throw new Error(`suggestion store lock timed out: ${this.lockPath}`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  private async releaseLock(guard: SuggestionStoreLock): Promise<void> {
    try {
      await assertLockOwned(guard)
      await unlinkExactPrivateFile(guard.owner, 'suggestion store lock owner')
      await assertPrivateDirectoriesStable([guard.parent, guard.lock])
      await rmdir(this.lockPath)
      await assertPrivateDirectoriesStable([guard.parent])
    } catch (error) {
      void error
      // A vanished or replaced path is not ours to remove; a real leftover becomes stale.
    }
  }

  /** every mutation = in-process queue → cross-process lock → replay+validate+append inside */
  private serialized<T>(fn: (guard: SuggestionStoreLock) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const guard = await this.acquireLock()
      try {
        await assertLockOwned(guard)
        const result = await fn(guard)
        await assertLockOwned(guard)
        return result
      } finally {
        await this.releaseLock(guard)
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
  private async replay(parent?: PrivateDirectoryIdentity): Promise<Map<string, SuggestionRecord>> {
    const canonical = new Map<string, SuggestionRecord>()
    const root = parent ?? await secureExistingPrivateDirectory(dirname(this.path), 'suggestion store directory')
    if (!root) return canonical
    await assertPrivateDirectoriesStable([root])
    const proposals = await secureExistingPrivateDirectory(this.proposalsDir, 'suggestion proposals directory')
    const directories = proposals ? [root, proposals] : [root]
    const bytes = await readPrivateSuggestionStore(this.path, directories)
    if (bytes === undefined) return canonical
    let offset = 0
    let lines = 0
    while (offset < bytes.length) {
      lines++
      if (lines > MAX_SUGGESTION_STORE_LINES) {
        throw new Error(`suggestion store exceeds ${MAX_SUGGESTION_STORE_LINES} lines: ${this.path}`)
      }
      const newline = bytes.indexOf(0x0a, offset)
      const end = newline === -1 ? bytes.length : newline
      if (end - offset > MAX_SUGGESTION_RECORD_BYTES) {
        throw new Error(`suggestion store record exceeds ${MAX_SUGGESTION_RECORD_BYTES} bytes: ${this.path}`)
      }
      if (end > offset) {
        const trimmed = bytes.toString('utf8', offset, end).trim()
        if (trimmed) {
          try {
            const rec: unknown = JSON.parse(trimmed)
            if (isPersistedSuggestionRecord(rec)) canonical.set(rec.id, rec)
          } catch (error) {
            void error
            /* corrupt line: skip, keep going */
          }
        }
      }
      if (newline === -1) break
      offset = newline + 1
    }
    const byId = new Map(canonical)
    for (const rec of canonical.values()) {
      for (const legacyId of rec.legacyIds ?? []) {
        if (isSuggestionId(legacyId)) byId.set(legacyId, rec)
      }
    }
    return byId
  }

  private async append(rec: SuggestionRecord, guard: SuggestionStoreLock): Promise<void> {
    await assertLockOwned(guard)
    const parent = guard.parent
    const proposals = await ensurePrivateDirectory(this.proposalsDir, 'suggestion proposals directory')
    await appendPrivateSuggestionRecord(this.path, rec, [parent, proposals], () => assertLockOwned(guard))
  }

  async all(): Promise<SuggestionRecord[]> {
    const unique = new Map<string, SuggestionRecord>()
    const records = await this.replay()
    for (const rec of records.values()) unique.set(rec.id, rec)
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
    return this.serialized((guard) => this.upsertNewLocked(f, source, explicitId, guard))
  }

  private async upsertNewLocked(
    f: Finding,
    source: SuggestionSource,
    explicitId: string | undefined,
    guard: SuggestionStoreLock,
  ): Promise<{ record: SuggestionRecord; created: boolean }> {
    assertSafeFindingIdentity(f)
    const key = suggestionKey(f, source)
    const canonicalId = suggestionIdV2(key)
    const legacyId = suggestionId(source, f.ruleId, f.sessionIds)
    const acceptsLegacyId = source === 'report' && !f.cohortFingerprint
    if (explicitId && explicitId !== canonicalId && !(acceptsLegacyId && explicitId === legacyId)) {
      throw new Error(`suggestion id identity mismatch: expected ${canonicalId}${acceptsLegacyId ? ` or legacy ${legacyId}` : ''}, got ${explicitId}`)
    }
    const id = explicitId ?? canonicalId
    const records = await this.replay(guard.parent)
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
      // Nothing to refresh: `orangu report` run twice must not append a second line per run.
      if (existing.title === f.title && sameEvidence(existing.evidence, f.evidence)) return { record: existing, created: false }
      const refreshed: SuggestionRecord = { ...existing, title: f.title, evidence: f.evidence, statusAt: ts }
      await this.append(refreshed, guard)
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
        await this.append(migrated, guard)
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
    await this.append(record, guard)
    return { record, created: true }
  }

  async transition(
    id: string,
    to: SuggestionStatus,
    patch?: TransitionPatch,
  ): Promise<SuggestionRecord> {
    return this.serialized((guard) => this.transitionLocked(id, to, guard, patch))
  }

  private async transitionLocked(
    id: string,
    to: SuggestionStatus,
    guard: SuggestionStoreLock,
    patch?: TransitionPatch,
  ): Promise<SuggestionRecord> {
    // replayed INSIDE the lock: another writer's append since our caller last looked is now visible
    const current = (await this.replay(guard.parent)).get(id)
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
    await this.append(next, guard)
    return next
  }
}
