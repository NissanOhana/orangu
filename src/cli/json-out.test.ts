import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { aggregate } from '../analyze/aggregate.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { prepareAggregateForOutput, renderAggregateJson, renderAnalysisJson } from './json-out.js'
import type { Analysis } from '../model/analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'

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

describe('renderAggregateJson', () => {
  const projectPath = `${HOME || '/home/test'}/Code/${SECRET}`
  const row: Aggregate['sessions'][number] = {
    id: 'aggregate-private-row',
    title: `Deploy with ${SECRET}`,
    project: projectPath,
    source: 'claude-code',
    activeMs: 1,
    turns: 1,
    humanTurns: 1,
    toolCalls: 1,
    toolErrors: 0,
    agents: 0,
    tokens: 1,
    contextPeak: 1,
    cacheHitRatio: 0,
    compactions: 0,
    prs: 0,
    commits: 0,
    interruptions: 0,
  }
  const aggregateWithPrivateData = (): Aggregate => ({
    ...aggregate([], 'test', 0),
    byProject: [{ key: projectPath, count: 1, tokens: 1 }],
    sessions: [row],
    topSessions: [row],
    topReReadFiles: [{ path: `${projectPath}/src/${SECRET}.ts`, sessions: 1, totalReads: 4 }],
  })

  it('masks planted secrets by default and preserves --no-redact', () => {
    const safe = renderAggregateJson(aggregateWithPrivateData(), {})
    expect(safe).not.toContain(SECRET)
    expect(safe).toContain('‹anthropic-key›')
    const raw = JSON.parse(renderAggregateJson(aggregateWithPrivateData(), { 'no-redact': true, 'strip-paths': true })) as Aggregate
    expect(JSON.stringify(raw)).toContain(SECRET)
    expect(raw.byProject[0]!.key).toBe(projectPath)
    expect(raw.sessions[0]!.project).toBe(projectPath)
  })

  it('applies --strip-paths and keeps compact stdout formatting under --quiet', () => {
    const out = renderAggregateJson(aggregateWithPrivateData(), { 'strip-paths': true, quiet: true })
    const parsed = JSON.parse(out) as Aggregate
    expect(out).not.toContain(SECRET)
    expect(parsed.byProject[0]!.key).toBe('‹anthropic-key›')
    expect(parsed.sessions[0]!.project).toBe('‹anthropic-key›')
    expect(parsed.topSessions[0]!.project).toBe('‹anthropic-key›')
    expect(parsed.topReReadFiles[0]!.path).toBe('src/‹anthropic-key›.ts')
    expect(out.trim().split('\n')).toHaveLength(1)
  })

  it('retains pretty file formatting without adding the stdout newline', () => {
    const out = renderAggregateJson(aggregateWithPrivateData(), {}, { pretty: true, trailingNewline: false })
    expect(out).toContain('\n  "schemaVersion"')
    expect(out.endsWith('\n')).toBe(false)
  })

  it('reduces encoded absolute project identities to a conservative leaf', () => {
    const base = aggregateWithPrivateData()
    const keys = [
      '-Users-alice-Code-demo',
      'C--Users-bob-work-widget',
      'ordinary-project',
      `-Users-alice-Code-${SECRET}`,
    ]
    base.byProject = keys.map((key) => ({ key, count: 1, tokens: 1 }))
    base.sessions = keys.map((project, index) => ({ ...row, id: `row-${index}`, project }))
    base.topSessions = [...base.sessions]

    const defaultSafe = prepareAggregateForOutput(base, {})
    expect(defaultSafe.byProject.map((value) => value.key)).toEqual(['demo', 'widget', 'ordinary-project', '‹anthropic-key›'])
    expect(JSON.stringify(defaultSafe)).not.toContain('Users-alice')
    expect(JSON.stringify(defaultSafe)).not.toContain('Users-bob')

    const raw = prepareAggregateForOutput(base, { 'no-redact': true, 'strip-paths': true })
    expect(raw.byProject.map((value) => value.key)).toEqual(keys)

    const stripped = prepareAggregateForOutput(base, { 'strip-paths': true })
    expect(stripped.byProject.map((value) => value.key)).toEqual(['demo', 'widget', 'ordinary-project', '‹anthropic-key›'])
    expect(stripped.sessions.map((value) => value.project)).toEqual(['demo', 'widget', 'ordinary-project', '‹anthropic-key›'])
    expect(stripped.topSessions.map((value) => value.project)).toEqual(['demo', 'widget', 'ordinary-project', '‹anthropic-key›'])
    expect(JSON.stringify(stripped)).not.toContain(SECRET)
    expect(JSON.stringify(stripped)).not.toContain('Users-alice')
    expect(JSON.stringify(stripped)).not.toContain('Users-bob')
  })
})
