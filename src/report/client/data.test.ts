import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFinding, sessionCohortFingerprint } from '../../suggest/id.js'
import type { AppData } from '../../model/app-data.js'
import { embeddedSource } from './data.js'

afterEach(() => vi.unstubAllGlobals())

describe('embedded report handoff', () => {
  it('preserves the complete aggregate cohort identity in the finding token', async () => {
    const cohortFingerprint = sessionCohortFingerprint(['session-a', 'session-b'])
    const data = {
      v: '1',
      mode: 'file',
      version: 'test',
      generatedAt: 0,
      capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false },
      sessions: [],
      aggregates: {},
      suggestions: [],
    } satisfies AppData
    vi.stubGlobal('window', { __ORANGU__: data })
    vi.stubGlobal('document', { getElementById: vi.fn() })

    const result = await embeddedSource().kickoff({
      mode: 'copy',
      finding: {
        ruleId: 'recurring-work',
        title: 'Recurring work',
        scope: 'repo',
        sessionIds: ['session-a'],
        cohortFingerprint,
        evidence: { estimated: true, sessions: 2 },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.record.cohortFingerprint).toBe(cohortFingerprint)
    expect(result.response.commands.claude).toBe(result.response.command)
    expect(result.response.commands.codex).toContain('$orangu-improve')
    const token = /--finding ([A-Za-z0-9_-]+)/.exec(result.response.command)?.[1]
    expect(token).toBeTruthy()
    expect(decodeFinding(token!).finding.cohortFingerprint).toBe(cohortFingerprint)
    const codexToken = /--finding ([A-Za-z0-9_-]+)/.exec(result.response.commands.codex)?.[1]
    expect(codexToken).toBe(token)
  })
})
