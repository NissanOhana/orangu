import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { metricsOf, uuid } from '../../test/fixtures/suggestion-records.js'
import { ANALYSIS_PAYLOAD_GENERATION, ANALYSIS_SCHEMA_VERSION } from '../model/analysis.js'
import { COHORT_FACTS_DIR, CohortFactsCache, cohortFactsKey, type CohortFacts } from './cohort-cache.js'

const KEY = 'a'.repeat(40)
const facts = (over: Partial<CohortFacts> = {}): CohortFacts => ({
  sessionId: uuid(1),
  cwd: '/w/repo',
  startedAt: 1_000,
  endedAt: 2_000,
  ranOrangu: false,
  bytesRead: 1_000,
  metrics: metricsOf(4),
  ...over,
})
const root = (): string => mkdtempSync(join(tmpdir(), 'orangu-cohort-cache-'))
const mode = (path: string): number => statSync(path).mode & 0o777

describe('CohortFactsCache: the layout', () => {
  it('writes under the generation directory of the analysis cache, with private modes', async () => {
    const dir = root()
    const cache = new CohortFactsCache({ version: '9.9.9', dir })
    await cache.put(KEY, facts())
    const generation = join(dir, `${ANALYSIS_SCHEMA_VERSION}-9.9.9-p${ANALYSIS_PAYLOAD_GENERATION}`)
    const folder = join(generation, COHORT_FACTS_DIR)
    expect(readdirSync(folder)).toEqual([`${KEY}.json`])
    expect([mode(dir), mode(generation), mode(folder)]).toEqual([0o700, 0o700, 0o700])
    expect(mode(join(folder, `${KEY}.json`))).toBe(0o600)
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, writes: 1 })
    expect(await cache.get(KEY, uuid(1))).toEqual(facts())
  })

  it('reads no entry of another generation', async () => {
    const dir = root()
    await new CohortFactsCache({ version: '9.9.9', dir }).put(KEY, facts())
    expect(await new CohortFactsCache({ version: '9.9.10', dir }).get(KEY, uuid(1))).toBeUndefined()
  })

  it('reads and writes nothing when it is off', async () => {
    const dir = root()
    const cache = new CohortFactsCache({ version: '9.9.9', dir, enabled: false })
    await cache.put(KEY, facts())
    expect(readdirSync(dir)).toEqual([])
    expect(await cache.get(KEY, uuid(1))).toBeUndefined()
  })
})

describe('CohortFactsCache: numbers and ids only', () => {
  it('stores exactly the facts, the key and the version, and no other string', async () => {
    const dir = root()
    const cache = new CohortFactsCache({ version: '9.9.9', dir })
    await cache.put(KEY, { ...facts(), title: 'secret prompt text', metrics: { ...metricsOf(4), extra: 1 } } as unknown as CohortFacts)
    const file = join(dir, readdirSync(dir)[0]!, COHORT_FACTS_DIR, `${KEY}.json`)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(stored)).toEqual(['v', 'key', 'sessionId', 'cwd', 'startedAt', 'endedAt', 'ranOrangu', 'bytesRead', 'metrics'])
    expect(Object.keys(stored['metrics'] as object)).toEqual(Object.keys(metricsOf(4)))
    expect(readFileSync(file, 'utf8')).not.toContain('secret')
  })

  it('refuses to store a value that is not a number, a session id or an absolute path', async () => {
    const dir = root()
    const cache = new CohortFactsCache({ version: '9.9.9', dir })
    for (const bad of [
      facts({ sessionId: 'not an id' }),
      facts({ cwd: 'relative/path' }),
      facts({ startedAt: Number.NaN }),
      facts({ bytesRead: 1.5 }),
      facts({ metrics: { ...metricsOf(1), avgToolCalls: -1 } }),
    ]) {
      await cache.put(KEY, bad)
    }
    expect(cache.stats().writes).toBe(0)
  })
})

describe('CohortFactsCache: a stale or hostile entry is a miss', () => {
  /** Write raw text as the entry of KEY, after a good write made the layout. */
  async function planted(text: string | ((file: string) => void)): Promise<CohortFactsCache> {
    const dir = root()
    const cache = new CohortFactsCache({ version: '9.9.9', dir })
    await cache.put(KEY, facts())
    const file = join(dir, readdirSync(dir)[0]!, COHORT_FACTS_DIR, `${KEY}.json`)
    if (typeof text === 'string') writeFileSync(file, text, { mode: 0o600 })
    else text(file)
    return cache
  }
  const good = (): Record<string, unknown> => ({ v: 1, key: KEY, ...facts() })

  it('misses on a changed shape, a wrong binding, a bad value or a corrupt file', async () => {
    const cases: Array<[string, unknown]> = [
      ['an extra key', { ...good(), title: 'x' }],
      ['a missing key', { ...good(), ranOrangu: undefined }],
      ['another version', { ...good(), v: 2 }],
      ['another key', { ...good(), key: 'b'.repeat(40) }],
      ['another session', { ...good(), sessionId: uuid(2) }],
      ['an upper-case session id', { ...good(), sessionId: uuid(1).toUpperCase() }],
      ['a relative cwd', { ...good(), cwd: 'w/repo' }],
      ['an end before the start', { ...good(), endedAt: 999 }],
      ['a string metric', { ...good(), metrics: { ...metricsOf(1), avgToolCalls: '1' } }],
      ['an extra metric', { ...good(), metrics: { ...metricsOf(1), more: 1 } }],
      ['a string boolean', { ...good(), ranOrangu: 'false' }],
      ['a negative byte count', { ...good(), bytesRead: -1 }],
      ['an array', [good()]],
    ]
    for (const [label, value] of cases) {
      const cache = await planted(JSON.stringify(value))
      expect(await cache.get(KEY, uuid(1)), label).toBeUndefined()
    }
    expect(await (await planted('{"v":1,')).get(KEY, uuid(1))).toBeUndefined()
    expect(await (await planted(JSON.stringify({ ...good(), pad: 'x'.repeat(20_000) }))).get(KEY, uuid(1))).toBeUndefined()
  })

  it('misses on an entry that is a link to a good entry, and never writes through a linked folder', async () => {
    const target = join(root(), 'target.json')
    writeFileSync(target, JSON.stringify({ v: 1, key: KEY, ...facts() }), { mode: 0o600 })
    const linked = await planted((file) => {
      unlinkSync(file)
      symlinkSync(target, file)
    })
    expect(await linked.get(KEY, uuid(1))).toBeUndefined()

    const dir = root()
    const elsewhere = root()
    const generation = join(dir, `${ANALYSIS_SCHEMA_VERSION}-9.9.9-p${ANALYSIS_PAYLOAD_GENERATION}`)
    mkdirSync(generation, { recursive: true, mode: 0o700 })
    symlinkSync(elsewhere, join(generation, COHORT_FACTS_DIR))
    const cache = new CohortFactsCache({ version: '9.9.9', dir })
    await cache.put(KEY, facts())
    expect(readdirSync(elsewhere)).toEqual([])
    expect(await cache.get(KEY, uuid(1))).toBeUndefined()
  })

  it('tightens an entry that another writer left open to others, through its own inode', async () => {
    const dir = root()
    const cache = new CohortFactsCache({ version: '9.9.9', dir })
    await cache.put(KEY, facts())
    const file = join(dir, readdirSync(dir)[0]!, COHORT_FACTS_DIR, `${KEY}.json`)
    chmodSync(file, 0o644)
    expect(await cache.get(KEY, uuid(1))).toEqual(facts())
    expect(mode(file)).toBe(0o600)
  })
})

describe('cohortFactsKey', () => {
  it('moves with the size, the time and the sidecars of a transcript, and is undefined for a link or a missing file', async () => {
    const dir = root()
    const path = join(dir, `${uuid(1)}.jsonl`)
    writeFileSync(path, '{}\n')
    const st = statSync(path)
    const ref = { path, sizeBytes: st.size, mtimeMs: st.mtimeMs, subagentFiles: [] as string[] }
    const first = await cohortFactsKey(ref)
    expect(first?.key).toMatch(/^[0-9a-f]{40}$/)
    expect(first?.changedAt).toBeGreaterThanOrEqual(Math.floor(st.mtimeMs))
    expect(await cohortFactsKey(ref)).toEqual(first)
    writeFileSync(path, '{}\n{}\n')
    expect((await cohortFactsKey(ref))?.key).not.toBe(first?.key)
    const sidecar = join(dir, 'agent-1.jsonl')
    writeFileSync(sidecar, '{}\n')
    const withSidecar = await cohortFactsKey({ ...ref, subagentFiles: [sidecar] })
    expect(withSidecar?.key).not.toBe((await cohortFactsKey(ref))?.key)
    const link = join(dir, 'link.jsonl')
    symlinkSync(path, link)
    expect(await cohortFactsKey({ ...ref, path: link })).toBeUndefined()
    expect(await cohortFactsKey({ ...ref, path: join(dir, 'missing.jsonl') })).toBeUndefined()
    expect(existsSync(path)).toBe(true)
  })

  it('reads the change times that the quiet gate reads: the ctime, each sidecar meta file and the folders', async () => {
    const project = root()
    const path = join(project, `${uuid(1)}.jsonl`)
    writeFileSync(path, '{}\n')
    const ref = { path, subagentFiles: [] as string[] }
    const first = (await cohortFactsKey(ref))!
    // A mode change moves only the ctime, and the quiet gate reads the ctime.
    chmodSync(path, 0o640)
    const moved = (await cohortFactsKey(ref))!
    expect(moved.key).not.toBe(first.key)
    // With no session folder, the gate reads the project folder: a new file there moves its change time.
    await new Promise((done) => setTimeout(done, 20))
    writeFileSync(join(project, 'other.jsonl'), '{}\n')
    expect((await cohortFactsKey(ref))!.changedAt).toBeGreaterThanOrEqual(Math.floor(statSync(project).ctimeMs))
    // A sidecar meta file counts in the key and in the change time.
    const subagents = join(project, uuid(1), 'subagents')
    mkdirSync(subagents, { recursive: true })
    const sidecar = join(subagents, 'agent-a1.jsonl')
    writeFileSync(sidecar, '{}\n')
    const withSidecar = { path, subagentFiles: [sidecar] }
    const before = (await cohortFactsKey(withSidecar))!
    await new Promise((done) => setTimeout(done, 20))
    writeFileSync(join(subagents, 'agent-a1.meta.json'), '{"agentType":"x"}')
    const after = (await cohortFactsKey(withSidecar))!
    expect(after.key).not.toBe(before.key)
    expect(after.changedAt).toBeGreaterThanOrEqual(Math.floor(statSync(join(subagents, 'agent-a1.meta.json')).ctimeMs))
    expect(after.changedAt).toBeGreaterThanOrEqual(Math.floor(statSync(subagents).ctimeMs))
  })
})
