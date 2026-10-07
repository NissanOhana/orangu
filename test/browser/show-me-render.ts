/**
 * The show-me files that the browser spec opens: made by the built CLI (`npm run test:browser` builds it first),
 * never by a test fill. One fixture session in a temp Claude home, `orangu show-me <session>` to prepare, hostile
 * words in words.json, then `orangu show-me --render`. Prints the run directory on stdout, for
 * test/browser/static-server.mjs to serve.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../fixtures/home.js'

const root = join(import.meta.dirname, '..', '..')
const temp = await mkdtemp(join(tmpdir(), 'orangu-browser-show-me-'))
const repo = join(temp, 'repo')
await mkdir(repo, { recursive: true })
const home = await makeFixtureHome(join(temp, 'claude'), { cwd: repo })
const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(temp, 'home'), XDG_DATA_HOME: join(temp, 'data'), CLAUDE_CONFIG_DIR: home.configDir, ORANGU_CLAUDE_ROOTS: home.configDir, ORANGU_NO_CACHE: '1' }
delete env['ORANGU_HOME']
const cli = (args: string[]): string => execFileSync(process.execPath, [join(root, 'dist', 'orangu.js'), 'show-me', ...args], { encoding: 'utf8', env })

const { dir } = JSON.parse(cli([home.endedId, '--json'])) as { dir: string }
// the hostile words of the security review, plus 2 that would set a mark if they ran
const hostile = [
  '<script>alert(1)</script>',
  '" onload="x',
  'javascript:',
  '</title><script>',
  '<!--',
  '&#106;avascript:',
  '<svg><set attributeName="href" to="https://x"/>',
  '<img src="data:," onerror="window.__xss=1">',
  '<script>window.__xss=2</script>',
].join(' ')
await writeFile(join(dir, 'words.json'), JSON.stringify({ verdict: hostile, summary: `The session ended. ${hostile}`, improvementsTitle: hostile }))
cli(['--render', dir, '--json'])
process.stdout.write(`${dir}\n`)
