/**
 * The cuts of orangu god's text gate: the whole text is cleaned first and then cut to 65,536 characters for the pane,
 * and only a text over 262,144 characters is cut before it is read, never across a secret. The redaction is wrapped,
 * not changed, so a test counts the characters that cleanText reads, and not the time. The control characters are
 * built from their code points, so this file spells no escape sequence.
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
const CSI = String.fromCharCode(0x9b)

describe('cleanText cuts', () => {
  beforeEach(() => {
    scrub.mockClear()
  })

  it('cleans the whole text, then shows 65,536 characters of it, never part of a marker, and counts the rest', () => {
    const words = 'word '.repeat(20_000)
    expect(cleanText(words, HOME)).toBe(`${words.slice(0, 65_536)}…+${100_000 - 65_536} chars`)
    // a text at the limit stays whole
    expect(cleanText('y-'.repeat(32_768), HOME)).toBe('y-'.repeat(32_768))
    const near = `${'word '.repeat(13_104)}password=${'Zq9xW2pL7mN4vB8k'} ${'tail '.repeat(10)}`
    expect(cleanText(near, HOME)).toBe(`${'word '.repeat(13_104)}password=…+${'‹redacted› '.length + 50} chars`)
  })

  it('masks a long secret across the display cut, as the whole text holds it: a quoted value with spaces, a URL password', () => {
    const s = 'Zq9xW2pL7mN4vB8k'
    const value = `${Array.from({ length: 1_500 }, (_, i) => `w${i}x`).join(' ')} ${s}`
    const quoted = `${'word '.repeat(12_800)}"password": "${value}" tail`
    expect(cleanText(quoted, HOME)).not.toMatch(/Zq9x|w100x|w1499x/)
    const url = `${'word '.repeat(12_800)}https://u:${'p-'.repeat(500)},${s}${'q-'.repeat(2_500)}@host/x tail`
    expect(cleanText(url, HOME)).not.toMatch(/Zq9x|p-p-|q-q-/)
  })

  it('cuts a text over 256 KiB at its last separator before it reads it, and counts every character it does not show', () => {
    const text = 'word '.repeat(60_000)
    expect(cleanText(text, HOME)).toBe(`${text.slice(0, 65_536)}…+${text.length - 65_536} chars`)
    expect(cleanText('x-'.repeat(150_000), HOME)).toBe('…+300000 chars')
  })

  it('leaves no part of a secret that straddles the read cut, also when only colour codes come before it', () => {
    const secret = 'Zq9xW2pL7mN4vB8k'
    const jwt = `eyJ${'a'.repeat(20)}.${secret}${'b'.repeat(10)}.${'c'.repeat(10)}`
    const marker = (edge: string): string => ['-----' + edge, 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
    const pem = `${marker('BEGIN')}\n${secret}\n${secret}\n${marker('END')}`
    const secrets = [`sk-ant-api03-${secret}${secret}`, `password=${secret}`, jwt, pem, `https://u:${secret}@host/x`, `"password": "correct ${secret} horse"`]
    // the colour codes clean to nothing, so the pane shows the text at the cut
    for (const value of secrets) {
      for (const back of [3, 8, 12, 30]) {
        const text = `${`${ESC}[31m`.repeat(52_429).slice(0, 262_144 - back)} ${value}${' tail'.repeat(20)}`
        expect(cleanText(text, HOME), `${back} ${value.slice(0, 12)}`).not.toMatch(/Zq9x|W2pL|7mN4|vB8k|xW2p|pL7m|N4vB/)
      }
    }
  })

  it('leaves no part of a quoted value of short words that the read cut splits at a space', () => {
    const value = '"password": "Zq9x W2pL 7mN4 vB8k"'
    // the cut moves to a space or a quote, so each of them is 1 cut
    for (const back of [...value].flatMap((c, i) => (c === ' ' || c === '"' ? [value.length - i] : []))) {
      const text = `${`${ESC}[31m`.repeat(52_000)}${' '.repeat(2_144 - value.length + back)}${value}${' tail'.repeat(20)}`
      expect(cleanText(text, HOME), String(back)).not.toMatch(/Zq9x|W2pL|7mN4|vB8k/)
    }
  })

  it('reads each hostile text of 1 MiB only as far as the read cut, and a bound count of times', () => {
    // a read holds at most the cut and the check (262,144 + 4,096 characters). The cut cleans the wide text, the kept
    // text and at most 524,288 characters of moves, and each clean reads the pane text and at most 11 readings.
    const most = 12 * (262_144 + 4_096 + 262_144 + 524_288)
    for (const shape of ['password-', 'a.', '_', '+-----', 'eyJ-', 'a=', '"a": ', '\\', 'x@', `a${ESC}[1m`, `${CSI}`]) {
      const text = shape.repeat(Math.ceil(1_048_576 / shape.length)).slice(0, 1_048_576)
      scrub.mockClear()
      cleanText(text, HOME)
      const reads = scrub.mock.calls.map(([read]) => read.length)
      expect(Math.max(...reads), JSON.stringify(shape)).toBeLessThanOrEqual(262_144 + 4_096)
      expect(reads.reduce((sum, read) => sum + read, 0), JSON.stringify(shape)).toBeLessThanOrEqual(most)
    }
  })

  it('leaves no part of a secret that straddles the display edge', () => {
    const secret = 'Zq9xW2pL7mN4vB8k'
    const jwt = `eyJ${'a'.repeat(20)}.${secret}${'b'.repeat(10)}.${'c'.repeat(10)}`
    // built from parts, so the public tree check sees no key block in this file
    const marker = (edge: string): string => ['-----' + edge, 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
    const pem = `${marker('BEGIN')}\n${secret}\n${secret}\n${marker('END')}`
    const secrets = [`sk-ant-api03-${secret}${secret}`, `password=${secret}`, jwt, pem, `https://u:${secret}@host/x`]
    for (const [filler, glue] of [['word ', ' '], ['xy', ' '], ['{"a":"b",', '']] as const) {
      for (const value of secrets) {
        for (const back of [3, 8, 12, 30]) {
          const text = `${filler.repeat(Math.ceil(65_536 / filler.length)).slice(0, 65_536 - back)}${glue}${value}${' tail'.repeat(20)}`
          const out = cleanText(text, HOME)
          expect(out, `${filler} ${back} ${value.slice(0, 12)}`).not.toMatch(/Zq9x|W2pL|7mN4|vB8k|xW2p|pL7m|N4vB/)
        }
      }
    }
  })

  it('leaves no part of a quoted secret value that the cut splits at a space or at its closing quote', () => {
    for (const value of ['"password": "Zq9xW2pL7mN4vB8k"', '"password": "correct Zq9xW2pL horse 7mN4vB8k staple"', '{\\"token\\":\\"Zq9xW2pL7mN4vB8k\\"}']) {
      for (let back = 1; back <= value.length; back++) {
        const text = `${'word '.repeat(14_000).slice(0, 65_536 - value.length + back)}${value}${' tail'.repeat(20)}`
        expect(cleanText(text, HOME), `${back} ${value}`).not.toMatch(/Zq9x|W2pL|7mN4|vB8k/)
      }
    }
  })

  it('leaves no part of a key that only a long run around it hid, when the cut is near it', () => {
    const secret = 'Zq9xW2pL7mN4vB8k'
    for (let start = 65_536 - 1_100; start <= 65_536 - 990; start += 2) {
      const text = `${'xy'.repeat(40_000).slice(0, start)}sk-ant-api03-${secret}${secret}${'xy'.repeat(1_000)}`
      expect(cleanText(text, HOME), String(start)).not.toMatch(/Zq9x|W2pL|7mN4|vB8k/)
    }
  })

  it('reads a text full of the controls that the narrow strip takes out at most 4 times, each read no longer than the text', () => {
    const text = `a${String.fromCharCode(0x200b)}${String.fromCharCode(7)}`.repeat(70_000)
    cleanText(text, HOME)
    const reads = scrub.mock.calls.map(([read]) => read.length)
    // the pane text, the controls out with no space and as 1 space each, and the narrow strip
    expect(reads.length).toBeLessThanOrEqual(4)
    expect(Math.max(...reads)).toBeLessThanOrEqual(text.length)
  })

  it('reads each hostile shape of 200 KB with no control once, whole', () => {
    for (const shape of ['password-', 'a-', 'a.', 'eyJ-', 'a=', '"a": ', '"password": "', 'https://a:', 'authorization: x ', '\\']) {
      const text = shape.repeat(Math.ceil(200_000 / shape.length))
      scrub.mockClear()
      cleanText(text, HOME)
      expect(scrub.mock.calls, shape).toStrictEqual([[text, HOME]])
    }
  })
})
