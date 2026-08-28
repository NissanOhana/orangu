import { describe, expect, it } from 'vitest'
import { EXTRA_HELP } from '../src/cli/commands/index.js'

// The extra-verb help block is joined into `orangu --help` line by line. It stays readable in an
// 80-column terminal and speaks the user-facing vocabulary (no internal nouns like cohort).
describe('EXTRA_HELP', () => {
  it('wraps every line at 80 columns', () => {
    for (const entry of EXTRA_HELP) {
      for (const line of entry.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80)
    }
  })
  it('hides internal nouns from the user-facing help', () => {
    const text = EXTRA_HELP.join('\n')
    // `--slim` is a real flag on estimate/analyze and may be named; the bare noun may not.
    // `--manifest` (the skills' proposal JSON) is still accepted by `suggest --set` but is not printed.
    expect(text).not.toMatch(/cohort|catalog|preflight|projection|manifest|\bL[123]\b|fresh-cohort|(?<!-)slim/i)
  })
})
