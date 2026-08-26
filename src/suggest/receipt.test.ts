import { describe, expect, it } from 'vitest'
import { generateConfirmationKeyPair, issueConfirmationReceipt, verifyConfirmationReceipt } from './receipt.js'
import type { Estimate, SuggestionRecord } from './types.js'

const estimate: Estimate = { bytes: 25_000, approxTokens: 6_250, sessions: 2, files: 3, overThreshold: true }
const record = (over: Partial<SuggestionRecord> = {}): SuggestionRecord => ({
  id: 'sg_0123456789ab',
  v: 2,
  createdAt: 1,
  source: 'report',
  scope: 'repo',
  sessionIds: ['b', 'a'],
  ruleId: 'r',
  title: 't',
  evidence: { estimated: true },
  status: 'new',
  statusAt: 1,
  ...over,
})

describe('confirmation receipt', () => {
  it('verifies only against the matching fresh identity, session set, and estimate', () => {
    const keys = generateConfirmationKeyPair()
    const token = issueConfirmationReceipt({ record: record(), estimate, privateKey: keys.privateKey, now: 1_000 })
    expect(verifyConfirmationReceipt({ token, record: record({ sessionIds: ['a', 'b', 'a'] }), estimate, publicKey: keys.publicKey, now: 2_000 })).toEqual({
      valid: true,
      expiresAt: 601_000,
    })
    expect(verifyConfirmationReceipt({ token, record: record({ id: 'sg_ffffffffffff' }), estimate, publicKey: keys.publicKey, now: 2_000 }).valid).toBe(false)
    expect(verifyConfirmationReceipt({ token, record: record({ scope: 'global' }), estimate, publicKey: keys.publicKey, now: 2_000 }).valid).toBe(false)
    expect(verifyConfirmationReceipt({ token, record: record({ sessionIds: ['a', 'c'] }), estimate, publicKey: keys.publicKey, now: 2_000 }).valid).toBe(false)
    expect(
      verifyConfirmationReceipt({ token, record: record(), estimate: { ...estimate, bytes: estimate.bytes + 1 }, publicKey: keys.publicKey, now: 2_000 }).valid,
    ).toBe(false)
  })

  it('rejects a tampered signature, wrong public key, expiry, and a no-longer-over-threshold estimate', () => {
    const keys = generateConfirmationKeyPair()
    const wrongKeys = generateConfirmationKeyPair()
    const token = issueConfirmationReceipt({ record: record(), estimate, privateKey: keys.privateKey, now: 1_000, ttlMs: 100 })
    const [payload, signature] = token.split('.') as [string, string]
    const tamperedSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
    expect(
      verifyConfirmationReceipt({
        token: `${payload}.${tamperedSignature}`,
        record: record(),
        estimate,
        publicKey: keys.publicKey,
        now: 1_050,
      }).valid,
    ).toBe(false)
    expect(verifyConfirmationReceipt({ token, record: record(), estimate, publicKey: wrongKeys.publicKey, now: 1_050 }).valid).toBe(false)
    expect(verifyConfirmationReceipt({ token, record: record(), estimate, publicKey: keys.publicKey, now: 1_101 })).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/expired/),
    })
    expect(
      verifyConfirmationReceipt({ token, record: record(), estimate: { ...estimate, overThreshold: false }, publicKey: keys.publicKey, now: 1_050 }).valid,
    ).toBe(false)
  })

  it('rejects a noncanonical base64url alias even when it decodes to the signed bytes', () => {
    const keys = generateConfirmationKeyPair()
    const token = issueConfirmationReceipt({ record: record(), estimate, privateKey: keys.privateKey, now: 1_000 })
    const [payload, signature] = token.split('.') as [string, string]
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const original = Buffer.from(signature, 'base64url')
    const aliased = alphabet
      .split('')
      .map((last) => signature.slice(0, -1) + last)
      .find((candidate) => candidate !== signature && Buffer.from(candidate, 'base64url').equals(original))
    if (!aliased) throw new Error('the final base64url quantum should have a noncanonical alias')
    expect(verifyConfirmationReceipt({ token: `${payload}.${aliased}`, record: record(), estimate, publicKey: keys.publicKey, now: 2_000 })).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/canonical/),
    })
  })

  it('is bounded independently of the number or length of session ids', () => {
    const keys = generateConfirmationKeyPair()
    const huge = record({ sessionIds: Array.from({ length: 10_000 }, (_, i) => `${i}-${'x'.repeat(100)}`) })
    const token = issueConfirmationReceipt({ record: huge, estimate: { ...estimate, sessions: 10_000 }, privateKey: keys.privateKey, now: 1_000 })
    expect(token.length).toBeLessThan(600)
    expect(
      verifyConfirmationReceipt({ token, record: huge, estimate: { ...estimate, sessions: 10_000 }, publicKey: keys.publicKey, now: 2_000 }).valid,
    ).toBe(true)
  })
})
