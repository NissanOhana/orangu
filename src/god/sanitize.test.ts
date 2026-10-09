/**
 * The text gate of orangu god: every text from outside (a transcript, a registry file, a cmux title or screen)
 * loses its control characters, then goes through the orangu redaction with the home folder that the engine
 * gives. The control characters are built from their code points, so this file spells no escape sequence.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cleanText, removeControls, textCleaner } from './sanitize.js'

const HOME = '/Users/test'
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const DEL = String.fromCharCode(0x7f)
const CSI = String.fromCharCode(0x9b)
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKE'

describe('removeControls', () => {
  it('removes ESC, BEL, every other C0 control, DEL and every C1 control, and keeps newline and tab', () => {
    const c0 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
    const c1 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(0x80 + code)).join('')
    expect(removeControls(`a${c0}b${DEL}c${c1}d`)).toBe('a\t\nbcd')
    expect(removeControls(`red${ESC}[31m text${BEL} and${CSI}2J${DEL}`)).toBe('red[31m text and2J')
    expect(removeControls('line 1\r\nline 2')).toBe('line 1\nline 2')
  })

  it('keeps printable text, the no-break space after the C1 range included', () => {
    const text = `café 中 ✓ … ‹key›${String.fromCharCode(0xa0)}end`
    expect(removeControls(text)).toBe(text)
  })
})

describe('cleanText', () => {
  it('masks a planted key, and finds a key that a control character split', () => {
    expect(cleanText(`Use ${KEY}${ESC} now.`, HOME)).toBe('Use ‹anthropic-key› now.')
    expect(cleanText(`sk-ant-api03-FAKE${BEL}FAKEFAKEFAKE`, HOME)).toBe('‹anthropic-key›')
  })

  it('writes the home folder as ~, as a path and as a project slug, and only on a segment boundary', () => {
    expect(cleanText('Open /Users/test/Code/demo/a.ts', HOME)).toBe('Open ~/Code/demo/a.ts')
    expect(cleanText('-Users-test-Code-demo', HOME)).toBe('~-Code-demo')
    expect(cleanText('/Users/me2/a.ts', '/Users/me')).toBe('/Users/me2/a.ts')
  })

  it('rewrites no home when the engine gives none', () => {
    expect(cleanText('/Users/test/a.ts', '')).toBe('/Users/test/a.ts')
  })
})

describe('textCleaner', () => {
  it('gives the text cleaner that a source takes: the same result as cleanText with that home', () => {
    const clean = textCleaner(HOME)
    const dirty = `name ${ESC}[2J${BEL}${CSI} ${KEY} /Users/test/Code/demo`
    expect(clean(dirty)).toBe(cleanText(dirty, HOME))
    expect(clean(dirty)).toBe('name [2J ‹anthropic-key› ~/Code/demo')
  })
})

describe('the source of sanitize.ts', () => {
  it('spells no escape sequence', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sanitize.ts'), 'utf8')
    expect(source).not.toMatch(new RegExp(['\\\\x1b', '\\\\u001b', '\\\\033'].join('|')))
  })
})
