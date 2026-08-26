/**
 * Incremental session tail. Keeps the accumulated record arrays of one session (main
 * transcript + agent sidecars) and appends only the new bytes on each tick, via the byte-offset
 * reader (jsonl.ts fromByte/nextByte). Full re-read only when a file shrinks (resumed/forked session).
 * `orangu watch` and the serve registry both run through this, so a 35 MB live transcript costs one
 * stat + the new bytes per tick instead of a full re-parse.
 */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import {
  readJsonlFile,
  type JsonObject,
  type JsonlFileIdentity,
  type JsonlFileResult,
  type ReadJsonlOptions,
} from '../adapters/claude-code/jsonl.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import {
  MAX_EVIDENCE_META_BYTES,
  MAX_EVIDENCE_SESSION_RECORDS,
  MAX_LOCAL_SESSION_BYTES,
} from '../adapters/claude-code/evidence-input.js'
import type { Session } from '../model/session.js'
import type { SessionRef } from '../discover/discover.js'

export type ReadFn = (path: string, opts?: ReadJsonlOptions) => Promise<JsonlFileResult>

export interface TailSidecar {
  nextByte: number
  records: JsonObject[]
  meta?: JsonObject
  bytes: number
  metaBytes: number
  totalLines: number
  fileIdentity?: JsonlFileIdentity
  metaIdentity?: TailMetaIdentity
}

export interface TailMetaIdentity {
  device: string
  inode: string
  size: number
  mtimeNs: string
  ctimeNs: string
}

export interface TailState {
  path: string
  /** byte offset just after the last complete line of the main transcript */
  nextByte: number
  records: JsonObject[]
  trailingPartial: boolean
  badLines: number
  totalLines: number
  /** main transcript size on disk at the last tick */
  bytes: number
  fileIdentity?: JsonlFileIdentity
  sidecars: Map<string, TailSidecar>
}

export function newTailState(path: string): TailState {
  return { path, nextByte: 0, records: [], trailingPartial: false, badLines: 0, totalLines: 0, bytes: 0, sidecars: new Map() }
}

function sidecarBytes(st: TailState, except?: string): number {
  let total = 0
  for (const [path, sidecar] of st.sidecars) {
    if (path !== except) total += sidecar.bytes + sidecar.metaBytes
  }
  return total
}

function sidecarRecords(st: TailState, except?: string): number {
  let total = 0
  for (const [path, sidecar] of st.sidecars) {
    if (path !== except) total += sidecar.totalLines
  }
  return total
}

function identityChanged(previous?: JsonlFileIdentity, next?: JsonlFileIdentity): boolean {
  if (!previous) return false
  return !next || previous.device !== next.device || previous.inode !== next.inode
}

function sameMetaIdentity(previous?: TailMetaIdentity, next?: TailMetaIdentity): boolean {
  return !!previous && !!next
    && previous.device === next.device
    && previous.inode === next.inode
    && previous.size === next.size
    && previous.mtimeNs === next.mtimeNs
    && previous.ctimeNs === next.ctimeNs
}

function remainingBudget(limit: number, used: number, kind: 'bytes' | 'records'): number {
  const remaining = limit - used
  if (remaining < 0) throw new Error(`session tail exceeds ${limit} ${kind}`)
  return remaining
}

function metaIdentity(st: BigIntStats): TailMetaIdentity {
  if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('metadata is too large to address safely')
  return {
    device: String(st.dev),
    inode: String(st.ino),
    size: Number(st.size),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
  }
}

async function readSidecarMeta(path: string, remainingBytes: number): Promise<{ meta?: JsonObject; bytes: number; identity: TailMetaIdentity }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat({ bigint: true })
    if (!st.isFile()) throw new Error(`session sidecar metadata must be a regular file: ${path}`)
    const before = metaIdentity(st)
    if (before.size > MAX_EVIDENCE_META_BYTES) throw new Error(`session sidecar metadata exceeds ${MAX_EVIDENCE_META_BYTES} bytes: ${path}`)
    if (before.size > remainingBytes) throw new Error(`session tail exceeds ${MAX_LOCAL_SESSION_BYTES} bytes`)
    const buffer = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < before.size) {
      const read = await handle.read(buffer, offset, before.size - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset !== before.size) throw new Error(`session sidecar metadata changed while it was being read: ${path}`)
    const after = metaIdentity(await handle.stat({ bigint: true }))
    const current = await lstat(path, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`session sidecar metadata must remain a regular non-symlink file: ${path}`)
    }
    const pathIdentity = metaIdentity(current)
    if (!sameMetaIdentity(before, after) || !sameMetaIdentity(after, pathIdentity)) {
      throw new Error(`session sidecar metadata changed while it was being read: ${path}`)
    }
    try {
      const value: unknown = JSON.parse(buffer.toString('utf8'))
      return {
        ...(value && typeof value === 'object' && !Array.isArray(value) ? { meta: value as JsonObject } : {}),
        bytes: before.size,
        identity: before,
      }
    } catch {
      return { bytes: before.size, identity: before }
    }
  } finally {
    await handle.close()
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Read whatever grew since the last tick. `ref.subagentFiles` is the current sidecar list
 * (the caller re-discovers it); a new file there is tailed from byte 0.
 * fileSize < nextByte → the file shrank → reset and re-read from 0 (fullReparse).
 */
export async function tailOnce(st: TailState, ref: SessionRef, read: ReadFn = readJsonlFile): Promise<{ changed: boolean; fullReparse: boolean }> {
  let changed = false
  let fullReparse = false
  const prevPartial = st.trailingPartial

  const activeSidecars = new Set(ref.subagentFiles)
  for (const path of st.sidecars.keys()) {
    if (!activeSidecars.has(path)) {
      st.sidecars.delete(path)
      changed = true
    }
  }

  let mainFileBudget = remainingBudget(MAX_LOCAL_SESSION_BYTES, sidecarBytes(st), 'bytes')
  let mainRecordBudget = remainingBudget(MAX_EVIDENCE_SESSION_RECORDS, sidecarRecords(st) + st.totalLines, 'records')
  let r = await read(st.path, {
    fromByte: st.nextByte,
    maxBytes: mainFileBudget,
    maxFileBytes: mainFileBudget,
    maxRecords: mainRecordBudget,
    noFollow: true,
  })
  if (st.fileIdentity && !r.fileIdentity) throw new Error(`session main transcript identity became unavailable: ${st.path}`)
  const firstMainIdentity = r.fileIdentity
  const mainIdentityChanged = identityChanged(st.fileIdentity, r.fileIdentity)
  if (r.fileSize < st.nextByte || mainIdentityChanged) {
    fullReparse = true
    if (mainIdentityChanged) st.sidecars.clear()
    st.records = []
    st.nextByte = 0
    st.badLines = 0
    st.totalLines = 0
    st.trailingPartial = false
    mainFileBudget = remainingBudget(MAX_LOCAL_SESSION_BYTES, sidecarBytes(st), 'bytes')
    mainRecordBudget = remainingBudget(MAX_EVIDENCE_SESSION_RECORDS, sidecarRecords(st), 'records')
    r = await read(st.path, {
      fromByte: 0,
      maxBytes: mainFileBudget,
      maxFileBytes: mainFileBudget,
      maxRecords: mainRecordBudget,
      noFollow: true,
    })
    if (identityChanged(firstMainIdentity, r.fileIdentity)) throw new Error(`session main transcript changed during tail reset: ${st.path}`)
  }
  // an unterminated non-parsing last fragment is counted by the reader but NOT consumed
  // (nextByte stops before it), so exclude it from the running totals and let the next tick re-read it
  const partial = r.trailingPartial ? 1 : 0
  if (r.records.length) {
    st.records.push(...r.records)
    changed = true
  }
  st.totalLines += Math.max(0, r.totalLines - partial)
  st.badLines += Math.max(0, r.badLines - partial)
  st.trailingPartial = r.trailingPartial
  st.nextByte = r.nextByte
  st.bytes = r.fileSize
  st.fileIdentity = r.fileIdentity
  if (fullReparse || st.trailingPartial !== prevPartial) changed = true

  for (const p of activeSidecars) {
    let sc = st.sidecars.get(p)
    if (!sc) {
      sc = { nextByte: 0, records: [], bytes: 0, metaBytes: 0, totalLines: 0 }
      st.sidecars.set(p, sc)
      changed = true
    }
    try {
      const loaded = await readSidecarMeta(
        p.replace(/\.jsonl$/, '.meta.json'),
        remainingBudget(MAX_LOCAL_SESSION_BYTES, st.bytes + sidecarBytes(st) - sc.metaBytes, 'bytes'),
      )
      if (!sameMetaIdentity(sc.metaIdentity, loaded.identity)) changed = true
      sc.metaBytes = loaded.bytes
      sc.metaIdentity = loaded.identity
      sc.meta = loaded.meta
    } catch (error) {
      if (!isMissing(error)) throw error
      if (sc.metaBytes !== 0 || sc.meta !== undefined || sc.metaIdentity !== undefined) changed = true
      sc.metaBytes = 0
      sc.meta = undefined
      sc.metaIdentity = undefined
      // no metadata sidecar; linkage falls back to name+team
    }
    try {
      const sideFileBudget = remainingBudget(
        MAX_LOCAL_SESSION_BYTES,
        st.bytes + sidecarBytes(st, p) + sc.metaBytes,
        'bytes',
      )
      let sideRecordBudget = remainingBudget(
        MAX_EVIDENCE_SESSION_RECORDS,
        st.totalLines + sidecarRecords(st, p) + sc.totalLines,
        'records',
      )
      let sr = await read(p, {
        fromByte: sc.nextByte,
        maxBytes: sideFileBudget,
        maxFileBytes: sideFileBudget,
        maxRecords: sideRecordBudget,
        noFollow: true,
      })
      if (sc.fileIdentity && !sr.fileIdentity) throw new Error(`session sidecar identity became unavailable: ${p}`)
      const firstSideIdentity = sr.fileIdentity
      if (sr.fileSize < sc.nextByte || identityChanged(sc.fileIdentity, sr.fileIdentity)) {
        sc.records = []
        sc.nextByte = 0
        sc.totalLines = 0
        sc.bytes = 0
        sideRecordBudget = remainingBudget(MAX_EVIDENCE_SESSION_RECORDS, st.totalLines + sidecarRecords(st, p), 'records')
        sr = await read(p, {
          fromByte: 0,
          maxBytes: sideFileBudget,
          maxFileBytes: sideFileBudget,
          maxRecords: sideRecordBudget,
          noFollow: true,
        })
        if (identityChanged(firstSideIdentity, sr.fileIdentity)) throw new Error(`session sidecar changed during tail reset: ${p}`)
        fullReparse = true
        changed = true
      }
      if (sr.records.length) {
        sc.records.push(...sr.records)
        changed = true
      }
      sc.nextByte = sr.nextByte
      sc.bytes = sr.fileSize
      sc.fileIdentity = sr.fileIdentity
      sc.totalLines += Math.max(0, sr.totalLines - (sr.trailingPartial ? 1 : 0))
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ''
      throw new Error(`session sidecar could not be read safely: ${p}${detail}`, { cause: error })
    }
  }
  return { changed, fullReparse }
}

/** Parse the accumulated records into a Session (the adapter's `records` path with the file facts). */
export function sessionFromTail(st: TailState): Promise<Session> {
  return parseClaudeCodeSession({
    path: st.path,
    records: st.records,
    subagents: [...st.sidecars.entries()].map(([path, s]) => ({ path, records: s.records, meta: s.meta })),
    trailingPartial: st.trailingPartial,
    bytes: st.bytes,
    badLines: st.badLines,
    totalLines: st.totalLines,
  })
}
