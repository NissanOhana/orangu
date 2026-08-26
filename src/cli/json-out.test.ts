import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { renderAnalysisJson } from './json-out.js'
import type { Analysis } from '../model/analysis.js'

const SECRET = 'sk-ant-api03-abc123def456ghi789'
const EMAIL = 'dev@example.com'

async function analysisWithSecrets(): Promise<Analysis> {
  const b = new SessionBuilder({ sessionId: 'cccccccc-0000-4000-8000-000000000003' })
  b.userPrompt(`My key is ${SECRET} and my mail is ${EMAIL}; please fix the build`)
  b.tick(400)
  b.assistant([{ type: 'text', text: 'On it.' }])
  b.turnDuration(1000, 2)
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}

describe('renderAnalysisJson', () => {
  it('masks a planted anthropic key and email by default (policy)', async () => {
    const out = renderAnalysisJson(await analysisWithSecrets(), {})
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain(EMAIL)
    expect(out).toContain('‹anthropic-key›')
    expect(out).toContain('‹email›')
  })

  it('keeps them with --no-redact (today\'s behaviour)', async () => {
    const out = renderAnalysisJson(await analysisWithSecrets(), { 'no-redact': true })
    expect(out).toContain(SECRET)
    expect(out).toContain(EMAIL)
  })

  it('--slim emits the projection (no turns/events; slim:true) and stays redacted', async () => {
    const out = renderAnalysisJson(await analysisWithSecrets(), { slim: true })
    const obj = JSON.parse(out) as Record<string, unknown>
    expect(obj['slim']).toBe(true)
    expect(obj['turns']).toBeUndefined()
    expect(obj['events']).toBeUndefined()
    expect(out).not.toContain(SECRET)
  })

  it('--quiet emits compact JSON', async () => {
    const out = renderAnalysisJson(await analysisWithSecrets(), { quiet: true })
    expect(out.trim().split('\n')).toHaveLength(1)
  })
})

// Default --json redaction also rewrites the home-directory prefix (username) to ~;
// --strip-paths stays the stronger opt-in; --no-redact keeps everything.
const HOME = process.env['HOME'] ?? ''

describe.skipIf(!HOME)('renderAnalysisJson home-path redaction', () => {
  const mk = (): Analysis =>
    ({
      schemaVersion: '1',
      session: { id: 'x', path: `${HOME}/Code/demo/s.jsonl`, cwd: `${HOME}/Code/demo` },
      summary: { narrative: `re-read ${HOME}/Code/demo/src/big.ts 14 times` },
    }) as unknown as Analysis

  it('rewrites the planted home path to ~ by default', () => {
    const out = renderAnalysisJson(mk(), { json: true })
    expect(out).not.toContain(HOME)
    expect(out).toContain('~/Code/demo/s.jsonl')
    expect(out).toContain('~/Code/demo/src/big.ts')
  })

  it('--strip-paths remains the stronger opt-in (basenames win over ~)', () => {
    const out = renderAnalysisJson(mk(), { json: true, 'strip-paths': true })
    expect(out).not.toContain(HOME)
    expect(out).toContain('demo/s.jsonl')
    expect(out).not.toContain('~/Code/demo/s.jsonl')
  })

  it('--no-redact keeps the raw home paths', () => {
    const out = renderAnalysisJson(mk(), { json: true, 'no-redact': true })
    expect(out).toContain(`${HOME}/Code/demo/s.jsonl`)
  })
})
