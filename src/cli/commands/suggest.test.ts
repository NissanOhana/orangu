import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession, SessionBuilder } from '../../../test/fixtures/session-builder.js'
import { cmdSuggest, recordLines } from './suggest.js'
import { displayWidth } from '../tty.js'
import { encodeFinding, kickoffCommand, normalizeSessionIds, sessionCohortFingerprint, suggestionId, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import {
  SUGGESTION_VERIFICATION_COMPARISONS,
  SUGGESTION_VERIFICATION_METRICS,
  type Finding,
  type SuggestionFrozenBaseline,
  type SuggestionRecord,
  type SuggestionVerificationIntent,
  type SuggestionVerificationMetric,
} from '../../suggest/types.js'
import type { CohortCandidate, CohortEffect, FreezeDeps } from '../../suggest/cohort.js'
import { COHORT_SKIP_REASONS, type CohortSkipReason } from '../../suggest/cohort-skip-reasons.js'
import { REJECT_REASON_CODES } from '../../suggest/reason-codes.js'
import { SuggestionStore } from '../../suggest/store.js'
import { createCohortDeps } from '../../suggest/cohort-deps.js'

/**
 * The trusted loaders, with a quiet gate that reads a clock past the ctime of each fixture file. The apply step runs at
 * a fake date before that ctime, and a session must be quiet for 30 minutes before the freeze can read it.
 */
const QUIET_LOADER = { cohort: createCohortDeps({ now: () => Date.parse('2030-01-01T00:00:00.000Z') }) }
import { parseArgs } from '../args.js'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../analyze/analyze.js'
import { projectEvidence } from '../../suggest/evidence.js'

let home: string
let claudeHome: string
let fixturePath: string
let laterFixturePath: string
let out: string[]
let savedHome: string | undefined

beforeEach(() => {
  // claudeRoots always appends the home roots: an empty temp HOME keeps the machine's own sessions out of cohorts.
  savedHome = process.env['HOME']
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'orangu-cmd-home-'))
  home = mkdtempSync(join(tmpdir(), 'orangu-cmd-'))
  process.env['ORANGU_HOME'] = home
  claudeHome = mkdtempSync(join(tmpdir(), 'orangu-claude-'))
  process.env['CLAUDE_CONFIG_DIR'] = claudeHome
  const dir = join(claudeHome, 'projects', '-fixture')
  mkdirSync(dir, { recursive: true })
  fixturePath = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
  writeFileSync(fixturePath, buildCanonicalSession({ cwd: process.cwd() }).toJsonl())
  laterFixturePath = join(dir, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl')
  writeFileSync(
    laterFixturePath,
    new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', startAt: '2026-08-16T10:00:00.000Z', cwd: process.cwd() })
      .userPrompt('Use the deterministic script.')
      .tick(100)
      .assistant([{ type: 'text', text: 'Done.' }], { usage: { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 5 } })
      .turnDuration(100, 2)
      .toJsonl(),
  )
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
})
afterEach(() => {
  vi.useRealTimers()
  delete process.env['ORANGU_HOME']
  delete process.env['CLAUDE_CONFIG_DIR']
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  vi.restoreAllMocks()
})

const stdout = () => out.join('')

describe('orangu suggest (in-process, ORANGU_HOME=tmp)', () => {
  it('creates a record from --rule/--scope/--session and prints the serve kickoff command', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const res = JSON.parse(stdout())
    expect(res.created).toBe(true)
    const finding: Finding = { ruleId: 'reread-files', title: 'reread-files', scope: 'session', sessionIds: [fixturePath], evidence: { estimated: true } }
    expect(res.record.id).toBe(suggestionIdV2(suggestionKey(finding, 'skill')))
    expect(res.record.v).toBe(2)
    expect(res.record.status).toBe('new')
    expect(res.record.source).toBe('skill')
    expect(res.command).toBe(`claude "/orangu:improve ${res.record.id}"`)
    // persisted under ORANGU_HOME
    const line = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim()
    expect(JSON.parse(line).id).toBe(res.record.id)
  })

  it('re-running the same create is a get (created:false)', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    out = []
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    expect(JSON.parse(stdout()).created).toBe(false)
  })

  it.each(['repo', 'global'] as const)('derives a stable full-cohort identity for manual %s creation', async (scope) => {
    const slashVariant = fixturePath.replaceAll('/', '\\')
    const supplied = [laterFixturePath, ` ${slashVariant} `, fixturePath]
    await cmdSuggest([], { rule: 'reread-files', scope, session: supplied.join(','), json: true })
    const first = JSON.parse(stdout())
    const normalized = normalizeSessionIds(supplied)
    expect(first.created).toBe(true)
    expect(first.record.sessionIds).toEqual(normalized)
    expect(first.record.cohortFingerprint).toBe(sessionCohortFingerprint(normalized))
    const finding: Finding = {
      ruleId: 'reread-files',
      title: 'reread-files',
      scope,
      sessionIds: normalized,
      cohortFingerprint: sessionCohortFingerprint(normalized),
      evidence: { estimated: true },
    }
    expect(first.record.id).toBe(suggestionIdV2(suggestionKey(finding, 'skill')))

    out = []
    await cmdSuggest([], { rule: 'reread-files', scope, session: [...normalized].reverse().join(','), json: true })
    const repeated = JSON.parse(stdout())
    expect(repeated.created).toBe(false)
    expect(repeated.record.id).toBe(first.record.id)
  })

  it('accepts only a valid explicit aggregate cohort override', async () => {
    await expect(cmdSuggest([], { rule: 'r', scope: 'repo', session: fixturePath, cohort: 'short' })).rejects.toThrow(/16 lowercase hexadecimal/)
    await expect(cmdSuggest([], { rule: 'r', scope: 'repo', session: fixturePath, cohort: 'ABCDEF0123456789' })).rejects.toThrow(/16 lowercase hexadecimal/)
    await expect(cmdSuggest([], { rule: 'r', scope: 'repo', session: fixturePath, cohort: true })).rejects.toThrow(/16 lowercase hexadecimal/)
    await expect(cmdSuggest([], { rule: 'r', scope: 'session', session: fixturePath, cohort: '1111111111111111' })).rejects.toThrow(/only with --scope repo\|global/)

    await cmdSuggest([], { rule: 'r', scope: 'global', session: fixturePath, cohort: '0123456789abcdef', json: true })
    expect(JSON.parse(stdout()).record.cohortFingerprint).toBe('0123456789abcdef')
  })

  it('scrubs suggestion records in JSON and terminal output unless explicitly disabled', async () => {
    const secret = 'sk-ant-api03-abc123def456ghi789'
    await cmdSuggest([], { rule: 'reread-files', title: `Finding ${secret}`, scope: 'session', session: fixturePath, json: true })
    expect(stdout()).not.toContain(secret)
    expect(stdout()).toContain('‹anthropic-key›')
    expect(readFileSync(join(home, 'suggestions.jsonl'), 'utf8')).toContain(secret)

    out = []
    await cmdSuggest([], { rule: 'reread-files', title: `Finding ${secret}`, scope: 'session', session: fixturePath, json: true, 'no-redact': true })
    expect(stdout()).toContain(secret)
  })

  it('--show returns the record plus redacted slim analyses of the evidence sessions', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id
    out = []
    await cmdSuggest([], { show: id, json: true })
    const res = JSON.parse(stdout())
    expect(res.record.id).toBe(id)
    expect(res.sessions).toHaveLength(1)
    expect(res.sessions[0].slim).toBe(true)
    expect(res.sessions[0].turns).toBeUndefined()
  })

  it('--for-proposal binds discovered session evidence to the current workspace', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id
    out = []
    await cmdSuggest([], { show: id, 'for-proposal': true, json: true })
    expect(JSON.parse(stdout()).proposalEligibility).toBe('workspace-bound')
    await expect(cmdSuggest([], { show: id, 'for-proposal': true, 'for-apply': true, json: true })).rejects.toThrow(/mutually exclusive/)

    const archive = join(mkdtempSync(join(tmpdir(), 'orangu-archive-')), 'dddddddd-0000-4000-8000-000000000004.jsonl')
    writeFileSync(
      archive,
      new SessionBuilder({ sessionId: 'dddddddd-0000-4000-8000-000000000004', cwd: process.cwd() })
        .userPrompt('Archived evidence.')
        .assistant([{ type: 'text', text: 'Done.' }])
        .toJsonl(),
    )
    out = []
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: archive, json: true })
    const archivedId = JSON.parse(stdout()).record.id
    await expect(cmdSuggest([], { show: archivedId, 'for-proposal': true, json: true })).rejects.toThrow(/could not be resolved from supported Claude roots/)
  })

  it('--for-proposal recomputes report-source session findings instead of trusting imported evidence', async () => {
    const parsed = await parseClaudeCodeSession({ records: buildCanonicalSession({ cwd: process.cwd() }).toRecords(), noSidecar: true })
    const analysis = analyzeSession(parsed, { version: 'test', now: 0 })
    const row = projectEvidence(analysis).findings[0]!
    await cmdSuggest([row.suggestionId], { finding: row.findingToken, json: true })
    out = []
    await cmdSuggest([], { show: row.suggestionId, 'for-proposal': true, json: true })
    expect(JSON.parse(stdout()).proposalEligibility).toBe('workspace-bound')

    const forged = { ...row.finding, title: 'Forged imported claim', evidence: { estimated: true, sessions: 1, savingsTokens: 99_999_999 } }
    out = []
    await cmdSuggest([row.suggestionId], { finding: encodeFinding(forged, 'report'), json: true })
    await expect(cmdSuggest([], { show: row.suggestionId, 'for-proposal': true, json: true })).rejects.toThrow(/does not match the canonical finding recomputed/)
  })

  it('--show resolves a canonical Cowork session id beyond the primary Claude root', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'orangu-show-cowork-home-'))
    const coworkRoot = join(
      fakeHome,
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions',
      'account-a',
      'workspace-b',
      'local_show',
      '.claude',
    )
    const project = join(coworkRoot, 'projects', '-cowork-show')
    mkdirSync(project, { recursive: true })
    const sessionId = 'cccccccc-0000-4000-8000-000000000003'
    writeFileSync(
      join(project, `${sessionId}.jsonl`),
      new SessionBuilder({ sessionId, startAt: '2026-08-14T10:00:00.000Z' })
        .userPrompt('Inspect this Cowork session.')
        .assistant([{ type: 'text', text: 'Inspected.' }], { usage: { input_tokens: 2, output_tokens: 3 } })
        .toJsonl(),
    )
    const previous = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      ORANGU_CLAUDE_ROOTS: process.env['ORANGU_CLAUDE_ROOTS'],
    }
    process.env['HOME'] = fakeHome
    process.env['USERPROFILE'] = fakeHome
    delete process.env['ORANGU_CLAUDE_ROOTS']
    try {
      await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: sessionId, json: true })
      const id = JSON.parse(stdout()).record.id
      out = []
      await cmdSuggest([], { show: id, json: true })
      const shown = JSON.parse(stdout())
      expect(shown.sessions).toHaveLength(1)
      expect(shown.sessions[0].session.id).toBe(sessionId)
      expect(shown.missingSessionIds).toEqual([])
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('--set walks the state machine and records the proposal path; illegal moves throw', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id
    out = []
    await expect(cmdSuggest(['verified'], { set: id, json: true })).rejects.toThrow(/illegal transition/)
    await cmdSuggest(['kicked-off'], { set: id, json: true })
    out = []
    const proposalPath = join(home, 'proposals', `${id}.md`)
    mkdirSync(join(home, 'proposals'), { recursive: true })
    writeFileSync(proposalPath, '# proposal\n')
    await cmdSuggest(['proposed'], { set: id, proposal: proposalPath, json: true })
    const rec = JSON.parse(stdout())
    expect(rec.status).toBe('proposed')
    expect(rec.proposal.proposalPath).toBe(proposalPath)
  })

  it('--set validates structured proposal, application, and later verification receipts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id as string
    await cmdSuggest(['kicked-off'], { set: id, json: true })
    const proposals = join(home, 'proposals')
    const proposalPath = join(proposals, `${id}.md`)
    const manifestPath = join(proposals, `${id}.json`)
    writeFileSync(proposalPath, '# proposal\n')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        v: 1,
        id,
        title: 'Use a deterministic check script',
        changeClass: 'script-cli',
        change: 'Add scripts/check.mjs and document when to run it.',
        evidence: 'The baseline repeated the same shell pipeline.',
        expectedEffect: 'Fewer repeated calls.',
        effort: 'S',
        risk: 'Flags can drift.',
        files: ['scripts/check.mjs'],
        verification: 'Compare a later session and run unit tests.',
        verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        sources: [{ kind: 'catalog', label: 'catalog: cli-ripgrep' }],
      }),
    )
    out = []
    await cmdSuggest(['proposed'], { set: id, proposal: proposalPath, manifest: manifestPath, json: true })
    expect(JSON.parse(stdout()).proposal).toMatchObject({ v: 1, changeClass: 'script-cli', manifestPath })
    out = []
    await cmdSuggest([], { show: id, 'for-apply': true, json: true })
    expect(JSON.parse(stdout()).workspaceMatchesCurrent).toBe(true)

    await expect(cmdSuggest(['applied'], { set: id, json: true })).rejects.toThrow(/--application/)
    const applicationPath = join(proposals, `${id}.applied.json`)
    writeFileSync(applicationPath, JSON.stringify({ v: 1, id, summary: 'Touched extra files.', files: ['scripts/check.mjs', 'src/unreviewed.ts'], checks: [{ name: 'tests', ok: true }] }))
    await expect(cmdSuggest(['applied'], { set: id, application: applicationPath, json: true })).rejects.toThrow(/exactly match/)
    writeFileSync(applicationPath, JSON.stringify({ v: 1, id, summary: 'Added the script.', files: ['scripts/check.mjs'], checks: [{ name: 'tests', command: 'npm test', ok: true }] }))
    const originalCwd = process.cwd()
    const wrongWorkspace = mkdtempSync(join(tmpdir(), 'orangu-wrong-workspace-'))
    try {
      process.chdir(wrongWorkspace)
      await expect(cmdSuggest([], { show: id, 'for-apply': true, json: true })).rejects.toThrow(/belongs to workspace/)
      await expect(cmdSuggest(['applied'], { set: id, application: applicationPath, json: true })).rejects.toThrow(/belongs to workspace/)
    } finally {
      process.chdir(originalCwd)
    }
    // A restart can renumber the volume: the same directory (path and inode) with a new device still applies,
    // while another directory at that path does not.
    const storePath = join(home, 'suggestions.jsonl')
    const proposedLine = JSON.parse(readFileSync(storePath, 'utf8').trim().split('\n').at(-1)!) as SuggestionRecord
    const rewrite = (workspace: Record<string, string>): void =>
      appendFileSync(storePath, `${JSON.stringify({ ...proposedLine, proposal: { ...proposedLine.proposal, workspace: { ...proposedLine.proposal!.workspace, ...workspace } } })}\n`)
    rewrite({ inode: String(BigInt(proposedLine.proposal!.workspace!.inode) + 1n) })
    await expect(cmdSuggest([], { show: id, 'for-apply': true, json: true })).rejects.toThrow(/belongs to workspace/)
    rewrite({ birthtimeNs: '1' })
    await expect(cmdSuggest([], { show: id, 'for-apply': true, json: true })).rejects.toThrow(/belongs to workspace/)
    rewrite({ device: String(BigInt(proposedLine.proposal!.workspace!.device) + 5n) })
    out = []
    await cmdSuggest([], { show: id, 'for-apply': true, json: true })
    expect(JSON.parse(stdout()).workspaceMatchesCurrent).toBe(true)

    // Orangu picks both cohorts from this workspace, cut at the application (2026-08-15). The apply step freezes the
    // baseline, so its sessions exist before it. The finding's own session is left out of the baseline. Sessions must
    // be quiet for 30 minutes, so the loader of the freeze, and later the clock, move past ctime.
    const project = join(claudeHome, 'projects', '-fixture')
    const writeWorkspaceSession = (sessionId: string, startAt: string, toolCalls: number, mtime?: string): string => {
      const b = new SessionBuilder({ sessionId, startAt, cwd: process.cwd() }).userPrompt('Work.')
      for (let i = 0; i < toolCalls; i++) b.toolCall('Read', { file_path: `src/f${i}.ts` }, 'ok')
      b.assistant([{ type: 'text', text: 'Done.' }], { usage: { input_tokens: 1, output_tokens: 1 } })
      const path = join(project, `${sessionId}.jsonl`)
      writeFileSync(path, b.toJsonl())
      if (mtime) utimesSync(path, new Date(mtime), new Date(mtime))
      return path
    }
    writeWorkspaceSession('dddddddd-0000-4000-8000-000000000011', '2026-08-10T10:00:00.000Z', 6, '2026-08-10T12:00:00.000Z')
    writeWorkspaceSession('dddddddd-0000-4000-8000-000000000012', '2026-08-11T10:00:00.000Z', 7, '2026-08-11T12:00:00.000Z')
    writeWorkspaceSession('dddddddd-0000-4000-8000-000000000013', '2026-08-12T10:00:00.000Z', 8, '2026-08-12T12:00:00.000Z')

    out = []
    await cmdSuggest(['applied'], { set: id, application: applicationPath, json: true }, QUIET_LOADER)
    expect(JSON.parse(stdout()).application).toMatchObject({ v: 1, summary: 'Added the script.', receiptPath: applicationPath })
    expect(JSON.parse(stdout()).frozenBaseline.sessions.map((s: { id: string }) => s.id)).toEqual([
      'dddddddd-0000-4000-8000-000000000011',
      'dddddddd-0000-4000-8000-000000000012',
      'dddddddd-0000-4000-8000-000000000013',
    ])
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))

    out = []
    await cmdSuggest([], { effect: id, json: true })
    const early = JSON.parse(stdout())
    expect(early).toMatchObject({ id, verdict: 'not-enough-sessions', baseline: { n: 3 }, later: { n: 1 } })
    expect(early.skipped['evidence-session']).toBe(1)
    expect(early.next).toMatch(/needs at least 3 settled sessions on each side \(has 3 before, 1 after\)/)
    await expect(cmdSuggest(['verified'], { set: id, json: true })).rejects.toThrow(/not verified: not-enough-sessions/)

    writeWorkspaceSession('dddddddd-0000-4000-8000-000000000021', '2026-08-17T10:00:00.000Z', 1)
    writeWorkspaceSession('dddddddd-0000-4000-8000-000000000022', '2026-08-18T10:00:00.000Z', 0)

    const verificationPath = join(proposals, `${id}.verified.json`)
    writeFileSync(
      verificationPath,
      JSON.stringify({
        v: 1,
        id,
        measuredSessionIds: ['bbbbbbbb-0000-4000-8000-000000000002'],
        checks: [{ name: 'claimed improvement', metric: 'avgToolCalls', comparison: 'decreased', before: 999, after: 0, ok: true }],
        before: { avgToolCalls: 999 },
        after: { avgToolCalls: 0 },
      }),
    )
    await expect(cmdSuggest(['verified'], { set: id, verification: verificationPath, json: true })).rejects.toThrow(/must be omitted|must omit/)
    const fabricatedPath = join(proposals, 'cccccccc-0000-4000-8000-000000000003.jsonl')
    writeFileSync(fabricatedPath, '{}\n')
    writeFileSync(
      verificationPath,
      JSON.stringify({ v: 1, id, measuredSessionIds: [fabricatedPath], checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }] }),
    )
    await expect(cmdSuggest(['verified'], { set: id, verification: verificationPath, json: true })).rejects.toThrow(
      /names .*cccccccc-0000-4000-8000-000000000003\.jsonl, which is not in the later cohort orangu measured/,
    )

    out = []
    await cmdSuggest([], { effect: id })
    expect(stdout()).toMatch(/avgToolCalls: 7 → 0\.333333 \(median 7 → 0; exact rank test p=0\.05; improved\)/)
    expect(stdout()).toMatch(/verdict: verified/)
    const listed = readFileSync(join(home, 'suggestions.jsonl'), 'utf8')

    // The compatibility intent may name later sessions, but only ones inside the cohort; it chooses nothing.
    writeFileSync(
      verificationPath,
      JSON.stringify({ v: 1, id, measuredSessionIds: [laterFixturePath], checks: [{ metric: 'avgToolCalls', comparison: 'decreased' }] }),
    )
    expect(readFileSync(join(home, 'suggestions.jsonl'), 'utf8')).toBe(listed) // --effect wrote nothing
    out = []
    await cmdSuggest(['verified'], { set: id, verification: verificationPath, json: true })
    const verified = JSON.parse(stdout())
    expect(verified.status).toBe('verified')
    expect(verified.verificationReceipt).toMatchObject({
      v: 2,
      baselineSessionIds: ['dddddddd-0000-4000-8000-000000000011', 'dddddddd-0000-4000-8000-000000000012', 'dddddddd-0000-4000-8000-000000000013'],
      measuredSessionIds: ['bbbbbbbb-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000021', 'dddddddd-0000-4000-8000-000000000022'],
    })
    expect(verified.verificationReceipt.checks[0]).toMatchObject({ metric: 'avgToolCalls', before: 7, after: 0.333333, verdict: 'improved', ok: true })
    out = []
    await cmdSuggest([], { show: id, json: true })
    expect(JSON.parse(stdout()).verificationTrusted).toBe(true)
  })

  it('--effect prints every verdict short of verified with its next step, and --set verified refuses each', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    const proposals = join(home, 'proposals')
    const project = join(claudeHome, 'projects', '-fixture')
    const appliedWith = async (ruleId: string, metric: string, comparison: string, storedByOlderOrangu = false): Promise<string> => {
      out = []
      await cmdSuggest([], { rule: ruleId, scope: 'session', session: fixturePath, json: true })
      const id = JSON.parse(stdout()).record.id as string
      await cmdSuggest(['kicked-off'], { set: id, json: true })
      writeFileSync(join(proposals, `${id}.md`), '# proposal\n')
      const writeManifest = (checkComparison: string): void => writeFileSync(
        join(proposals, `${id}.json`),
        JSON.stringify({
          v: 1, id, title: 'Reviewed change', changeClass: 'instruction', change: 'One line in CLAUDE.md.', evidence: 'Repeated reads.',
          expectedEffect: 'Named outcome.', effort: 'S', risk: 'None known.', files: ['CLAUDE.md'], verification: 'Compare later sessions.',
          verificationChecks: [{ metric, comparison: checkComparison }], sources: [{ kind: 'inference', label: 'Smallest change consistent with the evidence' }],
        }),
      )
      const propose = () => cmdSuggest(['proposed'], { set: id, proposal: join(proposals, `${id}.md`), manifest: join(proposals, `${id}.json`), json: true })
      writeManifest(comparison)
      if (storedByOlderOrangu) {
        // A new manifest needs a decreased or increased check, so only a record that an older orangu stored has a guard-only set.
        const storePath = join(home, 'suggestions.jsonl')
        const before = readFileSync(storePath)
        await expect(propose()).rejects.toThrow(/verificationChecks must include a decreased or increased check/)
        expect(readFileSync(storePath)).toEqual(before)
        writeManifest('decreased')
        await propose()
        const proposed = JSON.parse(readFileSync(storePath, 'utf8').trimEnd().split('\n').at(-1)!) as SuggestionRecord
        appendFileSync(storePath, `${JSON.stringify({ ...proposed, proposal: { ...proposed.proposal, verificationChecks: [{ metric, comparison }] } })}\n`)
      } else {
        await propose()
      }
      writeFileSync(join(proposals, `${id}.applied.json`), JSON.stringify({ v: 1, id, summary: 'Added the line.', files: ['CLAUDE.md'], checks: [{ name: 'diff check', ok: true }] }))
      await cmdSuggest(['applied'], { set: id, application: join(proposals, `${id}.applied.json`), json: true }, QUIET_LOADER)
      return id
    }
    const session = (sessionId: string, startAt: string, toolCalls: number, mtime?: string): void => {
      const b = new SessionBuilder({ sessionId, startAt, cwd: process.cwd() }).userPrompt('Work.')
      for (let i = 0; i < toolCalls; i++) b.toolCall('Read', { file_path: `src/f${i}.ts` }, 'ok')
      b.assistant([{ type: 'text', text: 'Done.' }], { usage: { input_tokens: 1, output_tokens: 1 } })
      const path = join(project, `${sessionId}.jsonl`)
      writeFileSync(path, b.toJsonl())
      if (mtime) utimesSync(path, new Date(mtime), new Date(mtime))
    }
    // Three sessions before the change (6, 7, 8 tool calls), settled before the apply step freezes them, and three
    // after it (0, 1, 0).
    session('eeeeeeee-0000-4000-8000-000000000011', '2026-08-10T10:00:00.000Z', 6, '2026-08-10T12:00:00.000Z')
    session('eeeeeeee-0000-4000-8000-000000000012', '2026-08-11T10:00:00.000Z', 7, '2026-08-11T12:00:00.000Z')
    session('eeeeeeee-0000-4000-8000-000000000013', '2026-08-12T10:00:00.000Z', 8, '2026-08-12T12:00:00.000Z')
    const regressed = await appliedWith('verdict-regressed', 'avgToolCalls', 'increased')
    const guardsOnly = await appliedWith('verdict-guards-only', 'avgToolCalls', 'not-increased', true)
    const withinNoise = await appliedWith('verdict-within-noise', 'avgTestRunsFailed', 'decreased')

    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    session('eeeeeeee-0000-4000-8000-000000000021', '2026-08-17T10:00:00.000Z', 1)
    session('eeeeeeee-0000-4000-8000-000000000022', '2026-08-18T10:00:00.000Z', 0)

    // 3 later sessions reach the first checkpoint only, so no verdict short of verified is final yet.
    const firstNotFinal = 'That is not final. Orangu grades again when the later cohort is complete (3 of 10 so far)'
    const expected: Array<[string, string, RegExp, string]> = [
      [
        regressed, 'regressed', /avgToolCalls: 7 → 0\.333333 \(median 7 → 0; exact rank test p=1; regressed\)/,
        `next: the first checkpoint (the first 3 later sessions) leans worse: a check moved the wrong way beyond chance. ${firstNotFinal}`,
      ],
      [
        guardsOnly, 'no-directional-check', /avgToolCalls: 7 → 0\.333333 \(median 7 → 0; exact rank test p=1; held\)/,
        `next: the first checkpoint (the first 3 later sessions) did not beat the baseline beyond chance. ${firstNotFinal}`,
      ],
      [
        withinNoise, 'within-noise', /avgTestRunsFailed: 0 → 0 \(median 0 → 0; exact rank test p=1; within-noise\)/,
        `next: the first checkpoint (the first 3 later sessions) did not beat the baseline beyond chance. ${firstNotFinal}`,
      ],
    ]
    for (const [id, verdict, evidence, next] of expected) {
      out = []
      await cmdSuggest([], { effect: id })
      const text = stdout()
      expect(text, verdict).toContain('3 before, 3 after the change')
      expect(text, verdict).toMatch(evidence)
      expect(text, verdict).toContain(`verdict: ${verdict}`)
      expect(text, verdict).toContain(next)
      // The three changes were applied together, so each names the other two.
      expect(text, verdict).toMatch(/measured together with: sg_[0-9a-f]{12}, sg_[0-9a-f]{12} \(not attributable to this change alone\)/)
      await expect(cmdSuggest(['verified'], { set: id, json: true })).rejects.toThrow(new RegExp(`not verified: ${verdict};`))
      out = []
      await cmdSuggest([], { show: id, json: true })
      expect(JSON.parse(stdout()).record.status, verdict).toBe('applied')
    }
  })

  it('--effect refuses global scope, which can never be applied or verified', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    await cmdSuggest([], { rule: 'reread-files', scope: 'global', session: fixturePath, json: true })
    const globalId = JSON.parse(stdout()).record.id as string
    out = []
    await expect(cmdSuggest([], { effect: globalId, json: true })).rejects.toThrow(/global suggestions are review-only/)
    await expect(cmdSuggest(['verified'], { set: globalId, json: true })).rejects.toThrow(/illegal transition new → verified/)
  })

  it('--list filters by scope', async () => {
    await cmdSuggest([], { rule: 'r1', scope: 'session', session: fixturePath, json: true })
    await cmdSuggest([], { rule: 'r2', scope: 'global', session: fixturePath, cohort: '1111111111111111', json: true })
    out = []
    await cmdSuggest([], { list: true, scope: 'global', json: true })
    const rows = JSON.parse(stdout())
    expect(rows).toHaveLength(1)
    expect(rows[0].ruleId).toBe('r2')
  })

  it('legacy file-command flags still recreate their explicit v1 id', async () => {
    // A pre-v2 copied command still maps `/orangu:improve <args>` 1:1 onto `orangu suggest <args>`.
    const rec = { id: suggestionId('report', 'reread-files', [fixturePath]), ruleId: 'reread-files', scope: 'session' as const, sessionIds: [fixturePath] }
    const cmd = kickoffCommand(rec, 'file')
    const inner = /^claude "\/orangu:improve (.+)"$/.exec(cmd)?.[1]
    expect(inner, `kickoff command shape: ${cmd}`).toBeTruthy()
    // the skill maps `/orangu:improve <args>` 1:1 onto `orangu suggest <args>`
    const { command, positionals, flags } = parseArgs(['suggest', ...inner!.split(' ')])
    expect(command).toBe('suggest')
    await cmdSuggest(positionals, { ...flags, json: true })
    const res = JSON.parse(stdout())
    expect(res.record.id).toBe(rec.id)
    expect(res.record.source).toBe('report')
    expect(res.record.v).toBe(1)
    expect(res.record.status).toBe('new')
    expect(res.created).toBe(true)
    // one record, not two: a re-run of the same command is a get
    out = []
    await cmdSuggest(positionals, { ...flags, json: true })
    expect(JSON.parse(stdout()).created).toBe(false)
  })

  it('v2 file handoff recreates the same id with exact title, insight, and evidence', async () => {
    const finding: Finding = {
      ruleId: 'reread-files',
      title: 'The exact report title',
      scope: 'session',
      sessionIds: [fixturePath],
      insightId: 'insight-42',
      evidence: { estimated: false, savingsTokens: 777, turnIndexes: [2, 5], detail: 'preserved' },
    }
    const id = suggestionIdV2(suggestionKey(finding, 'report'))
    const rec: SuggestionRecord = {
      id,
      v: 2,
      key: suggestionKey(finding, 'report'),
      createdAt: 0,
      source: 'report',
      ...finding,
      status: 'new',
      statusAt: 0,
    }
    const commandText = kickoffCommand(rec, 'file')
    const inner = /^claude "\/orangu:improve (.+)"$/.exec(commandText)?.[1]
    expect(inner).toContain('--finding ')
    const parsed = parseArgs(['suggest', ...inner!.split(' ')])
    await cmdSuggest(parsed.positionals, { ...parsed.flags, json: true })
    const result = JSON.parse(stdout())
    expect(result.record).toMatchObject({ id, v: 2, title: finding.title, insightId: finding.insightId, evidence: finding.evidence })
    expect(result.record.source).toBe('report')
  })

  it('rejects a v2 token paired with a different positional id', async () => {
    const finding: Finding = { ruleId: 'r', title: 't', scope: 'session', sessionIds: [fixturePath], evidence: { estimated: true } }
    const rec: SuggestionRecord = {
      id: suggestionIdV2(suggestionKey(finding, 'report')),
      v: 2,
      key: suggestionKey(finding, 'report'),
      createdAt: 0,
      source: 'report',
      ...finding,
      status: 'new',
      statusAt: 0,
    }
    const token = /--finding ([A-Za-z0-9_-]+)/.exec(kickoffCommand(rec, 'file'))![1]!
    await expect(cmdSuggest(['sg_0123456789ab'], { finding: token, json: true })).rejects.toThrow(/mismatch/)
  })

  it('rejects a positional id that is not an sg_ id', async () => {
    await expect(cmdSuggest(['not-an-id'], { rule: 'r', scope: 'session', session: fixturePath, json: true })).rejects.toThrow(/sg_/)
  })

  it('rejects a syntactically valid explicit id that does not hash to the legacy report finding', async () => {
    await expect(cmdSuggest(['sg_0123456789ab'], { rule: 'r', scope: 'session', session: fixturePath, json: true })).rejects.toThrow(/identity mismatch/)
    expect(() => readFileSync(join(home, 'suggestions.jsonl'), 'utf8')).toThrow()
  })

  it('rejects a bad scope and a missing rule', async () => {
    await expect(cmdSuggest([], { rule: 'x', scope: 'universe', session: 'a' })).rejects.toThrow(/--scope/)
    await expect(cmdSuggest([], { scope: 'session', session: 'a' })).rejects.toThrow(/usage/)
  })
})

describe('orangu suggest --list record lines', () => {
  const base = { id: 'sg_0123456789ab', v: 2, ruleId: 'reread-files', scope: 'session', sessionIds: ['aaaaaaaa-0000-4000-8000-000000000001'], status: 'new', statusAt: 0, source: 'report' }
  const title = '3 files re-read within one context (12 redundant reads, 3.92M tokens) in the same \x1b]52;c;SGVsbG8=\x07long \x1b[2Jsession'
  const rec = { ...base, title } as unknown as SuggestionRecord
  /** the 26 columns before the title: 2 spaces, the id, 2 spaces, [new], 2 spaces */
  const COLUMN = 26

  it('wraps the title under itself at whole words, inside the line measure, with nothing cut', () => {
    for (const width of [40, 60, 80]) {
      const lines = recordLines(rec, width)
      const rule = lines.findIndex((l) => l.startsWith('    rule '))
      const titleLines = lines.slice(0, rule)
      expect(titleLines[0], String(width)).toMatch(/^ {2}sg_0123456789ab {2}\[new\] {2}3 files/)
      for (const l of titleLines.slice(1)) expect(l, String(width)).toMatch(/^ {26}\S/)
      for (const l of titleLines) expect(displayWidth(l), `${width}: ${l}`).toBeLessThanOrEqual(Math.max(width, COLUMN + 20))
      expect(titleLines.map((l) => l.slice(COLUMN)).join(' '), String(width)).toBe('3 files re-read within one context (12 redundant reads, 3.92M tokens) in the same long session')
      expect(lines[rule]).toBe('    rule reread-files · scope session · sessions aaaaaaaa')
    }
  })

  it('strips terminal escapes from a stored title before it prints', () => {
    for (const l of recordLines(rec, 80)) expect(l).not.toMatch(/[\x1b\x07\x80-\x9f]/)
  })
})

// The verdict steps and the other writes, with injected cohort deps. The fakes copy src/suggest/cohort.test.ts.

/** The application time of each record below: the fake clock of each test, and the cut of each cohort. */
const T = Date.parse('2026-08-15T00:00:00.000Z')
/** The canonical workspace that the fake cohort deps give for every reviewed workspace. */
const WORKSPACE = '/w'
const MiB = 1024 * 1024
const DECREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'decreased' }
const NOT_INCREASED: SuggestionVerificationIntent = { metric: 'avgToolCalls', comparison: 'not-increased' }
/** A fake session id, with a prefix that no fixture transcript of this file uses. */
const sid = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index)

interface FakeSession {
  id: string
  startedAt: number
  endedAt: number
  toolCalls: number
  bytes?: number
  skip?: 'still-settling' | 'unreadable' | 'over-budget'
}

function metricsOf(toolCalls: number): Record<SuggestionVerificationMetric, number> {
  return { avgTotalTokens: 100, avgToolCalls: toolCalls, avgToolErrors: 0, avgActiveMs: 1_000, avgContextPeak: 10, avgTestRunsFailed: 0, avgBuildRunsFailed: 0, avgInterruptions: 0 }
}

/** Baseline sessions that end before T, 1 for each tool-call value. */
const baselineOf = (values: number[]): FakeSession[] =>
  values.map((toolCalls, index) => ({ id: sid(index), startedAt: T - 50_000 + index * 1_000, endedAt: T - 40_000 + index * 1_000, toolCalls }))

/** Later sessions in start order, 1 for each tool-call value. */
const laterOf = (values: number[]): FakeSession[] =>
  values.map((toolCalls, index) => ({ id: sid(100 + index), startedAt: T + 1_000 + index * 1_000, endedAt: T + 2_000 + index * 1_000, toolCalls }))

/** What a freeze at T stores for baselineOf(values). */
function frozenOf(values: number[]): SuggestionFrozenBaseline {
  return {
    v: 1,
    cutAt: T,
    sessions: baselineOf(values).map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, metrics: metricsOf(s.toolCalls) })),
    skipped: Object.fromEntries(COHORT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CohortSkipReason, number>,
  }
}

/** Cohort deps over a fixed list of sessions in WORKSPACE, with each call counted. */
function fakeCohort(sessions: FakeSession[], over: Partial<FreezeDeps> = {}): FreezeDeps & { calls: { list: number; workspace: number; load: string[] } } {
  const calls = { list: 0, workspace: 0, load: [] as string[] }
  return {
    calls,
    async listCandidates(cwd: string): Promise<CohortCandidate[]> {
      calls.list++
      expect(cwd).toBe(WORKSPACE)
      return sessions.map((s) => ({ sessionId: s.id, path: `/projects/-w/${s.id}.jsonl`, mtimeMs: s.endedAt }))
    },
    async loadCandidate(candidate: CohortCandidate, maxBytes: number) {
      calls.load.push(candidate.sessionId)
      const s = sessions.find((x) => x.id === candidate.sessionId)!
      const bytesRead = s.bytes ?? 1_000
      if (s.skip) return { skip: s.skip, bytesRead }
      if (bytesRead > maxBytes) return { skip: 'over-budget' as const, bytesRead: 0 }
      return {
        session: { id: s.id, path: candidate.path, cwd: WORKSPACE, ranOrangu: false, startedAt: s.startedAt, endedAt: s.endedAt, metrics: metricsOf(s.toolCalls) },
        bytesRead,
      }
    },
    async canonicalWorkspace() {
      calls.workspace++
      return WORKSPACE
    },
    ...over,
  }
}

const NO_CALLS = { list: 0, workspace: 0, load: [] }
const storePath = (): string => join(home, 'suggestions.jsonl')
const lastLine = (): Record<string, unknown> => JSON.parse(readFileSync(storePath(), 'utf8').trimEnd().split('\n').at(-1)!) as Record<string, unknown>

/** The call exits 1 with this message, and the store file keeps every byte. */
async function refusedUnchanged(call: () => Promise<void>, message: RegExp | string): Promise<void> {
  const before = readFileSync(storePath())
  await expect(call()).rejects.toThrow(message)
  expect(readFileSync(storePath())).toEqual(before)
}

/** An applied record that the store wrote at T: with this frozen baseline, or with none, as an older orangu wrote it. */
async function seedApplied(ruleId: string, frozen: number[] | undefined, intent: SuggestionVerificationIntent = DECREASED): Promise<string> {
  const store = new SuggestionStore({ home, now: () => T })
  const { record } = await store.upsertNew({ ruleId, title: 't', scope: 'session', sessionIds: [sid(900)], evidence: { estimated: true } }, 'report')
  await store.transition(record.id, 'kicked-off')
  await store.transition(record.id, 'proposed', {
    proposal: {
      v: 1, title: 'Reviewed change', change: 'Change one file.', effort: 'S', files: ['src/a.ts'], proposalPath: '/p/a.md', manifestPath: '/p/a.json',
      changeClass: 'instruction', evidence: 'e', expectedEffect: 'x', risk: 'r', verification: 'v', verificationChecks: [intent],
      workspace: { cwd: WORKSPACE, device: '1', inode: '2' },
    },
  })
  await store.transition(record.id, 'applied', {
    application: { v: 1, summary: 's', files: ['src/a.ts'], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.applied.json' },
    ...(frozen ? { frozenBaseline: frozenOf(frozen) } : {}),
  })
  return record.id
}

/** A record that the CLI moves to applied from this workspace, with these cohort deps and flags at the apply step. */
async function appliedThroughCli(
  ruleId: string,
  deps: FreezeDeps,
  intent: SuggestionVerificationIntent = DECREASED,
  applyFlags: Record<string, string | boolean> = {},
): Promise<string> {
  const proposals = join(home, 'proposals')
  out = []
  await cmdSuggest([], { rule: ruleId, scope: 'session', session: fixturePath, json: true })
  const id = JSON.parse(stdout()).record.id as string
  await cmdSuggest(['kicked-off'], { set: id, json: true })
  writeFileSync(join(proposals, `${id}.md`), '# proposal\n')
  writeFileSync(
    join(proposals, `${id}.json`),
    JSON.stringify({
      v: 1, id, title: 'Reviewed change', changeClass: 'instruction', change: 'One line in CLAUDE.md.', evidence: 'Repeated reads.',
      expectedEffect: 'Named outcome.', effort: 'S', risk: 'None known.', files: ['CLAUDE.md'], verification: 'Compare later sessions.',
      verificationChecks: [intent], sources: [{ kind: 'inference', label: 'Smallest change consistent with the evidence' }],
    }),
  )
  await cmdSuggest(['proposed'], { set: id, proposal: join(proposals, `${id}.md`), manifest: join(proposals, `${id}.json`), json: true })
  writeFileSync(join(proposals, `${id}.applied.json`), JSON.stringify({ v: 1, id, summary: 'Added the line.', files: ['CLAUDE.md'], checks: [{ name: 'diff check', ok: true }] }))
  out = []
  await cmdSuggest(['applied'], { set: id, application: join(proposals, `${id}.applied.json`), json: true, ...applyFlags }, { cohort: deps })
  return id
}

function captureStderr(): string[] {
  const err: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
  return err
}

describe('orangu suggest --record and --set verified: the 9 rows of the verdict table', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })

  interface Row {
    row: string
    frozen?: number[]
    live?: number[]
    later: FakeSession[]
    intent?: SuggestionVerificationIntent
    checkpoint: 'first' | 'complete' | null
    verdict: CohortEffect['verdict']
    final: boolean
    leaning?: 'worse'
    /** the later sessions so far */
    count: number
    /** what --set verified gives: the status, or the refusal */
    set: 'verified' | RegExp
    /** what --record gives: the status, or the refusal for this id */
    record: 'regressed' | 'unproven' | ((id: string) => RegExp)
  }
  const notFinal = (): RegExp => /^not final: /
  const toVerified = (id: string): RegExp => new RegExp(`^record it as verified: orangu suggest --set ${id} verified$`)
  const rejectOther = (id: string): RegExp =>
    new RegExp(`^not final: not-enough-sessions\\. needs at least 3 settled sessions on each side \\(has 2 before, 3 after\\)\\. .* orangu suggest --set ${id} rejected --reason other$`)
  /** 2 sessions of 64 MiB fill half the later budget, 2 unreadable ones of 64 MiB spend the rest, and a fifth is never read. */
  const budgetAtTwo: FakeSession[] = laterOf([4, 5, 0, 0, 4]).map((s, index) =>
    index < 2 ? { ...s, bytes: 64 * MiB } : index < 4 ? { ...s, bytes: 64 * MiB, skip: 'unreadable' as const } : s,
  )
  const settled10 = [6, 5, 7, 6, 5, 7, 6, 5, 7, 6]

  const rows: Row[] = [
    { row: '1 none yet', frozen: [20, 21, 22], later: laterOf([1, 2]), checkpoint: null, verdict: 'not-enough-sessions', final: false, count: 2, set: /^not verified: not-enough-sessions;/, record: notFinal },
    { row: '2 first, verified', frozen: [20, 21, 22], later: laterOf([1, 2, 3]), checkpoint: 'first', verdict: 'verified', final: true, count: 3, set: 'verified', record: toVerified },
    { row: '3 first, regressed', frozen: [1, 2, 3], later: laterOf([20, 21, 22, 23]), checkpoint: 'first', verdict: 'regressed', final: false, leaning: 'worse', count: 4, set: /^not verified: regressed;/, record: notFinal },
    { row: '4 first, within noise', frozen: [5, 6, 7], later: laterOf([6, 5, 7]), checkpoint: 'first', verdict: 'within-noise', final: false, count: 3, set: /^not verified: within-noise;/, record: notFinal },
    { row: '4 first, no directional check', frozen: [5, 6, 7], later: laterOf([6, 5, 7]), intent: NOT_INCREASED, checkpoint: 'first', verdict: 'no-directional-check', final: false, count: 3, set: /^not verified: no-directional-check;/, record: notFinal },
    { row: '5 complete, verified', frozen: range(20, 10), later: laterOf(range(0, 10)), checkpoint: 'complete', verdict: 'verified', final: true, count: 10, set: 'verified', record: toVerified },
    { row: '6 complete, regressed', frozen: [1, 2, 3], later: laterOf(range(20, 10)), checkpoint: 'complete', verdict: 'regressed', final: true, count: 10, set: /^not verified: regressed;/, record: 'regressed' },
    { row: '7 complete, within noise', frozen: [5, 6, 7], later: laterOf(settled10), checkpoint: 'complete', verdict: 'within-noise', final: true, count: 10, set: /^not verified: within-noise;/, record: 'unproven' },
    { row: '7 complete, no directional check', frozen: [5, 6, 7], later: laterOf(settled10), intent: NOT_INCREASED, checkpoint: 'complete', verdict: 'no-directional-check', final: true, count: 10, set: /^not verified: no-directional-check;/, record: 'unproven' },
    { row: '7 complete, not enough sessions: the byte budget is spent at 2', frozen: [5, 6, 7], later: budgetAtTwo, checkpoint: 'complete', verdict: 'not-enough-sessions', final: true, count: 2, set: /^not verified: not-enough-sessions;/, record: 'unproven' },
    { row: '8 a frozen baseline below 3, no later session', frozen: [5, 6], later: [], checkpoint: null, verdict: 'not-enough-sessions', final: true, count: 0, set: /^not verified: not-enough-sessions;/, record: 'unproven' },
    { row: '8 a frozen baseline below 3, 5 later sessions', frozen: [5, 6], later: laterOf([4, 5, 6, 7, 8]), checkpoint: 'first', verdict: 'not-enough-sessions', final: true, count: 5, set: /^not verified: not-enough-sessions;/, record: 'unproven' },
    { row: '8 a frozen baseline of 0 sessions', frozen: [], later: laterOf([4]), checkpoint: null, verdict: 'not-enough-sessions', final: true, count: 1, set: /^not verified: not-enough-sessions;/, record: 'unproven' },
    { row: '9 an older record with a live baseline below 3', live: [5, 6], later: laterOf([4, 5, 6]), checkpoint: 'first', verdict: 'not-enough-sessions', final: false, count: 3, set: /^not verified: not-enough-sessions;/, record: rejectOther },
  ]

  it.each(rows)('row $row', async (row) => {
    const id = await seedApplied('verdict-row', row.frozen, row.intent ?? DECREASED)
    const deps = fakeCohort([...baselineOf(row.live ?? []), ...row.later])
    out = []
    await cmdSuggest([], { effect: id, json: true }, { cohort: deps })
    const view = JSON.parse(stdout())
    expect(view).toMatchObject({ id, verdict: row.verdict, checkpoint: row.checkpoint, final: row.final, later: { count: row.count } })
    expect(Object.keys(view).includes('leaning'), 'leaning is a key only when the first verdict leans worse').toBe(row.leaning !== undefined)
    expect(view.leaning).toBe(row.leaning)

    // Each refusal first: an exit 1 leaves every byte of the store.
    if (row.set instanceof RegExp) await refusedUnchanged(() => cmdSuggest(['verified'], { set: id, json: true }, { cohort: deps }), row.set)
    if (typeof row.record === 'function') await refusedUnchanged(() => cmdSuggest([], { record: id, json: true }, { cohort: deps }), row.record(id))
    if (row.set === 'verified') {
      out = []
      await cmdSuggest(['verified'], { set: id, json: true }, { cohort: deps })
      expect(JSON.parse(stdout()).status).toBe('verified')
      expect(lastLine()).toMatchObject({ id, status: 'verified', verificationTrust: 'computed-v2' })
    }
    if (row.record === 'regressed' || row.record === 'unproven') {
      out = []
      await cmdSuggest([], { record: id, json: true }, { cohort: deps })
      const written = JSON.parse(stdout())
      expect(written.status).toBe(row.record)
      expect(written.outcomeReceipt).toMatchObject({
        verdict: row.verdict,
        checkpoint: row.checkpoint === 'complete' ? 'complete' : 'first',
        laterComplete: row.checkpoint === 'complete',
      })
      expect(lastLine()).toMatchObject({ id, status: row.record, outcomeReceipt: written.outcomeReceipt })
      expect(JSON.stringify(lastLine())).not.toContain('leaning')
    }
  })
})

describe('orangu suggest --set verified grades at the 2 checkpoints only', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })

  it('5 later sessions whose first 3 verify: the receipt names those 3 sessions', async () => {
    const id = await seedApplied('first-verified', [20, 21, 22])
    out = []
    await cmdSuggest(['verified'], { set: id, json: true }, { cohort: fakeCohort(laterOf([1, 2, 3, 4, 5])) })
    expect(JSON.parse(stdout()).verificationReceipt.measuredSessionIds).toEqual([sid(100), sid(101), sid(102)])
  })

  it('5 later sessions, the first 3 within noise and the next 2 much lower: the first verdict stays, and --set verified exits 1', async () => {
    const id = await seedApplied('first-within-noise', [5, 6, 7])
    const deps = fakeCohort(laterOf([6, 5, 7, 0, 0]))
    out = []
    await cmdSuggest([], { effect: id, json: true }, { cohort: deps })
    expect(JSON.parse(stdout())).toMatchObject({ verdict: 'within-noise', checkpoint: 'first', final: false, later: { n: 3, count: 5, complete: false } })
    await refusedUnchanged(() => cmdSuggest(['verified'], { set: id, json: true }, { cohort: deps }), /^not verified: within-noise;/)
  })

  it('10 later sessions: the complete verdict decides, also when the first verdict was verified', async () => {
    const id = await seedApplied('complete-decides', [5, 6, 7])
    out = []
    await cmdSuggest([], { effect: id, json: true }, { cohort: fakeCohort(laterOf([0, 0, 0])) })
    expect(JSON.parse(stdout())).toMatchObject({ verdict: 'verified', checkpoint: 'first', final: true })
    const complete = fakeCohort(laterOf([0, 0, 0, 9, 9, 9, 9, 9, 9, 9]))
    out = []
    await cmdSuggest([], { effect: id, json: true }, { cohort: complete })
    expect(JSON.parse(stdout())).toMatchObject({ verdict: 'within-noise', checkpoint: 'complete', final: true, later: { n: 10, count: 10, complete: true } })
    await refusedUnchanged(() => cmdSuggest(['verified'], { set: id, json: true }, { cohort: complete }), /^not verified: within-noise;/)
    out = []
    await cmdSuggest([], { record: id, json: true }, { cohort: complete })
    expect(JSON.parse(stdout())).toMatchObject({ status: 'unproven', outcomeReceipt: { verdict: 'within-noise', checkpoint: 'complete' } })
  })
})

describe('orangu suggest --set applied freezes the baseline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })

  it('stores the frozen baseline, and --effect gives the same baseline numbers once every baseline transcript is gone', async () => {
    const baseline = baselineOf([20, 21, 22])
    const later = laterOf([1, 2, 3])
    const id = await appliedThroughCli('freeze-stored', fakeCohort([...baseline, ...later]))
    // The JSON output says that the baseline froze. The key is output only, and the stored line does not have it.
    expect(JSON.parse(stdout())).toMatchObject({ id, status: 'applied', baselineFreeze: { frozen: true } })
    expect(JSON.parse(stdout()).baselineFreeze).toEqual({ frozen: true })
    const applied = lastLine() as unknown as SuggestionRecord
    expect(applied).toMatchObject({ id, status: 'applied', appliedAt: T })
    expect(applied.frozenBaseline).toEqual(frozenOf([20, 21, 22]))
    expect('baselineFreeze' in applied).toBe(false)

    out = []
    await cmdSuggest([], { effect: id, json: true }, { cohort: fakeCohort([...baseline, ...later]) })
    const withTranscripts = JSON.parse(stdout())
    const gone = fakeCohort(later)
    out = []
    await cmdSuggest([], { effect: id, json: true }, { cohort: gone })
    const withoutTranscripts = JSON.parse(stdout())
    expect(withoutTranscripts.baseline).toEqual({ n: 3, ids: [sid(0), sid(1), sid(2)] })
    expect(withoutTranscripts.baseline).toEqual(withTranscripts.baseline)
    expect(withoutTranscripts.checks).toEqual(withTranscripts.checks)
    expect(withoutTranscripts.checks[0]).toMatchObject({ before: 21, after: 2 })
    // The frozen baseline is read from the store: only the later transcripts are loaded.
    expect(gone.calls.load).toEqual(later.map((s) => s.id))
  })

  it('writes the move with no frozen baseline and prints 1 stderr line when the baseline read fails', async () => {
    const err = captureStderr()
    const failing = fakeCohort([], {
      async listCandidates() {
        throw new Error('discovery failed')
      },
    })
    const id = await appliedThroughCli('freeze-failed', failing)
    expect(JSON.parse(stdout())).toMatchObject({ id, status: 'applied', baselineFreeze: { frozen: false, reason: 'discovery failed' } })
    const applied = lastLine()
    expect(applied).toMatchObject({ id, status: 'applied' })
    expect('frozenBaseline' in applied).toBe(false)
    expect('baselineFreeze' in applied).toBe(false)
    expect(err.join('').split('\n').filter(Boolean)).toHaveLength(1)
    expect(err.join('')).toMatch(/^ {2}orangu did not freeze the baseline \(discovery failed\)\. /)
  })

  it('writes the move with no frozen baseline when the store refuses the frozen one, and prints 1 stderr line', async () => {
    // A wall clock that steps back between the freeze and the move gives a cut after the application time.
    const err = captureStderr()
    const id = await appliedThroughCli('freeze-refused', fakeCohort(baselineOf([20, 21, 22]), { now: () => T + 60_000 }))
    const output = JSON.parse(stdout())
    expect(output).toMatchObject({ id, status: 'applied', baselineFreeze: { frozen: false } })
    expect(output.baselineFreeze.reason).toContain('cutAt must not be later than the application time')
    const applied = lastLine()
    expect(applied).toMatchObject({ id, status: 'applied', appliedAt: T })
    expect('frozenBaseline' in applied).toBe(false)
    expect(err.join('').split('\n').filter(Boolean)).toHaveLength(1)
    expect(err.join('')).toContain('cutAt must not be later than the application time')
  })

  it('--quiet silences the stderr line of each freeze failure, and the JSON still says why the baseline did not freeze', async () => {
    const err = captureStderr()
    const failing = fakeCohort([], {
      async listCandidates() {
        throw new Error('discovery failed')
      },
    })
    const failed = await appliedThroughCli('freeze-failed-quiet', failing, DECREASED, { quiet: true })
    expect(JSON.parse(stdout())).toMatchObject({ id: failed, status: 'applied', baselineFreeze: { frozen: false, reason: 'discovery failed' } })
    expect('frozenBaseline' in lastLine()).toBe(false)
    const refused = await appliedThroughCli('freeze-refused-quiet', fakeCohort(baselineOf([20, 21, 22]), { now: () => T + 60_000 }), DECREASED, { quiet: true })
    const output = JSON.parse(stdout())
    expect(output).toMatchObject({ id: refused, status: 'applied', baselineFreeze: { frozen: false } })
    expect(output.baselineFreeze.reason).toContain('cutAt must not be later than the application time')
    expect('frozenBaseline' in lastLine()).toBe(false)
    expect(err).toEqual([])
  })
})

describe('orangu suggest: the moves that --set refuses, kept, the input of --record, and --reason', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })

  it('--set regressed and --set unproven exit 1, name orangu suggest --record, and measure nothing', async () => {
    const id = await seedApplied('set-refused', [1, 2, 3])
    const deps = fakeCohort(laterOf(range(20, 10)))
    for (const status of ['regressed', 'unproven']) {
      await refusedUnchanged(() => cmdSuggest([status], { set: id, json: true }, { cohort: deps }), `orangu suggest --record ${id}`)
    }
    expect(deps.calls).toEqual(NO_CALLS)
  })

  it('--set lists only the moves that --set accepts, and kept moves only a regressed record, carries its receipt and measures nothing', async () => {
    const id = await seedApplied('kept', [1, 2, 3])
    const deps = fakeCohort(laterOf(range(20, 10)))
    await refusedUnchanged(() => cmdSuggest(['kept'], { set: id, json: true }, { cohort: deps }), `illegal transition applied → kept for ${id} (allowed: verified, rejected)`)
    out = []
    await cmdSuggest([], { record: id, json: true }, { cohort: deps })
    const regressed = JSON.parse(stdout())
    expect(regressed.status).toBe('regressed')
    const keep = fakeCohort(laterOf(range(20, 10)))
    out = []
    await cmdSuggest(['kept'], { set: id, json: true }, { cohort: keep })
    const kept = JSON.parse(stdout())
    expect(kept.status).toBe('kept')
    expect(kept.outcomeReceipt).toEqual(regressed.outcomeReceipt)
    expect(lastLine()).toMatchObject({ status: 'kept', outcomeReceipt: regressed.outcomeReceipt })
    expect(keep.calls).toEqual(NO_CALLS)
    await refusedUnchanged(() => cmdSuggest(['kept'], { set: id, json: true }, { cohort: keep }), `illegal transition kept → kept for ${id} (allowed: rejected)`)
  })

  it('--record exits 1 on a record that is not applied and names its status, and on a global record before any discovery call', async () => {
    const deps = fakeCohort(laterOf(range(20, 10)))
    out = []
    await cmdSuggest([], { rule: 'record-new', scope: 'session', session: fixturePath, json: true })
    const fresh = JSON.parse(stdout()).record.id as string
    await refusedUnchanged(() => cmdSuggest([], { record: fresh, json: true }, { cohort: deps }), `suggestion ${fresh} is not applied (status new)`)
    out = []
    await cmdSuggest([], { rule: 'record-global', scope: 'global', session: fixturePath, json: true })
    const globalId = JSON.parse(stdout()).record.id as string
    await refusedUnchanged(() => cmdSuggest([], { record: globalId, json: true }, { cohort: deps }), `suggestion ${globalId}: global suggestions are review-only and cannot be verified`)
    await refusedUnchanged(() => cmdSuggest([], { record: 'sg_000000000000', json: true }, { cohort: deps }), /suggestion sg_000000000000 not found/)
    expect(deps.calls).toEqual(NO_CALLS)
    const recorded = await seedApplied('record-twice', [1, 2, 3])
    await cmdSuggest([], { record: recorded, json: true }, { cohort: deps })
    await refusedUnchanged(() => cmdSuggest([], { record: recorded, json: true }, { cohort: deps }), `suggestion ${recorded} is not applied (status regressed)`)
    // A verified record can be measured, but it has no verdict to record: the step stops before it reads a transcript.
    const verified = await seedApplied('record-verified', [20, 21, 22])
    await cmdSuggest(['verified'], { set: verified, json: true }, { cohort: fakeCohort(laterOf([1, 2, 3])) })
    const after = fakeCohort(laterOf([1, 2, 3]))
    await refusedUnchanged(() => cmdSuggest([], { record: verified, json: true }, { cohort: after }), `suggestion ${verified} is not applied (status verified)`)
    expect(after.calls).toEqual(NO_CALLS)
  })

  it('--record takes 1 id and nothing more: no status, no artifact and no reason', async () => {
    const id = await seedApplied('record-input', [1, 2, 3])
    const deps = fakeCohort(laterOf(range(20, 10)))
    await refusedUnchanged(() => cmdSuggest(['regressed'], { record: id, json: true }, { cohort: deps }), '--record takes no status. Orangu measures the verdict itself')
    for (const name of ['proposal', 'manifest', 'application', 'verification']) {
      await refusedUnchanged(() => cmdSuggest([], { record: id, [name]: '/p/x.json', json: true }, { cohort: deps }), `--${name} is not valid with --record`)
    }
    await refusedUnchanged(() => cmdSuggest([], { record: id, reason: 'other', json: true }, { cohort: deps }), '--reason is valid only with --set <id> rejected')
    await refusedUnchanged(() => cmdSuggest([], { record: true, json: true }, { cohort: deps }), '--record requires a suggestion id')
    expect(deps.calls).toEqual(NO_CALLS)
  })

  it('--reason is valid only with --set <id> rejected, takes 1 of the 5 codes, and the stored line has the code', async () => {
    out = []
    await cmdSuggest([], { rule: 'reason-code', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id as string
    await refusedUnchanged(() => cmdSuggest(['kicked-off'], { set: id, reason: 'other', json: true }), '--reason is valid only with --set <id> rejected')
    await refusedUnchanged(() => cmdSuggest([], { rule: 'reason-code', scope: 'session', session: fixturePath, reason: 'other', json: true }), '--reason is valid only with --set <id> rejected')
    for (const value of ['nope', 'Other', 'other ', '', true]) {
      await refusedUnchanged(() => cmdSuggest(['rejected'], { set: id, reason: value, json: true }), `--reason must be 1 of ${REJECT_REASON_CODES.join(', ')}`)
    }
    out = []
    await cmdSuggest(['rejected'], { set: id, reason: 'wrong-cause', json: true })
    expect(JSON.parse(stdout())).toMatchObject({ status: 'rejected', reasonCode: 'wrong-cause' })
    expect(lastLine()).toMatchObject({ id, status: 'rejected', reasonCode: 'wrong-cause' })
  })

  it('--set rejected binds the workspace only when every discovered evidence session gives the same canonical cwd', async () => {
    const reject = async (rule: string, sessions: string[], scope = 'repo'): Promise<Record<string, unknown>> => {
      out = []
      await cmdSuggest([], { rule, scope, session: sessions.join(','), json: true })
      const id = JSON.parse(stdout()).record.id as string
      out = []
      await cmdSuggest(['rejected'], { set: id, json: true })
      expect(JSON.parse(stdout()).status, rule).toBe('rejected')
      return lastLine()
    }
    expect((await reject('bind-same', [fixturePath, laterFixturePath])).workspaceCwd).toBe(realpathSync(process.cwd()))

    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-elsewhere-')))
    const otherPath = join(claudeHome, 'projects', '-fixture', 'eeeeeeee-0000-4000-8000-000000000005.jsonl')
    writeFileSync(otherPath, new SessionBuilder({ sessionId: 'eeeeeeee-0000-4000-8000-000000000005', cwd: elsewhere }).userPrompt('Work.').assistant([{ type: 'text', text: 'Done.' }]).toJsonl())
    expect('workspaceCwd' in (await reject('bind-two-paths', [fixturePath, otherPath]))).toBe(false)

    const archive = join(mkdtempSync(join(tmpdir(), 'orangu-archive-')), 'dddddddd-0000-4000-8000-000000000004.jsonl')
    writeFileSync(archive, buildCanonicalSession({ cwd: process.cwd() }).toJsonl())
    expect('workspaceCwd' in (await reject('bind-no-path', [archive], 'session'))).toBe(false)
  })
})

describe('orangu suggest: each new CLI move stores no free text', () => {
  const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const SUGGESTION_ID = /^sg_[0-9a-f]{12}$/
  // The value and key lists of the store walk (src/suggest/store.test.ts).
  const ENUM_VALUES = new Set<string>([
    ...SUGGESTION_VERIFICATION_METRICS,
    ...SUGGESTION_VERIFICATION_COMPARISONS,
    ...SUGGESTION_VERIFICATION_METRICS.flatMap((metric) => SUGGESTION_VERIFICATION_COMPARISONS.map((comparison) => `${metric} ${comparison}`)),
    ...REJECT_REASON_CODES,
    ...['cohort-rank-v1', 'first', 'complete', 'within-noise', 'regressed', 'not-enough-sessions', 'no-directional-check', 'improved', 'held', 'changed'],
  ])
  const SHAPE_KEYS = new Set<string>([
    ...['v', 'cutAt', 'sessions', 'skipped', 'id', 'startedAt', 'endedAt', 'metrics'],
    ...['method', 'alpha', 'appliedAt', 'checkpoint', 'verdict', 'laterComplete', 'confoundedBy', 'baselineSessionIds', 'measuredSessionIds', 'checks'],
    ...['metric', 'comparison', 'name', 'before', 'after', 'beforeMedian', 'afterMedian', 'pLower', 'pHigher'],
    ...SUGGESTION_VERIFICATION_METRICS,
    ...COHORT_SKIP_REASONS,
  ])
  const NEW_FIELDS = ['frozenBaseline', 'outcomeReceipt', 'reasonCode', 'workspaceCwd'] as const

  /** Each leaf of a new field that is not a finite number, a boolean, an id, an enum value or the bound workspace path. */
  function freeText(value: unknown, path: string, workspaceCwd: string, found: string[]): number {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) found.push(`${path} = ${value}`)
      return 1
    }
    if (typeof value === 'boolean') return 1
    if (typeof value === 'string') {
      if (!SESSION_ID.test(value) && !SUGGESTION_ID.test(value) && !ENUM_VALUES.has(value) && !(path === 'workspaceCwd' && value === workspaceCwd)) {
        found.push(`${path} = ${JSON.stringify(value)}`)
      }
      return 1
    }
    if (Array.isArray(value)) return value.reduce<number>((sum, item, index) => sum + freeText(item, `${path}[${index}]`, workspaceCwd, found), 0)
    if (value && typeof value === 'object') {
      let leaves = 0
      for (const [key, item] of Object.entries(value)) {
        if (!SHAPE_KEYS.has(key)) found.push(`${path}.${key}`)
        leaves += freeText(item, `${path}.${key}`, workspaceCwd, found)
      }
      return leaves
    }
    found.push(`${path} is ${value === null ? 'null' : typeof value}`)
    return 1
  }

  it('walks the new fields of the stored line after each CLI move, and no line carries the leaning hint', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
    const workspaceCwd = realpathSync(process.cwd())
    const walkLastLine = (move: string, expected: readonly (typeof NEW_FIELDS)[number][]): void => {
      const stored = lastLine()
      expect(NEW_FIELDS.filter((field) => stored[field] !== undefined), move).toEqual(expected)
      const found: string[] = []
      const leaves = NEW_FIELDS.reduce((sum, field) => sum + (stored[field] === undefined ? 0 : freeText(stored[field], field, workspaceCwd, found)), 0)
      expect(found, move).toEqual([])
      expect(leaves, move).toBeGreaterThan(0)
    }

    const regressed = await appliedThroughCli('walk-regressed', fakeCohort(baselineOf([1, 2, 3])))
    walkLastLine('applied with a frozen baseline', ['frozenBaseline'])
    await cmdSuggest([], { record: regressed, json: true }, { cohort: fakeCohort(laterOf(range(20, 10))) })
    walkLastLine('applied → regressed', ['frozenBaseline', 'outcomeReceipt'])
    await cmdSuggest(['kept'], { set: regressed, json: true })
    walkLastLine('regressed → kept', ['frozenBaseline', 'outcomeReceipt'])
    await cmdSuggest(['rejected'], { set: regressed, reason: 'not-wanted', json: true })
    walkLastLine('kept → rejected', ['frozenBaseline', 'outcomeReceipt', 'reasonCode'])

    const unproven = await appliedThroughCli('walk-unproven', fakeCohort(baselineOf([5, 6])))
    walkLastLine('applied with a short frozen baseline', ['frozenBaseline'])
    await cmdSuggest([], { record: unproven, json: true }, { cohort: fakeCohort([]) })
    walkLastLine('applied → unproven', ['frozenBaseline', 'outcomeReceipt'])
    await cmdSuggest(['rejected'], { set: unproven, reason: 'too-much-effort', json: true })
    walkLastLine('unproven → rejected', ['frozenBaseline', 'outcomeReceipt', 'reasonCode'])

    out = []
    await cmdSuggest([], { rule: 'walk-rejected', scope: 'session', session: fixturePath, json: true })
    const fresh = JSON.parse(stdout()).record.id as string
    await cmdSuggest(['rejected'], { set: fresh, reason: 'already-handled', json: true })
    walkLastLine('new → rejected', ['reasonCode', 'workspaceCwd'])

    expect(readFileSync(storePath(), 'utf8')).not.toContain('leaning')
  })
})
