import { describe, it, expect } from 'vitest'
import { decodeFinding, encodeFinding, isSuggestionId, kickoffCommand, kickoffCommands, normalizeSessionIds, sessionCohortFingerprint, sha1Hex, suggestionId, suggestionIdV2, suggestionKey } from './id.js'
import type { Finding, SuggestionRecord } from './types.js'

describe('sha1Hex', () => {
  it('matches the standard test vectors', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1')
    // > 55 bytes forces a second block; multi-byte UTF-8 is encoded before hashing
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12')
    expect(sha1Hex('é')).toBe('bf15be717ac1b080b4f1c456692825891ff5073d')
  })
})

describe('suggestion identity', () => {
  it('retains the exact v1 vector for readable legacy ids', () => {
    expect(suggestionId('report', 'context-bloat', ['s2', 's1'])).toBe('sg_' + sha1Hex('report|context-bloat|s1,s2').slice(0, 12))
  })

  it('is sg_ + 12 hex chars and independent of session order', () => {
    const a = suggestionId('report', 'context-bloat', ['s2', 's1'])
    const b = suggestionId('report', 'context-bloat', ['s1', 's2'])
    expect(a).toBe(b)
    expect(a).toMatch(/^sg_[0-9a-f]{12}$/)
    expect(a).toBe('sg_' + sha1Hex('report|context-bloat|s1,s2').slice(0, 12))
  })
  it('changes with source, rule or sessions', () => {
    const base = suggestionId('report', 'r', ['s1'])
    expect(suggestionId('skill', 'r', ['s1'])).not.toBe(base)
    expect(suggestionId('report', 'r2', ['s1'])).not.toBe(base)
    expect(suggestionId('report', 'r', ['s1', 's2'])).not.toBe(base)
  })

  it('v2 includes scope and insight identity and normalizes the session set', () => {
    const finding: Finding = {
      ruleId: 'context-bloat',
      title: 'Context grew',
      scope: 'session',
      sessionIds: ['  repo\\sessions\\b  ', 'repo/sessions/a', ' repo/sessions/a '],
      insightId: 'ins-1',
      evidence: { estimated: true },
    }
    const key = suggestionKey(finding, 'report')
    expect(key.sessionIds).toEqual(['repo/sessions/a', 'repo/sessions/b'])
    const base = suggestionIdV2(key)
    expect(base).toMatch(/^sg_[0-9a-f]{12}$/)
    expect(suggestionIdV2(suggestionKey({ ...finding, sessionIds: ['repo/sessions/b', 'repo/sessions/a'] }, 'report'))).toBe(base)
    const repo = { ...finding, scope: 'repo' as const, cohortFingerprint: sessionCohortFingerprint(finding.sessionIds) }
    expect(suggestionIdV2(suggestionKey(repo, 'report'))).not.toBe(base)
    expect(suggestionIdV2(suggestionKey({ ...finding, insightId: 'ins-2' }, 'report'))).not.toBe(base)
    expect(suggestionIdV2(suggestionKey(finding, 'skill'))).not.toBe(base)
  })

  it('normalization is deterministic but keeps case-sensitive session identity', () => {
    expect(normalizeSessionIds([' B ', 'A', 'A', 'a', 'x\\y', 'x/y'])).toEqual(['A', 'B', 'a', 'x/y'])
  })

  it('fingerprints the normalized complete session set, independent of spelling and order', () => {
    const first = sessionCohortFingerprint([' B ', 'A', 'A', 'x\\y'])
    expect(first).toBe(sessionCohortFingerprint(['x/y', 'B', 'A']))
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(sessionCohortFingerprint(['x/y', 'B', 'A', 'later'])).not.toBe(first)
  })

  it('binds aggregate identities to the complete cohort without expanding example-session tokens', () => {
    const finding: Finding = { ruleId: 'r', title: 'Recurring', scope: 'repo', sessionIds: ['example'], evidence: { estimated: true } }
    const first = { ...finding, cohortFingerprint: sessionCohortFingerprint(['example', 'cohort-a']) }
    const grown = { ...finding, cohortFingerprint: sessionCohortFingerprint(['example', 'cohort-a', 'cohort-b']) }
    expect(first.cohortFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(suggestionIdV2(suggestionKey(first, 'report'))).not.toBe(suggestionIdV2(suggestionKey(grown, 'report')))
    expect(() => suggestionKey(finding, 'report')).toThrow(/requires a 16-hex cohortFingerprint/)
    expect(() => suggestionKey({ ...first, scope: 'session' }, 'report')).toThrow(/must omit cohortFingerprint/)
  })
})

describe('finding codec v2', () => {
  const finding: Finding = {
    ruleId: 'context-bloat',
    title: 'Keep “quoted” evidence intact',
    scope: 'repo',
    sessionIds: ['b', 'a'],
    insightId: 'insight-7',
    cohortFingerprint: sessionCohortFingerprint(['a', 'b', 'cohort-c']),
    evidence: { estimated: true, savingsTokens: 321, nested: { z: 2, a: 'é' } },
  }

  it('round-trips the complete finding and is stable across evidence key order', () => {
    const token = encodeFinding(finding, 'report')
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeFinding(token)).toEqual({ v: 2, source: 'report', finding: { ...finding, sessionIds: ['a', 'b'] } })
    const reordered = { ...finding, evidence: { nested: { a: 'é', z: 2 }, savingsTokens: 321, estimated: true } }
    expect(encodeFinding(reordered, 'report')).toBe(token)
  })

  it('rejects malformed and incomplete tokens', () => {
    expect(() => decodeFinding('%%%')).toThrow(/invalid finding token/)
    expect(() => decodeFinding(encodeFinding({ ...finding, title: '' }, 'report'))).toThrow(/incomplete/)
    expect(() => decodeFinding(encodeFinding({ ...finding, insightId: 42 as unknown as string }, 'report'))).toThrow(/incomplete/)
    expect(() => encodeFinding({ ...finding, cohortFingerprint: 'wrong' }, 'report')).toThrow(/requires a 16-hex/)
    expect(() => decodeFinding(encodeFinding({ ...finding, evidence: [] as unknown as Finding['evidence'] }, 'report'))).toThrow(/incomplete/)
  })
})

describe('kickoffCommand', () => {
  const rec = { id: 'sg_abc', ruleId: 'context-bloat', scope: 'repo' as const, sessionIds: ['b', 'a'] }
  it('serve mode is exactly the policy text', () => {
    expect(kickoffCommand(rec, 'serve')).toBe('claude "/orangu:improve sg_abc"')
    expect(kickoffCommands(rec, 'serve')).toEqual({
      claude: 'claude "/orangu:improve sg_abc"',
      codex: '$orangu-improve sg_abc',
    })
  })
  it('file mode carries the finding args so the skill can recreate the record', () => {
    expect(kickoffCommand(rec, 'file')).toBe('claude "/orangu:improve sg_abc --rule context-bloat --scope repo --session a,b"')
  })

  it('file mode uses the self-contained codec when title and evidence are available', () => {
    const full = {
      ...rec,
      source: 'report' as const,
      title: 'Exact title',
      insightId: 'i-1',
      cohortFingerprint: sessionCohortFingerprint(rec.sessionIds),
      evidence: { estimated: false, savingsMs: 456 },
    } satisfies Partial<SuggestionRecord> & typeof rec
    const command = kickoffCommand(full, 'file')
    const commands = kickoffCommands(full, 'file')
    const token = /--finding ([A-Za-z0-9_-]+)/.exec(command)?.[1]
    expect(token).toBeTruthy()
    expect(decodeFinding(token!).finding).toMatchObject({ title: 'Exact title', insightId: 'i-1', evidence: { estimated: false, savingsMs: 456 } })
    expect(commands.claude).toBe(command)
    expect(commands.codex).toBe(`$orangu-improve sg_abc --finding ${token}`)
  })
})

describe('isSuggestionId', () => {
  it('accepts only canonical copy-safe ids', () => {
    expect(isSuggestionId('sg_0123456789ab')).toBe(true)
    expect(isSuggestionId('sg_0123456789AB')).toBe(false)
    expect(isSuggestionId('$(untrusted)')).toBe(false)
  })
})
