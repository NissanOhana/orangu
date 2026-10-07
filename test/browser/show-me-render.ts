/**
 * The show-me files that the browser spec opens: made by the built CLI (`npm run test:browser` builds it first),
 * never by a test fill. One fixture session in a temp Claude home, `orangu show-me <session>` to prepare, then
 * `orangu show-me --render`, twice:
 * - hostile: hostile words in words.json;
 * - long: the 5 longest improvement texts that the rules ship (read from src/analyze/insights.ts), so a rule
 *   rewrite that makes a slide overflow fails the spec.
 * Prints {"hostile": "<dir>", "long": "<dir>"} on stdout, for test/browser/static-server.mjs to serve.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../fixtures/home.js'
import { longestImprovements } from '../fixtures/rule-improvements.js'

const root = join(import.meta.dirname, '..', '..')
const temp = await mkdtemp(join(tmpdir(), 'orangu-browser-show-me-'))
const repo = join(temp, 'repo')
await mkdir(repo, { recursive: true })
const home = await makeFixtureHome(join(temp, 'claude'), { cwd: repo })
const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(temp, 'home'), XDG_DATA_HOME: join(temp, 'data'), CLAUDE_CONFIG_DIR: home.configDir, ORANGU_CLAUDE_ROOTS: home.configDir, ORANGU_NO_CACHE: '1' }
delete env['ORANGU_HOME']
const cli = (args: string[]): string => execFileSync(process.execPath, [join(root, 'dist', 'orangu.js'), 'show-me', ...args], { encoding: 'utf8', env })
const prepare = (): string => (JSON.parse(cli([home.endedId, '--json'])) as { dir: string }).dir

// the hostile words of the security review, plus 2 that would set a mark if they ran
const hostileDir = prepare()
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
await writeFile(join(hostileDir, 'words.json'), JSON.stringify({ verdict: hostile, summary: `The session ended. ${hostile}`, improvementsTitle: hostile }))
cli(['--render', hostileDir, '--json'])

// 5 findings whose improvements are the 5 longest that the rules ship: the 3 finding slides and the
// Improvements slide each show the longest texts
const longDir = prepare()
const data = JSON.parse(await readFile(join(longDir, 'data.json'), 'utf8')) as { insights: Array<Record<string, unknown>>; summary: { topInsightIds: string[] } }
const model = data.insights[0]!
data.insights = longestImprovements(5).map((improvement, i) => ({ ...model, id: `long-${i + 1}`, improvement, recommendation: improvement }))
data.summary.topInsightIds = ['long-1', 'long-2', 'long-3']
await writeFile(join(longDir, 'data.json'), JSON.stringify(data, null, 2))
await writeFile(join(longDir, 'words.json'), JSON.stringify({ verdict: 'The session ended on a clean check.', summary: 'The session changed 1 file.', improvementsTitle: 'Five changes for the next session' }))
cli(['--render', longDir, '--json'])

process.stdout.write(`${JSON.stringify({ hostile: hostileDir, long: longDir })}\n`)
