import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SuggestionStore } from '../suggest/store.js'
import { startServe, type ServeHandle } from './server.js'

/** A secret and a unique word that the planted profile holds in `role`. No body may hold either. */
const SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKE'
const MARKER = 'private-profile-marker-9074'

const PLANTED = {
  v: 1,
  updatedAt: '2026-11-01',
  role: `${MARKER} export KEY=${SECRET}`,
  priority: 'quality',
  answers: [{ q: 'Which role fits your work best?', a: `${MARKER} ${SECRET}`, how: 'own' }],
}

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
  vi.unstubAllEnvs()
})

/** A server over an empty Claude folder, and an orangu home of its own for the profile. */
async function boot(profile?: unknown): Promise<{ url: string; profileHome: string }> {
  const profileHome = await mkdtemp(join(tmpdir(), 'orangu-serve-profile-'))
  if (profile !== undefined) await writeFile(join(profileHome, 'profile.json'), JSON.stringify(profile))
  vi.stubEnv('ORANGU_HOME', profileHome)
  const configDir = await mkdtemp(join(tmpdir(), 'orangu-serve-profile-claude-'))
  const storeHome = await mkdtemp(join(tmpdir(), 'orangu-serve-profile-store-'))
  srv = await startServe({ open: false, includeText: false, configDir, noCache: true, version: 'test' }, { quiet: true, store: new SuggestionStore({ home: storeHome }) })
  return { url: srv.url, profileHome }
}

async function getProfile(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url + '/api/profile')
  return { status: response.status, body: await response.text() }
}

describe('GET /api/profile', () => {
  it('gives exactly exists and updatedAt for a valid profile, and no profile value', async () => {
    const { url, profileHome } = await boot(PLANTED)
    const { status, body } = await getProfile(url)
    expect(status).toBe(200)
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(['exists', 'updatedAt'])
    expect(JSON.parse(body)).toEqual({ exists: true, updatedAt: '2026-11-01' })
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain(MARKER)
    expect(body).not.toContain(profileHome)
  })

  it('gives exists true and updatedAt null for a file that is not valid, and no profile value', async () => {
    const { url } = await boot({ ...PLANTED, v: 2 })
    const { status, body } = await getProfile(url)
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ exists: true, updatedAt: null })
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain(MARKER)
  })

  it('gives exists false when there is no profile', async () => {
    const { url } = await boot()
    const { status, body } = await getProfile(url)
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ exists: false, updatedAt: null })
  })
})
