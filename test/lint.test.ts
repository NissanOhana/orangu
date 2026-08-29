/** Ratchet lints: structural constraints enter green and only shrink. */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function countIn(file: string, re: RegExp): number {
  return (readFileSync(file, 'utf8').match(re) ?? []).length
}

describe('ratchet: no clock as data in the measurement path', () => {
  it('Date.now() under src/analyze + src/adapters + src/harness stays at the baseline (2 files / 3 call sites)', () => {
    const files: string[] = []
    let calls = 0
    for (const base of ['src/analyze', 'src/adapters', 'src/harness']) {
      for (const f of walk(join(ROOT, base))) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        const n = countIn(f, /Date\.now\(\)/g)
        if (n) {
          files.push(relative(ROOT, f))
          calls += n
        }
      }
    }
    // parse.ts (t0 + parseMs) and analyze.ts (now fallback) feed clock-stamped
    // metadata fields only, never analysis values
    expect(files.length, `clock call files grew: ${files.join(', ')}`).toBeLessThanOrEqual(2)
    expect(calls, `clock call sites grew: ${files.join(', ')}`).toBeLessThanOrEqual(3)
  })
})

describe('ratchet: the O(n²) shapes stay dead', () => {
  it('parse.ts contains no messages.indexOf(', () => {
    expect(countIn(join(ROOT, 'src/adapters/claude-code/parse.ts'), /messages\.indexOf\(/g)).toBe(0)
  })
  it('context.ts contains no per-event scan of all messages', () => {
    expect(countIn(join(ROOT, 'src/analyze/context.ts'), /for \(const mm of s\.messages\)/g)).toBe(0)
  })
})

describe('ratchet: design tokens', () => {
  it('hex colour literals in src/report/client/*.ts only in mascot.ts (≤ 3)', () => {
    for (const f of walk(join(ROOT, 'src/report/client'))) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      const n = countIn(f, /#[0-9a-fA-F]{3,8}\b/g)
      if (f.endsWith('mascot.ts')) expect(n, 'mascot.ts fallback hexes').toBeLessThanOrEqual(3)
      else expect(n, `${relative(ROOT, f)} hardcodes a hex colour`).toBe(0)
    }
  })
  it('legacy --o- token names only shrink (baseline 271, target 0 after the client rework)', () => {
    let count = 0
    for (const base of ['src', 'site']) {
      for (const f of walk(join(ROOT, base))) {
        if (f.includes(join('src', 'report', 'generated'))) continue // rebuilt output mirrors its source
        if (!/\.(ts|css|html|mjs)$/.test(f)) continue
        count += countIn(f, /--o-/g)
      }
    }
    expect(count).toBeLessThanOrEqual(271)
  })
})

/**
 * Light is the only default (AC26, AC27). Nothing in the report client may follow the system colour
 * scheme, and the removed third theme state may not come back: both are one grep away from returning
 * by accident, and neither shows up as a failing behaviour test.
 */
describe('ratchet: light is the only default theme', () => {
  it('tokens.css never follows the system colour scheme', () => {
    expect(countIn(join(ROOT, 'src/report/client/tokens.css'), /prefers-color-scheme/g)).toBe(0)
  })
  it('app.ts carries no third theme state', () => {
    expect(countIn(join(ROOT, 'src/report/client/app.ts'), /'auto'/g)).toBe(0)
  })
})

/**
 * U+2014 is banned from
 * every product surface and from every string the product renders. En-dash (U+2013, ranges and the
 * "no value" placeholder) and the middle dot (U+00B7, the client's separator) are unaffected.
 * The literal is written as a code point so this guard cannot fail its own check.
 */
describe('ratchet: no em-dash on product surfaces', () => {
  const EM_DASH = String.fromCharCode(0x2014)
  const TEXT = /\.(ts|css|json|html|mjs)$/

  function offenders(bases: string[]): string[] {
    const hits: string[] = []
    for (const base of bases) {
      const target = join(ROOT, base)
      const files = statSync(target).isDirectory() ? [...walk(target)] : [target]
      for (const f of files) {
        if (!TEXT.test(f) || f.endsWith('.test.ts')) continue
        if (f.includes(join('src', 'report', 'generated'))) continue // rebuilt output mirrors its source
        const n = countIn(f, new RegExp(EM_DASH, 'g'))
        if (n) hits.push(`${relative(ROOT, f)} (${n})`)
      }
    }
    return hits
  }

  it('the app surfaces and the landing page carry no em-dash', () => {
    const hits = offenders(['src/report', 'src/serve', 'src/analyze', 'src/cli', 'site/index.src.html'])
    expect(hits, `em-dash is banned product-wide: ${hits.join(', ')}`).toEqual([])
  })

  it('nor does the rest of src/, whose strings reach the app and the CLI', () => {
    const hits = offenders(['src'])
    expect(hits, `em-dash is banned product-wide: ${hits.join(', ')}`).toEqual([])
  })
})

/**
 * Raw escape sequences belong to src/cli/tty.ts, whose caps decide per stream whether they may be
 * written at all. Any other file that spells `\x1b` bypasses NO_COLOR, --json and non-TTY handling.
 */
describe('ratchet: raw ANSI escapes live only in src/cli/tty.ts', () => {
  // baseline at the ratchet's birth; the CLI UX pass drives it to [] and it never grows
  const BASELINE: string[] = []
  it('no file under src/ outside the baseline contains an escape literal', () => {
    const hits: string[] = []
    for (const f of walk(join(ROOT, 'src'))) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      if (f.includes(join('src', 'report', 'generated'))) continue
      if (f.endsWith(join('src', 'cli', 'tty.ts'))) continue
      if (countIn(f, /\\x1b|\\u001b|\\033/g)) hits.push(relative(ROOT, f))
    }
    const grown = hits.filter((h) => !BASELINE.includes(h))
    expect(grown, `escape literals outside tty.ts: ${grown.join(', ')}`).toEqual([])
  })
})
