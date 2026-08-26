/**
 * Secure raw-session input for every disk-backed Claude-family parser path.
 *
 * Discovery produces an immutable inode manifest. Reading then opens exactly
 * those canonical files with O_NOFOLLOW, validates the inode before and after
 * the read, and returns an explicit in-memory ParseInput. The generic session
 * parser therefore never performs a second sidecar discovery pass.
 */
import { constants, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_MAX_JSONL_LINE_BYTES,
  DEFAULT_MAX_JSONL_BYTES,
  DEFAULT_MAX_JSONL_RECORDS,
  readJsonlHandle,
  type JsonObject,
  type JsonlHandleResult,
} from './jsonl.js'
import type { ParseInput } from './parse-input.js'

/** Main transcript + exact sidecar/meta manifest read limit. */
export const MAX_EVIDENCE_SESSION_BYTES = 64 * 1024 * 1024
/** Local parser/cache/live aggregate cap; preserves the historical per-file ceiling. */
export const MAX_LOCAL_SESSION_BYTES = DEFAULT_MAX_JSONL_BYTES
export const MAX_EVIDENCE_META_BYTES = 1 * 1024 * 1024
export const MAX_EVIDENCE_SESSION_RECORDS = DEFAULT_MAX_JSONL_RECORDS
/** Directory entries inspected while discovering one session's sidecars. */
export const MAX_EVIDENCE_SIDECAR_ENTRIES = 2_048
/** Nested directories below the `subagents` root that may be inspected. */
export const MAX_EVIDENCE_SIDECAR_DEPTH = 4

interface FileSnapshot {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface EvidenceInputFile {
  requestedPath: string
  canonicalPath: string
  snapshot: FileSnapshot
}

interface EvidenceInputDirectory {
  requestedPath: string
  canonicalPath: string
  snapshot: FileSnapshot
}

interface EvidenceSidecarManifest {
  transcript: EvidenceInputFile
  meta?: EvidenceInputFile
  agentIdHint: string
}

/** @internal Exported for deterministic security tests of the preflight/read boundary. */
export interface EvidenceSessionManifest {
  main: EvidenceInputFile
  sidecarRoot?: string
  sidecarDirectories: EvidenceInputDirectory[]
  absentSidecarPaths: string[]
  sidecars: EvidenceSidecarManifest[]
  /** Hash of canonical paths and immutable inode snapshots for cache identity. */
  fingerprint: string
  /** Aggregate byte ceiling selected by the caller during prevalidation. */
  maxBytes: number
}

export interface PrevalidateEvidenceSessionOptions {
  /** False preserves the parser's explicit `noSidecar` mode. */
  includeSidecars?: boolean
  /** Aggregate main + sidecars + metadata budget. */
  maxBytes?: number
}

/** @internal Exact parser input loaded from one immutable manifest. */
export interface ReadEvidenceSessionResult {
  parseInput: ParseInput
  bytesRead: number
}

function snapshotOf(stat: BigIntStats): FileSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function prevalidateRegularFile(path: string, root?: string): Promise<EvidenceInputFile> {
  const requestedPath = resolve(path)
  const requestedStat = await lstat(requestedPath, { bigint: true })
  if (requestedStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${requestedPath}`)
  if (!requestedStat.isFile()) throw new Error(`session input must contain only regular files: ${requestedPath}`)
  const canonicalPath = await realpath(requestedPath)
  if (root && !isWithin(root, canonicalPath)) throw new Error(`session sidecar escapes its canonical root: ${requestedPath}`)
  const canonicalStat = await lstat(canonicalPath, { bigint: true })
  const snapshot = snapshotOf(requestedStat)
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isFile() || !sameSnapshot(snapshot, snapshotOf(canonicalStat))) {
    throw new Error(`session input changed during prevalidation: ${requestedPath}`)
  }
  return { requestedPath, canonicalPath, snapshot }
}

async function prevalidateDirectory(path: string, root?: string): Promise<EvidenceInputDirectory> {
  const requestedPath = resolve(path)
  const requestedStat = await lstat(requestedPath, { bigint: true })
  if (requestedStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${requestedPath}`)
  if (!requestedStat.isDirectory()) throw new Error(`session sidecar path must be a directory: ${requestedPath}`)
  const canonicalPath = await realpath(requestedPath)
  if (root && !isWithin(root, canonicalPath)) throw new Error(`session sidecar escapes its canonical root: ${requestedPath}`)
  const canonicalStat = await lstat(canonicalPath, { bigint: true })
  const snapshot = snapshotOf(requestedStat)
  if (!canonicalStat.isDirectory() || !sameSnapshot(snapshot, snapshotOf(canonicalStat))) {
    throw new Error(`session sidecar directory changed during prevalidation: ${requestedPath}`)
  }
  return { requestedPath, canonicalPath, snapshot }
}

async function assertDirectoryStillMatches(directory: EvidenceInputDirectory): Promise<void> {
  let requestedStat: BigIntStats
  let canonicalNow: string
  try {
    requestedStat = await lstat(directory.requestedPath, { bigint: true })
    canonicalNow = await realpath(directory.requestedPath)
  } catch {
    throw new Error(`session sidecar directory changed while it was being read: ${directory.requestedPath}`)
  }
  if (
    requestedStat.isSymbolicLink() ||
    !requestedStat.isDirectory() ||
    canonicalNow !== directory.canonicalPath ||
    !sameSnapshot(directory.snapshot, snapshotOf(requestedStat))
  ) {
    throw new Error(`session sidecar directory changed while it was being read: ${directory.requestedPath}`)
  }
}

async function discoverEvidenceSidecars(
  main: EvidenceInputFile,
): Promise<{
  root?: string
  directories: EvidenceInputDirectory[]
  absentPaths: string[]
  sidecars: EvidenceSidecarManifest[]
}> {
  const sessionDir = join(dirname(main.canonicalPath), basename(main.canonicalPath, '.jsonl'))
  let sessionDirStat: BigIntStats
  try {
    sessionDirStat = await lstat(sessionDir, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      const projectDirectory = await prevalidateDirectory(dirname(main.canonicalPath))
      return { directories: [projectDirectory], absentPaths: [sessionDir], sidecars: [] }
    }
    throw error
  }
  if (sessionDirStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${sessionDir}`)
  if (!sessionDirStat.isDirectory()) throw new Error(`session sidecar parent must be a directory: ${sessionDir}`)
  const canonicalSessionDir = await realpath(sessionDir)
  const canonicalSessionDirStat = await lstat(canonicalSessionDir, { bigint: true })
  if (!canonicalSessionDirStat.isDirectory() || !sameSnapshot(snapshotOf(sessionDirStat), snapshotOf(canonicalSessionDirStat))) {
    throw new Error(`session sidecar parent changed during prevalidation: ${sessionDir}`)
  }
  const directories: EvidenceInputDirectory[] = [{
    requestedPath: sessionDir,
    canonicalPath: canonicalSessionDir,
    snapshot: snapshotOf(canonicalSessionDirStat),
  }]
  const expectedRoot = join(canonicalSessionDir, 'subagents')
  let rootStat: BigIntStats
  try {
    rootStat = await lstat(expectedRoot, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return { directories, absentPaths: [expectedRoot], sidecars: [] }
    throw error
  }
  if (rootStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${expectedRoot}`)
  if (!rootStat.isDirectory()) throw new Error(`session sidecar root must be a directory: ${expectedRoot}`)
  const root = await realpath(expectedRoot)
  if (!isWithin(canonicalSessionDir, root)) throw new Error(`session sidecar escapes its canonical parent: ${expectedRoot}`)
  const canonicalRootStat = await lstat(root, { bigint: true })
  if (!canonicalRootStat.isDirectory() || !sameSnapshot(snapshotOf(rootStat), snapshotOf(canonicalRootStat))) {
    throw new Error(`session sidecar root changed during prevalidation: ${expectedRoot}`)
  }
  const rootDirectory: EvidenceInputDirectory = {
    requestedPath: expectedRoot,
    canonicalPath: root,
    snapshot: snapshotOf(canonicalRootStat),
  }
  directories.push(rootDirectory)
  const sessionDirAfter = await lstat(canonicalSessionDir, { bigint: true })
  if (!sameSnapshot(snapshotOf(sessionDirStat), snapshotOf(sessionDirAfter))) {
    throw new Error(`session sidecar parent changed during prevalidation: ${sessionDir}`)
  }

  const transcriptFiles: EvidenceInputFile[] = []
  let visitedEntries = 0
  const walk = async (directory: EvidenceInputDirectory, depth: number): Promise<void> => {
    const canonicalDir = directory.canonicalPath
    const entries = []
    for await (const entry of await opendir(canonicalDir)) {
      visitedEntries++
      if (visitedEntries > MAX_EVIDENCE_SIDECAR_ENTRIES) {
        throw new Error(`session sidecar manifest exceeds ${MAX_EVIDENCE_SIDECAR_ENTRIES} entries`)
      }
      entries.push(entry)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(canonicalDir, entry.name)
      const stat = await lstat(path, { bigint: true })
      if (stat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${path}`)
      if (stat.isDirectory()) {
        if (depth >= MAX_EVIDENCE_SIDECAR_DEPTH) {
          throw new Error(`session sidecar traversal exceeds ${MAX_EVIDENCE_SIDECAR_DEPTH} levels`)
        }
        const child = await prevalidateDirectory(path, root)
        directories.push(child)
        await walk(child, depth + 1)
      } else if (entry.name.endsWith('.jsonl') && entry.name.startsWith('agent-')) {
        transcriptFiles.push(await prevalidateRegularFile(path, root))
      }
    }
    await assertDirectoryStillMatches(directory)
  }
  await walk(rootDirectory, 0)

  const sidecars: EvidenceSidecarManifest[] = []
  for (const transcript of transcriptFiles.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))) {
    const agentIdHint = basename(transcript.canonicalPath, '.jsonl').replace(/^agent-/, '')
    const metaPath = transcript.canonicalPath.replace(/\.jsonl$/, '.meta.json')
    let meta: EvidenceInputFile | undefined
    try {
      meta = await prevalidateRegularFile(metaPath, root)
      if (meta.snapshot.size > BigInt(MAX_EVIDENCE_META_BYTES)) {
        throw new Error(`session sidecar metadata exceeds ${MAX_EVIDENCE_META_BYTES} bytes: ${metaPath}`)
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    sidecars.push({ transcript, ...(meta ? { meta } : {}), agentIdHint })
  }
  for (const directory of directories) await assertDirectoryStillMatches(directory)
  return { root, directories, absentPaths: [], sidecars }
}

function manifestFingerprint(
  main: EvidenceInputFile,
  sidecars: EvidenceSidecarManifest[],
  directories: EvidenceInputDirectory[],
  absentPaths: string[],
): string {
  const hash = createHash('sha256')
  const add = (role: string, file: EvidenceInputFile) => {
    const s = file.snapshot
    hash.update([role, file.canonicalPath, s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join('\0'))
    hash.update('\0')
  }
  add('main', main)
  for (const directory of directories) {
    const s = directory.snapshot
    hash.update(['directory', directory.canonicalPath, s.dev, s.ino, s.mode, s.mtimeNs, s.ctimeNs].join('\0'))
    hash.update('\0')
  }
  for (const path of absentPaths) hash.update(`absent\0${path}\0`)
  for (const sidecar of sidecars) {
    add('sidecar', sidecar.transcript)
    if (sidecar.meta) add('meta', sidecar.meta)
  }
  return hash.digest('hex')
}

/** Resolve and snapshot exactly the files that a disk-backed session read may consume. */
export async function prevalidateEvidenceSession(
  mainPath: string,
  options: PrevalidateEvidenceSessionOptions = {},
): Promise<EvidenceSessionManifest> {
  const maxBytes = options.maxBytes ?? MAX_EVIDENCE_SESSION_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOCAL_SESSION_BYTES) {
    throw new Error(`session prevalidation budget must be an integer from 1-${MAX_LOCAL_SESSION_BYTES} bytes`)
  }
  let main: EvidenceInputFile
  try {
    main = await prevalidateRegularFile(mainPath)
  } catch (error) {
    if (isMissing(error)) throw new Error(`session JSONL not found: ${resolve(mainPath)}`)
    throw error
  }
  const discovered = options.includeSidecars === false
    ? { directories: [], absentPaths: [], sidecars: [] }
    : await discoverEvidenceSidecars(main)
  const files = [main, ...discovered.sidecars.flatMap((sidecar) => [sidecar.transcript, ...(sidecar.meta ? [sidecar.meta] : [])])]
  let declaredBytes = 0n
  for (const file of files) {
    declaredBytes += file.snapshot.size
    if (declaredBytes > BigInt(maxBytes)) throw new Error(`session input exceeds ${maxBytes} bytes`)
  }
  return {
    main,
    ...(discovered.root ? { sidecarRoot: discovered.root } : {}),
    sidecarDirectories: discovered.directories,
    absentSidecarPaths: discovered.absentPaths,
    sidecars: discovered.sidecars,
    fingerprint: manifestFingerprint(main, discovered.sidecars, discovered.directories, discovered.absentPaths),
    maxBytes,
  }
}

/** Canonical, prevalidated sidecar paths for incremental tail callers. */
export function evidenceManifestSidecarFiles(
  manifest: EvidenceSessionManifest,
): Array<{ path: string; metaPath?: string; agentIdHint: string }> {
  return manifest.sidecars.map((sidecar) => ({
    path: sidecar.transcript.canonicalPath,
    ...(sidecar.meta ? { metaPath: sidecar.meta.canonicalPath } : {}),
    agentIdHint: sidecar.agentIdHint,
  }))
}

/** Latest file content/metadata change represented by this immutable manifest. */
export function evidenceManifestLatestChangeMs(manifest: EvidenceSessionManifest): number | undefined {
  const entries = [
    manifest.main,
    ...manifest.sidecars.flatMap((sidecar) => [sidecar.transcript, ...(sidecar.meta ? [sidecar.meta] : [])]),
    ...manifest.sidecarDirectories,
  ]
  let latestNs = -1n
  for (const entry of entries) {
    const changedNs = entry.snapshot.mtimeNs > entry.snapshot.ctimeNs ? entry.snapshot.mtimeNs : entry.snapshot.ctimeNs
    if (changedNs > latestNs) latestNs = changedNs
  }
  if (latestNs < 0n) return undefined
  // Round toward the future: flooring a sub-millisecond timestamp could admit
  // verification fractionally before the full quiet interval has elapsed.
  const milliseconds = Number((latestNs + 999_999n) / 1_000_000n)
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined
}

/** Recheck a manifest after an asynchronous cache lookup and before trusting a hit. */
export async function assertEvidenceSessionManifestStable(manifest: EvidenceSessionManifest): Promise<void> {
  await assertPathStillMatches(manifest.main)
  for (const sidecar of manifest.sidecars) {
    await assertPathStillMatches(sidecar.transcript)
    if (sidecar.meta) await assertPathStillMatches(sidecar.meta)
  }
  for (const directory of manifest.sidecarDirectories) await assertDirectoryStillMatches(directory)
  for (const path of manifest.absentSidecarPaths) {
    try {
      await lstat(path)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    throw new Error(`session sidecar tree changed while it was being read: ${path}`)
  }
}

async function assertPathStillMatches(file: EvidenceInputFile): Promise<void> {
  let requestedStat: BigIntStats
  let canonicalNow: string
  try {
    requestedStat = await lstat(file.requestedPath, { bigint: true })
    canonicalNow = await realpath(file.requestedPath)
  } catch {
    throw new Error(`session input changed while it was being read: ${file.requestedPath}`)
  }
  if (requestedStat.isSymbolicLink() || canonicalNow !== file.canonicalPath || !sameSnapshot(file.snapshot, snapshotOf(requestedStat))) {
    throw new Error(`session input changed while it was being read: ${file.requestedPath}`)
  }
  const canonicalStat = await lstat(file.canonicalPath, { bigint: true })
  if (canonicalStat.isSymbolicLink() || !sameSnapshot(file.snapshot, snapshotOf(canonicalStat))) {
    throw new Error(`session input changed while it was being read: ${file.requestedPath}`)
  }
}

async function withStableFile<T>(
  file: EvidenceInputFile,
  remainingBytes: number,
  read: (handle: Awaited<ReturnType<typeof open>>, size: number) => Promise<{ value: T; bytesRead: number }>,
): Promise<{ value: T; bytesRead: number }> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new Error(`session input changed before it was read: ${file.requestedPath}`)
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameSnapshot(file.snapshot, snapshotOf(before))) {
      throw new Error(`session input changed before it was read: ${file.requestedPath}`)
    }
    await assertPathStillMatches(file)
    if (before.size > BigInt(remainingBytes)) throw new Error(`session input exceeds the remaining ${remainingBytes}-byte read budget`)
    const size = Number(before.size)
    const result = await read(handle, size)
    if (result.bytesRead !== size) throw new Error(`session input changed while it was being read: ${file.requestedPath}`)
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(snapshotOf(before), snapshotOf(after))) {
      throw new Error(`session input changed while it was being read: ${file.requestedPath}`)
    }
    await assertPathStillMatches(file)
    return result
  } finally {
    await handle.close()
  }
}

function readStableJsonl(
  file: EvidenceInputFile,
  remainingBytes: number,
  remainingRecords: number,
): Promise<{ value: JsonlHandleResult; bytesRead: number }> {
  return withStableFile(file, remainingBytes, async (handle, size) => {
    const value = await readJsonlHandle(handle, {
      fileSize: size,
      maxBytes: remainingBytes,
      maxLineBytes: DEFAULT_MAX_JSONL_LINE_BYTES,
      maxRecords: remainingRecords,
    })
    return { value, bytesRead: value.physicalBytesRead }
  })
}

function readStableText(file: EvidenceInputFile, remainingBytes: number): Promise<{ value: string; bytesRead: number }> {
  return withStableFile(file, remainingBytes, async (handle, size) => {
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const result = await handle.read(buffer, offset, size - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
      if (offset > remainingBytes) throw new Error(`session input exceeds the remaining ${remainingBytes}-byte read budget`)
    }
    return { value: buffer.subarray(0, offset).toString('utf8'), bytesRead: offset }
  })
}

function jsonObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
  } catch {
    return undefined
  }
}

/** Read every manifest entry once, through its prevalidated inode, and return an
 * explicit in-memory parser input. Supplying `subagents: []` is intentional: it
 * disables the generic parser's sidecar rediscovery branch. */
export async function readEvidenceSessionManifest(
  manifest: EvidenceSessionManifest,
  maxBytes = manifest.maxBytes,
): Promise<ReadEvidenceSessionResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > manifest.maxBytes) {
    throw new Error(`session read budget must be an integer from 1-${manifest.maxBytes} bytes`)
  }
  let bytesRead = 0
  let recordsRead = 0
  const main = await readStableJsonl(manifest.main, maxBytes, MAX_EVIDENCE_SESSION_RECORDS)
  bytesRead += main.bytesRead
  recordsRead += main.value.totalLines
  if (recordsRead > MAX_EVIDENCE_SESSION_RECORDS) throw new Error(`session input exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`)
  const subagents: NonNullable<ParseInput['subagents']> = []
  for (const sidecar of manifest.sidecars) {
    let transcript: Awaited<ReturnType<typeof readStableJsonl>>
    try {
      transcript = await readStableJsonl(
        sidecar.transcript,
        maxBytes - bytesRead,
        MAX_EVIDENCE_SESSION_RECORDS - recordsRead,
      )
    } catch (error) {
      if (error instanceof Error && /JSONL input exceeds \d+ records/.test(error.message)) {
        throw new Error(`session input exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`)
      }
      throw error
    }
    bytesRead += transcript.bytesRead
    recordsRead += transcript.value.totalLines
    if (recordsRead > MAX_EVIDENCE_SESSION_RECORDS) throw new Error(`session input exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`)
    let meta: JsonObject | undefined
    if (sidecar.meta) {
      const loadedMeta = await readStableText(sidecar.meta, maxBytes - bytesRead)
      bytesRead += loadedMeta.bytesRead
      meta = jsonObject(loadedMeta.value)
    }
    subagents.push({
      path: sidecar.transcript.canonicalPath,
      records: transcript.value.records,
      lineNumbers: transcript.value.lineNumbers,
      agentIdHint: sidecar.agentIdHint,
      ...(meta ? { meta } : {}),
      totalLines: transcript.value.totalLines,
      badLines: transcript.value.badLines,
      bytes: transcript.bytesRead,
      trailingPartial: transcript.value.trailingPartial,
    })
  }
  await assertEvidenceSessionManifestStable(manifest)
  return {
    bytesRead,
    parseInput: {
      path: manifest.main.canonicalPath,
      records: main.value.records,
      lineNumbers: main.value.lineNumbers,
      subagents,
      totalLines: main.value.totalLines,
      badLines: main.value.badLines,
      bytes: main.bytesRead,
      trailingPartial: main.value.trailingPartial,
    },
  }
}
