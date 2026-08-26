import { spawn } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../fixtures/home.js'

const root = process.cwd()
const temp = await mkdtemp(join(tmpdir(), 'orangu-browser-'))
const fixtureRepo = join(temp, 'repo')
await mkdir(fixtureRepo, { recursive: true })
const fixture = await makeFixtureHome(join(temp, 'claude'), { cwd: fixtureRepo })
const appHome = join(temp, 'orangu-home')
const cli = join(root, 'dist', 'orangu.js')

const child = spawn(
  process.execPath,
  [cli, 'serve', '--port', '4174', '--no-open', '--root', fixture.configDir],
  {
    env: {
      ...process.env,
      ORANGU_HOME: appHome,
      ORANGU_NO_CACHE: '1',
    },
    stdio: 'inherit',
  },
)

const stop = (signal: NodeJS.Signals) => {
  child.kill(signal)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
await new Promise(() => {})
