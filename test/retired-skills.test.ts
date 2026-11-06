import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listFiles } from '../scripts/ste-surfaces.js'

/**
 * The retired-command sweep (C9 of the 2026-11-01 simplify run). The brain chunk folded `/orangu:analyze` and
 * `/orangu:harness` into `/orangu:improve`: the app observes a session, and improve diagnoses one input and reviews a
 * whole harness. A typed `/orangu:analyze` or `/orangu:harness` no longer runs, so no copy may name either one.
 *
 * The hide chunk (C-5b) gave apply, feedback and show-me `user-invocable: false`. Claude Code then hides each one from the
 * `/` menu and does not run it when a person types it, and Claude still invokes it through the Skill tool. So:
 * - a hidden skill may name its own command only in its own folder (its heading), and the skill catalog
 *   `plugin/skills/README.md` keeps 1 row for each skill (its pin reads 1 `/orangu:<name>` row for each folder);
 * - `/orangu:apply` is the step that improve invokes after the approval question, so only apply, improve, the catalog and
 *   `docs/DETERMINISM.md` (the authority of each skill) may name it.
 *
 * Scope: the tracked files that a person or a skill reads. That is `src/` (no tests, no generated modules), `docs/`,
 * `plugin/` (no eval results, no bundled CLI, no generated show-me pages), the landing source, the llms source, the
 * 404 page, the README and the security policy. `npm run verify:generated` ties each generated file to its source, so
 * the sources are enough.
 *
 * The baseline only shrinks. A file outside it that names a command that it may not name fails. An entry whose file no
 * longer names one fails too, so the chunk that rewrites that file removes its entry.
 */
const RETIRED = ['/orangu:analyze', '/orangu:harness'] as const
/** A hidden skill, and the folder in which it may name its own command. */
const HIDDEN: Readonly<Record<string, string>> = { '/orangu:show-me': 'plugin/skills/show-me/', '/orangu:feedback': 'plugin/skills/feedback/' }
const CATALOG = 'plugin/skills/README.md'
const APPLY = '/orangu:apply'
const APPLY_MAY_NAME = ['plugin/skills/apply/', 'plugin/skills/improve/', CATALOG, 'docs/DETERMINISM.md'] as const
/** A file that still names a command that it may not name, and the chunk that rewrites it. */
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
    file === 'README.md' ||
    file === 'SECURITY.md')

/** The commands of a text that the file may not name. */
function forbiddenIn(file: string, text: string): string[] {
  const named = (command: string): boolean => new RegExp(`${command.replace(/[/:]/g, '\\$&')}\\b`).test(text)
  const may = (prefixes: readonly string[]): boolean => prefixes.some((prefix) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix))
  return [
    ...RETIRED.filter(named),
    ...Object.entries(HIDDEN).filter(([command, own]) => named(command) && !may([own, CATALOG])).map(([command]) => command),
    ...(named(APPLY) && !may(APPLY_MAY_NAME) ? [APPLY] : []),
  ]
}

describe('retired and hidden skill commands', () => {
  const root = process.cwd()
  const files = listFiles(root).filter(inScope)
  const forbidden = (file: string): string[] => forbiddenIn(file, readFileSync(join(root, file), 'utf8'))

  it('reads a meaningful part of the tree (the sweep is not silently empty)', () => {
    for (const prefix of ['src/', 'docs/', 'plugin/skills/', 'plugin/agents/', 'plugin/evals/']) expect(files.some((file) => file.startsWith(prefix)), prefix).toBe(true)
    for (const file of ['README.md', 'SECURITY.md', 'site/llms.src.txt', 'site/404.html', 'site/index.src.html', 'plugin/skills/show-me/references/report.src.html'])
      expect(files, file).toContain(file)
    expect(files, 'no generated page and no test file').not.toContain('plugin/skills/show-me/references/report.html')
    expect(files.filter((file) => file.endsWith('.test.ts'))).toEqual([])
  })

  it('applies each rule to the file that names the command', () => {
    expect(forbiddenIn('plugin/skills/show-me/SKILL.md', '# /orangu:show-me'), 'a hidden skill names itself in its own folder').toEqual([])
    expect(forbiddenIn('plugin/skills/feedback/SKILL.md', 'run /orangu:show-me'), 'not in the folder of another skill').toEqual(['/orangu:show-me'])
    expect(forbiddenIn(CATALOG, '/orangu:show-me /orangu:feedback /orangu:apply'), 'the catalog keeps 1 row for each skill').toEqual([])
    expect(forbiddenIn(CATALOG, '/orangu:harness'), 'the catalog names no retired command').toEqual(['/orangu:harness'])
    expect(forbiddenIn('plugin/skills/improve/references/review.md', '`/orangu:apply <id>`'), 'improve invokes apply').toEqual([])
    expect(forbiddenIn('docs/DETERMINISM.md', '/orangu:apply'), 'the authority doc names apply').toEqual([])
    expect(forbiddenIn('docs/DETERMINISM.md', '/orangu:feedback'), 'but no other hidden command').toEqual(['/orangu:feedback'])
    expect(forbiddenIn('src/suggest/queue.ts', 'claude "/orangu:apply sg_000000000001"'), 'no handoff types apply').toEqual(['/orangu:apply'])
  })

  it('no file outside the baseline names a command that it may not name', () => {
    const named = files.filter((file) => BASELINE[file] === undefined).map((file) => [file, forbidden(file)] as const).filter(([, found]) => found.length)
    expect(named, 'name the skill that owns the job now: /orangu:improve').toEqual([])
  })

  it('each baseline entry still names a command that it may not name, or it goes', () => {
    for (const [file, owner] of Object.entries(BASELINE)) {
      expect(files, `${file} is in the scope of the sweep`).toContain(file)
      expect(forbidden(file).length, `${file} names no retired or hidden command now: remove this entry (owner ${owner})`).toBeGreaterThan(0)
    }
  })
})
