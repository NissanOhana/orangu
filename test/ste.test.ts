/**
 * The STE gate. Every user-visible surface (scripts/ste-surfaces.ts) holds its floor and its banned
 * ceilings from test/ste-floors.ts. `npm run ste` prints the table, and `npm run ste -- <surface>` prints
 * the findings of one surface with file, line and fix.
 */
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DOC_EXEMPT, HELP_BIN, ROOT, SRC_EXEMPT, STORED_COPY_EXEMPT, fragmentResult, helpText, listFiles, measureAll, rowFailures, surfaces, tsBlocks, tsFiles, type SurfaceMeasure } from '../scripts/ste-surfaces.js'
import { BANNED, BELOW_TARGET, STE_FLOORS, STE_TARGET } from './ste-floors.js'

let measured = new Map<string, SurfaceMeasure>()
beforeAll(() => {
  measured = new Map(measureAll().map((surface) => [surface.id, surface]))
})

describe('STE gate', () => {
  it('every surface with copy has a floor row, and every row still has copy', () => {
    const present = [...measured.values()].filter((surface) => surface.sentences > 0).map((surface) => surface.id)
    expect(Object.keys(STE_FLOORS).sort(), 'a new surface gets a row at its measured score - 2, in its owner group of test/ste-floors.ts (npm run ste)').toEqual(present.sort())
  })

  it(`holds the target on every row: a floor of ${STE_TARGET} or more and 0 banned tokens, unless the row is named below target with its reason`, () => {
    expect(STE_TARGET).toBe(80)
    const missed: string[] = []
    for (const [id, row] of Object.entries(STE_FLOORS)) {
      if (BELOW_TARGET[id] !== undefined) continue
      if (row.floor < STE_TARGET) missed.push(`${id}: floor ${row.floor}`)
      for (const key of BANNED) if (row[key] !== 0) missed.push(`${id}: ${key} ${row[key]}`)
    }
    expect(missed, 'raise the copy to the target, or name the row in BELOW_TARGET with its measured score and the literals that hold it down').toEqual([])
    // a named row is a real row that is really below target, and its reason says why
    for (const [id, reason] of Object.entries(BELOW_TARGET)) {
      const row = STE_FLOORS[id]
      expect(row, `${id} is a row`).toBeDefined()
      expect(row!.floor < STE_TARGET || BANNED.some((key) => row![key] > 0), `${id} is below target`).toBe(true)
      expect(reason, `${id} names its reason`).toMatch(/\w{4,}.*\w{4,}/)
    }
  })

  it('a floor is a score and a ceiling is a count', () => {
    for (const [id, row] of Object.entries(STE_FLOORS)) {
      expect(Number.isInteger(row.floor) && row.floor >= 0 && row.floor <= 100, `${id} floor`).toBe(true)
      for (const key of BANNED) expect(Number.isInteger(row[key]) && row[key] >= 0, `${id} ${key}`).toBe(true)
      expect(Number.isInteger(row.findings) && row.findings >= 0, `${id} findings`).toBe(true)
    }
  })

  for (const [id, row] of Object.entries(STE_FLOORS)) {
    it(`${id} holds its floor (${row.floor}), its banned-token ceilings and its findings ceiling (${row.findings})`, () => {
      const surface = measured.get(id)
      expect(surface, `${id} is not a gated surface`).toBeDefined()
      expect(rowFailures(surface!, row), `${id}. Run: npm run ste -- ${id}`).toEqual([])
    })
  }

  it('fails one bad sentence in a large surface: the findings ceiling, not only the score floor', () => {
    // The probe from the close-out QA: one 33-word sentence with "prior to" added to the report client. The
    // score floor alone cannot see it there (330 sentences, 329 clean, score 100, floor 98).
    const id = 'src/report/client'
    const blocks = tsFiles(ROOT, [id]).flatMap((file) => tsBlocks(readFileSync(join(ROOT, file), 'utf8'), file))
    const probe = 'Paste the command in a terminal prior to the review, and then wait while Claude Code reads the evidence, writes the proposal, checks every file it names and saves it under your home folder.'
    const result = fragmentResult([...blocks, { file: 'src/report/client/screens/suggest.ts', line: 1, text: probe }])
    const row = STE_FLOORS[id]!
    expect(result.findings.map((f) => f.rule).sort()).toEqual([...measured.get(id)!.findings.map((f) => f.rule), 'sentence-length', 'ste-word'].sort())
    expect(result.score, 'the hole: the score floor alone still passes').toBeGreaterThanOrEqual(row.floor)
    expect(rowFailures(result, row).join(' '), 'the findings ceiling fails it').toMatch(/findings/)
  })

  it('reads the help from the tracked plugin bin, so the gate needs no dist/', () => {
    expect(HELP_BIN).toBe('plugin/bin/orangu.cli.mjs')
    expect(helpText().trimStart().split('\n')[0]).toMatch(/^orangu v\d+\.\d+\.\d+: /)
  })

  it('measures source files only, never a test', () => {
    const files = tsFiles(ROOT, ['src/report/client'])
    expect(files).toContain('src/report/client/proposals-ui.ts')
    expect(files.filter((file) => /\.(test|spec)\.ts$/.test(file))).toEqual([])
  })

  it('measures every top-level src/ folder and the top-level src files; only built output and the checker word tables are exempt, with their reasons', () => {
    const ids = new Set(surfaces().map((surface) => surface.id))
    const dirs = readdirSync(join(ROOT, 'src'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    for (const dir of dirs) {
      if (dir === 'report') expect([ids.has('src/report/client'), ids.has('src/report/*.ts')], 'src/report splits in two rows').toEqual([true, true])
      else expect(ids.has(`src/${dir}`), `src/${dir} is a surface`).toBe(true)
    }
    expect(ids.has('src/*.ts')).toBe(true)
    expect(SRC_EXEMPT).toEqual({ 'src/report/generated': expect.stringMatching(/built/), 'src/ste/words.ts': expect.stringMatching(/word tables/) })
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

  it('keeps the stored receipt copy byte-identical: a hash of each frozen function', () => {
    // New words here would demote every verified record on disk (see the case above). To change this text,
    // version the receipt instead, then record the new hash in the same commit with the reason.
    const FROZEN: Readonly<Record<string, string>> = {
      // recorded 2026-10-07 from the source on main b0178f8 (src/suggest unchanged since K)
      verificationReceiptSummary: '8670c1e673a701142f630b0bed13205f2a0f6fa5eaf6268ac596422b0d39e624',
      cohortReceiptSummary: '24b130696b9dbc257b5edb99b2272a917553ee2d93e28668b0c0655f897f7c03',
      checkEvidence: '2f1a0a9483b806a612197db936227225264d24cbe76052c7a8b11970e0cc967b',
    }
    const hashes: Record<string, string> = {}
    for (const [file, { functions }] of Object.entries(STORED_COPY_EXEMPT)) {
      const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
      for (const name of functions) {
        const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
        hashes[name] = createHash('sha256').update(fn!.getText(sf)).digest('hex')
      }
    }
    expect(hashes).toEqual(FROZEN)
  })
})
