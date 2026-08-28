import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, renameSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  MAX_EVIDENCE_SIDECAR_ENTRIES,
  prevalidateEvidenceSession,
  readEvidenceSessionManifest,
} from '../../adapters/claude-code/evidence-input.js'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { aggregate } from '../../analyze/aggregate.js'
import { analyzeSession } from '../../analyze/analyze.js'
import type { Analysis } from '../../model/analysis.js'
import { MAX_EVIDENCE_ARTIFACT_BYTES } from '../../suggest/evidence.js'
import { slimAnalysis } from '../../suggest/slim.js'
import { buildCanonicalSession, SessionBuilder } from '../../../test/fixtures/session-builder.js'
import { makeFixtureHome } from '../../../test/fixtures/home.js'
import { cmdEvidence, MAX_EVIDENCE_SESSION_BYTES } from './evidence.js'

let output: string[]

beforeEach(() => {
  output = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['ORANGU_HOME']
})

const stdout = () => output.join('')
const resetOutput = () => {
  output = []
}

async function canonical(): Promise<Analysis> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  return analyzeSession(session, { version: 'test', now: 0 })
}

describe('orangu evidence', () => {
  it('routes latest selectors and raw .jsonl paths through session analysis without store writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orangu-evidence-selector-'))
    const home = await makeFixtureHome(root)
    process.env['ORANGU_HOME'] = join(root, 'orangu-state')

    await cmdEvidence(['latest'], { root: home.configDir, quiet: true })
    const latest = JSON.parse(stdout())
    expect(latest.source).toMatchObject({ kind: 'analysis', scope: 'session' })

    resetOutput()
    await cmdEvidence([home.sessions[0]!.path], { quiet: true })
    const raw = JSON.parse(stdout())
    expect(raw.source.kind).toBe('analysis')
    expect(raw.findings.every((row: { finding: { sessionIds: string[] } }) => row.finding.sessionIds.includes(home.sessions[0]!.id))).toBe(true)
    expect(existsSync(join(process.env['ORANGU_HOME']!, 'suggestions.jsonl'))).toBe(false)
  })

  it('accepts current regular Analysis and SlimAnalysis JSON files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-json-'))
    const analysis = await canonical()
    const fullPath = join(dir, 'analysis.json')
    const slimPath = join(dir, 'slim.json')
    writeFileSync(fullPath, JSON.stringify(analysis))
    writeFileSync(slimPath, JSON.stringify(slimAnalysis(analysis)))

    await cmdEvidence([fullPath], { quiet: true })
    const full = JSON.parse(stdout())
    resetOutput()
    await cmdEvidence([slimPath], { quiet: true })
    const slim = JSON.parse(stdout())
    expect(full.source.kind).toBe('analysis')
    expect(slim.source.kind).toBe('slim-analysis')
    expect(slim.findings.map((row: { suggestionId: string }) => row.suggestionId)).toEqual(full.findings.map((row: { suggestionId: string }) => row.suggestionId))
  })

  it('accepts Aggregate JSON only with explicit repo|global scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-aggregate-'))
    const path = join(dir, 'aggregate.json')
    writeFileSync(path, JSON.stringify(aggregate([await canonical()], 'display label only', 0)))

    await expect(cmdEvidence([path], { quiet: true })).rejects.toThrow(/explicit --scope repo\|global/)
    await expect(cmdEvidence([path], { scope: 'session', quiet: true })).rejects.toThrow(/--scope must be repo\|global/)
    await cmdEvidence([path], { scope: 'repo', quiet: true })
    expect(JSON.parse(stdout()).source.scope).toBe('repo')
  })

  it('rejects malformed, stale, oversized, and symlinked JSON before projection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-invalid-'))
    const malformed = join(dir, 'malformed.json')
    const stale = join(dir, 'stale.json')
    const oversized = join(dir, 'oversized.json')
    const target = join(dir, 'target.json')
    const link = join(dir, 'link.json')
    writeFileSync(malformed, '{nope')
    writeFileSync(stale, JSON.stringify({ ...(await canonical()), schemaVersion: '1' }))
    writeFileSync(target, JSON.stringify(await canonical()))
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_EVIDENCE_ARTIFACT_BYTES + 1)
    symlinkSync(target, link)

    await expect(cmdEvidence([malformed], {})).rejects.toThrow(/invalid evidence JSON/)
    await expect(cmdEvidence([stale], {})).rejects.toThrow(/current/)
    await expect(cmdEvidence([oversized], {})).rejects.toThrow(/exceeds/)
    await expect(cmdEvidence([link], {})).rejects.toThrow(/symbolic link/)
  })

  it('bounds and rejects symlinked JSONL before parser input is constructed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-jsonl-bound-'))
    const target = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const link = join(dir, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl')
    const oversized = join(dir, 'cccccccc-0000-4000-8000-000000000003.jsonl')
    writeFileSync(target, buildCanonicalSession().toJsonl())
    symlinkSync(target, link)
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_EVIDENCE_SESSION_BYTES + 1)

    await expect(cmdEvidence([link], {})).rejects.toThrow(/symbolic links/)
    await expect(cmdEvidence([oversized], {})).rejects.toThrow(/session input exceeds/)
  })

  it('enforces the session byte cap across the exact main, sidecar, and metadata manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-aggregate-bound-'))
    const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const main = join(dir, `${sessionId}.jsonl`)
    const root = join(dir, sessionId, 'subagents')
    const sidecar = join(root, 'agent-large.jsonl')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    writeFileSync(sidecar, '')
    truncateSync(sidecar, MAX_EVIDENCE_SESSION_BYTES - statSync(main).size + 1)

    await expect(prevalidateEvidenceSession(main)).rejects.toThrow(/session input exceeds/)
  })

  it('caps sidecar discovery by entry count before building an unbounded manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-sidecar-count-'))
    const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const main = join(dir, `${sessionId}.jsonl`)
    const root = join(dir, sessionId, 'subagents')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    for (let index = 0; index <= MAX_EVIDENCE_SIDECAR_ENTRIES; index++) {
      writeFileSync(join(root, `ignored-${String(index).padStart(5, '0')}`), '')
    }
    await expect(prevalidateEvidenceSession(main)).rejects.toThrow(/sidecar manifest exceeds/)
  })

  it('rejects sidecar file and directory symlinks instead of following them outside the canonical root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-sidecar-link-'))
    const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const main = join(dir, `${sessionId}.jsonl`)
    const root = join(dir, sessionId, 'subagents')
    const outside = join(dir, 'outside')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'agent-escape.jsonl'), buildCanonicalSession().toJsonl())

    symlinkSync(join(outside, 'agent-escape.jsonl'), join(root, 'agent-escape.jsonl'))
    await expect(prevalidateEvidenceSession(main)).rejects.toThrow(/must not include symbolic links/)

    const secondId = 'bbbbbbbb-0000-4000-8000-000000000002'
    const secondMain = join(dir, `${secondId}.jsonl`)
    const secondRoot = join(dir, secondId, 'subagents')
    writeFileSync(secondMain, buildCanonicalSession().toJsonl())
    mkdirSync(secondRoot, { recursive: true })
    symlinkSync(outside, join(secondRoot, 'nested'))
    await expect(prevalidateEvidenceSession(secondMain)).rejects.toThrow(/must not include symbolic links/)

    const thirdId = 'cccccccc-0000-4000-8000-000000000003'
    const thirdMain = join(dir, `${thirdId}.jsonl`)
    const outsideSession = join(dir, 'outside-session')
    writeFileSync(thirdMain, buildCanonicalSession().toJsonl())
    mkdirSync(join(outsideSession, 'subagents'), { recursive: true })
    symlinkSync(outsideSession, join(dir, thirdId))
    await expect(prevalidateEvidenceSession(thirdMain)).rejects.toThrow(/must not include symbolic links/)
  })

  it('rejects a transcript replaced while the manifest read is starting, even when the replacement has valid JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-replaced-'))
    const path = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const original = buildCanonicalSession().toJsonl()
    writeFileSync(path, original)
    const manifest = await prevalidateEvidenceSession(path)
    const reading = readEvidenceSessionManifest(manifest)
    renameSync(path, `${path}.old`)
    writeFileSync(path, original)

    await expect(reading).rejects.toThrow(/changed before it was read|changed while it was being read/)
  })

  it('reads the exact prevalidated bytes and never rediscovers a sidecar that appears afterward', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-exact-input-'))
    const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const main = join(dir, `${sessionId}.jsonl`)
    const root = join(dir, sessionId, 'subagents')
    const first = join(root, 'agent-first.jsonl')
    const firstMeta = join(root, 'agent-first.meta.json')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    writeFileSync(first, buildCanonicalSession().toJsonl())
    writeFileSync(firstMeta, JSON.stringify({ taskKind: 'subagent', agentType: 'tester' }))

    const manifest = await prevalidateEvidenceSession(main)
    const loaded = await readEvidenceSessionManifest(manifest)
    expect(loaded.bytesRead).toBe(statSync(main).size + statSync(first).size + statSync(firstMeta).size)

    const late = join(root, 'agent-late.jsonl')
    writeFileSync(late, buildCanonicalSession().toJsonl())
    const parsed = await parseClaudeCodeSession(loaded.parseInput)
    expect(parsed.meta.subagentPaths.map((path) => basename(path))).toEqual(['agent-first.jsonl'])
    expect(parsed.meta.subagentPaths.map((path) => basename(path))).not.toContain('agent-late.jsonl')
  })

  it('rejects direct and nested sidecar tree mutation after manifest enumeration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-tree-race-'))
    const directId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const directMain = join(dir, `${directId}.jsonl`)
    const directRoot = join(dir, directId, 'subagents')
    writeFileSync(directMain, buildCanonicalSession().toJsonl())
    mkdirSync(directRoot, { recursive: true })
    const directManifest = await prevalidateEvidenceSession(directMain)
    const directRead = readEvidenceSessionManifest(directManifest)
    writeFileSync(join(directRoot, 'agent-new.jsonl'), buildCanonicalSession().toJsonl())
    await expect(directRead).rejects.toThrow(/directory changed|tree changed/)

    const nestedId = 'bbbbbbbb-0000-4000-8000-000000000002'
    const nestedMain = join(dir, `${nestedId}.jsonl`)
    const nestedRoot = join(dir, nestedId, 'subagents', 'team')
    writeFileSync(nestedMain, buildCanonicalSession().toJsonl())
    mkdirSync(nestedRoot, { recursive: true })
    writeFileSync(join(nestedRoot, 'agent-first.jsonl'), buildCanonicalSession().toJsonl())
    const nestedManifest = await prevalidateEvidenceSession(nestedMain)
    const nestedRead = readEvidenceSessionManifest(nestedManifest)
    writeFileSync(join(nestedRoot, 'agent-second.jsonl'), buildCanonicalSession().toJsonl())
    await expect(nestedRead).rejects.toThrow(/directory changed/)
  })

  it('rejects a listed sidecar removed while its immutable manifest is being read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-sidecar-remove-'))
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    const main = join(dir, `${id}.jsonl`)
    const root = join(dir, id, 'subagents')
    const sidecar = join(root, 'agent-remove.jsonl')
    writeFileSync(main, buildCanonicalSession().toJsonl())
    mkdirSync(root, { recursive: true })
    writeFileSync(sidecar, buildCanonicalSession().toJsonl())
    const manifest = await prevalidateEvidenceSession(main)
    const reading = readEvidenceSessionManifest(manifest)
    unlinkSync(sidecar)
    await expect(reading).rejects.toThrow(/changed before it was read|changed while it was being read/)
  })

  it('--estimate emits the exact compact projection size without the evidence bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-estimate-'))
    const path = join(dir, 'analysis.json')
    writeFileSync(path, JSON.stringify(await canonical()))

    await cmdEvidence([path], { quiet: true })
    const bundle = JSON.parse(stdout())
    resetOutput()
    await cmdEvidence([path], { estimate: true, quiet: true })
    const estimate = JSON.parse(stdout())
    const bytes = Buffer.byteLength(JSON.stringify(bundle))
    expect(estimate).toEqual({
      bytes,
      approxTokens: Math.ceil(bytes / 4),
      thresholdTokens: 5_000,
      overThreshold: Math.ceil(bytes / 4) > 5_000,
    })
    expect(estimate.findings).toBeUndefined()
  })

  it('strips transcript-derived finding text by default and restores it, scrubbed, with --include-text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-text-'))
    const id = 'bbbbbbbb-0000-4000-8000-000000000002'
    const path = join(dir, `${id}.jsonl`)
    const b = new SessionBuilder({ sessionId: id })
    b.userPrompt('deploy')
    for (let i = 0; i < 3; i++) {
      b.tick(100)
      b.toolCall('Bash', { command: 'psql' }, 'error: key sk-ant-api03-abc123def456ghi789 rejected; password authentication failed for user acme_prod at db.acme-internal.example', { isError: true, durationMs: 50 })
    }
    writeFileSync(path, b.toJsonl())

    await cmdEvidence([path], { quiet: true })
    const plain = stdout()
    expect(plain).not.toContain('abc123def456ghi789')
    expect(plain).not.toContain('acme_prod')
    expect(plain).not.toContain('acme-internal')
    expect(JSON.parse(plain).findings.length).toBeGreaterThan(0)

    resetOutput()
    await cmdEvidence([path], { quiet: true, 'include-text': true })
    const kept = stdout()
    expect(kept).not.toContain('abc123def456ghi789')
    expect(kept).toContain('‹anthropic-key›')
  })

  it('always redacts secrets and rejects the redaction bypass flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-evidence-secret-'))
    const path = join(dir, 'analysis.json')
    const analysis = await canonical()
    const secret = 'sk-ant-api03-abc123def456ghi789'
    analysis.insights[0] = {
      ...analysis.insights[0]!,
      title: `Secret ${secret}`,
      detail: `Secret ${secret}`,
      recommendation: `Secret ${secret}`,
    }
    writeFileSync(path, JSON.stringify(analysis))

    await cmdEvidence([path], { quiet: true })
    expect(stdout()).not.toContain(secret)
    expect(stdout()).toContain('‹anthropic-key›')
    await expect(cmdEvidence([path], { 'no-redact': true })).rejects.toThrow(/always redacted/)
    await expect(cmdEvidence([path], { depth: 'deep' })).rejects.toThrow(/one canonical bounded projection/)
  })
})
