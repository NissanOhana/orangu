/**
 * Suggestion ids + kickoff command text. Pure JS (no node:crypto) because the same code runs in the
 * CLI bundle and in the browser report bundle, and the id must be identical in both.
 */
import type { Finding, SuggestionKey, SuggestionRecord, SuggestionSource } from './types.js'

function utf8(s: string): Uint8Array {
  // TextEncoder exists in node ≥ 11 and every browser; avoid Buffer for the client bundle
  return new TextEncoder().encode(s)
}

/** SHA-1 of a string (UTF-8), lowercase hex. Test vector: sha1('abc') = a9993e36… */
export function sha1Hex(input: string): string {
  const msg = utf8(input)
  const ml = msg.length
  // padding: 0x80, zeros, 64-bit big-endian bit length
  const withPad = ((ml + 8) >> 6) + 1
  const words = new Uint32Array(withPad * 16)
  for (let i = 0; i < ml; i++) words[i >> 2]! |= msg[i]! << (24 - (i & 3) * 8)
  words[ml >> 2]! |= 0x80 << (24 - (ml & 3) * 8)
  const bits = ml * 8
  words[withPad * 16 - 1] = bits >>> 0
  words[withPad * 16 - 2] = Math.floor(bits / 0x100000000) >>> 0

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  for (let blk = 0; blk < words.length; blk += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[blk + t]!
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let t = 0; t < 80; t++) {
      let f: number
      let k: number
      if (t < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (t < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const tmp = (rotl(a, 5) + f + e + k + w[t]!) >>> 0
      e = d
      d = c
      c = rotl(b, 30) >>> 0
      b = a
      a = tmp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0')
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4)
}

/**
 * Normalize only transport-level spelling. Session selectors remain case-sensitive:
 * trim whitespace, use `/` on every platform, de-dupe,
 * then sort by Unicode code point. No filesystem access or cwd-dependent resolution.
 */
export function normalizeSessionIds(sessionIds: string[]): string[] {
  return [...new Set(sessionIds.map((id) => id.trim().replace(/\\/g, '/')).filter(Boolean))].sort()
}

/** Compact identity of the full aggregate cohort; example sessions alone are not the cohort. */
export function sessionCohortFingerprint(sessionIds: string[]): string {
  return sha1Hex(JSON.stringify(normalizeSessionIds(sessionIds))).slice(0, 16)
}

/** Current v2 identities bind aggregate findings to a full cohort and never
 * allow a session finding to acquire an attacker-chosen aggregate namespace. */
export function assertCohortBinding(
  finding: Pick<Finding, 'scope' | 'cohortFingerprint'>,
  label = 'finding',
): void {
  const fingerprint = finding.cohortFingerprint
  if (finding.scope === 'session') {
    if (fingerprint !== undefined) throw new Error(`${label} session scope must omit cohortFingerprint`)
    return
  }
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new Error(`${label} repo/global scope requires a 16-hex cohortFingerprint`)
  }
}

/** Build the canonical v2 key shared by the browser, CLI, and loopback server. */
export function suggestionKey(finding: Pick<Finding, 'scope' | 'ruleId' | 'sessionIds' | 'insightId' | 'cohortFingerprint'>, source: SuggestionSource): SuggestionKey {
  assertCohortBinding(finding)
  return {
    v: 2,
    source,
    scope: finding.scope,
    ruleId: finding.ruleId,
    sessionIds: normalizeSessionIds(finding.sessionIds),
    ...(finding.insightId ? { insightId: finding.insightId } : {}),
    ...(finding.cohortFingerprint ? { cohortFingerprint: finding.cohortFingerprint } : {}),
  }
}

/** Canonical, field-labelled preimage prevents delimiter collisions. */
export function suggestionIdV2(key: SuggestionKey): string {
  const canonical = JSON.stringify({
    v: 2,
    source: key.source,
    scope: key.scope,
    ruleId: key.ruleId,
    sessionIds: normalizeSessionIds(key.sessionIds),
    insightId: key.insightId ?? null,
    ...(key.cohortFingerprint ? { cohortFingerprint: key.cohortFingerprint } : {}),
  })
  return 'sg_' + sha1Hex(canonical).slice(0, 12)
}

/** Exact v1 algorithm retained for old records, links, and file-command flags. */
export function suggestionId(source: SuggestionSource, ruleId: string, sessionIds: string[]): string {
  const ids = [...sessionIds].sort()
  return 'sg_' + sha1Hex(source + '|' + ruleId + '|' + ids.join(',')).slice(0, 12)
}

/** True only for canonical v1/v2 suggestion ids safe to persist and copy into host commands. */
export function isSuggestionId(value: unknown): value is string {
  return typeof value === 'string' && /^sg_[0-9a-f]{12}$/.test(value)
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(token: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(token)) throw new Error('finding token is not base64url')
  const raw = atob(token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '='))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
}

interface FindingEnvelopeV2 {
  v: 2
  source: SuggestionSource
  finding: Finding
}

const MAX_FINDING_TOKEN_CHARS = 256 * 1024

/** Self-contained, shell-safe v2 file handoff. Includes title and complete evidence. */
export function encodeFinding(finding: Finding, source: SuggestionSource = 'report'): string {
  assertCohortBinding(finding)
  const normalized: Finding = { ...finding, sessionIds: normalizeSessionIds(finding.sessionIds) }
  const envelope: FindingEnvelopeV2 = { v: 2, source, finding: normalized }
  return base64UrlEncode(utf8(canonicalJson(envelope)))
}

/** Decode + validate a v2 file handoff. Legacy commands continue through their individual flags. */
export function decodeFinding(token: string): FindingEnvelopeV2 {
  if (!token || token.length > MAX_FINDING_TOKEN_CHARS) throw new Error('finding token is empty or too large')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(base64UrlDecode(token)))
  } catch (e) {
    throw new Error(`invalid finding token: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!value || typeof value !== 'object') throw new Error('invalid finding token: expected object')
  const env = value as Partial<FindingEnvelopeV2>
  const f = env.finding as Partial<Finding> | undefined
  if (
    env.v !== 2 ||
    (env.source !== 'report' && env.source !== 'skill') ||
    !f ||
    typeof f.ruleId !== 'string' ||
    !f.ruleId.trim() ||
    typeof f.title !== 'string' ||
    !f.title.trim() ||
    (f.scope !== 'session' && f.scope !== 'repo' && f.scope !== 'global') ||
    !Array.isArray(f.sessionIds) ||
    !f.sessionIds.length ||
    !f.sessionIds.every((id) => typeof id === 'string' && id.trim()) ||
    !f.evidence ||
    typeof f.evidence !== 'object' ||
    Array.isArray(f.evidence) ||
    typeof f.evidence.estimated !== 'boolean' ||
    (f.insightId !== undefined && typeof f.insightId !== 'string') ||
    (f.scope === 'session' ? f.cohortFingerprint !== undefined : typeof f.cohortFingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(f.cohortFingerprint))
  ) {
    throw new Error('invalid finding token: incomplete v2 finding')
  }
  return {
    v: 2,
    source: env.source,
    finding: { ...f, sessionIds: normalizeSessionIds(f.sessionIds) } as Finding,
  }
}

function kickoffArgs(
  rec: Pick<SuggestionRecord, 'id' | 'ruleId' | 'scope' | 'sessionIds'> & Partial<Pick<SuggestionRecord, 'source' | 'title' | 'insightId' | 'cohortFingerprint' | 'evidence'>>,
  mode: 'file' | 'serve',
): string {
  if (mode === 'serve') return rec.id
  if (rec.title && rec.evidence) {
    const finding: Finding = {
      ruleId: rec.ruleId,
      title: rec.title,
      scope: rec.scope,
      sessionIds: rec.sessionIds,
      ...(rec.insightId ? { insightId: rec.insightId } : {}),
      ...(rec.cohortFingerprint ? { cohortFingerprint: rec.cohortFingerprint } : {}),
      evidence: rec.evidence,
    }
    return `${rec.id} --finding ${encodeFinding(finding, rec.source ?? 'report')}`
  }
  const ids = [...rec.sessionIds].sort().join(',')
  return `${rec.id} --rule ${rec.ruleId} --scope ${rec.scope} --session ${ids}`
}

/**
 * Host-specific commands for the same canonical improve handoff.
 * - serve: the skill loads the record by id from ~/.orangu/suggestions.jsonl
 * - file: a file:// page cannot write there, so both commands carry identical finding args
 */
export function kickoffCommands(
  rec: Pick<SuggestionRecord, 'id' | 'ruleId' | 'scope' | 'sessionIds'> & Partial<Pick<SuggestionRecord, 'source' | 'title' | 'insightId' | 'cohortFingerprint' | 'evidence'>>,
  mode: 'file' | 'serve',
): { claude: string; codex: string } {
  const args = kickoffArgs(rec, mode)
  return { claude: `claude "/orangu:improve ${args}"`, codex: `$orangu-improve ${args}` }
}

/** Backward-compatible Claude command used by existing records and links. */
export function kickoffCommand(
  rec: Pick<SuggestionRecord, 'id' | 'ruleId' | 'scope' | 'sessionIds'> & Partial<Pick<SuggestionRecord, 'source' | 'title' | 'insightId' | 'cohortFingerprint' | 'evidence'>>,
  mode: 'file' | 'serve',
): string {
  return kickoffCommands(rec, mode).claude
}
