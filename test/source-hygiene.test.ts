import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('source hygiene', () => {
  it('no raw control bytes in src/**/*.ts (a NUL makes git treat the file as binary — use \\u escapes)', () => {
    const offenders: string[] = []
    for (const f of tsFiles(SRC)) {
      const buf = readFileSync(f)
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i]!
        // allow \t (9), \n (10), \r (13); flag every other C0 control byte
        if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
          offenders.push(`${f} @ byte ${i} (0x${b.toString(16).padStart(2, '0')})`)
          break
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
