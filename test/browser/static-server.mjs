import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// the /orangu:show-me files: rendered by the built CLI before the server listens (test/browser/show-me-render.ts)
const showMe = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', join(root, 'test', 'browser', 'show-me-render.ts')], { cwd: root, encoding: 'utf8' }))
const pages = new Map([
  ['/', join(root, 'site', 'index.html')],
  ['/index.html', join(root, 'site', 'index.html')],
  ['/sample.html', join(root, 'site', 'sample.html')],
  ['/sample-repo.html', join(root, 'site', 'sample-repo.html')],
  ['/404.html', join(root, 'site', '404.html')],
  ['/robots.txt', join(root, 'site', 'robots.txt')],
  ['/sitemap.xml', join(root, 'site', 'sitemap.xml')],
  ['/llms.txt', join(root, 'site', 'llms.txt')],
  ['/llms-full.txt', join(root, 'site', 'llms-full.txt')],
  // the 2 files that `orangu show-me --render` wrote, side by side so their relative links resolve, and the
  // words it rendered, so the spec can look for each one as text
  ['/show-me/slides.html', join(showMe.hostile, 'slides.html')],
  ['/show-me/report.html', join(showMe.hostile, 'report.html')],
  ['/show-me/words.json', join(showMe.hostile, 'words.json')],
  // a deck of the 5 longest improvement texts that the rules ship
  ['/show-me-long/slides.html', join(showMe.long, 'slides.html')],
  ['/show-me-long/report.html', join(showMe.long, 'report.html')],
])
const contentType = (file) =>
  file.endsWith('.txt') ? 'text/plain; charset=utf-8'
  : file.endsWith('.xml') ? 'application/xml; charset=utf-8'
  : file.endsWith('.json') ? 'application/json; charset=utf-8'
  : 'text/html; charset=utf-8'

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const file = pages.get(path)
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' })
  res.end(readFileSync(file))
})

server.listen(4173, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
