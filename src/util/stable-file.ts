/** Stable, capped read for untrusted local text artifacts. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

interface Snapshot {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export interface StableTextManifest {
  requestedPath: string
  canonicalPath: string
  maxBytes: number
  label: string
  snapshot: Snapshot
}

function snapshot(stat: BigIntStats): Snapshot {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

function same(a: Snapshot, b: Snapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** @internal Split from the read so replacement resistance can be tested deterministically. */
export async function prevalidateStableTextFile(path: string, maxBytes: number, label: string): Promise<StableTextManifest> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`${label} byte cap must be a positive integer`)
  const requestedPath = resolve(path)
  let requested: BigIntStats
  try {
    requested = await lstat(requestedPath, { bigint: true })
  } catch {
    throw new Error(`${label} not found: ${requestedPath}`)
  }
  if (requested.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!requested.isFile()) throw new Error(`${label} must be a regular file`)
  if (requested.size > BigInt(maxBytes)) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  const canonicalPath = await realpath(requestedPath)
  const canonical = await lstat(canonicalPath, { bigint: true })
  const expected = snapshot(requested)
  if (canonical.isSymbolicLink() || !canonical.isFile() || !same(expected, snapshot(canonical))) {
    throw new Error(`${label} changed during prevalidation`)
  }
  return { requestedPath, canonicalPath, maxBytes, label, snapshot: expected }
}

export async function readStableTextManifest(manifest: StableTextManifest): Promise<string> {
  const { requestedPath, canonicalPath, maxBytes, label, snapshot: expected } = manifest
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    throw new Error(`${label} changed before it was read`)
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes) || !same(expected, snapshot(before))) {
      throw new Error(`${label} changed before it was read`)
    }
    const buffer = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const [after, requestedAfter, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(requestedPath, { bigint: true }),
      realpath(requestedPath),
    ])
    if (
      offset !== buffer.length ||
      requestedAfter.isSymbolicLink() ||
      canonicalAfter !== canonicalPath ||
      !same(expected, snapshot(after)) ||
      !same(expected, snapshot(requestedAfter))
    ) {
      throw new Error(`${label} changed while it was being read`)
    }
    return buffer.toString('utf8')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} changed`)) throw error
    throw new Error(`${label} changed while it was being read`)
  } finally {
    await handle.close()
  }
}

export async function readStableTextFile(path: string, maxBytes: number, label: string): Promise<string> {
  return readStableTextManifest(await prevalidateStableTextFile(path, maxBytes, label))
}
