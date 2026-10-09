/**
 * The text gate of orangu god: every text from outside (a transcript, a registry file, a cmux title or screen)
 * loses its control characters, then goes through the orangu redaction with the home folder that the engine
 * gives. The control characters are built from their code points, so this file spells no escape sequence.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cleanText, cleanValue, removeControls, textCleaner } from './sanitize.js'
import type { CleanText } from './source/agents.js'

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

  it('removes the bidirectional controls that reorder the text, and keeps the characters beside them', () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    expect(removeControls(`a${bidi.map((code) => String.fromCharCode(code)).join('')}b`)).toBe('ab')
    const beside = [0x061b, 0x200d, 0x2010, 0x2029, 0x202f, 0x2065, 0x206a].map((code) => String.fromCharCode(code)).join('')
    expect(removeControls(beside)).toBe(beside)
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
    const clean: CleanText = textCleaner(HOME)
    const dirty = `name ${ESC}[2J${BEL}${CSI} ${KEY} /Users/test/Code/demo`
    expect(clean(dirty)).toBe(cleanText(dirty, HOME))
    expect(clean(dirty)).toBe('name [2J ‹anthropic-key› ~/Code/demo')
  })
})

describe('cleanValue', () => {
  const secret = 'Zq9xW2pL7mN4vB8k'

  it('masks a string that only its key names as a secret, at any depth and in an array, and keeps a plain key as it is', () => {
    const value = {
      path: '/Users/test/Code/demo',
      env: { API_KEY: secret, password: secret, client_secret: secret, authToken: secret, region: 'eu-west-1' },
      services: [{ name: 'db', password: secret }],
      access: { API_KEY: [secret] },
      count: 3,
    }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({
      path: '~/Code/demo',
      env: { API_KEY: '‹redacted›', password: '‹redacted›', client_secret: '‹redacted›', authToken: '‹redacted›', region: 'eu-west-1' },
      services: [{ name: 'db', password: '‹redacted›' }],
      access: { API_KEY: ['‹redacted›'] },
      count: 3,
    })
  })

  it('reads the key once, with its space, tab or last colon trimmed', () => {
    const value = { 'password ': 'hunter22', 'token:': 'Zq9xW2pL7mN4vB8k', 'password\t': 'x', ' API_KEY : ': 'Zq9xW2pL7mN4vB8k', 'path:': '/Users/test/a' }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({ 'password ': '‹redacted›', 'token:': '‹redacted›', 'password\t': '‹redacted›', ' API_KEY : ': '‹redacted›', 'path:': '~/a' })
  })

  it('masks every value under a secret key: a number, a short string, true, null, and each value in an object or an array under it', () => {
    const value = { config: { password: 1234, token: 'ab', secret: true, auth: null, api_key: { inner: 'Zq9xW2pL7mN4vB8k', list: [1, 'x'] }, port: 8080 } }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({
      config: { password: '‹redacted›', token: '‹redacted›', secret: '‹redacted›', auth: '‹redacted›', api_key: { inner: '‹redacted›', list: ['‹redacted›', '‹redacted›'] }, port: 8080 },
    })
  })

  it('masks the value of a pair whose name or key names a secret, as an env list writes it', () => {
    const value = { env: [{ name: 'API_KEY', value: 'Zq9xW2pL7mN4vB8k' }, { key: 'password ', value: 1234 }, { name: 'REGION', value: 'eu-west-1' }, { key: 'token', value: { id: 'x' } }] }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({
      env: [{ name: 'API_KEY', value: '‹redacted›' }, { key: 'password ', value: '‹redacted›' }, { name: 'REGION', value: 'eu-west-1' }, { key: 'token', value: { id: '‹redacted›' } }],
    })
  })

  it('cleans each key, and each string with no key alone', () => {
    expect(cleanValue({ [`na${CSI}me`]: `a${ESC}b` }, textCleaner(HOME))).toStrictEqual({ name: 'ab' })
    expect(cleanValue([`Use ${KEY}`, 'API_KEY=Zq9xW2pL7mN4vB8k'], textCleaner(HOME))).toStrictEqual(['Use ‹anthropic-key›', 'API_KEY=‹redacted›'])
  })
})

describe('the source of sanitize.ts', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sanitize.ts'), 'utf8')

  it('spells no escape sequence', () => {
    expect(source).not.toMatch(new RegExp(['\\\\x1b', '\\\\u001b', '\\\\033'].join('|')))
  })

  it('holds no raw control or bidirectional character: the class names each one as a code point', () => {
    expect(removeControls(source)).toBe(source)
  })
})
