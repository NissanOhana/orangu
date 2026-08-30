import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
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
])
const contentType = (file) =>
  file.endsWith('.txt') ? 'text/plain; charset=utf-8' : file.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/html; charset=utf-8'

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
