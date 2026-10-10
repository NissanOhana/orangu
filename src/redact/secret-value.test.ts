/**
 * The value walk of the redaction: a value under a key that names a secret, at any depth, the error signature that a
 * cached Analysis carries, and the origin of each character that scrubWithOrigins gives the god cleaner. Fake values
 * only.
 */
import { describe, expect, it } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import type { Analysis } from '../model/analysis.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { redactAnalysis, redactValue, scrubWithOrigins } from './redact.js'

describe('redactValue masks every scalar under a secret key, and scrubWithOrigins keeps the origin of each character', () => {
  const v = 'Zq9xW2pL7mN4vB8k'

  it('redactValue walks the value under a secret key as before, then masks its scalars: a count map keeps its scrubbed keys', () => {
    const key = `sk-ant-api03-${v}${v}`
    const value = { token: { unknownRecordTypes: { [key]: 3 }, recordCounts: { [key]: 2 } }, password: { attachmentTypes: { [`type ${v}`]: 2 } } }
    expect(redactValue(value, { home: '' })).toStrictEqual({
      token: { unknownRecordTypes: { '‹anthropic-key›': '‹redacted›' }, recordCounts: { '‹anthropic-key›': '‹redacted›' } },
      password: { attachmentTypes: { [`type ${v}`]: '‹redacted›' } },
    })
    expect(redactValue(value, { home: '', stripText: true })).toStrictEqual({
      token: { unknownRecordTypes: { '‹stripped›': '‹redacted›' }, recordCounts: {} },
      password: { attachmentTypes: { '‹stripped›': '‹redacted›' } },
    })
  })

  it('scrubWithOrigins gives the text of the redaction, and each kept character points at the same character of the input, in order', () => {
    const parts = [
      `password=${v}`, ` "api_key": "${v}"`, `https://u:${v}@host/x`, `Bearer ${v}${v}`, `Authorization: Basic ${v}`, `sk-ant-api03-${v}`,
      `eyJ${v}aa.${v}bbbb.${v}`, 'me@example.com', '/Users/test/a.ts', '-Users-test-Code-x', ' plain words ', 'token: ', '"', '=', `m${v}`,
    ]
    let seed = 7
    const next = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: 1 + next(6) }, () => parts[next(parts.length)]!).join('')
      const { text: out, origins } = scrubWithOrigins(text, '/Users/test')
      expect(out, text).toBe(redactValue(text, { home: '/Users/test' }))
      if (!origins) {
        expect(out).toBe(text)
        continue
      }
      expect(origins.length).toBe(out.length)
      let last = -1
      origins.forEach((at, j) => {
        if (at < 0) return
        expect(out[j], `${text} at ${j}`).toBe(text[at])
        expect(at).toBeGreaterThan(last)
        last = at
      })
    }
    expect(scrubWithOrigins('plain words', '/Users/test')).toStrictEqual({ text: 'plain words', origins: undefined })
    // a rule that writes back the start and the end of what it replaced keeps their origins
    expect(Array.from(scrubWithOrigins(`x Bearer ${v}${v}`, '').origins!.slice(0, 9))).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('redactValue masks every scalar in the whole value under a secret key, and keeps its shape, null and empty text', () => {
    const value = { password: { value: v, list: [{ inner: 7 }, true], none: null, empty: '', title: v }, path: { secret: { path: `/a/${v}` } } }
    expect(redactValue(value, { home: '', stripText: true, stripPaths: true })).toStrictEqual({
      // stripText blanks the title first, as the walk does everywhere
      password: { value: '‹redacted›', list: [{ inner: '‹redacted›' }, '‹redacted›'], none: null, empty: '', title: '' },
      path: { secret: { path: '‹redacted›' } },
    })
  })

  it('redactValue masks a string whose own key names a secret, with the key trimmed, at any depth', () => {
    const value = {
      env: { API_KEY: v, password: v, clientSecret: v, region: 'eu-west-1' },
      services: [{ name: 'db', privateKey: v, passphrase: v }],
      'token:': v,
      ' secret_key ': v,
      apiKeys: [v, v],
      title: 'plain text',
    }
    expect(redactValue(value, { home: '' })).toStrictEqual({
      env: { API_KEY: '‹redacted›', password: '‹redacted›', clientSecret: '‹redacted›', region: 'eu-west-1' },
      services: [{ name: 'db', privateKey: '‹redacted›', passphrase: '‹redacted›' }],
      'token:': '‹redacted›',
      ' secret_key ': '‹redacted›',
      apiKeys: ['‹redacted›', '‹redacted›'],
      title: 'plain text',
    })
  })

  it('redactValue masks the whole scalar under a secret key: a number and a boolean too, and a key with a space inside', () => {
    const value = { api_key: 1234567890, auth: true, password: null, secret: '', 'api key': v, ' client secret ': v, list: { apiKeys: [123456, v] } }
    expect(redactValue(value, { home: '' })).toStrictEqual({
      api_key: '‹redacted›',
      auth: '‹redacted›',
      password: null,
      secret: '',
      'api key': '‹redacted›',
      ' client secret ': '‹redacted›',
      list: { apiKeys: ['‹redacted›', '‹redacted›'] },
    })
  })

  it('reads an object key of any length in a line, and finds a secret name early in a long key', () => {
    // the regex read the key once for each secret word in it: about 6 s for this key; the bound is wide for load
    const hostile = 'password_'.repeat(20_000)
    const start = performance.now()
    expect(redactValue({ [hostile]: v, ['a-'.repeat(50_000)]: v }, { home: '' })).toStrictEqual({ [hostile]: v, ['a-'.repeat(50_000)]: v })
    expect(performance.now() - start).toBeLessThan(2000)
    const long = { [`${'x'.repeat(100)}_password`]: v, [`password_${'x'.repeat(100)}`]: v, [`api key${' x'.repeat(50)} y`]: v }
    expect(Object.values(redactValue(long, { home: '' }))).toStrictEqual(['‹redacted›', '‹redacted›', '‹redacted›'])
  })

  it('redactValue keeps a plain count key, prose keys, and every value when scrub is off', () => {
    const counts = { tokens: 1234, inputTokens: 5, totalTokens: 7, author: 'someone', 'the author': 'x', 'tokens used': 3 }
    expect(redactValue(counts, { home: '' })).toStrictEqual(counts)
    expect(redactValue({ API_KEY: v }, { scrub: false, home: '' })).toStrictEqual({ API_KEY: v })
  })

  it('the error signature that a cached Analysis carries masks a JSON pair too', async () => {
    const b = new SessionBuilder()
    b.userPrompt('deploy')
    b.toolCall('Bash', { command: 'curl' }, `error: {"api_key": "${v}"} rejected`, { isError: true, durationMs: 50 })
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    const signature = analyzeSession(s, { version: 'test', now: 0 }).tools.errorGroups[0]!.signature
    expect(signature).toBe('error: {"api_key": "‹redacted›"} rejected')
    expect(signature).not.toMatch(/zq.*xw/)
  })

  it('redactAnalysis counts each masked value in its report', () => {
    const a = { session: { id: 'x' }, extra: { api_key: v } } as unknown as Analysis
    const { analysis, report } = redactAnalysis(a, { home: '' })
    expect((analysis as unknown as { extra: { api_key: string } }).extra.api_key).toBe('‹redacted›')
    expect(report.applied).toBe(1)
  })
})
