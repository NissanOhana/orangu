/**
 * The show-me fill for tests. The fill itself lives in src/show-me (the code behind `orangu show-me --render`), and
 * this module re-exports it, so a test fills the templates through the same code as the CLI. It keeps only the
 * post-write Grep counts of SKILL.md, until the skill stops running them.
 */
export { FORMATS, escapeHtml, fillTemplate, type Chart, type Item, type Page, type Scope, type SlotValue } from '../../src/show-me/fill.js'
export { aggregatePage, sessionPage } from '../../src/show-me/pages.js'
export type { Words } from '../../src/show-me/words.js'

// ---------- the post-write check of SKILL.md, as code ----------

export interface ShowMeCheck {
  pattern: string
  expected: number
  caseSensitive: boolean
  /** A pattern with `\n` runs with Grep `multiline: true`; ripgrep refuses `\n` without it, so the check fails closed. */
  multiline: boolean
  /** Set when the check is for one file only: "counts 1 in slides.html." */
  file?: 'slides' | 'report'
}

/**
 * The numbered Grep counts in SKILL.md, one per line: a number, the pattern in a code span, "counts <k>", and an
 * optional "in <file>.html". The first is case-sensitive.
 */
export function showMeChecks(skillMd: string): ShowMeCheck[] {
  return [...skillMd.matchAll(/^\d+\. `(.+)` counts (\d+)(?: in (slides|report)\.html)?\.$/gm)].map((m, index) => ({
    pattern: m[1]!,
    expected: Number(m[2]),
    caseSensitive: index === 0,
    multiline: m[1]!.includes('\\n'),
    ...(m[3] ? { file: m[3] as 'slides' | 'report' } : {}),
  }))
}

/** The checks that run on one of the 2 files. */
export function checksFor(checks: ShowMeCheck[], file: 'slides' | 'report'): ShowMeCheck[] {
  return checks.filter((check) => check.file === undefined || check.file === file)
}

/**
 * One check on one file. Grep in count mode may count lines with a match, or matches: the check must hold either
 * way, so the tests run both. The patterns use only syntax that ripgrep and JavaScript read the same way. A multiline
 * pattern starts with `\A` (the start of the file). JavaScript has no `\A`, and `^` without the m flag means the same.
 * ripgrep counts one multiline match once by `-c` and by `--count-matches`, so both ways count matches in the file.
 */
export function countCheck(text: string, check: ShowMeCheck, by: 'lines' | 'matches'): number {
  const flags = check.caseSensitive ? '' : 'i'
  if (check.multiline) {
    if (!check.pattern.startsWith('\\A') || check.pattern.lastIndexOf('\\A') !== 0) throw new Error(`a multiline check starts at \\A once: ${check.pattern}`)
    return text.match(new RegExp(`^${check.pattern.slice(2)}`, `${flags}g`))?.length ?? 0
  }
  if (by === 'lines') {
    const re = new RegExp(check.pattern, flags)
    return text.split('\n').filter((line) => re.test(line)).length
  }
  return text.match(new RegExp(check.pattern, `${flags}gm`))?.length ?? 0
}
