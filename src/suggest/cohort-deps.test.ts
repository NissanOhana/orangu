import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { MIN_VERIFICATION_QUIET_MS } from '../adapters/claude-code/discovered-analysis.js'
import { projectSlug } from '../discover/discover.js'
import { measureCohortEffect } from './cohort.js'
import { createCohortDeps } from './cohort-deps.js'
import type { SuggestionRecord } from './types.js'

const ENV_KEYS = ['ORANGU_CLAUDE_ROOTS', 'CLAUDE_CONFIG_DIR'] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const APPLIED_AT = Date.parse('2026-08-05T00:00:00.000Z')
const id = (n: number): string => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function writeSession(project: string, sessionId: string, cwd: string, startAt: string, toolCalls: number): void {
  const b = new SessionBuilder({ sessionId, cwd, startAt })
  b.userPrompt('Make the change')
  for (let i = 0; i < toolCalls; i++) b.toolCall('Read', { file_path: `${cwd}/src/f${i}.ts` }, 'ok')
  b.assistant([{ type: 'text', text: 'Done.' }])
  const path = join(project, `${sessionId}.jsonl`)
  writeFileSync(path, b.toJsonl())
  const end = new Date(Date.parse(startAt) + 60 * 60_000)
  utimesSync(path, end, end)
}

function workspaceWithSessions(): { cwd: string; identity: { cwd: string; device: string; inode: string } } {
  const root = mkdtempSync(join(tmpdir(), 'orangu-cohort-root-'))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-cohort-ws-')))
  const project = join(root, 'projects', projectSlug(cwd))
  mkdirSync(project, { recursive: true })
  const baseline = [['2026-08-01T10:00:00.000Z', 7], ['2026-08-02T10:00:00.000Z', 8], ['2026-08-03T10:00:00.000Z', 9]] as const
  const later = [['2026-08-10T10:00:00.000Z', 1], ['2026-08-11T10:00:00.000Z', 2], ['2026-08-12T10:00:00.000Z', 3]] as const
  baseline.forEach(([start, calls], i) => writeSession(project, id(i), cwd, start, calls))
  later.forEach(([start, calls], i) => writeSession(project, id(100 + i), cwd, start, calls))
  // A session from another cwd whose slug lands in the same project directory is read and skipped.
  writeSession(project, id(200), `${cwd}-elsewhere`, '2026-08-13T10:00:00.000Z', 0)
  process.env['ORANGU_CLAUDE_ROOTS'] = root
  process.env['CLAUDE_CONFIG_DIR'] = root
  const st = statSync(cwd, { bigint: true })
  return { cwd, identity: { cwd, device: String(st.dev), inode: String(st.ino) } }
}

function applied(identity: { cwd: string; device: string; inode: string }): SuggestionRecord {
  return {
    id: 'sg_aaaaaaaaaaaa',
    v: 2,
    createdAt: 1,
    source: 'report',
    scope: 'repo',
    sessionIds: [id(0)],
    ruleId: 'reread-files',
    title: 't',
    evidence: { estimated: true },
    proposal: {
      v: 1,
      title: 'Reviewed change',
      change: 'c',
      effort: 'S',
      files: ['CLAUDE.md'],
      proposalPath: '/p/a.md',
      manifestPath: '/p/a.json',
      changeClass: 'instruction',
      evidence: 'e',
      expectedEffect: 'x',
      risk: 'r',
      verification: 'v',
      verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
      workspace: identity,
    },
    application: { v: 1, summary: 's', files: ['CLAUDE.md'], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.applied.json' },
    appliedAt: APPLIED_AT,
    status: 'applied',
    statusAt: APPLIED_AT,
  }
}

describe('createCohortDeps over real transcripts', () => {
  it('reads settled sessions through the evidence manifest and cuts them at the application', async () => {
    const { identity } = workspaceWithSessions()
    const deps = createCohortDeps({ now: () => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000 })
    const effect = await measureCohortEffect(applied(identity), [], deps)
    expect(effect.baseline.map((s) => s.id).sort()).toEqual([id(1), id(2)])
    expect(effect.skipped['evidence-session']).toBe(1)
    expect(effect.later.map((s) => s.id)).toEqual([id(100), id(101), id(102)])
    expect(effect.skipped['other-workspace']).toBe(1)
    expect(effect.checks[0]).toMatchObject({ before: 8.5, after: 2 })
    expect(effect.verdict).toBe('not-enough-sessions')
  })

  it('counts sessions that changed inside the quiet window as still settling', async () => {
    const { identity } = workspaceWithSessions()
    const effect = await measureCohortEffect(applied(identity), [], createCohortDeps({ now: () => Date.now() }))
    expect(effect.baseline).toHaveLength(0)
    expect(effect.later).toHaveLength(0)
    expect(effect.skipped['still-settling']).toBe(6)
  })

  it('refuses a workspace whose identity no longer matches', async () => {
    const { identity } = workspaceWithSessions()
    const deps = createCohortDeps({ now: () => Date.now() + MIN_VERIFICATION_QUIET_MS + 60_000 })
    await expect(measureCohortEffect(applied({ ...identity, inode: '1' }), [], deps)).rejects.toThrow(/workspace identity no longer matches/)
  })
})
