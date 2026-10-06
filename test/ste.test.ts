/**
 * The STE gate. Every user-visible surface (scripts/ste-surfaces.ts) holds its floor and its banned
 * ceilings from test/ste-floors.ts. `npm run ste` prints the table, and `npm run ste -- <surface>` prints
 * the findings of one surface with file, line and fix.
 */
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DOC_EXEMPT, HELP_BIN, ROOT, SRC_EXEMPT, STORED_COPY_EXEMPT, helpText, listFiles, measureAll, surfaces, tsBlocks, tsFiles, type SurfaceMeasure } from '../scripts/ste-surfaces.js'
import { BANNED, STE_FLOORS } from './ste-floors.js'

let measured = new Map<string, SurfaceMeasure>()
beforeAll(() => {
  measured = new Map(measureAll().map((surface) => [surface.id, surface]))
})

describe('STE gate', () => {
  it('every surface with copy has a floor row, and every row still has copy', () => {
    const present = [...measured.values()].filter((surface) => surface.sentences > 0).map((surface) => surface.id)
    expect(Object.keys(STE_FLOORS).sort(), 'a new surface gets a row at its measured score - 2, in its owner group of test/ste-floors.ts (npm run ste)').toEqual(present.sort())
  })

  it('a floor is a score and a ceiling is a count', () => {
    for (const [id, row] of Object.entries(STE_FLOORS)) {
      expect(Number.isInteger(row.floor) && row.floor >= 0 && row.floor <= 100, `${id} floor`).toBe(true)
      for (const key of BANNED) expect(Number.isInteger(row[key]) && row[key] >= 0, `${id} ${key}`).toBe(true)
    }
  })

  for (const [id, row] of Object.entries(STE_FLOORS)) {
    it(`${id} holds its floor (${row.floor}) and its banned-token ceilings`, () => {
      const surface = measured.get(id)
      expect(surface, `${id} is not a gated surface`).toBeDefined()
      expect(surface!.score, `${id}: the STE score fell below its floor. Run: npm run ste -- ${id}`).toBeGreaterThanOrEqual(row.floor)
      for (const key of BANNED) {
        expect(surface!.banned[key], `${id}: more ${key} than its ceiling. Run: npm run ste -- ${id}`).toBeLessThanOrEqual(row[key])
      }
    })
  }

  it('reads the help from the tracked plugin bin, so the gate needs no dist/', () => {
    expect(HELP_BIN).toBe('plugin/bin/orangu.cli.mjs')
    expect(helpText().trimStart().split('\n')[0]).toMatch(/^orangu v\d+\.\d+\.\d+: /)
  })

  it('measures source files only, never a test', () => {
    const files = tsFiles(ROOT, ['src/report/client'])
    expect(files).toContain('src/report/client/proposals-ui.ts')
    expect(files.filter((file) => /\.(test|spec)\.ts$/.test(file))).toEqual([])
  })

  it('measures every top-level src/ folder and the top-level src files; only built output is exempt, with its reason', () => {
    const ids = new Set(surfaces().map((surface) => surface.id))
    const dirs = readdirSync(join(ROOT, 'src'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    for (const dir of dirs) {
      if (dir === 'report') expect([ids.has('src/report/client'), ids.has('src/report/*.ts')], 'src/report splits in two rows').toEqual([true, true])
      else expect(ids.has(`src/${dir}`), `src/${dir} is a surface`).toBe(true)
    }
    expect(ids.has('src/*.ts')).toBe(true)
    expect(SRC_EXEMPT).toEqual({ 'src/report/generated': expect.stringMatching(/built/) })
  })

  it('measures every user doc at the root and in docs/; a doc left out names its reason', () => {
    const ids = new Set(surfaces().map((surface) => surface.id))
    const docs = listFiles(ROOT).filter((file) => /^(?:docs\/)?[^/]+\.md$/.test(file))
    for (const doc of docs) expect(ids.has(doc) || DOC_EXEMPT[doc] !== undefined, `${doc} is gated or exempt`).toBe(true)
    for (const doc of ['README.md', 'docs/USAGE.md', 'docs/DETERMINISM.md', 'docs/feedback.md', 'docs/README.md']) expect(ids.has(doc), doc).toBe(true)
  })

  it('measures the copy that the Codex mirror injects into the mirrored skills', () => {
    expect(measured.get('scripts/build.mjs#codex')?.sentences ?? 0).toBeGreaterThan(0)
  })

  it('leaves out the copy that a verified record stores and compares byte for byte, and names why', () => {
    // A verified record stores the receipt summary and each check's evidence. On every read the store renders
    // them again and compares byte for byte (verification-policy.ts isTrustedComputedVerification and
    // cohortReceiptViolation). New words would not match the stored text, so every verified record on disk
    // would lose its trusted state. The suggest unit tests pin each rendering exactly; the gate does not score it.
    expect(STORED_COPY_EXEMPT).toEqual({
      'src/suggest/verification-policy.ts': { functions: ['verificationReceiptSummary', 'cohortReceiptSummary'], reason: expect.stringMatching(/byte for byte/) },
      'src/suggest/cohort-stats.ts': { functions: ['checkEvidence'], reason: expect.stringMatching(/byte for byte/) },
    })
    const findings = measured.get('src/suggest')!.findings
    for (const [file, { functions }] of Object.entries(STORED_COPY_EXEMPT)) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1
      const spans = functions.map((name) => {
        const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
        expect(fn, `${file} still declares ${name}: a rename must move this entry, never drop the freeze`).toBeDefined()
        return [line(fn!.getStart(sf)), line(fn!.end)] as const
      })
      const inside = findings.filter((f) => f.file === file && spans.some(([from, to]) => f.line >= from && f.line <= to))
      expect(inside.map((f) => `${file}:${f.line} ${f.rule}`), 'a stored string is scored').toEqual([])
      // the rest of the file is still measured: only the named functions are left out
      const rest = tsBlocks(source, file).filter((block) => !spans.some(([from, to]) => block.line >= from && block.line <= to))
      expect(rest.length, `${file} keeps its other copy in the gate`).toBeGreaterThan(0)
    }
  })
})
