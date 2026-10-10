/**
 * The text rules of the redaction: a secret that only its key, its URL, its header or a quoted pair names, in each
 * sibling form, read in 1 pass. Fake values only.
 */
import { describe, expect, it } from 'vitest'
import { INNER_PAIR_FORMS, INNER_PAIR_RELATIVES, INNER_SECRET_PART, LINE_END_SHAPES, NEXT_LINES } from '../../test/fixtures/inner-pair-shapes.js'
import { AFTER_WORD_CHAR, KEY_PREFIX_SHAPES } from '../../test/fixtures/key-prefix-shapes.js'
import { redactValue, scrubStr } from './redact.js'

describe('scrubStr masks a secret that only its key, its URL, its header or a quoted pair names', () => {
  const v = 'Zq9xW2pL7mN4vB8k'
  const bs = '\\'

  it('masks a quoted key and value pair whose key names a secret, in JSON, in single quotes and inside an escaped JSON string', () => {
    expect(scrubStr(`reply: {"api_key": "${v}"}`)).toBe('reply: {"api_key": "‹redacted›"}')
    expect(scrubStr(`{"API_KEY":"${v}"}`)).toBe('{"API_KEY":"‹redacted›"}')
    expect(scrubStr(`{'password':'${v}', 'user': 'bob'}`)).toBe(`{'password':'‹redacted›', 'user': 'bob'}`)
    const escaped = `{"input":"{${bs}"token${bs}":${bs}"${v}${bs}",${bs}"path${bs}":${bs}"/a/b${bs}"}"}`
    expect(scrubStr(escaped)).toBe(`{"input":"{${bs}"token${bs}":${bs}"‹redacted›${bs}",${bs}"path${bs}":${bs}"/a/b${bs}"}"}`)
    expect(scrubStr(`{"password": "correct horse battery", "n": 1}`)).toBe('{"password": "‹redacted›", "n": 1}')
    expect(scrubStr(`{"password": "ab${bs}"cd${bs}"efgh"}`)).toBe('{"password": "‹redacted›"}')
    const q3 = `${bs.repeat(3)}"`
    expect(scrubStr(`${q3}api_key${q3}:${q3}${v}${q3}`)).toBe(`${q3}api_key${q3}:${q3}‹redacted›${q3}`)
  })

  it('reads a long run of backslashes in a line, not once for each backslash', () => {
    // about 5 ms in a line, and about 47 s when a quote takes any count of backslashes: the bound is wide for load
    const run = `"password": "${bs.repeat(200_000)}`
    const start = performance.now()
    // a quoted value with no closing quote on its line goes to the end of the line
    expect(scrubStr(run)).toBe('"password": "‹redacted›')
    expect(scrubStr(`${bs.repeat(200_000)}"token": "${v}"`)).toBe(`${bs.repeat(200_000)}"token": "‹redacted›"`)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('masks an unquoted value of 6 or more characters after a quoted secret key, and a quoted key with a space inside', () => {
    expect(scrubStr('{"api_key": 123456789012}')).toBe('{"api_key": ‹redacted›}')
    expect(scrubStr('{"token":123456789012,"n":1}')).toBe('{"token":‹redacted›,"n":1}')
    expect(scrubStr(`{"api key": "${v}"}`)).toBe('{"api key": "‹redacted›"}')
    expect(scrubStr(`{'client secret': '${v}'}`)).toBe(`{'client secret': '‹redacted›'}`)
    expect(scrubStr(`{${bs}"API KEY${bs}":${bs}"${v}${bs}"}`)).toBe(`{${bs}"API KEY${bs}":${bs}"‹redacted›${bs}"}`)
  })

  it('reads a long quoted run of secret words in a line, not once for each word', () => {
    // a key holds 64 characters at most, so a long quoted run is not read as a key name
    const run = `"${'token '.repeat(40_000)}."`
    const start = performance.now()
    expect(scrubStr(run)).toBe(run)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('masks the password of a URL and keeps its scheme, user, host and path', () => {
    expect(scrubStr(`https://user:${v}@host/x`)).toBe('https://user:‹redacted›@host/x')
    expect(scrubStr(`clone git+ssh://deploy:${v}@git.example.com:22/r.git now`)).toBe('clone git+ssh://deploy:‹redacted›@git.example.com:22/r.git now')
    expect(scrubStr(`{"url": "https://u:${v}@host"}`)).toBe('{"url": "https://u:‹redacted›@host"}')
  })

  it('masks the value of camelCase and snake_case secret key names: secretKey, privateKey, passphrase, apiKeys', () => {
    for (const name of ['secretKey', 'secret_key', 'privateKey', 'private_key', 'passphrase', 'apiKeys', 'api_keys', 'clientSecret', 'client_secret', 'SECRET_KEY']) {
      expect(scrubStr(`${name}=${v}`), name).toBe(`${name}=‹redacted›`)
      expect(scrubStr(`{"${name}": "${v}"}`), name).toBe(`{"${name}": "‹redacted›"}`)
    }
  })

  it('masks an Authorization Basic credential beside the Bearer rule, as a header and as a JSON pair', () => {
    expect(scrubStr(`curl -H 'Authorization: Basic ${v}=='`)).toBe(`curl -H 'Authorization: Basic ‹token›'`)
    expect(scrubStr(`{"Authorization": "Basic ${v}"}`)).toBe('{"Authorization": "‹redacted›"}')
    expect(scrubStr(`authorization: basic ${v}`)).toBe('authorization: basic ‹token›')
  })

  it('reads authorization and proxy-authorization as secret names, with any scheme or none', () => {
    expect(scrubStr(`authorization=${v}`)).toBe('authorization=‹redacted›')
    expect(scrubStr(`Proxy-Authorization: ${v}`)).toBe('Proxy-Authorization=‹redacted›')
    expect(scrubStr(`Authorization: Token ${v}`)).toBe('Authorization: Token ‹token›')
    for (const text of [`Authorization: Negotiate ${v}`, `Authorization: Bearer ${v}`, `{"proxy-authorization": "${v}"}`]) {
      expect(scrubStr(text), text).not.toContain(v.slice(0, 6))
    }
    expect(redactValue({ authorization: v, 'Proxy-Authorization': `Digest ${v}` }, { home: '' })).toStrictEqual({ authorization: '‹redacted›', 'Proxy-Authorization': '‹redacted›' })
  })

  it('leaves a name=value parameter after the scheme word of an Authorization header to the key=value rule', () => {
    const cases: Array<[string, string]> = [
      [`curl -H 'Authorization: Token token="${v}"'`, `curl -H 'Authorization: Token token=‹redacted›'`],
      [`Authorization: OAuth oauth_token="${v}"`, 'Authorization: OAuth oauth_token=‹redacted›'],
      [`Authorization: Bearer token=${v}`, 'Authorization=‹redacted› token=‹redacted›'],
      [`Authorization: Basic auth_token=${v}`, 'Authorization: Basic auth_token=‹redacted›'],
    ]
    for (const [text, want] of cases) expect(scrubStr(text), text).toBe(want)
    // a base64 credential keeps its padding, also right before the closing quote of a JSON value
    expect(scrubStr(`curl -H "Authorization: Basic ${v}=" -d x`)).toBe('curl -H "Authorization: Basic ‹token›" -d x')
  })

  it('reads each hostile shape of 200 KB in a line: names, assignments, quoted keys, e-mail and JWT parts', () => {
    const shapes = ['password-', 'password_', 'a-', 'a.', 'eyJ-', 'a=', '"a": ', '"password": "', 'x@', 'https://a:', 'authorization: x ']
    for (const shape of shapes) {
      const text = shape.repeat(Math.ceil(200_000 / shape.length))
      const start = performance.now()
      scrubStr(text)
      // linear rules take about 10 ms here; the bound is wide for a loaded machine
      expect(performance.now() - start, shape).toBeLessThan(500)
    }
  })

  it('masks a quoted key with a dot, a colon or a slash in it, and a long quoted key, as the object key test does', () => {
    for (const key of ['db.password', 'Jwt:Secret', 'http.proxyAuthorization', 'vault/token', `${'x'.repeat(100)}_password`, 'password.file']) {
      expect(scrubStr(`{"${key}": "${v}"}`), key).toBe(`{"${key}": "‹redacted›"}`)
      expect(redactValue({ [key]: v }, { home: '' }), key).toStrictEqual({ [key]: '‹redacted›' })
    }
  })

  it('masks a value that holds a quoted name=value', () => {
    expect(scrubStr(`passphrase=token="${v}"`)).toBe('passphrase=‹redacted›')
    expect(scrubStr(`password: x=y="${v}" next`)).toBe('password=‹redacted› next')
  })

  it('masks the value of an inner pair that a secret value names: a value that ends in a separator, or a separator after it', () => {
    expect(scrubStr(`Authorization: token: ${v}`)).not.toContain(v.slice(0, 6))
    expect(scrubStr(`Authorization: password = ${v}`)).not.toContain(v.slice(0, 6))
  })

  it('masks each inner pair and each whole run that main masks: after a quoted key, a newline or a credential, and around a URL password', () => {
    expect(INNER_PAIR_FORMS).toHaveLength(1_920)
    for (const text of [...INNER_PAIR_FORMS, ...INNER_PAIR_RELATIVES]) expect(scrubStr(text), text).not.toMatch(INNER_SECRET_PART)
  })

  it('keeps each line end: a value on a later line is masked alone, and the line ends before it stay', () => {
    const lineEnds = (text: string): string[] => text.match(/\r\n|\n|\r/g) ?? []
    for (const text of [...INNER_PAIR_FORMS, ...INNER_PAIR_RELATIVES].filter((form) => lineEnds(form).length)) {
      const out = scrubStr(text)
      expect(lineEnds(out), JSON.stringify(text)).toStrictEqual(lineEnds(text))
      expect(out, text).not.toMatch(INNER_SECRET_PART)
    }
    expect(scrubStr(`token:\n${v} next`)).toBe('token:\n‹redacted› next')
    expect(scrubStr(`{"password": token:\r\n${v} }`)).toBe('{"password": ‹redacted›\r\n‹redacted› }')
    expect(scrubStr(`password\n= ${v}`)).toBe('password\n=‹redacted›')
  })

  it('never takes the next line of a command with a masked value: an inner pair, a quoted tail or a credential at the end of a line', () => {
    for (const shape of LINE_END_SHAPES) {
      for (const [line, stays] of NEXT_LINES) {
        for (const end of ['\n', '\r\n']) {
          const out = scrubStr(`${shape}${end}${line}`)
          expect(out.endsWith(stays === line ? `${end}${line}` : stays), JSON.stringify(out)).toBe(true)
          expect(out.split(end), JSON.stringify(out)).toHaveLength(2)
          expect(out, shape).not.toMatch(INNER_SECRET_PART)
        }
      }
    }
  })

  it('masks each address as a leftmost match does, also 2 addresses glued by a dot or a hyphen', () => {
    expect(scrubStr('a@b.example.com.x@y.example.org')).toBe('‹email›‹email›')
    expect(scrubStr('x@y.example.com-z@w.example.net')).toBe('‹email›‹email›')
    expect(scrubStr('mail a.b+c@dept.example.com, x_y@z.example.net; bad@host and a@b.c1 or q@w.e_')).toBe('mail ‹email›, ‹email›; bad@host and a@b.c1 or q@w.e_')
  })

  it('reads each hostile e-mail run of 64 KB in a line', () => {
    for (const shape of ['.', '_', '+-----', 'a.', 'a@', '@a.', 'a.b@', '-a', '%+']) {
      const text = shape.repeat(Math.ceil(64_000 / shape.length))
      const start = performance.now()
      scrubStr(text)
      // a scan in a line takes about 5 ms here, and a regex that starts again at each word start takes about 7 s on
      // `a.` and `-a`: the bound holds on a loaded machine and still catches that regex
      expect(performance.now() - start, shape).toBeLessThan(1_000)
    }
  })

  it('masks an e-mail address of any length, as before the 1-pass rules: a long local part and a long last label', () => {
    expect(scrubStr(`to me@${v}.${'q'.repeat(64)} now`)).toBe('to ‹email› now')
    expect(scrubStr(`to ${'a'.repeat(300)}@example.com now`)).toBe('to ‹email› now')
    expect(scrubStr(`to .-a.b@example.com now`)).toBe('to .-‹email› now')
  })

  it('masks a secret key in each sibling form: text with = or :, a quoted pair, an object, and a key with a dot, a slash or a space', () => {
    const forms = (k: string): string[] => [`${k}=${v}`, `${k}: ${v}`, `{"${k}": "${v}"}`, `{'${k}':'${v}'}`, `export ${k}="${v}"`]
    for (const k of ['vault/token', 'db.password', 'api key', 'access key', `${'k'.repeat(300)}_token`]) {
      for (const text of forms(k)) expect(scrubStr(text), text.slice(0, 40)).not.toContain(v.slice(0, 6))
      expect(redactValue({ [k]: v }, { home: '' }), k).toStrictEqual({ [k]: '‹redacted›' })
    }
    // a quoted key and an object key have a clear end, so a dot after the secret word is still part of the key
    for (const text of [`{"password.file": "${v}"}`, `{'password.file':'${v}'}`]) expect(scrubStr(text), text).not.toContain(v.slice(0, 6))
    expect(redactValue({ 'password.file': v }, { home: '' })).toStrictEqual({ 'password.file': '‹redacted›' })
    // a word before a 1-word name is not part of it: a count stays
    expect(scrubStr('the token count: 1234567')).toBe('the token count: 1234567')
  })

  it('reads a dot or a slash in a free-text name only before the secret word, so a file path and its line stay', () => {
    for (const text of ['src/lib/auth.ts:13:import { session }', 'see docs/token.md: the rules', 'password.file=/etc/app/secret.txt']) {
      expect(scrubStr(text), text).toBe(text)
    }
    expect(scrubStr(`db.password=${v} vault/token: ${v} config/api_key_prod=${v}`)).toBe('db.password=‹redacted› vault/token=‹redacted› config/api_key_prod=‹redacted›')
  })

  it('masks an unquoted value after a quoted key as the text form does, also with a comma in it', () => {
    expect(scrubStr(`{"password": Qv7R,w2Tx,9Yz4}`)).not.toMatch(/Qv7R|w2Tx|9Yz4/)
    expect(scrubStr(`password: Qv7R,w2Tx,9Yz4`)).not.toMatch(/Qv7R|w2Tx|9Yz4/)
    expect(scrubStr('{"api_key": 123456789012}')).toBe('{"api_key": ‹redacted›}')
  })

  it('masks a quoted value to its closing quote, or to the end of the line when it has none', () => {
    expect(scrubStr(`password="correct horse ${v}" next`)).toBe('password=‹redacted› next')
    expect(scrubStr(`{"password": "correct horse ${v}`)).toBe('{"password": "‹redacted›')
    expect(scrubStr(`password='correct ${v}\nnext line`)).toBe('password=‹redacted›\nnext line')
  })

  it('masks a URL password up to the last @ before the host', () => {
    expect(scrubStr(`https://deploy:${v}@${v.slice(0, 8)}@host/x`)).toBe('https://deploy:‹redacted›@host/x')
    expect(scrubStr(`https://u:${v}@host/x@y`)).toBe('https://u:‹redacted›@host/x@y')
    // a user that names a secret is the name of a key=value, as main reads it, and its value is the rest of the run
    expect(scrubStr(`https://token:${v}@${v.slice(0, 8)}@host/x`)).toBe('https://token=‹redacted›')
    expect(scrubStr(`DB_PASSWORD=https://user:${v}@db.example.com/x next`)).toBe('DB_PASSWORD=‹redacted› next')
  })

  it('keeps a count, a path, a token count, prose and a URL with no password as they are', () => {
    const plain = [
      '{"tokens": 1234, "inputTokens": 99}',
      '{"path": "/a/b/c/d/e/f"}',
      '{"token_count": 1234}',
      'token_count: 1234',
      'the password rule and the "password" field',
      'Basic usage: Basic authentication is old',
      'https://user@host/x',
      'https://host:8080/x?q=1',
      'see http://localhost:3000/api and ws://127.0.0.1:9229/abc',
      '{"auth": "none"}',
      '{"password": "ab", "note": "hello world"}',
      '{"token_count": 1234, "auth": true, "password": null}',
      'the auth flow: rewritten today, and the token count: 123',
      '{"tokens used": 123456}',
    ]
    for (const text of plain) expect(scrubStr(text), text).toBe(text)
  })

  it('fails closed on a count of 6 or more digits under a secret name, and on prose that starts with authorization:', () => {
    // token_count is a secret name, as `token_count=152340` is in free text, so its value goes
    expect(scrubStr('{"token_count": 152340}')).toBe('{"token_count": ‹redacted›}')
    // a line that starts with `authorization:` reads as a header: the first word as the scheme, the next as the credential
    expect(scrubStr('authorization: required when calling')).toBe('authorization=‹redacted› ‹token› calling')
  })

  it('keeps the word start of main on each key rule, the JWT rule, Bearer and Authorization: a run with a key prefix goes whole, a key after a word character stays', () => {
    for (const [text, out] of KEY_PREFIX_SHAPES) expect(scrubStr(text), text.slice(0, 30)).toBe(out)
    for (const text of AFTER_WORD_CHAR) expect(scrubStr(text), text.slice(0, 30)).toBe(text)
  })
})
