import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../../test/fixtures/home.js'
import { MAX_SESSION_RECORD_BYTES, pidAlive, resolveCurrentSession, runningSessions } from './current.js'

const FIXTURE_CWD = '/Users/test/Code/demo'
const ABSENT_ID = '99999999-0000-4000-8000-000000000099'

async function home(): Promise<Awaited<ReturnType<typeof makeFixtureHome>>> {
  const dir = await mkdtemp(join(tmpdir(), 'orangu-current-'))
  return makeFixtureHome(dir, { cwd: FIXTURE_CWD })
}

async function pidRecord(configDir: string, pid: number, body: string): Promise<string> {
  const dir = join(configDir, 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${pid}.json`)
  await writeFile(path, body)
  return path
}

describe('resolveCurrentSession', () => {
  it('step 1: CLAUDE_CODE_SESSION_ID names the session directly', async () => {
    const h = await home()
    const r = await resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_CODE_SESSION_ID: h.idleId })
    expect(r.ref.sessionId).toBe(h.idleId)
    expect(r.via).toBe('env')
    expect(r.note).toBeUndefined()
  })
  it('step 1: a set id without a transcript is a precise error, never a different session', async () => {
    const h = await home()
    await expect(resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_CODE_SESSION_ID: ABSENT_ID, CLAUDECODE: '1' })).rejects.toThrow(
      /current: session 99999999 has no transcript yet/,
    )
  })
  it('step 1: a malformed id is an error, not a fall-through', async () => {
    const h = await home()
    await expect(resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_CODE_SESSION_ID: 'latest', CLAUDECODE: '1' })).rejects.toThrow(
      /CLAUDE_CODE_SESSION_ID is not a session id/,
    )
  })
  it('step 2: CLAUDE_PID reads <configDir>/sessions/<pid>.json', async () => {
    const h = await home()
    await pidRecord(h.configDir, 4242, JSON.stringify({ pid: 4242, sessionId: h.endedId, cwd: FIXTURE_CWD, status: 'busy' }))
    const r = await resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_PID: '4242' })
    expect(r.ref.sessionId).toBe(h.endedId)
    expect(r.via).toBe('pid-file')
  })
  it('step 2: malformed, oversized and symlinked records fall through', async () => {
    const h = await home()
    await pidRecord(h.configDir, 1, '{not json')
    await pidRecord(h.configDir, 2, JSON.stringify({ pid: 2, sessionId: h.endedId, pad: 'x'.repeat(MAX_SESSION_RECORD_BYTES) }))
    await pidRecord(h.configDir, 3, JSON.stringify({ pid: 3, sessionId: 'not-an-id' }))
    const real = await pidRecord(h.configDir, 4, JSON.stringify({ pid: 4, sessionId: h.endedId }))
    await symlink(real, join(h.configDir, 'sessions', '5.json'))
    for (const pid of ['1', '2', '3', '5']) {
      await expect(resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_PID: pid })).rejects.toThrow(/not inside a Claude Code session/)
    }
    await expect(resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_PID: '4' })).resolves.toMatchObject({ via: 'pid-file' })
  })
  it('step 2: a record whose session has no transcript is the same precise error as step 1', async () => {
    const h = await home()
    await pidRecord(h.configDir, 7, JSON.stringify({ pid: 7, sessionId: ABSENT_ID }))
    await expect(resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_PID: '7' })).rejects.toThrow(/has no transcript yet/)
  })
  it('step 3: CLAUDECODE alone guesses the newest session for the cwd and says so', async () => {
    const h = await home()
    const r = await resolveCurrentSession({ configDir: h.configDir }, { CLAUDECODE: '1' }, { cwd: () => FIXTURE_CWD })
    expect(r.ref.sessionId).toBe(h.liveId)
    expect(r.via).toBe('cwd')
    expect(r.note).toMatch(/guessed 11111111 from cwd/)
  })
  it('step 3: CLAUDE_PROJECT_DIR wins over the process cwd', async () => {
    const h = await home()
    const r = await resolveCurrentSession({ configDir: h.configDir }, { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: FIXTURE_CWD }, { cwd: () => '/elsewhere' })
    expect(r.ref.sessionId).toBe(h.liveId)
  })
  it('step 3: no session for the cwd is an error naming the cwd', async () => {
    const h = await home()
    await expect(resolveCurrentSession({ configDir: h.configDir }, { CLAUDECODE: '1' }, { cwd: () => '/nowhere' })).rejects.toThrow(/no session for \/nowhere yet/)
  })
  it('step 4: outside Claude Code the error names the alternatives', async () => {
    const h = await home()
    await expect(resolveCurrentSession({ configDir: h.configDir }, {})).rejects.toThrow(/not inside a Claude Code session; use latest, an id, or orangu pick/)
  })
  it('never returns an alias: the ref is a concrete session', async () => {
    const h = await home()
    const r = await resolveCurrentSession({ configDir: h.configDir }, { CLAUDE_CODE_SESSION_ID: h.idleId })
    expect(r.ref.path.endsWith(`${h.idleId}.jsonl`)).toBe(true)
  })
})

describe('runningSessions', () => {
  it('keeps records whose pid is alive and drops dead or malformed ones', async () => {
    const h = await home()
    await pidRecord(h.configDir, 10, JSON.stringify({ pid: 10, sessionId: h.liveId, name: 'demo', status: 'busy', cwd: FIXTURE_CWD }))
    await pidRecord(h.configDir, 11, JSON.stringify({ pid: 11, sessionId: h.idleId }))
    await pidRecord(h.configDir, 12, '{"pid":12}')
    await pidRecord(h.configDir, 13, 'garbage')
    const alive = new Set([10])
    const m = await runningSessions({ configDir: h.configDir }, { isAlive: (pid) => alive.has(pid) })
    expect([...m.keys()]).toEqual([h.liveId])
    expect(m.get(h.liveId)).toMatchObject({ pid: 10, name: 'demo', status: 'busy', cwd: FIXTURE_CWD })
  })
  it('is empty, not an error, without a sessions directory', async () => {
    const h = await home()
    expect((await runningSessions({ configDir: h.configDir })).size).toBe(0)
  })
  it('pidAlive answers for this process and for a pid that cannot exist', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2 ** 31 - 2)).toBe(false)
  })
})
