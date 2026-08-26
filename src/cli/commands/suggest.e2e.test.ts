/**
 * E2E over the BUILT CLI (dist/orangu.js). Skips when dist is missing or was built before the suggest
 * verbs existed.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import { encodeFinding, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import type { Finding } from '../../suggest/types.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')
const helpHasSuggest = (): boolean => {
  try {
    return execFileSync('node', [CLI, '--help'], { encoding: 'utf8' }).includes('orangu suggest')
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
})
