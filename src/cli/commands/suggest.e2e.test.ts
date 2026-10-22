/**
 * E2E over the BUILT CLI (dist/orangu.js). Skips when dist is missing or was built before the suggest
 * verbs existed.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import { encodeFinding, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import type { Finding } from '../../suggest/types.js'
import { projectSlug } from '../../discover/discover.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')
const helpHasSuggest = (): boolean => {
  try {
    return execFileSync('node', [CLI, 'help', 'all'], { encoding: 'utf8' }).includes('orangu suggest')
  } catch {
    return false
  }
}

describe.skipIf(!existsSync(CLI) || !helpHasSuggest())('orangu suggest/estimate (built CLI)', () => {
  const home = mkdtempSync(join(tmpdir(), 'orangu-e2e-home-'))
  const dir = mkdtempSync(join(tmpdir(), 'orangu-e2e-sess-'))
  const fixture = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
  writeFileSync(fixture, buildCanonicalSession().toJsonl())
  const run = (args: string[]) =>
    execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ORANGU_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })

  it('estimate → suggest create → show → set proposed, end to end on a fixture', () => {
    const est = JSON.parse(run(['estimate', fixture, '--json']))
    expect(est.approxTokens).toBe(Math.ceil(est.bytes / 4))

    const created = JSON.parse(run(['suggest', '--rule', 'reread-files', '--scope', 'session', '--session', fixture, '--json']))
    expect(created.record.status).toBe('new')
    expect(created.command).toContain('/orangu:improve ')

    const shown = JSON.parse(run(['suggest', '--show', created.record.id, '--json']))
    expect(shown.sessions[0].slim).toBe(true)

    run(['suggest', '--set', created.record.id, 'kicked-off', '--json'])
    const proposalPath = join(home, 'proposals', `${created.record.id}.md`)
    writeFileSync(proposalPath, '# proposal\n')
    const proposed = JSON.parse(run(['suggest', '--set', created.record.id, 'proposed', '--proposal', proposalPath, '--json']))
    expect(proposed.status).toBe('proposed')
    expect(proposed.proposal.proposalPath).toBe(proposalPath)
  })

  it('recreates a complete v2 file handoff without losing title or evidence', () => {
    const finding: Finding = {
      ruleId: 'file-handoff-e2e',
      title: 'Exact E2E finding title',
      scope: 'session',
      sessionIds: [fixture],
      insightId: 'e2e-insight',
      evidence: { estimated: false, savingsTokens: 4321, turnIndexes: [1, 3] },
    }
    const id = suggestionIdV2(suggestionKey(finding, 'report'))
    const created = JSON.parse(run(['suggest', id, '--finding', encodeFinding(finding, 'report'), '--json']))
    expect(created.record).toMatchObject({ id, v: 2, title: finding.title, insightId: finding.insightId, evidence: finding.evidence })
  })

  it('analyze --json is redacted by default and --slim shrinks it', () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'orangu-e2e-secret-'))
    const secretFixture = join(secretDir, 'bbbbbbbb-0000-4000-8000-000000000009.jsonl')
    const b = buildCanonicalSession()
    b.userPrompt('my key is sk-ant-api03-abc123def456ghi789 thanks')
    b.assistant([{ type: 'text', text: 'noted' }])
    b.turnDuration(500, 2)
    writeFileSync(secretFixture, b.toJsonl())
    const full = run(['analyze', secretFixture, '--json'])
    expect(full).not.toContain('sk-ant-api03-abc123def456ghi789')
    const slim = run(['analyze', secretFixture, '--json', '--slim'])
    expect(JSON.parse(slim).slim).toBe(true)
    expect(slim.length).toBeLessThan(full.length)
    const raw = run(['analyze', secretFixture, '--json', '--no-redact'])
    expect(raw).toContain('sk-ant-api03-abc123def456ghi789')
  })

  it('--effect reads the cohort and --set verified refuses a verdict short of verified', () => {
    // Hermetic: the only Claude root is a temp one, HOME is empty, and the child runs in a temp workspace.
    const claudeRoot = mkdtempSync(join(tmpdir(), 'orangu-e2e-claude-'))
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-e2e-ws-')))
    const project = join(claudeRoot, 'projects', projectSlug(workspace))
    mkdirSync(project, { recursive: true })
    const evidence = join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    writeFileSync(evidence, buildCanonicalSession({ cwd: workspace }).toJsonl())
    const env = {
      ...process.env,
      ORANGU_HOME: mkdtempSync(join(tmpdir(), 'orangu-e2e-home2-')),
      HOME: mkdtempSync(join(tmpdir(), 'orangu-e2e-user-')),
      ORANGU_CLAUDE_ROOTS: claudeRoot,
      CLAUDE_CONFIG_DIR: claudeRoot,
    }
    const cli = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    const id = JSON.parse(cli(['suggest', '--rule', 'reread-files', '--scope', 'session', '--session', evidence, '--json'])).record.id as string
    cli(['suggest', '--set', id, 'kicked-off', '--json'])
    const proposals = join(env.ORANGU_HOME, 'proposals')
    writeFileSync(join(proposals, `${id}.md`), '# proposal\n')
    writeFileSync(
      join(proposals, `${id}.json`),
      JSON.stringify({
        v: 1, id, title: 'Name the file once', changeClass: 'instruction', change: 'Add one line to CLAUDE.md.',
        evidence: 'The same file was re-read.', expectedEffect: 'Fewer tool calls.', effort: 'S', risk: 'None known.',
        files: ['CLAUDE.md'], verification: 'Compare later sessions.', verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        sources: [{ kind: 'inference', label: 'Smallest change consistent with the evidence' }],
      }),
    )
    cli(['suggest', '--set', id, 'proposed', '--proposal', join(proposals, `${id}.md`), '--manifest', join(proposals, `${id}.json`), '--json'])
    writeFileSync(join(proposals, `${id}.applied.json`), JSON.stringify({ v: 1, id, summary: 'Added the line.', files: ['CLAUDE.md'], checks: [{ name: 'diff check', ok: true }] }))
    const applied = JSON.parse(cli(['suggest', '--set', id, 'applied', '--application', join(proposals, `${id}.applied.json`), '--json']))
    // The apply step froze the baseline: no session, because the only one is the finding's own.
    expect(applied.frozenBaseline).toMatchObject({ v: 1, sessions: [] })
    expect(applied.baselineFreeze).toEqual({ frozen: true })
    expect(applied.frozenBaseline.skipped['evidence-session']).toBe(1)
    expect(applied.frozenBaseline.cutAt).toBeLessThanOrEqual(applied.appliedAt)

    const effect = JSON.parse(cli(['suggest', '--effect', id, '--json']))
    expect(effect).toMatchObject({ id, verdict: 'not-enough-sessions', checkpoint: null, final: true, baseline: { n: 0 }, later: { n: 0, count: 0 } })
    expect(effect.skipped['evidence-session']).toBe(1)
    expect(cli(['suggest', '--effect', id])).toMatch(/verdict: not-enough-sessions\n {2}next: needs at least 3 settled sessions on each side/)
    const failure = (args: string[]): string => {
      try {
        cli(args)
      } catch (error) {
        return String((error as { stderr?: string }).stderr)
      }
      return ''
    }
    expect(failure(['suggest', '--set', id, 'verified', '--json'])).toMatch(/not verified: not-enough-sessions/)
    expect(JSON.parse(cli(['suggest', '--show', id, '--json'])).record.status).toBe('applied')
    // A frozen baseline below 3 sessions cannot change, so the record step closes the record as unproven.
    const recorded = JSON.parse(cli(['suggest', '--record', id, '--json']))
    expect(recorded).toMatchObject({ id, status: 'unproven', outcomeReceipt: { verdict: 'not-enough-sessions', checkpoint: 'first', laterComplete: false } })
    expect(failure(['suggest', '--record', id, '--json'])).toContain(`suggestion ${id} is not applied (status unproven)`)

    // The 4 store reads of the same workspace: the unproven record is a lesson and a change row, and nothing is open.
    const lessons = JSON.parse(cli(['suggest', '--lessons', '--json']))
    expect(lessons).toMatchObject({ v: 1, scope: workspace, maxBytes: 16_384, omitted: 0 })
    expect(lessons.lessons.map((lesson: { id: string; status: string }) => [lesson.id, lesson.status])).toEqual([[id, 'unproven']])
    const history = JSON.parse(cli(['suggest', '--history', '--json']))
    expect(history.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([[id, 'unproven']])
    expect(JSON.parse(cli(['suggest', '--queue', '--json']))).toMatchObject({ v: 1, scope: workspace, counts: { open: 0, due: 0 }, globalOpen: 0 })
    expect(cli(['suggest', '--queue'])).toMatch(/orangu found no open record in this workspace\.\n\n {2}See this queue in the app: orangu serve\n$/)
    expect(JSON.parse(cli(['suggest', '--todo', '--json', '--quiet']))).toEqual({ v: 1, workspace, counts: { verdict: 0, regressed: 0, apply: 0, review: 0, running: 0, wait: 0, due: 0, open: 0 }, maxBytes: 8_192, omitted: 0, items: [] })
    expect(failure(['suggest', '--todo', '--all'])).toContain('Name the workspace with --cwd <dir>.')
    expect(failure(['suggest', '--record', id, '--queue'])).toContain('orangu suggest runs 1 step at a time')
    const shown = JSON.parse(cli(['suggest', '--show', id, '--json']))
    expect(shown.transitions.map((move: { status: string }) => move.status)).toEqual(['new', 'kicked-off', 'proposed', 'applied', 'unproven'])
    expect(JSON.parse(cli(['suggest', '--list', '--status', 'unproven', '--json'])).map((record: { id: string }) => record.id)).toEqual([id])
    const help = execFileSync('node', [CLI, 'help', 'all'], { encoding: 'utf8' })
    for (const flag of ['--effect <id>', '--record <id>', '--reason <code>', '--queue', '--todo', '--lessons', '--history', '--status <s>']) expect(help, flag).toContain(flag)
  })
})

