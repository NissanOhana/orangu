/**
 * Short-lived confirmation receipts for the noninteractive serve -> skill handoff.
 * Node-only by design: the browser asks the loopback server to confirm, while the
 * spawned local CLI re-estimates and verifies the receipt with an inherited public key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto'
import { normalizeSessionIds } from './id.js'
import type { ConfirmationReceiptResult, Estimate, SuggestionRecord } from './types.js'

export const CONFIRMATION_PUBLIC_KEY_ENV = 'ORANGU_CONFIRMATION_PUBLIC_KEY'
export const CONFIRMATION_RECEIPT_TTL_MS = 10 * 60_000
const MAX_RECEIPT_TTL_MS = 15 * 60_000
const MAX_RECEIPT_CHARS = 2048
const CLOCK_SKEW_MS = 30_000

interface ConfirmationReceiptClaims {
  v: 1
  suggestionId: string
  scope: SuggestionRecord['scope']
  sessionsHash: string
  estimateHash: string
  issuedAt: number
  expiresAt: number
}

/** DER keys are base64url strings so the public half is safe in a child env. */
export interface ConfirmationKeyPair {
  privateKey: string
  publicKey: string
}

export function generateConfirmationKeyPair(): ConfirmationKeyPair {
  const keys = generateKeyPairSync('ed25519')
  return {
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function sessionsHash(record: Pick<SuggestionRecord, 'sessionIds'>): string {
  return hash(JSON.stringify(normalizeSessionIds(record.sessionIds)))
}

function estimateHash(estimate: Estimate): string {
  // Field-labelled tuple keeps verification stable even if Estimate gains an
  // additive display-only member later.
  return hash(
    JSON.stringify({
      bytes: estimate.bytes,
      approxTokens: estimate.approxTokens,
      sessions: estimate.sessions,
      files: estimate.files,
      overThreshold: estimate.overThreshold,
    }),
  )
}

function sign(payload: string, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  return signBytes(null, Buffer.from(payload), key).toString('base64url')
}

export function issueConfirmationReceipt(o: {
  record: Pick<SuggestionRecord, 'id' | 'scope' | 'sessionIds'>
  estimate: Estimate
  privateKey: string
  now: number
  ttlMs?: number
}): string {
  if (!o.privateKey) throw new Error('confirmation receipt signer is unavailable')
  if (!o.estimate.overThreshold) throw new Error('confirmation receipt requires an over-threshold estimate')
  const ttlMs = Math.min(Math.max(1, o.ttlMs ?? CONFIRMATION_RECEIPT_TTL_MS), MAX_RECEIPT_TTL_MS)
  const claims: ConfirmationReceiptClaims = {
    v: 1,
    suggestionId: o.record.id,
    scope: o.record.scope,
    sessionsHash: sessionsHash(o.record),
    estimateHash: estimateHash(o.estimate),
    issuedAt: o.now,
    expiresAt: o.now + ttlMs,
  }
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, o.privateKey)}`
}

function invalid(reason: string): ConfirmationReceiptResult {
  return { valid: false, reason }
}

/** Verify issuance, expiry, identity, normalized sessions, and the fresh estimate. */
export function verifyConfirmationReceipt(o: {
  token: string
  record: Pick<SuggestionRecord, 'id' | 'scope' | 'sessionIds'>
  estimate: Estimate
  publicKey?: string
  now: number
}): ConfirmationReceiptResult {
  if (!o.publicKey) return invalid('confirmation public key unavailable')
  if (!o.token || o.token.length > MAX_RECEIPT_CHARS) return invalid('receipt is empty or too large')
  const parts = o.token.split('.')
  if (parts.length !== 2) return invalid('receipt format is invalid')
  const [payload, signature] = parts as [string, string]
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return invalid('receipt format is invalid')
  const payloadBytes = Buffer.from(payload, 'base64url')
  const signatureBytes = Buffer.from(signature, 'base64url')
  // Node's decoder accepts aliases whose unused trailing bits differ. Require
  // the one canonical spelling so a signed receipt has exactly one token value.
  if (payloadBytes.toString('base64url') !== payload || signatureBytes.toString('base64url') !== signature)
    return invalid('receipt encoding is not canonical')
  try {
    const key = createPublicKey({ key: Buffer.from(o.publicKey, 'base64url'), format: 'der', type: 'spki' })
    if (!verifyBytes(null, Buffer.from(payload), key, signatureBytes)) return invalid('receipt signature is invalid')
  } catch {
    return invalid('receipt public key is invalid')
  }

  let claims: ConfirmationReceiptClaims
  try {
    claims = JSON.parse(payloadBytes.toString('utf8')) as ConfirmationReceiptClaims
  } catch {
    return invalid('receipt payload is invalid')
  }
  if (
    claims?.v !== 1 ||
    typeof claims.suggestionId !== 'string' ||
    !['session', 'repo', 'global'].includes(claims.scope) ||
    typeof claims.sessionsHash !== 'string' ||
    typeof claims.estimateHash !== 'string' ||
    !Number.isFinite(claims.issuedAt) ||
    !Number.isFinite(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_RECEIPT_TTL_MS
  ) {
    return invalid('receipt claims are invalid')
  }
  if (claims.issuedAt > o.now + CLOCK_SKEW_MS) return invalid('receipt was issued in the future')
  if (claims.expiresAt < o.now) return invalid('receipt has expired')
  if (claims.suggestionId !== o.record.id) return invalid('receipt suggestion does not match')
  if (claims.scope !== o.record.scope) return invalid('receipt scope does not match')
  if (claims.sessionsHash !== sessionsHash(o.record)) return invalid('receipt sessions do not match')
  if (claims.estimateHash !== estimateHash(o.estimate)) return invalid('receipt estimate does not match')
  if (!o.estimate.overThreshold) return invalid('fresh estimate is no longer over threshold')
  return { valid: true, expiresAt: claims.expiresAt }
}
