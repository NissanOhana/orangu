import { beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import type { Analysis } from '../model/analysis.js'
import { buildCanonicalSession, SessionBuilder } from '../../test/fixtures/session-builder.js'
import { loadApplicationReceipt, loadProposalArtifacts, loadVerificationReceipt } from './artifacts.js'
import type { SuggestionVerificationIntent } from './types.js'

const id = 'sg_0123456789ab'
let root: string
let proposals: string
let baselinePath: string
let laterPath: string
const applicationStatusAt = Date.parse('2026-08-15T00:00:00.000Z')
let workspace: { cwd: string; device: string; inode: string }
const plannedVerificationChecks = [
  { metric: 'avgToolCalls', comparison: 'decreased' },
] satisfies SuggestionVerificationIntent[]

function json(name: string, value: unknown): string {
  const path = join(proposals, name)
  writeFileSync(path, JSON.stringify(value), 'utf8')
  return path
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id,
    title: 'Make repeated checks deterministic',
    changeClass: 'script-cli',
    change: 'Add a checked project script and teach the agent to use it.',
    evidence: 'Three later turns repeated the same shell pipeline.',
    expectedEffect: 'Fewer repeated calls with the same or better result.',
    effort: 'S',
    risk: 'The script could encode an outdated flag.',
    files: ['scripts/check.mjs', 'CLAUDE.md'],
    verification: 'Run the script and compare later sessions.',
    verificationChecks: plannedVerificationChecks,
    sources: [
      { kind: 'catalog', label: 'catalog: fix-reread-files' },
      { kind: 'research', label: 'Official CLI guide', url: 'https://example.com/guide', verifiedAt: '2026-08-26' },
    ],
    rank: 1,
    ...overrides,
  }
}

function laterSession(startAt = '2026-08-16T10:00:00.000Z', sessionId = 'bbbbbbbb-0000-4000-8000-000000000002'): SessionBuilder {
  return new SessionBuilder({ sessionId, startAt, cwd: workspace.cwd })
    .userPrompt('Use the new deterministic check.')
    .tick(100)
    .assistant([{ type: 'text', text: 'The check passed.' }], { usage: { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 5 } })
    .turnDuration(100, 2)
}

async function analysesByPath(paths: string[]): Promise<Map<string, Analysis>> {
  const entries = await Promise.all(
    paths.map(async (path) => [path, analyzeSession(await parseClaudeCodeSession({ path }), { now: applicationStatusAt })] as const),
  )
  return new Map(entries)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orangu-artifacts-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath)
  const cwd = realpathSync(workspacePath)
  const workspaceStat = statSync(cwd, { bigint: true })
  workspace = { cwd, device: String(workspaceStat.dev), inode: String(workspaceStat.ino) }
  proposals = join(root, 'proposals')
  mkdirSync(proposals)
  writeFileSync(join(proposals, `${id}.md`), '# Proposal\n', 'utf8')
  baselinePath = join(root, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
  laterPath = join(root, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl')
  writeFileSync(baselinePath, buildCanonicalSession({ cwd: workspace.cwd }).toJsonl(), 'utf8')
  writeFileSync(laterPath, laterSession().toJsonl(), 'utf8')
})

describe('suggestion lifecycle artifact validation', () => {
  it('loads a bounded versioned proposal and projects only known fields', async () => {
    const manifestPath = json(`${id}.json`, { ...manifest(), ignored: 'not persisted' })
    const proposal = await loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), manifestPath, workspace)
    expect(proposal).toMatchObject({
      v: 1,
      title: 'Make repeated checks deterministic',
      changeClass: 'script-cli',
      effort: 'S',
      files: ['scripts/check.mjs', 'CLAUDE.md'],
      verificationChecks: plannedVerificationChecks,
      rank: 1,
    })
    expect(proposal.sources).toEqual([
      {
        kind: 'catalog',
        label: 'catalog: fix-reread-files',
        url: 'https://code.claude.com/docs/en/memory.md',
        verifiedAt: '2026-08-23',
      },
      { kind: 'research', label: 'Official CLI guide', url: 'https://example.com/guide', verifiedAt: '2026-08-26' },
    ])
    expect(proposal).not.toHaveProperty('ignored')
  })

  it('keeps artifacts inside proposals and rejects symlinks', async () => {
    const outside = join(root, `${id}.json`)
    writeFileSync(outside, JSON.stringify(manifest()), 'utf8')
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), outside, workspace)).rejects.toThrow(/must be inside/)

    const markdown = join(proposals, `${id}.md`)
    unlinkSync(markdown)
    const outsideMarkdown = join(root, 'outside.md')
    writeFileSync(outsideMarkdown, '# outside\n', 'utf8')
    symlinkSync(outsideMarkdown, markdown)
    await expect(loadProposalArtifacts(proposals, id, markdown, undefined, workspace)).rejects.toThrow(/non-symlink/)
  })

  it('rejects unsafe target files and unverifiable source URLs', async () => {
    const escaping = json(`${id}.json`, manifest({ files: ['../outside'] }))
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), escaping, workspace)).rejects.toThrow(/must not escape/)
    const gitCaseVariant = json(`${id}.json`, manifest({ files: ['.GIT/hooks/pre-commit'] }))
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), gitCaseVariant, workspace)).rejects.toThrow(/modify \.git/)
    const noReviewedFiles = json(`${id}.json`, manifest({ files: [] }))
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), noReviewedFiles, workspace)).rejects.toThrow(/must contain 1-/)
    const insecure = json(`${id}.json`, manifest({ sources: [{ kind: 'research', label: 'blog', url: 'http://example.com' }] }))
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), insecure, workspace)).rejects.toThrow(/valid HTTPS URL/)

    for (const unsafe of [
      'src/file.',
      'src/file ',
      'src/data:stream',
      'src/.git.',
      'src/CON',
      'src/aux.txt',
      'src/COM9.log',
      'src/LPT1',
      'src//file.ts',
      'src/./file.ts',
      './src/file.ts',
      'src/file.ts/',
      'src/file\n.ts',
      'src/\x7f.ts',
    ]) {
      const aliased = json(`${id}.json`, manifest({ files: [unsafe] }))
      await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), aliased, workspace), unsafe).rejects.toThrow(
        /dot or space|alternate data stream|\.git|reserved Windows device|empty path components|dot path components|control characters/,
      )
    }

    const normalized = json(`${id}.json`, manifest({ files: ['src\\nested\\file.ts'] }))
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), normalized, workspace)).resolves.toMatchObject({
      files: ['src/nested/file.ts'],
    })
    for (const duplicateFiles of [
      ['src\\nested\\file.ts', 'src/nested/file.ts'],
      ['SRC/nested/file.ts', 'src/nested/file.ts'],
    ]) {
      const duplicate = json(`${id}.json`, manifest({ files: duplicateFiles }))
      await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), duplicate, workspace)).rejects.toThrow(/platform-aliased paths/)
    }
  })

  it('derives catalog provenance and requires explicit checked research provenance', async () => {
    const invalidSources = [
      [{ kind: 'inference', label: 'Reasoned locally', url: 'https://example.com' }],
      [{ kind: 'inference', label: 'Reasoned locally', verifiedAt: '2026-08-26' }],
      [{ kind: 'research', label: 'Missing URL', verifiedAt: '2026-08-26' }],
      [{ kind: 'research', label: 'Missing date', url: 'https://example.com' }],
      [{ kind: 'research', label: 'Null date', url: 'https://example.com', verifiedAt: null }],
      [{ kind: 'research', label: 'Bad date', url: 'https://example.com', verifiedAt: '2026-02-30' }],
      [{ kind: 'catalog', label: 'fix-reread-files' }],
      [{ kind: 'catalog', label: 'catalog: does-not-exist' }],
      [{ kind: 'catalog', label: 'catalog: fix-reread-files', url: 'https://evil.example/source' }],
      [{ kind: 'catalog', label: 'catalog: fix-reread-files', verifiedAt: '2026-08-26' }],
    ]
    for (const sources of invalidSources) {
      const path = json(`${id}.json`, manifest({ sources }))
      await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), path, workspace), JSON.stringify(sources)).rejects.toThrow(
        /inference|HTTPS URL|non-null valid|catalog entry|label must be exactly|does not match/,
      )
    }
  })

  it('requires bounded unique supported verificationChecks in structured manifests', async () => {
    for (const verificationChecks of [undefined, [], [{ metric: 'unknown', comparison: 'decreased' }]]) {
      const path = json(`${id}.json`, manifest({ verificationChecks }))
      await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), path, workspace)).rejects.toThrow(/verificationChecks/)
    }
    const duplicate = json(`${id}.json`, manifest({ verificationChecks: [...plannedVerificationChecks, ...plannedVerificationChecks] }))
    await expect(loadProposalArtifacts(proposals, id, join(proposals, `${id}.md`), duplicate, workspace)).rejects.toThrow(/duplicate metric\/comparison pairs/)
  })

  it('loads successful application and later verification receipts', async () => {
    const applicationPath = json(`${id}.applied.json`, {
      v: 1,
      id,
      summary: 'Added the checked script.',
      files: ['scripts/check.mjs'],
      checks: [{ name: 'unit tests', command: 'npm test', ok: true }],
    })
    const application = await loadApplicationReceipt(proposals, id, applicationPath, ['scripts/check.mjs'])
    expect(application.checks[0]).toEqual({ name: 'unit tests', command: 'npm test', ok: true })

    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Untrusted display summary.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'Untrusted display name', metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const verified = await loadVerificationReceipt(proposals, id, verificationPath, {
      baselineSessionIds: [baselinePath],
      applicationStatusAt,
      expectedChecks: plannedVerificationChecks,
      workspace,
      loadAnalysis: async (selector) => analyses.get(selector),
    })
    expect(verified.receipt.summary).toBe('Later-session comparison passed: avgToolCalls decreased.')
    expect(verified.receipt.measuredSessionIds).toEqual(['bbbbbbbb-0000-4000-8000-000000000002'])
    expect(verified.receipt.checks[0]).toMatchObject({ name: 'avgToolCalls decreased', metric: 'avgToolCalls', comparison: 'decreased', before: 6, after: 0, ok: true })
    expect(verified.effect).toEqual({
      before: { avgToolCalls: 6 },
      after: { avgToolCalls: 0 },
      measuredSessionIds: ['bbbbbbbb-0000-4000-8000-000000000002'],
    })
  })

  it('accepts a completed baseline that ended before application', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const baseline = analyses.get(baselinePath)!
    expect(baseline.session.live).toBe(false)
    expect(baseline.session.endedAt).toBeLessThan(applicationStatusAt)

    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => analyses.get(selector),
      }),
    ).resolves.toMatchObject({ receipt: { measuredSessionIds: ['bbbbbbbb-0000-4000-8000-000000000002'] } })
  })

  it('rejects a live baseline even when it has a last-record timestamp', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const liveBaseline = { ...analyses.get(baselinePath)!, session: { ...analyses.get(baselinePath)!.session, live: true } }

    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === baselinePath ? liveBaseline : analyses.get(selector)),
      }),
    ).rejects.toThrow(/baseline session .* is live/)
  })

  it('rejects a baseline that grew past the application transition', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const postApplicationBaseline = {
      ...analyses.get(baselinePath)!,
      session: { ...analyses.get(baselinePath)!.session, endedAt: applicationStatusAt + 1, live: false },
    }

    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === baselinePath ? postApplicationBaseline : analyses.get(selector)),
      }),
    ).rejects.toThrow(/baseline sessions must end no later than the application transition/)
  })

  it('rejects a live measured session before computing its metrics', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const liveLater = { ...analyses.get(laterPath)!, session: { ...analyses.get(laterPath)!.session, live: true } }

    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === laterPath ? liveLater : analyses.get(selector)),
      }),
    ).rejects.toThrow(/measured session .* is live/)
  })

  it('does not accept failed checks or reuse baseline sessions as verification', async () => {
    const applicationPath = json(`${id}.applied.json`, {
      v: 1,
      id,
      summary: 'Attempted change.',
      files: ['scripts/check.mjs'],
      checks: [{ name: 'unit tests', ok: false }],
    })
    await expect(loadApplicationReceipt(proposals, id, applicationPath, ['scripts/check.mjs'])).rejects.toThrow(/ok must be true/)

    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Reused the original evidence.',
      measuredSessionIds: [baselinePath],
      checks: [{ name: 'comparison', metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath])
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => analyses.get(selector),
      }),
    ).rejects.toThrow(/later evidence/)
  })

  it('rejects self-attested metric values and unsupported comparison intents', async () => {
    const tampered = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Claimed improvement.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'claimed', metric: 'avgToolCalls', comparison: 'decreased', before: 999, after: 0, ok: true }],
      before: { avgToolCalls: 999 },
      after: { avgToolCalls: 0 },
    })
    await expect(
      loadVerificationReceipt(proposals, id, tampered, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async () => {
          throw new Error('must not load self-attested metrics')
        },
      }),
    ).rejects.toThrow(/must be omitted/)

    const unsupported = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Unknown metric.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'claimed', metric: 'moneySaved', comparison: 'roughly-better' }],
    })
    await expect(
      loadVerificationReceipt(proposals, id, unsupported, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async () => undefined,
      }),
    ).rejects.toThrow(/metric is not supported/)
  })

  it('binds later verification intent to the reviewed proposal checks', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Move the goalposts after applying.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'broader claim', metric: 'avgToolCalls', comparison: 'not-increased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => analyses.get(selector),
      }),
    ).rejects.toThrow(/exactly match the reviewed proposal verificationChecks/)
  })

  it('refuses unresolved, missing-time, and not-later sessions', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Measure a later run.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'fewer tool calls', metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const baselineOnly = await analysesByPath([baselinePath])
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => baselineOnly.get(selector),
      }),
    ).rejects.toThrow(/could not be resolved/)

    const analyses = await analysesByPath([baselinePath, laterPath])
    const missingBaselineTime = { ...analyses.get(baselinePath)!, session: { ...analyses.get(baselinePath)!.session, startedAt: undefined } }
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === baselinePath ? missingBaselineTime : analyses.get(selector)),
      }),
    ).rejects.toThrow(/baselineSessionIds\[0\] has no valid session start timestamp/)

    const missingTime = { ...analyses.get(laterPath)!, session: { ...analyses.get(laterPath)!.session, startedAt: undefined } }
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === laterPath ? missingTime : analyses.get(selector)),
      }),
    ).rejects.toThrow(/no valid session start timestamp/)

    const notLaterPath = join(root, 'cccccccc-0000-4000-8000-000000000003.jsonl')
    writeFileSync(notLaterPath, laterSession('2026-08-15T00:00:00.000Z', 'cccccccc-0000-4000-8000-000000000003').toJsonl(), 'utf8')
    const notLaterAnalyses = await analysesByPath([baselinePath, notLaterPath])
    writeFileSync(
      verificationPath,
      JSON.stringify({
        v: 1,
        id,
        summary: 'Not actually later.',
        measuredSessionIds: [notLaterPath],
        checks: [{ name: 'fewer tool calls', metric: 'avgToolCalls', comparison: 'decreased' }],
      }),
    )
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => notLaterAnalyses.get(selector),
      }),
    ).rejects.toThrow(/must start after the application transition/)
  })

  it('caps verification selectors and accepts only supported session analyses', async () => {
    const tooMany = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Unbounded request.',
      measuredSessionIds: Array.from({ length: 51 }, (_, index) => `session-${index}`),
      checks: [{ name: 'fewer tool calls', metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    await expect(
      loadVerificationReceipt(proposals, id, tooMany, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async () => undefined,
      }),
    ).rejects.toThrow(/1-50 session selectors/)

    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Unsupported source.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'fewer tool calls', metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const unsupported = { ...analyses.get(laterPath)!, session: { ...analyses.get(laterPath)!.session, source: 'unknown' } }
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === laterPath ? unsupported : analyses.get(selector)),
      }),
    ).rejects.toThrow(/not a supported Claude session/)
  })

  it('binds every baseline and later analysis to the reviewed canonical workspace', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const otherWorkspace = join(root, 'other-workspace')
    mkdirSync(otherWorkspace)
    const wrongWorkspace = {
      ...analyses.get(laterPath)!,
      session: { ...analyses.get(laterPath)!.session, cwd: otherWorkspace },
    }
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === laterPath ? wrongWorkspace : analyses.get(selector)),
      }),
    ).rejects.toThrow(/belongs to a different workspace/)

    const missingCwd = { ...analyses.get(baselinePath)!, session: { ...analyses.get(baselinePath)!.session, cwd: undefined } }
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => (selector === baselinePath ? missingCwd : analyses.get(selector)),
      }),
    ).rejects.toThrow(/has no resolvable workspace cwd/)
  })

  it('rejects a replacement workspace at the same canonical path', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    const originalWorkspace = `${workspace.cwd}-original`
    renameSync(workspace.cwd, originalWorkspace)
    mkdirSync(workspace.cwd)
    const replacement = statSync(workspace.cwd, { bigint: true })
    expect({ device: String(replacement.dev), inode: String(replacement.ino) }).not.toEqual({
      device: workspace.device,
      inode: workspace.inode,
    })

    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: plannedVerificationChecks,
        workspace,
        loadAnalysis: async (selector) => analyses.get(selector),
      }),
    ).rejects.toThrow(/workspace identity no longer matches/)
  })

  it('requires every computed comparison to pass', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Expect the wrong direction.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'more tool calls', metric: 'avgToolCalls', comparison: 'increased' }],
    })
    const analyses = await analysesByPath([baselinePath, laterPath])
    await expect(
      loadVerificationReceipt(proposals, id, verificationPath, {
        baselineSessionIds: [baselinePath],
        applicationStatusAt,
        expectedChecks: [{ metric: 'avgToolCalls', comparison: 'increased' }],
        workspace,
        loadAnalysis: async (selector) => analyses.get(selector),
      }),
    ).rejects.toThrow(/did not pass/)
  })

  it('binds an application receipt to exactly the reviewed proposal files', async () => {
    const applicationPath = json(`${id}.applied.json`, {
      v: 1,
      id,
      summary: 'Changed a broader set than the proposal reviewed.',
      files: ['scripts/check.mjs', 'src/unreviewed.ts'],
      checks: [{ name: 'unit tests', ok: true }],
    })
    await expect(loadApplicationReceipt(proposals, id, applicationPath, ['scripts/check.mjs'])).rejects.toThrow(/exactly match/)
  })

  it.skipIf(process.platform === 'win32')('hardens accepted proposal and receipt files to private POSIX modes', async () => {
    const markdownPath = join(proposals, `${id}.md`)
    const manifestPath = json(`${id}.json`, manifest())
    const applicationPath = json(`${id}.applied.json`, {
      v: 1,
      id,
      summary: 'Applied reviewed files.',
      files: ['scripts/check.mjs'],
      checks: [{ name: 'tests', ok: true }],
    })
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    chmodSync(proposals, 0o777)
    for (const path of [markdownPath, manifestPath, applicationPath, verificationPath]) chmodSync(path, 0o666)

    await loadProposalArtifacts(proposals, id, markdownPath, manifestPath, workspace)
    await loadApplicationReceipt(proposals, id, applicationPath, ['scripts/check.mjs'])
    const analyses = await analysesByPath([baselinePath, laterPath])
    await loadVerificationReceipt(proposals, id, verificationPath, {
      baselineSessionIds: [baselinePath],
      applicationStatusAt,
      expectedChecks: plannedVerificationChecks,
      workspace,
      loadAnalysis: async (selector) => analyses.get(selector),
    })

    expect(statSync(proposals).mode & 0o777).toBe(0o700)
    for (const path of [markdownPath, manifestPath, applicationPath, verificationPath]) {
      expect(statSync(path).mode & 0o777, path).toBe(0o600)
    }
  })
})
