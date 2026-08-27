import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
]
const before = new Map(generated.map((path) => [path, readFileSync(join(root, path))]))

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

const stale = generated.filter((path) => !before.get(path)?.equals(readFileSync(join(root, path))))
if (stale.length > 0) {
  process.stderr.write(`generated artifacts are stale: ${stale.join(', ')}\n`)
  process.stderr.write('run npm run build, node scripts/build.mjs --site, and npm run build:sample; then commit the results\n')
  process.exit(1)
}

process.stdout.write(`generated artifacts are current (${generated.join(', ')})\n`)
