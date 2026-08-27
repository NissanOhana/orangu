import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServe } from '../../src/serve/server.js'
import { makeFixtureHome } from '../fixtures/home.js'
import { BROWSER_CAPABILITY } from './app-url.js'

const temp = await mkdtemp(join(tmpdir(), 'orangu-browser-'))
const fixtureRepo = join(temp, 'repo')
await mkdir(fixtureRepo, { recursive: true })
const fixture = await makeFixtureHome(join(temp, 'claude'), { cwd: fixtureRepo })
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
