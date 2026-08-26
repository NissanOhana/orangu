/**
 * Golden corpus gate: the analysis JSON of every fixture must be byte-identical to the
 * committed file under test/golden/. Any diff is a (possibly intended) contract change.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GOLDEN_FIXTURES, goldenCorpus } from './fixtures/corpus.js'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'golden')
const HINT =
  'Golden analysis diff — intended? run `npm run golden:update`, bump ANALYSIS_SCHEMA_VERSION/AGGREGATE_SCHEMA_VERSION if breaking, and state the cause in the commit message.'

describe('golden corpus', () => {
  it('has a committed golden file per fixture', () => {
    for (const fx of GOLDEN_FIXTURES) {
      expect(existsSync(join(GOLDEN_DIR, `${fx.name}.analysis.json`)), `${fx.name}.analysis.json missing — run npm run golden:update`).toBe(true)
    }
    expect(existsSync(join(GOLDEN_DIR, 'aggregate.json'))).toBe(true)
  })

  it('analysis JSON is byte-identical to the committed corpus', async () => {
    const { files, aggregateJson } = await goldenCorpus()
    for (const f of files) {
      const want = readFileSync(join(GOLDEN_DIR, `${f.name}.analysis.json`), 'utf8')
      expect(f.json === want, `${f.name}.analysis.json differs. ${HINT}`).toBe(true)
    }
    const wantAgg = readFileSync(join(GOLDEN_DIR, 'aggregate.json'), 'utf8')
    expect(aggregateJson === wantAgg, `aggregate.json differs. ${HINT}`).toBe(true)
  })

  it('the corpus is deterministic (two runs, same bytes)', async () => {
    const one = await goldenCorpus()
    const two = await goldenCorpus()
    for (let i = 0; i < one.files.length; i++) expect(two.files[i]!.json).toBe(one.files[i]!.json)
    expect(two.aggregateJson).toBe(one.aggregateJson)
  })
})
