/**
 * The STE gate. Every user-visible surface (scripts/ste-surfaces.ts) holds its floor and its banned
 * ceilings from test/ste-floors.ts. `npm run ste` prints the table, and `npm run ste -- <surface>` prints
 * the findings of one surface with file, line and fix.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { HELP_BIN, ROOT, helpText, measureAll, tsFiles, type SurfaceMeasure } from '../scripts/ste-surfaces.js'
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
})
