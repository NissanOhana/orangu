import { describe, it, expect } from 'vitest'
import { REJECT_REASON_CODES, REJECT_REASON_LABELS } from './reason-codes.js'

describe('reject reason codes', () => {
  it('pins the 5 stored code strings in their order', () => {
    // A stored rejection carries one of these strings. Renaming one orphans every record that stores it.
    expect(REJECT_REASON_CODES).toEqual(['not-wanted', 'already-handled', 'wrong-cause', 'too-much-effort', 'other'])
  })

  it('gives each code exactly 1 label, in code order', () => {
    expect(Object.keys(REJECT_REASON_LABELS)).toEqual([...REJECT_REASON_CODES])
    for (const code of REJECT_REASON_CODES) expect(REJECT_REASON_LABELS[code].trim()).not.toBe('')
  })

  it('stays browser-safe: no import and no node module', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('./reason-codes.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(source).not.toContain('node:')
  })
})
