import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const generated = [
  'plugin/bin/orangu.cli.mjs',
  'plugins/orangu/bin/orangu.cli.mjs',
  'plugins/orangu/assets/icon.png',
  'plugins/orangu/assets/logo.png',
  'src/report/generated/client-bundle.ts',
  'site/index.html',
  'site/llms.txt',
  'site/llms-full.txt',
  'site/sample.html',
  'site/sample-repo.html',
]
// Generated directories: the Codex skill mirror. Every path under them is compared, so an added or
// removed mirror file is caught, not only a changed one.
const generatedDirs = ['.agents/skills', 'plugins/orangu/skills']

function filesUnder(dir) {
  const files = []
  const walk = (current) => {
    if (!existsSync(join(root, current))) return
    for (const entry of readdirSync(join(root, current)).sort()) {
      const path = `${current}/${entry}`
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(dir)
  return files
}

const snapshot = () => new Map(
  [...generated, ...generatedDirs.flatMap(filesUnder)].map((path) => [path, readFileSync(join(root, path))]),
)
const before = snapshot()

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
}

run(['scripts/build.mjs', '--site'])
run(['--import', 'tsx', 'scripts/build-sample.ts'])

const after = snapshot()
const stale = [...new Set([...before.keys(), ...after.keys()])]
  .filter((path) => !before.get(path) || !after.get(path) || !before.get(path).equals(after.get(path)))
if (stale.length > 0) {
  process.stderr.write(`generated artifacts are stale: ${stale.join(', ')}\n`)
  process.stderr.write('run npm run build, node scripts/build.mjs --site, and npm run build:sample; then commit the results\n')
  process.exit(1)
}

process.stdout.write(`generated artifacts are current (${[...generated, ...generatedDirs.map((d) => `${d}/**`)].join(', ')})\n`)
