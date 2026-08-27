import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pages = new Map([
  ['/', join(root, 'site', 'index.html')],
  ['/index.html', join(root, 'site', 'index.html')],
  ['/sample.html', join(root, 'site', 'sample.html')],
  ['/assets/report-overview.png', join(root, 'site', 'assets', 'report-overview.png')],
])
const contentType = (file) => (file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8')

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
