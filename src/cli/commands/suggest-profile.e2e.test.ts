/**
 * E2E over the BUILT CLI (dist/orangu.js): `orangu suggest --profile` prints where the profile is and whether it
 * reads as profile v1, and never a profile value. It skips when dist is missing, as suggest.e2e.test.ts does.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'orangu.js')

/** A unique word in each string key of the profile. No output may hold one. */
const WORDS = {
  role: 'quokka-role-5521',
  work: 'quokka-work-5522',
  process: 'quokka-process-5523',
  repeats: 'quokka-repeats-5524',
  never: 'quokka-never-5525',
  q: 'quokka-question-5526',
  a: 'quokka-answer-5527',
}

const PLANTED = {
  v: 1,
  updatedAt: '2026-11-01',
  role: `I write code. ${WORDS.role}`,
  work: ['features', WORDS.work],
  process: WORDS.process,
  priority: 'tokens',
  models: 'ask',
  audience: 'local',
  repeats: WORDS.repeats,
  never: WORDS.never,
  answers: [{ q: WORDS.q, a: WORDS.a, how: 'own' }],
}

function newHome(profile?: unknown): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), 'orangu-e2e-profile-'))
  const path = join(home, 'profile.json')
  if (profile !== undefined) writeFileSync(path, JSON.stringify(profile))
  return { home, path }
}

function cli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ORANGU_HOME: home } })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** Run a call that must succeed, and give its stdout. A failure shows its exit code and stderr. */
function ok(home: string, args: string[]): string {
  const run = cli(home, args)
  expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
  return run.stdout
}

function expectNoWord(output: string): void {
  for (const word of Object.values(WORDS)) expect(output, word).not.toContain(word)
}

describe.skipIf(!existsSync(CLI))('orangu suggest --profile (built CLI)', () => {
  it('prints the state of a valid profile in each output form, and no profile value', () => {
    const { home, path } = newHome(PLANTED)
    const json = ok(home, ['suggest', '--profile', '--json'])
    expect(JSON.parse(json)).toEqual({ path, exists: true, valid: true, updatedAt: '2026-11-01' })
    expect(Object.keys(JSON.parse(json))).toEqual(['path', 'exists', 'valid', 'updatedAt'])
    const quiet = ok(home, ['suggest', '--profile', '--json', '--quiet'])
    expect(quiet).toBe(`${JSON.stringify({ path, exists: true, valid: true, updatedAt: '2026-11-01' })}\n`)
    const text = ok(home, ['suggest', '--profile'])
    expect(text).toBe(`  profile  ${path}  (valid, updated 2026-11-01)\n`)
    for (const output of [json, quiet, text]) expectNoWord(output)
  })

  it('prints no profile value for a file that is not valid', () => {
    const { home, path } = newHome({ ...PLANTED, v: 2 })
    const json = ok(home, ['suggest', '--profile', '--json'])
    expect(JSON.parse(json)).toEqual({ path, exists: true, valid: false, updatedAt: null })
    const text = ok(home, ['suggest', '--profile'])
    expect(text).toBe(`  profile  ${path}  (not valid)\n`)
    for (const output of [json, text]) expectNoWord(output)
  })

  it('prints the state of a missing profile', () => {
    const { home, path } = newHome()
    expect(JSON.parse(ok(home, ['suggest', '--profile', '--json']))).toEqual({ path, exists: false, valid: false, updatedAt: null })
    expect(ok(home, ['suggest', '--profile'])).toBe(`  profile  ${path}  (no file)\n`)
  })

  it('runs as its own step: a second step or a read option exits 1 before any read, and makes no folder', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'orangu-e2e-profile-parent-')), 'orangu')
    const twoSteps = cli(home, ['suggest', '--profile', '--queue'])
    expect(twoSteps.status).toBe(1)
    expect(twoSteps.stdout).toBe('')
    expect(twoSteps.stderr).toContain('orangu suggest runs 1 step at a time, and this call has 2: --queue, --profile.')
    const option = cli(home, ['suggest', '--profile', '--cwd', tmpdir()])
    expect(option.status).toBe(1)
    expect(option.stdout).toBe('')
    expect(option.stderr).toContain('--cwd is not valid with --profile. usage: orangu suggest --profile [--json]')
    expect(existsSync(home)).toBe(false)
  })

  it('makes a missing orangu home with mode 0700, and keeps the mode of a home that exists', () => {
    const parent = mkdtempSync(join(tmpdir(), 'orangu-e2e-profile-parent-'))
    const missing = join(parent, 'made', 'orangu')
    expect(JSON.parse(ok(missing, ['suggest', '--profile', '--json']))).toEqual({ path: join(missing, 'profile.json'), exists: false, valid: false, updatedAt: null })
    expect(existsSync(missing)).toBe(true)
    expect((statSync(missing).mode & 0o777).toString(8)).toBe('700')
    const shared = join(parent, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o755)
    ok(shared, ['suggest', '--profile'])
    expect((statSync(shared).mode & 0o777).toString(8)).toBe('755')
  })

  it('prints the state when it cannot make the orangu home, and says why on stderr unless --quiet', () => {
    const parent = mkdtempSync(join(tmpdir(), 'orangu-e2e-profile-parent-'))
    const file = join(parent, 'a-file')
    writeFileSync(file, 'x')
    const run = cli(file, ['suggest', '--profile', '--json'])
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ path: join(file, 'profile.json'), exists: false, valid: false, updatedAt: null })
    expect(run.stderr).toBe('  orangu could not make its home folder (EEXIST), so the profile write can fail.\n')
    const quiet = cli(file, ['suggest', '--profile', '--json', '--quiet'])
    expect({ status: quiet.status, stderr: quiet.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('is in the full help', () => {
    const { home } = newHome()
    expect(ok(home, ['help', 'all'])).toContain('| --profile  (the profile file and its state)')
  })
})
