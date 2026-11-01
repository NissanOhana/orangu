import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listFiles } from '../scripts/ste-surfaces.js'

/**
 * The retired-command sweep (C9 of the 2026-11-01 simplify run). The brain chunk folded `/orangu:analyze` and
 * `/orangu:harness` into `/orangu:improve`: the app observes a session, and improve diagnoses one input and reviews a
 * whole harness. A typed `/orangu:analyze` or `/orangu:harness` no longer runs, so no copy may name either one.
 *
 * Scope: the tracked files that a person or a skill reads. That is `src/` (no tests, no generated modules), `docs/`,
 * `plugin/` (no eval results, no bundled CLI, no generated show-me pages), the landing source, the llms source, the
 * 404 page and the README. `npm run verify:generated` ties each generated file to its source, so the sources are enough.
 *
 * The baseline only shrinks. A file outside it that names a retired command fails. An entry whose file no longer names
 * one fails too, so the chunk that rewrites that file removes its entry.
 */
const RETIRED = ['/orangu:analyze', '/orangu:harness'] as const
/** A file that still names a retired command, and the chunk that rewrites it. */
const BASELINE: Readonly<Record<string, string>> = {
  'site/index.src.html': 'C-9, the landing rewrite',
}
const TEXT = /\.(?:md|ts|tsx|mjs|js|json|yaml|yml|html|txt|css|jsonl)$/

const inScope = (file: string): boolean =>
  TEXT.test(file) &&
  ((file.startsWith('src/') && !/\.test\.tsx?$/.test(file) && !file.includes('/generated/')) ||
    file.startsWith('docs/') ||
    (file.startsWith('plugin/') &&
      !file.startsWith('plugin/evals/results/') &&
      !file.startsWith('plugin/bin/') &&
      !/^plugin\/skills\/[^/]+\/references\/[^/]+(?<!\.src)\.html$/.test(file)) ||
    /^site\/[^/]+\.src\.html$/.test(file) ||
    file === 'site/llms.src.txt' ||
    file === 'site/404.html' ||
    file === 'README.md')

describe('retired skill commands', () => {
  const root = process.cwd()
  const files = listFiles(root).filter(inScope)
  const names = (file: string): string[] => {
    const text = readFileSync(join(root, file), 'utf8')
    return RETIRED.filter((command) => new RegExp(`${command.replace(/[/:]/g, '\\$&')}\\b`).test(text))
  }

  it('reads a meaningful part of the tree (the sweep is not silently empty)', () => {
    for (const prefix of ['src/', 'docs/', 'plugin/skills/', 'plugin/agents/', 'plugin/evals/']) expect(files.some((file) => file.startsWith(prefix)), prefix).toBe(true)
    for (const file of ['README.md', 'site/llms.src.txt', 'site/404.html', 'site/index.src.html', 'plugin/skills/show-me/references/report.src.html'])
      expect(files, file).toContain(file)
    expect(files, 'no generated page and no test file').not.toContain('plugin/skills/show-me/references/report.html')
    expect(files.filter((file) => file.endsWith('.test.ts'))).toEqual([])
  })

  it('no file outside the baseline names a retired skill command', () => {
    const named = files.filter((file) => BASELINE[file] === undefined).map((file) => [file, names(file)] as const).filter(([, found]) => found.length)
    expect(named, 'name the skill that owns the job now: /orangu:improve').toEqual([])
  })

  it('each baseline entry still names a retired command, or it goes', () => {
    for (const [file, owner] of Object.entries(BASELINE)) {
      expect(files, `${file} is in the scope of the sweep`).toContain(file)
      expect(names(file).length, `${file} names no retired command now: remove this entry (owner ${owner})`).toBeGreaterThan(0)
    }
  })
})
