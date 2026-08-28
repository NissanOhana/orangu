import { appendFile, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServe } from '../../src/serve/server.js'
import { makeFixtureHome } from '../fixtures/home.js'
import { SessionBuilder } from '../fixtures/session-builder.js'
import { BROWSER_CAPABILITY } from './app-url.js'

const temp = await mkdtemp(join(tmpdir(), 'orangu-browser-'))
const fixtureRepo = join(temp, 'repo')
await mkdir(fixtureRepo, { recursive: true })
const fixture = await makeFixtureHome(join(temp, 'claude'), { cwd: fixtureRepo })
// a populated harness: the repo declares one skill nobody fired, and the canonical session carries a
// skill_listing attachment, so #harness renders the idle card AND the injected-listings table
await mkdir(join(fixtureRepo, '.claude', 'skills', 'demo-skill'), { recursive: true })
await writeFile(join(fixtureRepo, '.claude', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A fixture skill nobody invokes.\n---\nDo the demo.\n')
const ended = fixture.sessions.find((s) => s.id === fixture.endedId)!
const listing = new SessionBuilder({ sessionId: ended.id, startAt: '2026-08-14T10:00:00.000Z', cwd: fixtureRepo })
listing.attachment('skill_listing', { content: 'Available skills: demo-skill — A fixture skill nobody invokes. '.repeat(80) })
await appendFile(ended.path, listing.toJsonl())
await utimes(ended.path, new Date(ended.mtimeMs), new Date(ended.mtimeMs))
const appHome = join(temp, 'orangu-home')
process.env['ORANGU_HOME'] = appHome
// the harness route reads ~/.claude.json and the repo's .claude/: keep both synthetic (never the real home)
const fakeHome = join(temp, 'home')
await mkdir(fakeHome, { recursive: true })
process.env['HOME'] = fakeHome

const server = await startServe(
  {
    port: 4174,
    open: false,
    includeText: true,
    configDir: fixture.configDir,
    cwd: fixtureRepo,
    noCache: true,
    version: 'browser-test',
  },
  { capability: BROWSER_CAPABILITY },
)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void server.close().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await new Promise(() => {})
