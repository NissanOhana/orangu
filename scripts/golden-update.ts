/**
 * Regenerate the golden corpus: test/golden/<fixture>.analysis.json + aggregate.json.
 * Run with: npm run golden:update
 * The pipeline is shared with test/golden.test.ts (test/fixtures/corpus.ts), so what this
 * writes is exactly what the gate compares.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { goldenCorpus } from '../test/fixtures/corpus.js'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'golden')

const { files, aggregateJson } = await goldenCorpus()
mkdirSync(GOLDEN_DIR, { recursive: true })
for (const f of files) {
  writeFileSync(join(GOLDEN_DIR, `${f.name}.analysis.json`), f.json)
  process.stdout.write(`wrote test/golden/${f.name}.analysis.json (${f.json.length} bytes)\n`)
}
writeFileSync(join(GOLDEN_DIR, 'aggregate.json'), aggregateJson)
process.stdout.write(`wrote test/golden/aggregate.json (${aggregateJson.length} bytes)\n`)
