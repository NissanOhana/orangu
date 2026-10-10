/**
 * The cache of orangu god's text gate: cleanText keeps the cleaned text of each raw text for 1 home, so a refresh
 * cleans only a new text. The redaction is wrapped, not changed, so each test counts how many times cleanText reads
 * a text. The control characters are built from their code points, so this file spells no escape sequence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as redact from '../redact/redact.js'
import { cleanText } from './sanitize.js'

vi.mock('../redact/redact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../redact/redact.js')>()
  return { ...actual, scrubWithOrigins: vi.fn(actual.scrubWithOrigins) }
})

const scrub = vi.mocked(redact.scrubWithOrigins)
const HOME = '/Users/test'
const ESC = String.fromCharCode(0x1b)

describe('cleanText cache', () => {
  beforeEach(() => {
    scrub.mockClear()
  })

  it('cleans a text that it cleaned before from its cache, for the same home only', () => {
    const text = `${'a-'.repeat(512)}${ESC}[31m`.repeat(260)
    const first = cleanText(text, HOME)
    expect(scrub).toHaveBeenCalled()
    scrub.mockClear()
    for (let i = 0; i < 3; i++) expect(cleanText(text, HOME)).toBe(first)
    expect(scrub).not.toHaveBeenCalled()
    expect(cleanText('/Users/test/a.ts', HOME)).toBe('~/a.ts')
    expect(cleanText('/Users/test/a.ts', '')).toBe('/Users/test/a.ts')
    expect(cleanText('/Users/test/a.ts', HOME)).toBe('~/a.ts')
  })

  it('keeps at most 4,096 texts: the text read longest ago goes first, and a text read again goes last', () => {
    cleanText('read again', HOME)
    cleanText('read once', HOME)
    for (let i = 0; i < 4_096; i++) cleanText(`filler ${i}`, HOME)
    // the fillers pushed out both texts: each is read again
    scrub.mockClear()
    cleanText('read again', HOME)
    cleanText('read once', HOME)
    expect(scrub).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 4_000; i++) cleanText(`second filler ${i}`, HOME)
    cleanText('read again', HOME)
    for (let i = 0; i < 95; i++) cleanText(`third filler ${i}`, HOME)
    // the text read again went last, so the new texts push out the text read once and not it
    scrub.mockClear()
    cleanText('read again', HOME)
    expect(scrub).not.toHaveBeenCalled()
    cleanText('read once', HOME)
    expect(scrub).toHaveBeenCalledTimes(1)
  })

  it('keeps at most 8,388,608 characters of raw and cleaned text, and does not keep a text that is longer alone', () => {
    const big = (word: string): string => `${word} `.repeat(600_000)
    cleanText(big('alpha'), HOME)
    cleanText(big('bravo'), HOME)
    scrub.mockClear()
    cleanText(big('alpha'), HOME)
    expect(scrub).not.toHaveBeenCalled()
    // a third text of 3,600,000 characters takes the cache over its characters: the text read longest ago goes
    cleanText(big('charlie'), HOME)
    scrub.mockClear()
    cleanText(big('bravo'), HOME)
    expect(scrub).toHaveBeenCalled()
    // a text longer than the cache alone is not kept, and it pushes out no other text
    const huge = 'x '.repeat(4_200_000)
    cleanText(huge, HOME)
    scrub.mockClear()
    cleanText(big('bravo'), HOME)
    expect(scrub).not.toHaveBeenCalled()
    cleanText(huge, HOME)
    expect(scrub).toHaveBeenCalled()
  })
})
