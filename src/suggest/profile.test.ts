import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, profileStatus } from './profile.js'

/** A profile v1 with every key, as the interview writes it. */
const FULL = {
  v: 1,
  updatedAt: '2026-11-01',
  role: 'write-code',
  work: ['features', 'fixes'],
  process: 'orchestrator',
  priority: 'tokens',
  models: 'ask',
  audience: 'local',
  repeats: 'Run the tests before you commit.',
  never: 'A change to the model of a subagent.',
  answers: [
    { q: 'Which role fits your work best?', a: 'I write and ship code.', how: 'option' },
    { q: 'What do you tell the agent again and again?', a: 'Run the tests before you commit.', how: 'own' },
    { q: 'What must orangu never propose?', a: '', how: 'skipped' },
  ],
}

type Env = Record<string, string | undefined>

/** A new orangu home, with `profile.json` when `content` is given. */
async function homeWith(content?: string): Promise<{ env: Env; home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'orangu-profile-'))
  const path = join(home, 'profile.json')
  if (content !== undefined) await writeFile(path, content)
  return { env: { ORANGU_HOME: home }, home, path }
}

const json = (value: unknown): string => JSON.stringify(value)
const answer = (n: number) => ({ q: `Question ${n}?`, a: `Answer ${n}.`, how: 'option' })

describe('profileStatus and loadProfile: the file', () => {
  it('reads a missing file as exists false, and gives the path under the orangu home', async () => {
    const { env, path } = await homeWith()
    expect(await profileStatus(env)).toEqual({ path, exists: false, valid: false, updatedAt: null })
    expect(await loadProfile(env)).toBeNull()
  })

  it('reads a missing orangu home, and an orangu home that is a file, as exists false', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orangu-profile-parent-'))
    const missing = join(parent, 'not-made')
    expect(await profileStatus({ ORANGU_HOME: missing })).toEqual({ path: join(missing, 'profile.json'), exists: false, valid: false, updatedAt: null })
    const file = join(parent, 'a-file')
    await writeFile(file, 'x')
    expect(await profileStatus({ ORANGU_HOME: file })).toEqual({ path: join(file, 'profile.json'), exists: false, valid: false, updatedAt: null })
  })

  it('reads a valid profile: the status holds 4 keys and no profile value, and loadProfile gives the values', async () => {
    const { env, path } = await homeWith(json(FULL))
    const status = await profileStatus(env)
    expect(status).toEqual({ path, exists: true, valid: true, updatedAt: '2026-11-01' })
    expect(Object.keys(status)).toEqual(['path', 'exists', 'valid', 'updatedAt'])
    expect(await loadProfile(env)).toEqual(FULL)
  })

  it('follows XDG_DATA_HOME, and ORANGU_HOME wins over it', async () => {
    const xdg = await mkdtemp(join(tmpdir(), 'orangu-profile-xdg-'))
    await mkdir(join(xdg, 'orangu'))
    await writeFile(join(xdg, 'orangu', 'profile.json'), json(FULL))
    expect(await profileStatus({ XDG_DATA_HOME: xdg })).toEqual({ path: join(xdg, 'orangu', 'profile.json'), exists: true, valid: true, updatedAt: '2026-11-01' })
    const { env, path } = await homeWith()
    expect(await profileStatus({ ...env, XDG_DATA_HOME: xdg })).toEqual({ path, exists: false, valid: false, updatedAt: null })
  })

  it('reads 16,384 B as valid and 16,385 B as not valid', async () => {
    const minimal = json({ v: 1, updatedAt: '2026-11-01' })
    const atCap = await homeWith(minimal.padEnd(16_384, ' '))
    expect(await profileStatus(atCap.env)).toEqual({ path: atCap.path, exists: true, valid: true, updatedAt: '2026-11-01' })
    const overCap = await homeWith(minimal.padEnd(16_385, ' '))
    expect(await profileStatus(overCap.env)).toEqual({ path: overCap.path, exists: true, valid: false, updatedAt: null })
    expect(await loadProfile(overCap.env)).toBeNull()
  })

  it('refuses a symlink, also one to a valid profile', async () => {
    const target = await homeWith(json(FULL))
    const { env, path } = await homeWith()
    await symlink(target.path, path)
    expect(await profileStatus(env)).toEqual({ path, exists: true, valid: false, updatedAt: null })
    expect(await loadProfile(env)).toBeNull()
  })

  it('refuses a folder at the path', async () => {
    const { env, path } = await homeWith()
    await mkdir(path)
    expect(await profileStatus(env)).toEqual({ path, exists: true, valid: false, updatedAt: null })
  })
})

describe('profileStatus and loadProfile: the shape of profile v1', () => {
  const { v: _v, ...noV } = FULL
  const { updatedAt: _u, ...noDate } = FULL
  const notValid: Array<[string, string]> = [
    ['bad JSON', '{"v":1,'],
    ['a UTF-8 BOM before the JSON', '﻿' + json(FULL)],
    ['JSON that is an array', '[]'],
    ['JSON that is null', 'null'],
    ['v is 2', json({ ...FULL, v: 2 })],
    ['v is the string "1"', json({ ...FULL, v: '1' })],
    ['no v', json(noV)],
    ['no updatedAt', json(noDate)],
    ['updatedAt with no zero pad', json({ ...FULL, updatedAt: '2026-11-1' })],
    ['updatedAt with a time', json({ ...FULL, updatedAt: '2026-11-01T09:00:00Z' })],
    ['updatedAt with a newline after the date', json({ ...FULL, updatedAt: '2026-11-01\n' })],
    ['updatedAt that is a word', json({ ...FULL, updatedAt: 'yesterday' })],
    ['an unknown key', json({ ...FULL, notes: 'more text' })],
    ['a __proto__ key', '{"v":1,"updatedAt":"2026-11-01","__proto__":{"role":"x"}}'],
    ['a null value for a skipped question', json({ ...FULL, priority: null })],
    ['own words in priority', json({ ...FULL, priority: 'speed' })],
    ['own words in models', json({ ...FULL, models: 'maybe' })],
    ['own words in audience', json({ ...FULL, audience: 'team' })],
    ['an empty enum value', json({ ...FULL, audience: '' })],
    ['role over 200 characters', json({ ...FULL, role: 'r'.repeat(201) })],
    ['role over 200 code points', json({ ...FULL, role: '\u{1F600}'.repeat(201) })],
    ['process over 200 characters', json({ ...FULL, process: 'p'.repeat(201) })],
    ['work with 7 items', json({ ...FULL, work: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })],
    ['a work item over 120 characters', json({ ...FULL, work: ['w'.repeat(121)] })],
    ['a work item that is a number', json({ ...FULL, work: [1] })],
    ['work that is a string', json({ ...FULL, work: 'features' })],
    ['repeats over 500 characters', json({ ...FULL, repeats: 'x'.repeat(501) })],
    ['never over 500 characters', json({ ...FULL, never: 'x'.repeat(501) })],
    ['answers with 13 entries', json({ ...FULL, answers: Array.from({ length: 13 }, (_, n) => answer(n)) })],
    ['an answer with an unknown key', json({ ...FULL, answers: [{ ...answer(1), note: 'x' }] })],
    ['an answer with no how', json({ ...FULL, answers: [{ q: 'Question?', a: 'Answer.' }] })],
    ['an answer with an unknown how', json({ ...FULL, answers: [{ ...answer(1), how: 'maybe' }] })],
    ['an answer that is a string', json({ ...FULL, answers: ['Answer.'] })],
    ['an answer with a number for a', json({ ...FULL, answers: [{ ...answer(1), a: 3 }] })],
  ]

  it.each(notValid)('reads %s as exists true, valid false, updatedAt null', async (_name, content) => {
    const { env, path } = await homeWith(content)
    expect(await profileStatus(env)).toEqual({ path, exists: true, valid: false, updatedAt: null })
    expect(await loadProfile(env)).toBeNull()
  })

  const valid: Array<[string, Record<string, unknown>]> = [
    ['only v and updatedAt (each question skipped)', { v: 1, updatedAt: '2026-11-01' }],
    ['empty text keys and an empty work list', { v: 1, updatedAt: '2026-11-01', role: '', process: '', repeats: '', never: '', work: [] }],
    ['own words in role, process and work', { v: 1, updatedAt: '2026-11-01', role: 'I review the plans of 3 teams.', process: 'A long run each night.', work: ['Data pipelines'] }],
    ['role and process at 200 characters', { v: 1, updatedAt: '2026-11-01', role: 'r'.repeat(200), process: 'p'.repeat(200) }],
    ['role at 200 code points of 2 UTF-16 units each', { v: 1, updatedAt: '2026-11-01', role: '\u{1F600}'.repeat(200) }],
    ['work at 6 items of 120 characters', { v: 1, updatedAt: '2026-11-01', work: Array.from({ length: 6 }, () => 'w'.repeat(120)) }],
    ['repeats and never at 500 characters', { v: 1, updatedAt: '2026-11-01', repeats: 'x'.repeat(500), never: 'y'.repeat(500) }],
    ['answers at 12 entries', { v: 1, updatedAt: '2026-11-01', answers: Array.from({ length: 12 }, (_, n) => answer(n)) }],
    ['each enum value', { v: 1, updatedAt: '1999-01-31', priority: 'quality', models: 'no', audience: 'shared' }],
  ]

  it.each(valid)('reads %s as valid', async (_name, profile) => {
    const { env, path } = await homeWith(json(profile))
    expect(await profileStatus(env)).toEqual({ path, exists: true, valid: true, updatedAt: profile['updatedAt'] })
    expect(await loadProfile(env)).toEqual(profile)
  })
})
