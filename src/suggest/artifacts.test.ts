import { beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { canonicalWorkspace, loadApplicationReceipt, loadProposalArtifacts, loadVerificationIntent } from './artifacts.js'
import type { SuggestionVerificationIntent } from './types.js'

const id = 'sg_0123456789ab'
let root: string
let proposals: string
let laterPath: string
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
  laterPath = join(root, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl')
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

  it.skipIf(process.platform === 'win32')('rejects hard-linked artifacts without changing the outside inode', async () => {
    const markdown = join(proposals, `${id}.md`)
    unlinkSync(markdown)
    const outside = join(root, 'outside-hardlink.md')
    writeFileSync(outside, '# Outside bytes stay unchanged\n', 'utf8')
    chmodSync(outside, 0o644)
    linkSync(outside, markdown)
    const before = readFileSync(outside)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(loadProposalArtifacts(proposals, id, markdown, undefined, workspace)).rejects.toThrow(/exactly one hard link/)

    expect(readFileSync(outside)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(statSync(outside).nlink).toBe(2)
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

  it('loads a successful application receipt and a well-formed verification intent', async () => {
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
    await expect(loadVerificationIntent(proposals, id, verificationPath, plannedVerificationChecks)).resolves.toEqual({ selectors: [laterPath] })
  })
  it('does not accept failed application checks', async () => {
    const applicationPath = json(`${id}.applied.json`, {
      v: 1,
      id,
      summary: 'Attempted change.',
      files: ['scripts/check.mjs'],
      checks: [{ name: 'unit tests', ok: false }],
    })
    await expect(loadApplicationReceipt(proposals, id, applicationPath, ['scripts/check.mjs'])).rejects.toThrow(/ok must be true/)
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
    await expect(loadVerificationIntent(proposals, id, tampered, plannedVerificationChecks)).rejects.toThrow(/must be omitted/)
    const selfGraded = json(`${id}.verified.json`, {
      v: 1,
      id,
      measuredSessionIds: [laterPath],
      checks: [{ metric: 'avgToolCalls', comparison: 'decreased', ok: true }],
    })
    await expect(loadVerificationIntent(proposals, id, selfGraded, plannedVerificationChecks)).rejects.toThrow(/must omit ok, before, after, and evidence/)

    const unsupported = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Unknown metric.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'claimed', metric: 'moneySaved', comparison: 'roughly-better' }],
    })
    await expect(loadVerificationIntent(proposals, id, unsupported, plannedVerificationChecks)).rejects.toThrow(/metric is not supported/)
  })
  it('binds later verification intent to the reviewed proposal checks', async () => {
    const verificationPath = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Move the goalposts after applying.',
      measuredSessionIds: [laterPath],
      checks: [{ name: 'broader claim', metric: 'avgToolCalls', comparison: 'not-increased' }],
    })
    await expect(loadVerificationIntent(proposals, id, verificationPath, plannedVerificationChecks)).rejects.toThrow(
      /exactly match the reviewed proposal verificationChecks/,
    )
    const otherId = json(`${id}.verified.json`, { v: 1, id: 'sg_ffffffffffff', measuredSessionIds: [laterPath], checks: plannedVerificationChecks })
    await expect(loadVerificationIntent(proposals, id, otherId, plannedVerificationChecks)).rejects.toThrow(/id must exactly match/)
  })
  it('caps and de-duplicates verification selectors', async () => {
    const tooMany = json(`${id}.verified.json`, {
      v: 1,
      id,
      summary: 'Unbounded request.',
      measuredSessionIds: Array.from({ length: 51 }, (_, index) => `session-${index}`),
      checks: [{ name: 'fewer tool calls', metric: 'avgToolCalls', comparison: 'decreased' }],
    })
    await expect(loadVerificationIntent(proposals, id, tooMany, plannedVerificationChecks)).rejects.toThrow(/1-50 session selectors/)
    const duplicated = json(`${id}.verified.json`, { v: 1, id, measuredSessionIds: [laterPath, laterPath], checks: plannedVerificationChecks })
    await expect(loadVerificationIntent(proposals, id, duplicated, plannedVerificationChecks)).rejects.toThrow(/duplicate selectors/)
  })
  it('accepts a renumbered device for the same directory', async () => {
    // macOS renumbers volumes across restarts: same path, same inode, new device.
    const renumbered = { ...workspace, device: String(BigInt(workspace.device) + 5n) }
    await expect(canonicalWorkspace(renumbered)).resolves.toBe(workspace.cwd)
    await expect(canonicalWorkspace({ ...renumbered, inode: String(BigInt(workspace.inode) + 1n) })).rejects.toThrow(/workspace identity no longer matches/)
  })

  it('rejects a replacement workspace at the same canonical path', async () => {
    await expect(canonicalWorkspace(workspace)).resolves.toBe(workspace.cwd)
    const originalWorkspace = `${workspace.cwd}-original`
    renameSync(workspace.cwd, originalWorkspace)
    mkdirSync(workspace.cwd)
    const replacement = statSync(workspace.cwd, { bigint: true })
    expect({ device: String(replacement.dev), inode: String(replacement.ino) }).not.toEqual({
      device: workspace.device,
      inode: workspace.inode,
    })
    await expect(canonicalWorkspace(workspace)).rejects.toThrow(/workspace identity no longer matches/)
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
    await loadVerificationIntent(proposals, id, verificationPath, plannedVerificationChecks)

    expect(statSync(proposals).mode & 0o777).toBe(0o700)
    for (const path of [markdownPath, manifestPath, applicationPath, verificationPath]) {
      expect(statSync(path).mode & 0o777, path).toBe(0o600)
    }
  })
})
