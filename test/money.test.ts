/**
 * Product-wide guard for unsupported monetary language.
 *
 * Everything a user or a model can see is checked against one shared vocabulary.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currencyHits, moneyHits, stripComments, stripRetiredFlagLiterals } from './money-vocabulary.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function* walk(dir: string, ext: string): Generator<string> {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`
    if (statSync(join(ROOT, rel)).isDirectory()) yield* walk(rel, ext)
    else if (rel.endsWith(ext)) yield rel
  }
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** Executable TypeScript we ship, comments stripped — i.e. every string a user could be shown. */
function shippedSources(): string[] {
  const out: string[] = []
  for (const dir of ['src/analyze', 'src/report/client', 'src/cli', 'src/harness', 'src/serve', 'src/model', 'src/suggest']) {
    for (const f of walk(dir, '.ts')) {
      if (f.endsWith('.test.ts') || f.includes('/generated/')) continue
      out.push(f)
    }
  }
  return out
}

describe('money guard: the executable text of everything we ship', () => {
  it('names a meaningful number of source files (the walk is not silently empty)', () => {
    expect(shippedSources().length).toBeGreaterThanOrEqual(40)
  })

  // This is the guard that would have caught `const price = ...` / "Price &amp; time" /
  // "at published prices, not your bill" in the report's Outcome Card, and the `model-fallback`
  // recommendation telling users a fallback "changes quality and price".
  it('no money vocabulary in any shipped string literal or identifier', () => {
    const offenders: string[] = []
    for (const f of shippedSources()) {
      const hits = moneyHits(stripRetiredFlagLiterals(stripComments(read(f))))
      if (hits.length) offenders.push(`${f}: ${hits.join(' || ')}`)
    }
    expect(offenders, `money vocabulary in shipped code:\n${offenders.join('\n')}`).toEqual([])
  })

  it('no currency amount in any shipped source', () => {
    const offenders: string[] = []
    for (const f of shippedSources()) {
      const hits = currencyHits(stripRetiredFlagLiterals(stripComments(read(f))))
      if (hits.length) offenders.push(`${f}: ${hits.join(' || ')}`)
    }
    expect(offenders, `currency amounts in shipped code:\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('money guard: the compatibility exception', () => {
  it('the retired --max-cost migration message is still present and still the only exception', () => {
    const main = read('src/cli/main.ts')
    expect(main, 'a removed gate flag must still name itself').toContain('--max-cost was removed; use --max-tokens <n>')
    // everything else in that file must be clean once the literal is removed
    expect(moneyHits(stripRetiredFlagLiterals(stripComments(main)))).toEqual([])
  })
})

describe('money guard: the curated catalog', () => {
  // catalog.json / features.json `note` text is quoted verbatim to the user by `orangu suggest --show`
  // and read by the suggest skill, so it is user-visible copy even though it lives in a data file.
  for (const f of ['src/suggest/catalog.json', 'src/suggest/features.json']) {
    it(`${relative('src/suggest', f)} quotes no money`, () => {
      const text = read(f)
      expect(moneyHits(text), `${f}: ${moneyHits(text).join(' || ')}`).toEqual([])
      expect(currencyHits(text)).toEqual([])
    })
  }
})

describe('money guard: the documentation we publish', () => {
  // The root documents by name, plus EVERY top-level docs/*.md (docs/feedback.md escaped the earlier
  // hand-written list): a published doc must not be able to skip this gate by being new.
  const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'design/brand/README.md']
  const PUBLISHED_DOCS = readdirSync(join(ROOT, 'docs'))
    .filter((e) => e.endsWith('.md') && statSync(join(ROOT, 'docs', e)).isFile())
    .sort()
    .map((e) => `docs/${e}`)
  const DOCS = [...ROOT_DOCS, ...PUBLISHED_DOCS]

  it('walks every top-level docs/*.md, feedback.md included', () => {
    expect(DOCS).toContain('docs/feedback.md')
    for (const known of ['docs/README.md', 'docs/USAGE.md', 'docs/PRIVACY.md', 'docs/DETERMINISM.md', 'docs/ARCHITECTURE.md', 'docs/DATA-CONTRACTS.md', 'docs/DESIGN.md']) {
      expect(DOCS).toContain(known)
    }
  })

  for (const f of DOCS) {
    it(`${f} quotes no currency amount`, () => {
      expect(currencyHits(read(f))).toEqual([])
    })
  }

  for (const f of DOCS) {
    it(`${f} uses no money vocabulary`, () => {
      const hits = moneyHits(read(f))
      expect(hits, `${f}: ${hits.join(' || ')}`).toEqual([])
    })
  }
})
