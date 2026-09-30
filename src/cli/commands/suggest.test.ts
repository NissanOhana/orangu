import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession, SessionBuilder } from '../../../test/fixtures/session-builder.js'
import { cmdSuggest } from './suggest.js'
import { encodeFinding, kickoffCommand, normalizeSessionIds, sessionCohortFingerprint, suggestionId, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import type { Finding, SuggestionRecord } from '../../suggest/types.js'
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
    rewrite({ device: String(BigInt(proposedLine.proposal!.workspace!.device) + 5n) })
    out = []
    await cmdSuggest([], { show: id, 'for-apply': true, json: true })
    expect(JSON.parse(stdout()).workspaceMatchesCurrent).toBe(true)

    out = []
    await cmdSuggest(['applied'], { set: id, application: applicationPath, json: true })
    expect(JSON.parse(stdout()).application).toMatchObject({ v: 1, summary: 'Added the script.', receiptPath: applicationPath })

    // Orangu picks both cohorts from this workspace, cut at the application (2026-08-15). The finding's own
    // session is left out of the baseline; sessions must be quiet for 30 minutes, so move the clock past ctime.
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
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
