import { describe, expect, it } from 'vitest'
import { chmodSync as chmodS, mkdirSync as mkdirS, writeFileSync as writeS } from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  AnalysisCache,
  MAX_ANALYSIS_CACHE_ENTRY_BYTES,
  analyzeRefCached,
  cacheKey,
  prevalidateAnalysisCacheEntry,
  readAnalysisCacheEntry,
} from './index.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import type { Analysis } from '../model/analysis.js'
import {
  MAX_EVIDENCE_META_BYTES,
  MAX_EVIDENCE_SESSION_RECORDS,
  MAX_EVIDENCE_SIDECAR_DEPTH,
  MAX_EVIDENCE_SIDECAR_ENTRIES,
  MAX_LOCAL_SESSION_BYTES,
} from '../adapters/claude-code/evidence-input.js'
import type { SessionRef } from '../discover/discover.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'orangu-cache-'))

async function fixtureAnalysis(): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'cache-test', now: 12345 })
}

function refFor(path: string): SessionRef {
  const st = statSync(path)
  const sessionId = basename(path, '.jsonl')
  return {
    sessionId,
    path,
    projectSlug: 'p',
    projectPath: dirname(path),
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    hasSidecarDir: false,
    subagentFiles: [],
  }
}

function sidecarRoot(main: string): string {
  return join(dirname(main), basename(main, '.jsonl'), 'subagents')
}

function defaultCacheAt(home: string, version: string): AnalysisCache {
  const previous = process.env['ORANGU_HOME']
  process.env['ORANGU_HOME'] = home
  try {
    return new AnalysisCache({ version })
  } finally {
    if (previous === undefined) delete process.env['ORANGU_HOME']
    else process.env['ORANGU_HOME'] = previous
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

function cachePaths(home: string, key: string): { root: string; version: string; entry: string } {
  const root = join(home, 'cache')
  const version = join(root, readdirSync(root)[0] as string)
  return { root, version, entry: join(version, `${key}.json`) }
}

describe('cacheKey', () => {
  const base = { path: '/a/b.jsonl', sizeBytes: 100, mtimeMs: 5000, subagentFiles: [] as string[] }
  it('is stable for identical input', async () => {
    expect(await cacheKey(base)).toBe(await cacheKey({ ...base }))
  })
  it('changes when path, size or mtime change', async () => {
    const k = await cacheKey(base)
    expect(await cacheKey({ ...base, path: '/a/c.jsonl' })).not.toBe(k)
    expect(await cacheKey({ ...base, sizeBytes: 101 })).not.toBe(k)
    expect(await cacheKey({ ...base, mtimeMs: 5001 })).not.toBe(k)
  })
  it('changes when a sidecar file grows', async () => {
    const dir = tmp()
    const side = join(dir, 'agent-1.jsonl')
    writeFileSync(side, '{"a":1}\n')
    const k1 = await cacheKey({ ...base, subagentFiles: [side] })
    writeFileSync(side, '{"a":1}\n{"b":2}\n')
    const k2 = await cacheKey({ ...base, subagentFiles: [side] })
    expect(k2).not.toBe(k1)
    expect(k1).not.toBe(await cacheKey(base))
  })
  it('a missing sidecar file is not an error', async () => {
    await expect(cacheKey({ ...base, subagentFiles: ['/nope/never.jsonl'] })).resolves.toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('AnalysisCache', () => {
  it('round-trips an analysis byte-identically after re-stamping generatedAt', async () => {
    const a = await fixtureAnalysis()
    const c = new AnalysisCache({ dir: tmp(), version: '9.9.9' })
    await c.put('k1', a)
    const back = await c.get('k1')
    expect(back).toBeDefined()
    expect(back!.generator.generatedAt).toBe(0) // stored without the clock stamp
    back!.generator.generatedAt = a.generator.generatedAt
    expect(JSON.stringify(back, null, 2)).toBe(JSON.stringify(a, null, 2))
    expect(c.stats()).toEqual({ hits: 1, misses: 0, writes: 1 })
  })
  it.skipIf(process.platform === 'win32')('creates the default home, cache, version, and entry with private modes', async () => {
    const home = join(tmp(), 'fresh', 'orangu-home')
    const c = defaultCacheAt(home, 'private-fresh')
    await c.put('simple-key_1.2', await fixtureAnalysis())
    const paths = cachePaths(home, 'simple-key_1.2')

    expect(mode(home)).toBe(0o700)
    expect(mode(paths.root)).toBe(0o700)
    expect(mode(paths.version)).toBe(0o700)
    expect(mode(paths.entry)).toBe(0o600)
    expect(await c.get('simple-key_1.2')).toBeDefined()
  })
  it.skipIf(process.platform === 'win32')('tightens existing default cache directories and entries', async () => {
    const home = join(tmp(), 'existing-home')
    const c = defaultCacheAt(home, 'private-existing')
    await c.put('existing', await fixtureAnalysis())
    const paths = cachePaths(home, 'existing')
    chmodSync(home, 0o755)
    chmodSync(paths.root, 0o755)
    chmodSync(paths.version, 0o755)
    chmodSync(paths.entry, 0o644)

    expect(await c.get('existing')).toBeDefined()
    expect(mode(home)).toBe(0o700)
    expect(mode(paths.root)).toBe(0o700)
    expect(mode(paths.version)).toBe(0o700)
    expect(mode(paths.entry)).toBe(0o600)
  })
  it.skipIf(process.platform === 'win32')('does not follow a symlinked default cache directory', async () => {
    const parent = tmp()
    const home = join(parent, 'home')
    const outside = join(parent, 'outside')
    mkdirSync(home)
    mkdirSync(outside)
    symlinkSync(outside, join(home, 'cache'), 'dir')
    const c = defaultCacheAt(home, 'symlink-root')

    expect(await c.get('missing')).toBeUndefined()
    await expect(c.put('entry', await fixtureAnalysis())).resolves.toBeUndefined()
    expect(readdirSync(outside)).toEqual([])
    expect(c.stats()).toEqual({ hits: 0, misses: 1, writes: 0 })
  })
  it.skipIf(process.platform === 'win32')('treats a symlink entry as a miss without chmodding its target', async () => {
    const dir = tmp()
    const c = new AnalysisCache({ dir, version: 'symlink-entry' })
    const analysis = await fixtureAnalysis()
    await c.put('entry', analysis)
    const version = join(dir, readdirSync(dir)[0] as string)
    const entry = join(version, 'entry.json')
    const outside = join(dir, 'outside.json')
    writeFileSync(outside, JSON.stringify(analysis), { mode: 0o644 })
    chmodSync(outside, 0o644)
    unlinkSync(entry)
    symlinkSync(outside, entry)

    expect(await c.get('entry')).toBeUndefined()
    expect(mode(outside)).toBe(0o644)
  })
  it('treats non-regular and oversized entries as cache misses', async () => {
    const dir = tmp()
    const c = new AnalysisCache({ dir, version: 'invalid-entries' })
    const analysis = await fixtureAnalysis()
    await c.put('nonregular', analysis)
    const version = join(dir, readdirSync(dir)[0] as string)
    const nonregular = join(version, 'nonregular.json')
    unlinkSync(nonregular)
    mkdirSync(nonregular)
    expect(await c.get('nonregular')).toBeUndefined()
    rmdirSync(nonregular)

    await c.put('oversized', analysis)
    truncateSync(join(version, 'oversized.json'), MAX_ANALYSIS_CACHE_ENTRY_BYTES + 1)
    expect(await c.get('oversized')).toBeUndefined()
  })
  it('rejects a cache entry replaced after prevalidation', async () => {
    const dir = tmp()
    const path = join(dir, 'entry.json')
    const moved = join(dir, 'entry.original.json')
    writeFileSync(path, '{"first":true}', { mode: 0o600 })
    const manifest = await prevalidateAnalysisCacheEntry(path)
    renameSync(path, moved)
    writeFileSync(path, '{"replacement":true}', { mode: 0o600 })

    await expect(readAnalysisCacheEntry(manifest)).rejects.toThrow(/changed/)
  })
  it('misses on an absent key', async () => {
    const c = new AnalysisCache({ dir: tmp(), version: '1.0.0' })
    expect(await c.get('nope')).toBeUndefined()
    expect(c.stats().misses).toBe(1)
  })
  it('misses (never throws) on a corrupt file', async () => {
    const dir = tmp()
    const c = new AnalysisCache({ dir, version: '1.0.0' })
    const a = await fixtureAnalysis()
    await c.put('k', a)
    const sub = readdirSync(dir)[0] as string
    writeFileSync(join(dir, sub, 'k.json'), '{ not json !!!')
    expect(await c.get('k')).toBeUndefined()
  })
  it('misses across engine versions (separate version dirs)', async () => {
    const dir = tmp()
    const a = await fixtureAnalysis()
    const c1 = new AnalysisCache({ dir, version: '1.0.0' })
    await c1.put('k', a)
    const c2 = new AnalysisCache({ dir, version: '2.0.0' })
    expect(await c2.get('k')).toBeUndefined()
  })
  it('does nothing when disabled', async () => {
    const dir = tmp()
    const c = new AnalysisCache({ dir, version: '1.0.0', enabled: false })
    await c.put('k', await fixtureAnalysis())
    expect(await c.get('k')).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('analyzeRefCached', () => {
  it('analyzes on miss, serves the identical analysis on hit with a fresh generatedAt', async () => {
    const dir = tmp()
    const jsonl = join(dir, 'sess.jsonl')
    writeFileSync(jsonl, buildCanonicalSession().toJsonl())
    const ref = { sessionId: 's', path: jsonl, projectSlug: 'p', projectPath: dir, sizeBytes: 10, mtimeMs: 1, hasSidecarDir: false, subagentFiles: [] }
    const cache = new AnalysisCache({ dir: join(dir, 'cache'), version: 'x' })
    const a1 = await analyzeRefCached(ref, { cache, version: 'x', now: 111 })
    expect(a1.generator.generatedAt).toBe(111)
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, writes: 1 })
    const a2 = await analyzeRefCached(ref, { cache, version: 'x', now: 222 })
    expect(cache.stats().hits).toBe(1)
    expect(a2.generator.generatedAt).toBe(222)
    a2.generator.generatedAt = 111
    expect(JSON.stringify(a2, null, 2)).toBe(JSON.stringify(a1, null, 2))
  })
  it('works without a cache', async () => {
    const dir = tmp()
    const jsonl = join(dir, 'sess.jsonl')
    writeFileSync(jsonl, buildCanonicalSession().toJsonl())
    const ref = { sessionId: 's', path: jsonl, projectSlug: 'p', projectPath: dir, sizeBytes: 10, mtimeMs: 1, hasSidecarDir: false, subagentFiles: [] }
    const a = await analyzeRefCached(ref, { cache: null, version: 'x', now: 5 })
    expect(a.summary.turns).toBeGreaterThan(0)
  })

  it('prevalidates before a cache hit and rejects a main transcript replaced by a symlink', async () => {
    const dir = tmp()
    const main = join(dir, 'sess.jsonl')
    const outside = join(dir, 'outside.jsonl')
    const moved = join(dir, 'sess.original.jsonl')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    writeFileSync(outside, buildCanonicalSession().toJsonl())
    const ref = refFor(main)
    const cache = new AnalysisCache({ dir: join(dir, 'cache'), version: 'secure' })
    await analyzeRefCached(ref, { cache, version: 'secure', now: 1 })
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, writes: 1 })

    renameSync(main, moved)
    symlinkSync(outside, main)
    await expect(analyzeRefCached(ref, { cache, version: 'secure', now: 2 })).rejects.toThrow(/symbolic links/)
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, writes: 1 })
  })

  it('keys cache entries from the validated manifest, including sidecar metadata', async () => {
    const dir = tmp()
    const main = join(dir, 'sess.jsonl')
    const root = sidecarRoot(main)
    const sidecar = join(root, 'agent-one.jsonl')
    const meta = join(root, 'agent-one.meta.json')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    writeFileSync(sidecar, buildCanonicalSession().toJsonl())
    writeFileSync(meta, JSON.stringify({ agentType: 'first' }))
    const ref = refFor(main)
    const cache = new AnalysisCache({ dir: join(dir, 'cache'), version: 'manifest' })
    await analyzeRefCached(ref, { cache, version: 'manifest', now: 1 })
    writeFileSync(meta, JSON.stringify({ agentType: 'second', changed: true }))
    await analyzeRefCached(ref, { cache, version: 'manifest', now: 2 })
    expect(cache.stats()).toEqual({ hits: 0, misses: 2, writes: 2 })
  })

  it('rejects sidecar symlink escape and traversal/entry overflow on the ordinary path', async () => {
    const dir = tmp()
    const linkedMain = join(dir, 'linked.jsonl')
    const linkedRoot = sidecarRoot(linkedMain)
    const outside = join(dir, 'outside.jsonl')
    writeFileSync(linkedMain, buildCanonicalSession().toJsonl())
    writeFileSync(outside, buildCanonicalSession().toJsonl())
    mkdirSync(linkedRoot, { recursive: true })
    symlinkSync(outside, join(linkedRoot, 'agent-escape.jsonl'))
    await expect(analyzeRefCached(refFor(linkedMain), { cache: null, version: 'x', now: 0 })).rejects.toThrow(/symbolic links/)

    const deepMain = join(dir, 'deep.jsonl')
    let deepRoot = sidecarRoot(deepMain)
    writeFileSync(deepMain, buildCanonicalSession().toJsonl())
    mkdirSync(deepRoot, { recursive: true })
    for (let index = 0; index <= MAX_EVIDENCE_SIDECAR_DEPTH; index++) {
      deepRoot = join(deepRoot, `level-${index}`)
      mkdirSync(deepRoot)
    }
    await expect(analyzeRefCached(refFor(deepMain), { cache: null, version: 'x', now: 0 })).rejects.toThrow(/traversal exceeds/)

    const crowdedMain = join(dir, 'crowded.jsonl')
    const crowdedRoot = sidecarRoot(crowdedMain)
    writeFileSync(crowdedMain, buildCanonicalSession().toJsonl())
    mkdirSync(crowdedRoot, { recursive: true })
    for (let index = 0; index <= MAX_EVIDENCE_SIDECAR_ENTRIES; index++) {
      writeFileSync(join(crowdedRoot, `ignored-${index}`), '')
    }
    await expect(analyzeRefCached(refFor(crowdedMain), { cache: null, version: 'x', now: 0 })).rejects.toThrow(/manifest exceeds/)
  })

  it('shares ordinary byte and record caps across main and sidecar transcripts', async () => {
    const dir = tmp()
    const byteMain = join(dir, 'bytes.jsonl')
    const byteRoot = sidecarRoot(byteMain)
    const byteSidecar = join(byteRoot, 'agent-large.jsonl')
    writeFileSync(byteMain, buildCanonicalSession().toJsonl())
    mkdirSync(byteRoot, { recursive: true })
    writeFileSync(byteSidecar, '')
    truncateSync(byteSidecar, MAX_LOCAL_SESSION_BYTES - statSync(byteMain).size + 1)
    await expect(analyzeRefCached(refFor(byteMain), { cache: null, version: 'x', now: 0 })).rejects.toThrow(
      new RegExp(`exceeds ${MAX_LOCAL_SESSION_BYTES} bytes`),
    )

    const recordMain = join(dir, 'records.jsonl')
    const recordRoot = sidecarRoot(recordMain)
    writeFileSync(recordMain, '{}\n'.repeat(60_000))
    mkdirSync(recordRoot, { recursive: true })
    writeFileSync(join(recordRoot, 'agent-many.jsonl'), '{}\n'.repeat(MAX_EVIDENCE_SESSION_RECORDS - 60_000 + 1))
    await expect(analyzeRefCached(refFor(recordMain), { cache: null, version: 'x', now: 0 })).rejects.toThrow(
      new RegExp(`exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`),
    )
  })

  it('rejects oversized sidecar metadata before reading it', async () => {
    const dir = tmp()
    const main = join(dir, 'meta.jsonl')
    const root = sidecarRoot(main)
    const sidecar = join(root, 'agent-meta.jsonl')
    const meta = join(root, 'agent-meta.meta.json')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    writeFileSync(sidecar, buildCanonicalSession().toJsonl())
    writeFileSync(meta, '')
    truncateSync(meta, MAX_EVIDENCE_META_BYTES + 1)
    await expect(analyzeRefCached(refFor(main), { cache: null, version: 'x', now: 0 })).rejects.toThrow(/metadata exceeds/)
  })
})

describe('worker pool e2e via the built CLI', () => {
  const dist = resolve('dist/orangu.js')
  it.skipIf(!existsSync(dist))('pooled global equals sequential global byte-for-byte (modulo clock fields)', async () => {
    const home = tmp()
    const cfg = tmp()
    const slug = join(cfg, 'projects', '-Users-test-Code-demo')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(slug, { recursive: true })
    const { GOLDEN_FIXTURES } = await import('../../test/fixtures/corpus.js')
    for (const fx of GOLDEN_FIXTURES.slice(0, 3)) {
      const b = fx.build()
      writeFileSync(join(slug, `${b.sessionId}.jsonl`), b.toJsonl())
    }
    const { execFile } = await import('node:child_process')
    const run = (extra: string[], envExtra: Record<string, string>) =>
      new Promise<{ stdout: string; stderr: string }>((res, rej) =>
        execFile(
          'node',
          [dist, 'global', '--json', '--verbose', '--root', cfg, ...extra],
          { maxBuffer: 1 << 28, env: { ...process.env, HOME: cfg, ORANGU_HOME: home, ORANGU_NO_CACHE: '1', ORANGU_CLAUDE_ROOTS: cfg, CLAUDE_CONFIG_DIR: cfg, ...envExtra } },
          (err, stdout, stderr) => (err ? rej(err) : res({ stdout, stderr })),
        ),
      )
    const seq = await run(['--jobs', '1'], {})
    const pooled = await run(['--jobs', '3'], {})
    expect(pooled.stderr).toMatch(/jobs {5}3/)
    expect(seq.stderr).not.toMatch(/jobs:/)
    const norm = (s: string) => {
      const a = JSON.parse(s) as { generatedAt?: number; sessions?: unknown }
      delete a.generatedAt
      return JSON.stringify(a, null, 2)
    }
    expect(norm(pooled.stdout)).toBe(norm(seq.stdout))
  }, 120_000)
})

describe('cache e2e via the built CLI', () => {
  const dist = resolve('dist/orangu.js')
  it.skipIf(!existsSync(dist))('second analyze run is a cache hit and byte-identical modulo generatedAt', async () => {
    const home = tmp()
    const dir = tmp()
    const jsonl = join(dir, 'sess.jsonl')
    writeFileSync(jsonl, buildCanonicalSession().toJsonl())
    const env = { ...process.env, ORANGU_HOME: home }
    delete (env as Record<string, unknown>)['ORANGU_NO_CACHE']
    const run = () => {
      const out = execFileSync('node', [dist, 'analyze', jsonl, '--json'], { env, maxBuffer: 1 << 28 })
      return out.toString()
    }
    const first = run()
    // stderr of a second spawn: capture via piped stderr
    const { execFile } = await import('node:child_process')
    const second: { stdout: string; stderr: string } = await new Promise((res, rej) => {
      execFile('node', [dist, 'analyze', jsonl, '--json', '--verbose'], { env, maxBuffer: 1 << 28 }, (err, stdout, stderr) => (err ? rej(err) : res({ stdout, stderr })))
    })
    // the cache diagnostic is --verbose only (stderr); --json stdout is untouched by it
    expect(second.stderr).toMatch(/cache {4}1 hits?, 0 miss/)
    const norm = (s: string) => JSON.parse(s) as Analysis
    const a = norm(first)
    const b = norm(second.stdout)
    a.generator.generatedAt = 0
    b.generator.generatedAt = 0
    expect(JSON.stringify(b, null, 2)).toBe(JSON.stringify(a, null, 2))
    // the cache dir was populated under ORANGU_HOME
    expect(readdirSync(join(home, 'cache')).length).toBe(1)
    // the cached file itself carries no clock stamp
    const vdir = readdirSync(join(home, 'cache'))[0] as string
    const file = readdirSync(join(home, 'cache', vdir))[0] as string
    const stored = JSON.parse(readFileSync(join(home, 'cache', vdir, file), 'utf8')) as Analysis
    expect(stored.generator.generatedAt).toBe(0)
  }, 60_000)
})

describe('stale cache generations', () => {
  it.skipIf(process.platform === 'win32')('tightens a sibling version directory an older release left world-readable', async () => {
    const home = join(tmp(), 'stale', 'orangu-home')
    const old = join(home, 'cache', '1-0.4.1')
    mkdirS(old, { recursive: true })
    writeS(join(old, 'k.json'), '{}')
    chmodS(join(old, 'k.json'), 0o644)
    chmodS(old, 0o755)
    const c = defaultCacheAt(home, 'sweep-9.9.9')
    await c.get('missing') // opening the current generation is the moment the siblings are swept
    expect(mode(old)).toBe(0o700)
    expect(mode(join(old, 'k.json'))).toBe(0o600)
  })
})
