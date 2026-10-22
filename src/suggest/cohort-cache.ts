/**
 * The cohort facts cache: the facts of 1 settled session that a cohort read needs, so a second queue read parses no
 * transcript. 1 small file for each session, under the generation directory of the analysis cache
 * (`<orangu home>/cache/<generation>/cohort-facts-v1/<key>.json`), so a generation move drops every entry.
 *
 * It copies the private layout of `AnalysisCache` (`src/cache/index.ts`): each directory is 0700 and is checked again
 * around each read and write, each entry is 0600, a link is never followed, and a write is an exclusive temporary
 * file and a rename. An entry holds numbers, booleans, the lowercase session id, its own key and the canonical cwd
 * of the session (the workspace identity that the store keeps too). It holds no transcript text.
 *
 * An entry can instead hold a skip: the trusted loader refused the session as over the cap of its load. That entry
 * holds the session id, its own key, the cap and the probe bytes of that load, all numbers. A later read reuses it only
 * at a cap where the same refusal holds, so a session over the 64 MiB evidence cap is not probed and walked again on
 * each warm read.
 *
 * A miss is never an error. An entry is bound to its key and to its session id, and any other shape is a miss, so a
 * stale or broken file can only cost a transcript read. Only the queue reads this cache. The record steps measure
 * with the trusted loaders of `createCohortDeps`, so no entry can change a stored verdict.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MAX_EVIDENCE_SESSION_BYTES } from '../adapters/claude-code/evidence-input.js'
import {
  assertPrivateDirectoriesStable,
  cacheGenerationSegment,
  ensurePrivateDirectory,
  isCacheSegment,
  prevalidateAnalysisCacheEntry,
  PRIVATE_FILE_MODE,
  readAnalysisCacheEntry,
  type PrivateDirectoryIdentity,
} from '../cache/index.js'
import type { SessionRef } from '../discover/discover.js'
import { oranguHome } from '../util/home.js'
import { SUGGESTION_VERIFICATION_METRICS, type SuggestionVerificationMetric } from './types.js'

/** The folder of the cohort facts inside a generation directory. A change to what a fact means moves its version. */
export const COHORT_FACTS_DIR = 'cohort-facts-v1'
/** An entry is about 500 B. A larger file is not an entry, and it is refused before it is read. */
export const COHORT_FACTS_MAX_ENTRY_BYTES = 16_384

/** The facts of 1 settled session that a cohort read takes from the cache. */
export interface CohortFacts {
  /** lowercase */
  sessionId: string
  /** the canonical (realpath) cwd of the session */
  cwd: string
  startedAt: number
  endedAt: number
  ranOrangu: boolean
  /** the transcript bytes of the trusted read, so a hit spends the same side budget as that read */
  bytesRead: number
  metrics: Record<SuggestionVerificationMetric, number>
}

/**
 * A session that the trusted loader refused as over the cap of its load: the 64 MiB evidence cap, or what was left of
 * its side. A queue read reuses it only at a cap where the same refusal holds (`overCapHolds` in `cohort-deps.ts`).
 */
export interface CohortOverCap {
  /** lowercase */
  sessionId: string
  /** the cap of the refused load */
  maxBytes: number
  /** the probe bytes of the refused load, which a reuse spends again */
  bytesRead: number
}

/** 1 cache entry: the facts of a settled session, or a session over the cap of its load. */
export type CohortEntry = { facts: CohortFacts } | { overCap: CohortOverCap }

const ENTRY_KEYS = ['v', 'key', 'sessionId', 'cwd', 'startedAt', 'endedAt', 'ranOrangu', 'bytesRead', 'metrics'] as const
const OVER_CAP_KEYS = ['v', 'key', 'sessionId', 'skip', 'maxBytes', 'bytesRead'] as const
const KEY_RE = /^[0-9a-f]{40}$/
/** The lowercase form of `SESSION_ID_RE` (`src/discover/discover.ts`), as the trusted loader stores an id. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The longest canonical cwd that the store accepts (`src/suggest/store.ts`). */
const MAX_CWD_CHARS = 4_096

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

const finiteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** True when the facts keep every rule: the same rules hold for a write and for a read. */
function validFacts(value: Record<string, unknown>): boolean {
  const { sessionId, cwd, startedAt, endedAt, ranOrangu, bytesRead, metrics } = value
  return (
    typeof sessionId === 'string' &&
    SESSION_ID_RE.test(sessionId) &&
    typeof cwd === 'string' &&
    isAbsolute(cwd) &&
    cwd.length <= MAX_CWD_CHARS &&
    resolve(cwd) === cwd &&
    finiteNonNegative(startedAt) &&
    startedAt > 0 &&
    finiteNonNegative(endedAt) &&
    endedAt >= startedAt &&
    typeof ranOrangu === 'boolean' &&
    Number.isSafeInteger(bytesRead) &&
    (bytesRead as number) >= 0 &&
    plainObject(metrics) &&
    hasExactKeys(metrics, SUGGESTION_VERIFICATION_METRICS) &&
    SUGGESTION_VERIFICATION_METRICS.every((metric) => finiteNonNegative(metrics[metric]))
  )
}

/** True when the skip keeps every rule: an id, a cap up to the evidence cap, and probe bytes below the cap. */
function validOverCap(value: Record<string, unknown>): boolean {
  const { sessionId, skip, maxBytes, bytesRead } = value
  return (
    typeof sessionId === 'string' &&
    SESSION_ID_RE.test(sessionId) &&
    skip === 'over-budget' &&
    Number.isSafeInteger(maxBytes) &&
    (maxBytes as number) >= 1 &&
    (maxBytes as number) <= MAX_EVIDENCE_SESSION_BYTES &&
    Number.isSafeInteger(bytesRead) &&
    (bytesRead as number) >= 0 &&
    (bytesRead as number) < (maxBytes as number)
  )
}

/** The skip with its keys in a fixed order, and nothing that a caller adds. */
function pickOverCap(overCap: CohortOverCap): CohortOverCap {
  return { sessionId: overCap.sessionId, maxBytes: overCap.maxBytes, bytesRead: overCap.bytesRead }
}

/** The facts with their keys in a fixed order, and nothing that a caller adds. */
function pick(facts: CohortFacts): CohortFacts {
  return {
    sessionId: facts.sessionId,
    cwd: facts.cwd,
    startedAt: facts.startedAt,
    endedAt: facts.endedAt,
    ranOrangu: facts.ranOrangu,
    bytesRead: facts.bytesRead,
    metrics: Object.fromEntries(SUGGESTION_VERIFICATION_METRICS.map((metric) => [metric, facts.metrics?.[metric]])) as Record<SuggestionVerificationMetric, number>,
  }
}

/** The cache key of a transcript, and the newest change time of its files for the settle rule. */
export interface CohortFactsKey {
  key: string
  /** the newest mtime or ctime of the transcript and its sidecar files, in ms */
  changedAt: number
}

/**
 * The key of a transcript, and its newest change time, from the entries that the quiet gate of the trusted loader
 * reads (`evidenceManifestLatestChangeMs`, `src/adapters/claude-code/evidence-input.ts`). The key holds the path, the
 * inode, the size, the mtime and the ctime of the transcript, and the size, mtime and ctime of each sidecar file and
 * its `.meta.json`. The change time is the newest mtime or ctime of those files and of the session folder and its
 * `subagents` folder, or of the project folder when the session has no folder. Undefined for a link, a missing file or
 * a file that is not regular, so such a transcript is never a cache hit.
 */
export async function cohortFactsKey(ref: Pick<SessionRef, 'path' | 'subagentFiles'>): Promise<CohortFactsKey | undefined> {
  try {
    const main = await lstat(ref.path, { bigint: true })
    if (main.isSymbolicLink() || !main.isFile()) return undefined
    let changedNs = 0n
    const changed = (st: { mtimeNs: bigint; ctimeNs: bigint }): void => {
      if (st.mtimeNs > changedNs) changedNs = st.mtimeNs
      if (st.ctimeNs > changedNs) changedNs = st.ctimeNs
    }
    changed(main)
    const parts: Array<string | bigint | number> = [COHORT_FACTS_DIR, ref.path, main.dev, main.ino, main.size, main.mtimeNs, main.ctimeNs]
    const sessionDir = join(dirname(ref.path), basename(ref.path, '.jsonl'))
    const folder = await lstatOrUndefined(sessionDir)
    if (folder?.isDirectory()) {
      changed(folder)
      const subagents = await lstatOrUndefined(join(sessionDir, 'subagents'))
      if (subagents?.isDirectory()) changed(subagents)
    } else {
      const project = await lstatOrUndefined(dirname(ref.path))
      if (project) changed(project)
    }
    const files = [...ref.subagentFiles].sort()
    parts.push(files.length)
    for (const dir of new Set(files.map((file) => dirname(file)))) {
      const st = await lstatOrUndefined(dir)
      if (st) changed(st)
    }
    for (const file of files) {
      // A vanished sidecar or meta file counts as absent. The main file moves when its session writes again.
      for (const path of [file, file.replace(/\.jsonl$/, '.meta.json')]) {
        const st = await lstatOrUndefined(path)
        if (st) changed(st)
        parts.push(st ? `${st.size}:${st.mtimeNs}:${st.ctimeNs}` : '-')
      }
    }
    // Round toward the future, as the quiet gate of the trusted loader does.
    const changedAt = Number((changedNs + 999_999n) / 1_000_000n)
    return { key: createHash('sha1').update(parts.join('|')).digest('hex'), changedAt }
  } catch {
    return undefined
  }
}

async function lstatOrUndefined(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch {
    return undefined
  }
}

export interface CohortFactsCacheOptions {
  /** engine version, part of the generation directory */
  version: string
  /** the cache root; default `<orangu home>/cache` */
  dir?: string
  /** false with `--no-cache` or `ORANGU_NO_CACHE=1`: every read misses and nothing is written */
  enabled?: boolean
}

export class CohortFactsCache {
  private readonly layoutDirectories: string[]
  private readonly folder: string
  private readonly enabled: boolean
  private readonly validVersion: boolean
  private layout: Promise<PrivateDirectoryIdentity[]> | undefined
  private hits = 0
  private misses = 0
  private writes = 0

  constructor(opts: CohortFactsCacheOptions) {
    const home = resolve(oranguHome())
    const cacheRoot = resolve(opts.dir ?? join(home, 'cache'))
    const segment = cacheGenerationSegment(opts.version)
    this.validVersion = isCacheSegment(segment)
    const generation = join(cacheRoot, segment)
    this.folder = join(generation, COHORT_FACTS_DIR)
    this.layoutDirectories = opts.dir === undefined ? [home, cacheRoot, generation, this.folder] : [cacheRoot, generation, this.folder]
    this.enabled = opts.enabled !== false
  }

  private file(key: string): string | undefined {
    return this.validVersion && KEY_RE.test(key) ? join(this.folder, `${key}.json`) : undefined
  }

  /** Secure the layout once, and check it again before each use. A changed layout is secured again on the next use. */
  private async directories(): Promise<PrivateDirectoryIdentity[]> {
    this.layout ??= (async () => {
      const identities: PrivateDirectoryIdentity[] = []
      for (const path of this.layoutDirectories) identities.push(await ensurePrivateDirectory(path))
      return identities
    })()
    try {
      const identities = await this.layout
      await assertPrivateDirectoriesStable(identities)
      return identities
    } catch (error) {
      this.layout = undefined
      throw error
    }
  }

  /** The entry of this key and this session, or undefined: no stats. It never throws. */
  private async read(key: string, sessionId: string): Promise<CohortEntry | undefined> {
    if (!this.enabled) return undefined
    try {
      const path = this.file(key)
      if (!path) return undefined
      const directories = await this.directories()
      const manifest = await prevalidateAnalysisCacheEntry(path, COHORT_FACTS_MAX_ENTRY_BYTES)
      await assertPrivateDirectoriesStable(directories)
      const raw = await readAnalysisCacheEntry(manifest)
      await assertPrivateDirectoriesStable(directories)
      const value: unknown = JSON.parse(raw)
      if (!plainObject(value) || value['v'] !== 1 || value['key'] !== key || value['sessionId'] !== sessionId) return undefined
      if (hasExactKeys(value, ENTRY_KEYS) && validFacts(value)) return { facts: pick(value as unknown as CohortFacts) }
      if (hasExactKeys(value, OVER_CAP_KEYS) && validOverCap(value)) return { overCap: pickOverCap(value as unknown as CohortOverCap) }
      return undefined
    } catch {
      return undefined
    }
  }

  /** The entry of this key and this session (facts or a skip over the cap), or undefined. It never throws. */
  async lookup(key: string, sessionId: string): Promise<CohortEntry | undefined> {
    const entry = await this.read(key, sessionId)
    if (entry) this.hits++
    else this.misses++
    return entry
  }

  /** The facts of this key and this session, or undefined. It never throws. */
  async get(key: string, sessionId: string): Promise<CohortFacts | undefined> {
    const entry = await this.read(key, sessionId)
    if (entry && 'facts' in entry) {
      this.hits++
      return entry.facts
    }
    this.misses++
    return undefined
  }

  /** Write the facts of 1 settled session under its key: an exclusive temporary file, then a rename. It never throws. */
  async put(key: string, facts: CohortFacts): Promise<void> {
    const picked = pick(facts)
    if (!validFacts(picked as unknown as Record<string, unknown>)) return
    await this.write(key, { v: 1, key, ...picked })
  }

  /** Write a session over the cap of its load under its key, as `put` writes facts. It never throws. */
  async putOverCap(key: string, overCap: CohortOverCap): Promise<void> {
    const picked = { sessionId: overCap.sessionId, skip: 'over-budget', maxBytes: overCap.maxBytes, bytesRead: overCap.bytesRead }
    if (!validOverCap(picked)) return
    await this.write(key, { v: 1, key, ...picked })
  }

  /** Write 1 checked entry: an exclusive temporary file, then a rename. It never throws. */
  private async write(key: string, entry: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return
    let tmp: string | undefined
    try {
      const path = this.file(key)
      if (!path) return
      const bytes = Buffer.from(JSON.stringify(entry), 'utf8')
      if (bytes.byteLength > COHORT_FACTS_MAX_ENTRY_BYTES) return
      const directories = await this.directories()
      tmp = `${path}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`
      const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE)
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
      if (!final.isFile() || final.isSymbolicLink() || Number(final.mode & 0o777n) !== PRIVATE_FILE_MODE) throw new Error('cache entry changed after its atomic write')
      this.writes++
    } catch {
      // A failed write is a later miss, never an error.
    } finally {
      if (tmp) {
        try {
          await unlink(tmp)
        } catch {
          // The temporary file is ours and private, so a failed removal leaves only a private file.
        }
      }
    }
  }

  stats(): { hits: number; misses: number; writes: number } {
    return { hits: this.hits, misses: this.misses, writes: this.writes }
  }
}
