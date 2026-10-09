/**
 * verify:god (scripts/verify-god.mjs) reads the report of `claude plugin validate --strict --json god` and
 * fails the gate on a gating hook with no .catch, on a `$` call outside its allowlist, on an environment read
 * outside HOME and ORANGU_GOD, and on any environment write. These probes feed it planted reports, so the gate
 * is proven to bite on a machine with no claude binary too.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts/verify-god.mjs')

interface Notes {
  calls?: string
  reads?: string
  writes?: string
  gating?: Array<{ hook: string; hasCatch: boolean }>
  success?: boolean
}

/** A validate report shaped as the 2.1.295 validator writes it, with the notes given. */
function report({ calls = '$.command.register, $.env.get', reads = 'HOME, ORANGU_GOD', writes = 'nothing', gating = [], success = true }: Notes = {}): unknown {
  return {
    success,
    strict: true,
    manifest: { errors: [], warnings: [], notes: [], gatingHooks: [] },
    contents: [
      {
        type: 'hooks',
        errors: [],
        warnings: [],
        notes: ['./god.mjs hooks: session.start, command.run{command=god}', `./god.mjs calls: ${calls}`, `./god.mjs env writes: ${writes}`, `./god.mjs env reads: ${reads}`],
        gatingHooks: gating.map((hook) => ({ module: './god.mjs', pattern: hook.hook.split('{')[0], ...hook })),
      },
    ],
    advice: [],
  }
}

function findings(value: unknown): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'orangu-verify-god-'))
  const file = join(dir, 'report.json')
  writeFileSync(file, JSON.stringify(value))
  const run = spawnSync(process.execPath, [SCRIPT, '--check-report', file], { encoding: 'utf8' })
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as string[]
}

describe('verify:god reads the validate report', () => {
  it('passes a report within its pins', () => {
    expect(findings(report())).toEqual([])
    expect(findings(report({ reads: 'HOME', gating: [{ hook: 'tool.call{tool=mcp__orangu-god__board}', hasCatch: true }] }))).toEqual([])
  })

  it('fails a report that the validator failed', () => {
    expect(findings(report({ success: false }))).toEqual(['the validator failed the plugin'])
  })

  it('fails a gating hook with no .catch', () => {
    expect(findings(report({ gating: [{ hook: 'tool.call{tool=mcp__orangu-god__board}', hasCatch: false }] }))).toEqual([
      'gating hook without .catch: tool.call{tool=mcp__orangu-god__board}',
    ])
  })

  it('fails each call that the plan keeps out of the mod', () => {
    for (const call of ['$.fs.write', '$.env.set', '$.http.fetch', '$.prompt.submit', '$.process.spawn', '$.agent.spawn']) {
      expect(findings(report({ calls: `$.command.register, ${call}` })), call).toEqual([`call outside the allowlist: ${call}`])
    }
  })

  it('fails an environment read outside HOME and ORANGU_GOD, and any environment write', () => {
    expect(findings(report({ reads: 'HOME, PATH' }))).toEqual(['environment read outside HOME and ORANGU_GOD: PATH'])
    expect(findings(report({ writes: 'ORANGU_GOD' }))).toEqual(['environment write: ORANGU_GOD'])
  })

  it('reads an absent env note as none, but fails a report with no hooks or calls note, so a new note format cannot pass unread', () => {
    const plain = report() as { contents: Array<{ notes: string[] }> }
    plain.contents[0]!.notes = plain.contents[0]!.notes.filter((note) => !note.includes(' env '))
    expect(findings(plain)).toEqual([])
    plain.contents[0]!.notes = []
    expect(findings(plain)).toEqual(['the report has no hooks note and calls note: read the validator output and update this script'])
  })
})
