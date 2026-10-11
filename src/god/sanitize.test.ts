/**
 * The text gate of orangu god: every text from outside (a transcript, a registry file, a cmux title or screen)
 * loses its control characters, then goes through the orangu redaction with the home folder that the engine
 * gives. The control characters are built from their code points, so this file spells no escape sequence.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INNER_PAIR_FORMS, INNER_PAIR_RELATIVES, INNER_SECRET_PART, LINE_END_SHAPES, NEXT_LINES } from '../../test/fixtures/inner-pair-shapes.js'
import { cleanText, cleanValue, removeControls, textCleaner } from './sanitize.js'
import type { CleanText } from './source/agents.js'

const HOME = '/Users/test'
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const DEL = String.fromCharCode(0x7f)
const CSI = String.fromCharCode(0x9b)
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKE'

describe('removeControls', () => {
  it('takes out each run of C0 controls but tab and newline, DEL and C1 controls, with 1 space only where 2 words meet', () => {
    const c0 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
    const c1 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(0x80 + code)).join('')
    expect(removeControls(`a${c0}b${DEL}c${c1}d`)).toBe('a\t\nb c d')
    expect(removeControls('line 1\r\nline 2')).toBe('line 1\nline 2')
  })

  it('takes out each whole CSI and OSC sequence, 7-bit and 8-bit, so 2 words never join', () => {
    expect(removeControls(`red${ESC}[31m text${BEL} and${CSI}2J${DEL}`)).toBe('red text and')
    expect(removeControls(`alpha${ESC}[01;31m${ESC}[Kbeta${ESC}[m${ESC}[Kgamma`)).toBe('alpha beta gamma')
    expect(removeControls(`a${ESC}]0;window title${BEL}b${ESC}]2;other${ESC}\\c${String.fromCharCode(0x9d)}x${String.fromCharCode(0x9c)}d`)).toBe('a b c d')
    // an OSC with no end runs to the end of its line, as a terminal reads it
    expect(removeControls(`a${ESC}]0;title\nnext`)).toBe('a\nnext')
  })

  it('takes out an ESC 2-byte sequence, a CSI with intermediate bytes, and a DCS, SOS, PM or APC string, 7-bit and 8-bit', () => {
    const C = (code: number): string => String.fromCharCode(code)
    expect(removeControls(`a${ESC}(Bb${ESC}7c${ESC}[0 qd`)).toBe('a b c d')
    expect(removeControls(`a${ESC}Pq#0;2${ESC}\\b${ESC}Xsos${ESC}\\c${ESC}^pm${ESC}\\d${ESC}_apc${ESC}\\e`)).toBe('a b c d e')
    expect(removeControls(`a${C(0x90)}dcs${C(0x9c)}b${C(0x98)}sos${C(0x9c)}c${C(0x9e)}pm${C(0x9c)}d${C(0x9f)}apc${C(0x9c)}e`)).toBe('a b c d e')
  })

  it('removes the bidirectional controls that reorder the text, and keeps the characters beside them', () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    expect(removeControls(`a${bidi.map((code) => String.fromCharCode(code)).join('')}b`)).toBe('a b')
    const beside = [0x061b, 0x200a, 0x2010, 0x2029, 0x202f, 0x2065, 0x2070].map((code) => String.fromCharCode(code)).join('')
    expect(removeControls(beside)).toBe(beside)
  })

  it('removes the tag characters and the zero-width characters, which a model reads and the pane does not show', () => {
    const tags = String.fromCodePoint(0xe0000, 0xe0041, 0xe0069, 0xe007f)
    const zero = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) => String.fromCharCode(code)).join('')
    expect(removeControls(`a${tags}b${zero}c`)).toBe('a b c')
    expect(removeControls(`a${String.fromCodePoint(0xe0080)}b`)).toBe(`a${String.fromCodePoint(0xe0080)}b`)
    const hidden = [0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x180b, 0x180e, 0x180f, 0x2061, 0x2064, 0x206a, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0xfff9, 0xfffb]
    expect(removeControls(hidden.map((code) => String.fromCharCode(code)).join('x'))).toBe(Array(hidden.length - 1).fill('x').join(' '))
    expect(removeControls(`a${String.fromCodePoint(0xe0100, 0xe01ef)}b`)).toBe('a b')
  })

  it('keeps printable text, the no-break space after the C1 range included', () => {
    const text = `café 中 ✓ … ‹key›${String.fromCharCode(0xa0)}end`
    expect(removeControls(text)).toBe(text)
  })
})

describe('cleanText', () => {
  it('masks a planted key, and finds a key that a control character split', () => {
    expect(cleanText(`Use ${KEY}${BEL} now.`, HOME)).toBe('Use ‹anthropic-key› now.')
    // ESC SP is 1 sequence to a reader that stops before its final byte: it glues `now` to the key, so `now` is hidden too
    expect(cleanText(`Use ${KEY}${ESC} now.`, HOME)).toBe('Use ‹anthropic-key› ‹redacted›.')
    expect(cleanText(`sk-ant-api03-FAKE${BEL}FAKEFAKEFAKE`, HOME)).toBe('‹anthropic-key› ‹redacted›')
  })

  it('writes the home folder as ~, as a path and as a project slug, and only on a segment boundary', () => {
    expect(cleanText('Open /Users/test/Code/demo/a.ts', HOME)).toBe('Open ~/Code/demo/a.ts')
    expect(cleanText('-Users-test-Code-demo', HOME)).toBe('~-Code-demo')
    expect(cleanText('/Users/me2/a.ts', '/Users/me')).toBe('/Users/me2/a.ts')
  })

  it('rewrites no home when the engine gives none', () => {
    expect(cleanText('/Users/test/a.ts', '')).toBe('/Users/test/a.ts')
  })

  it('masks each inner pair and each whole run that main masks: after a quoted key, a newline or a credential, and around a URL password', () => {
    expect(INNER_PAIR_FORMS).toHaveLength(1_920)
    for (const text of [...INNER_PAIR_FORMS, ...INNER_PAIR_RELATIVES]) expect(cleanText(text, HOME), text).not.toMatch(INNER_SECRET_PART)
  })

  it('never takes the next line of a command with a masked value, so the confirm bar shows the whole command', () => {
    for (const shape of LINE_END_SHAPES) {
      for (const [line, stays] of NEXT_LINES) {
        for (const end of ['\n', '\r\n']) {
          const out = cleanText(`${shape}${end}${line}`, HOME)
          expect(out.endsWith(stays === line ? `\n${line}` : stays), JSON.stringify(out)).toBe(true)
          expect(out.split('\n'), JSON.stringify(out)).toHaveLength(2)
          expect(out, shape).not.toMatch(INNER_SECRET_PART)
        }
      }
    }
  })

  it('never lets an open sequence at a line end take the newline, so the next line of a command stays whole', () => {
    for (const open of [ESC, `${ESC}[`, `${ESC}[1 `, CSI]) {
      for (const end of ['\n', '\r\n']) {
        const out = cleanText(`x@example.com${open}${end}rm -rf ~/x`, HOME)
        expect(out.endsWith('\nrm -rf ~/x'), JSON.stringify(out)).toBe(true)
      }
    }
    expect(cleanText(`"authorization" : 'uayqM5c${CSI}3'\r\nsudo rm -rf ~/x`, HOME)).toBe(`"authorization" : '‹redacted›'\nsudo rm -rf ~/x`)
  })
})

describe('textCleaner', () => {
  it('gives the text cleaner that a source takes: the same result as cleanText with that home', () => {
    const clean: CleanText = textCleaner(HOME)
    const dirty = `name ${ESC}[2J${BEL}${CSI} ${KEY} /Users/test/Code/demo`
    expect(clean(dirty)).toBe(cleanText(dirty, HOME))
    expect(clean(dirty)).toBe('name  ‹anthropic-key› ~/Code/demo')
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

  it('masks the value of a pair in any case of name, key and value, and of a ParameterKey and ParameterValue pair', () => {
    const value = {
      ecs: [{ Name: 'API_KEY', Value: secret }, { NAME: 'REGION', VALUE: 'eu-west-1' }],
      tags: [{ Key: 'password', Value: secret }, { KEY: 'db_token', VALUE: secret }],
      stack: [{ ParameterKey: 'DbPassword', ParameterValue: secret }, { ParameterKey: 'InstanceType', ParameterValue: 't3.micro' }],
    }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({
      ecs: [{ Name: 'API_KEY', Value: '‹redacted›' }, { NAME: 'REGION', VALUE: 'eu-west-1' }],
      tags: [{ Key: 'password', Value: '‹redacted›' }, { KEY: 'db_token', VALUE: '‹redacted›' }],
      stack: [{ ParameterKey: 'DbPassword', ParameterValue: '‹redacted›' }, { ParameterKey: 'InstanceType', ParameterValue: 't3.micro' }],
    })
  })

  it('masks a JSON pair in a text, URL credentials, a Basic credential and the camelCase key names', () => {
    expect(cleanText(`reply: {"api_key": "${secret}"}`, HOME)).toBe('reply: {"api_key": "‹redacted›"}')
    expect(cleanValue({ body: `{"API_KEY":"${secret}"}` }, textCleaner(HOME))).toStrictEqual({ body: '{"API_KEY":"‹redacted›"}' })
    expect(cleanText(`https://user:${secret}@host/x`, HOME)).toBe('https://user:‹redacted›@host/x')
    expect(cleanText(`Authorization: Basic ${secret}`, HOME)).toBe('Authorization: Basic ‹token›')
    const value = { secretKey: secret, privateKey: secret, passphrase: secret, apiKeys: [secret], port: 8080 }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({ secretKey: '‹redacted›', privateKey: '‹redacted›', passphrase: '‹redacted›', apiKeys: ['‹redacted›'], port: 8080 })
  })

  it('masks a number after a quoted secret key, and a key with a space inside', () => {
    expect(cleanText('{"api_key": 123456789012}', HOME)).toBe('{"api_key": ‹redacted›}')
    expect(cleanText(`{"api key": "${secret}"}`, HOME)).toBe('{"api key": "‹redacted›"}')
    const value = { 'api key': secret, 'client secret': 1234, env: [{ Name: 'client secret', Value: secret }], 'the author': 'x' }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({ 'api key': '‹redacted›', 'client secret': '‹redacted›', env: [{ Name: 'client secret', Value: '‹redacted›' }], 'the author': 'x' })
  })

  it('masks an authorization key with any value', () => {
    const value = { headers: { Authorization: `Token ${secret}`, 'Proxy-Authorization': secret }, env: [{ name: 'AUTHORIZATION', value: secret }] }
    expect(cleanValue(value, textCleaner(HOME))).toStrictEqual({ headers: { Authorization: '‹redacted›', 'Proxy-Authorization': '‹redacted›' }, env: [{ name: 'AUTHORIZATION', value: '‹redacted›' }] })
    expect(cleanText(`authorization=${secret}`, HOME)).toBe('authorization=‹redacted›')
  })

  it('masks a name=value parameter of an Authorization header in a text and in a Bash command', () => {
    for (const header of [`Token token="${secret}"`, `OAuth oauth_token="${secret}"`, `Bearer token=${secret}`, `Basic auth_token=${secret}`]) {
      const command = `curl -H 'Authorization: ${header}' https://example.com`
      expect(cleanText(command, HOME), header).not.toContain(secret.slice(0, 6))
      expect(JSON.stringify(cleanValue({ command }, textCleaner(HOME))), header).not.toContain(secret.slice(0, 6))
    }
  })

  it('reads a key with its control characters removed, so a control character cannot hide a secret key', () => {
    expect(cleanValue({ [`api${CSI}_key`]: secret, [`pass${BEL}word`]: 1234 }, textCleaner(HOME))).toStrictEqual({ 'api key': '‹redacted›', 'pass word': '‹redacted›' })
    expect(cleanValue({ [`to${String.fromCharCode(0x200b)}ken`]: secret }, textCleaner(HOME))).toStrictEqual({ 'to ken': '‹redacted›' })
  })

  it('cleans each key, and each string with no key alone', () => {
    // U+009B m and ESC b are whole sequences: each takes out its final byte
    expect(cleanValue({ [`na${CSI}me`]: `a${ESC}b c` }, textCleaner(HOME))).toStrictEqual({ 'na e': 'a c' })
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
