/**
 * AnalysisCache: on-disk cache of Analysis JSON under <oranguHome>/cache.
 *
 * Keyed by transcript path + size + mtime + sidecar fingerprint; versioned by directory
 * (<ANALYSIS_SCHEMA_VERSION>-<engine version>) so a schema or engine bump is an automatic miss.
 * A miss is NEVER an error: absent, corrupt or mismatched entries simply re-analyze.
 * Entries are stored with generator.generatedAt = 0 (no clock in the cached bytes);
 * analyzeRefCached re-stamps it on the way out.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ANALYSIS_SCHEMA_VERSION, type Analysis } from '../model/analysis.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import {
  assertEvidenceSessionManifestStable,
  MAX_LOCAL_SESSION_BYTES,
  prevalidateEvidenceSession,
  readEvidenceSessionManifest,
  type EvidenceSessionManifest,
} from '../adapters/claude-code/evidence-input.js'
import { analyzeSession } from '../analyze/analyze.js'
import type { SessionRef } from '../discover/discover.js'
import { oranguHome } from '../util/home.js'
import {
  prevalidateStableTextFile,
  readStableTextManifest,
  type StableTextManifest,
} from '../util/stable-file.js'

/** A cache miss above this bound is cheaper and safer than an unbounded allocation. */
export const MAX_ANALYSIS_CACHE_ENTRY_BYTES = 256 * 1024 * 1024

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SIMPLE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/

interface PrivateDirectoryIdentity {
  path: string
  canonicalPath: string
  dev: bigint
  ino: bigint
}

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function modeBits(stat: BigIntStats): number {
  return Number(stat.mode & 0o777n)
}

async function ensurePrivateDirectory(path: string): Promise<PrivateDirectoryIdentity> {
  // Recursive creation is needed for a fresh custom ORANGU_HOME. We validate the
  // requested directory itself before using it as a cache parent.
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const requested = await lstat(path, { bigint: true })
  if (requested.isSymbolicLink() || !requested.isDirectory()) throw new Error(`cache directory must be a real directory: ${path}`)

  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isDirectory() || !sameInode(requested, before)) throw new Error(`cache directory changed while opening: ${path}`)
    if (modeBits(before) !== PRIVATE_DIRECTORY_MODE) await handle.chmod(PRIVATE_DIRECTORY_MODE)

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
      modeBits(after) !== PRIVATE_DIRECTORY_MODE ||
      modeBits(requestedAfter) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error(`cache directory changed while securing: ${path}`)
    }
    return { path, canonicalPath, dev: after.dev, ino: after.ino }
  } finally {
    await handle.close()
  }
}

async function assertPrivateDirectoriesStable(directories: PrivateDirectoryIdentity[]): Promise<void> {
  for (const expected of directories) {
    const [current, canonicalPath] = await Promise.all([lstat(expected.path, { bigint: true }), realpath(expected.path)])
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      canonicalPath !== expected.canonicalPath ||
      modeBits(current) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error(`cache directory changed during access: ${expected.path}`)
    }
  }
}

/** @internal Split from the read so replacement handling has a deterministic regression test. */
export async function prevalidateAnalysisCacheEntry(path: string): Promise<StableTextManifest> {
  const requested = await lstat(path, { bigint: true })
  if (requested.isSymbolicLink()) throw new Error('cache entry must not be a symbolic link')
  if (!requested.isFile()) throw new Error('cache entry must be a regular file')
  if (requested.size > BigInt(MAX_ANALYSIS_CACHE_ENTRY_BYTES)) {
    throw new Error(`cache entry exceeds ${MAX_ANALYSIS_CACHE_ENTRY_BYTES} bytes`)
  }

  // Tighten an entry created by an older release through its already-open inode;
  // never chmod a pathname that could have been swapped to a symlink.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameInode(requested, opened) || opened.size > BigInt(MAX_ANALYSIS_CACHE_ENTRY_BYTES)) {
      throw new Error('cache entry changed while opening')
    }
    if (modeBits(opened) !== PRIVATE_FILE_MODE) await handle.chmod(PRIVATE_FILE_MODE)
  } finally {
    await handle.close()
  }

  return prevalidateStableTextFile(path, MAX_ANALYSIS_CACHE_ENTRY_BYTES, 'cache entry')
}

/** @internal Read the exact regular inode accepted by prevalidateAnalysisCacheEntry. */
export async function readAnalysisCacheEntry(manifest: StableTextManifest): Promise<string> {
  return readStableTextManifest(manifest)
}

export interface CacheOptions {
  /** cache root; default oranguHome()/cache */
  dir?: string
  /** engine version (part of the version directory name) */
  version: string
  /** false on --no-cache / ORANGU_NO_CACHE=1: get/put become no-ops */
  enabled?: boolean
}

export interface CacheKeyInput {
  path: string
  sizeBytes: number
  mtimeMs: number
  subagentFiles: string[]
}

/** sha1(path|size|mtime|n|Σ sidecar size|max sidecar mtime); stats the sidecar files. */
export async function cacheKey(i: CacheKeyInput): Promise<string> {
  let sidecarBytes = 0
  let sidecarMaxMtime = 0
  for (const f of i.subagentFiles) {
    try {
      const st = await stat(f)
      sidecarBytes += st.size
      if (st.mtimeMs > sidecarMaxMtime) sidecarMaxMtime = st.mtimeMs
    } catch {
      /* a vanished sidecar simply doesn't contribute; the main mtime moves anyway */
    }
  }
  const raw = [i.path, i.sizeBytes, i.mtimeMs, i.subagentFiles.length, sidecarBytes, sidecarMaxMtime].join('|')
  return createHash('sha1').update(raw).digest('hex')
}

/** Cache identity from the exact canonical inode manifest that parsing may read. */
export function manifestCacheKey(manifest: EvidenceSessionManifest): string {
  return createHash('sha1').update(`manifest-v1|${manifest.fingerprint}`).digest('hex')
}

export class AnalysisCache {
  private readonly layoutDirectories: string[]
  private readonly dir: string
  private readonly enabled: boolean
  private readonly validVersion: boolean
  private hits = 0
  private misses = 0
  private writes = 0

  constructor(opts: CacheOptions) {
    const home = resolve(oranguHome())
    const cacheRoot = resolve(opts.dir ?? join(home, 'cache'))
    const versionSegment = `${ANALYSIS_SCHEMA_VERSION}-${opts.version}`
    this.validVersion = SIMPLE_SEGMENT.test(versionSegment)
    this.dir = join(cacheRoot, versionSegment)
    this.layoutDirectories = opts.dir === undefined ? [home, cacheRoot, this.dir] : [cacheRoot, this.dir]
    this.enabled = opts.enabled !== false
  }

  private file(key: string): string | undefined {
    if (!this.validVersion || !SIMPLE_SEGMENT.test(key)) return undefined
    return join(this.dir, `${key}.json`)
  }

  private async ensurePrivateLayout(): Promise<PrivateDirectoryIdentity[]> {
    const identities: PrivateDirectoryIdentity[] = []
    for (const path of this.layoutDirectories) identities.push(await ensurePrivateDirectory(path))
    return identities
  }

  /** miss on absent/corrupt/version mismatch; never throws */
  async get(key: string): Promise<Analysis | undefined> {
    if (!this.enabled) {
      this.misses++
      return undefined
    }
    try {
      const path = this.file(key)
      if (!path) throw new Error('invalid cache key')
      const directories = await this.ensurePrivateLayout()
      const manifest = await prevalidateAnalysisCacheEntry(path)
      await assertPrivateDirectoriesStable(directories)
      const raw = await readAnalysisCacheEntry(manifest)
      await assertPrivateDirectoriesStable(directories)
      const a = JSON.parse(raw) as Analysis
      if (!a || typeof a !== 'object' || a.schemaVersion !== ANALYSIS_SCHEMA_VERSION || !a.generator) {
        this.misses++
        return undefined
      }
      this.hits++
      return a
    } catch {
      this.misses++
      return undefined
    }
  }

  /** atomic tmp+rename; stores WITHOUT generator.generatedAt (set to 0) */
  async put(key: string, a: Analysis): Promise<void> {
    if (!this.enabled) return
    let tmp: string | undefined
    try {
      const stored: Analysis = { ...a, generator: { ...a.generator, generatedAt: 0 } }
      const path = this.file(key)
      if (!path) return
      const bytes = Buffer.from(JSON.stringify(stored), 'utf8')
      if (bytes.byteLength > MAX_ANALYSIS_CACHE_ENTRY_BYTES) return
      const directories = await this.ensurePrivateLayout()
      tmp = `${path}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`
      const handle = await open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      )
      try {
        await handle.writeFile(bytes)
        await handle.chmod(PRIVATE_FILE_MODE)
      } finally {
        await handle.close()
      }
      await assertPrivateDirectoriesStable(directories)
      await rename(tmp, path)
      tmp = undefined
      await assertPrivateDirectoriesStable(directories)
      const final = await lstat(path, { bigint: true })
      if (!final.isFile() || final.isSymbolicLink() || modeBits(final) !== PRIVATE_FILE_MODE) {
        throw new Error('cache entry changed after its atomic write')
      }
      this.writes++
    } catch {
      /* a failed write is a future miss, never an error */
    } finally {
      if (tmp) {
        try {
          await unlink(tmp)
        } catch {
          /* best-effort cleanup of our private, exclusively-created temporary */
        }
      }
    }
  }

  stats(): { hits: number; misses: number; writes: number } {
    return { hits: this.hits, misses: this.misses, writes: this.writes }
  }
}

/** analyze via the cache: hit → re-stamp generatedAt; miss → parse + analyze + put. */
export async function analyzeRefCached(
  ref: SessionRef,
  o: { cache: AnalysisCache | null; version: string; now: number },
): Promise<Analysis> {
  // This validation intentionally precedes cache lookup: a stale key must not
  // turn a replaced/symlinked transcript into a trusted cache hit.
  let manifest = await prevalidateEvidenceSession(ref.path, { maxBytes: MAX_LOCAL_SESSION_BYTES })
  if (o.cache) {
    let key = manifestCacheKey(manifest)
    const hit = await o.cache.get(key)
    if (hit) {
      await assertEvidenceSessionManifestStable(manifest)
      hit.generator.generatedAt = o.now
      return hit
    }
    // A miss may initialize the caller-selected cache directory beside the transcript, changing the
    // project tree after the first snapshot. Take a fresh immutable manifest (and key) before parsing
    // rather than weakening tree stability.
    manifest = await prevalidateEvidenceSession(ref.path, { maxBytes: MAX_LOCAL_SESSION_BYTES })
    key = manifestCacheKey(manifest)
    const loaded = await readEvidenceSessionManifest(manifest)
    const session = await parseClaudeCodeSession(loaded.parseInput)
    const a = analyzeSession(session, { version: o.version, now: o.now })
    await o.cache.put(key, a)
    return a
  }
  const loaded = await readEvidenceSessionManifest(manifest)
  const session = await parseClaudeCodeSession(loaded.parseInput)
  return analyzeSession(session, { version: o.version, now: o.now })
}
