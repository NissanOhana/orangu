#!/usr/bin/env node
// Regenerate site/assets/report-overview.png: the landing page's proof image.
//
//   node scripts/site-screenshot.mjs [--session <id|latest>] [--out site/assets/report-overview.png]
//                                    [--html <already-rendered report>] [--height <px>] [--project <label>]
//
// DEVELOPER-ONLY. Never call this from a test, from `npm run verify`, or from a workflow: it needs
// dist/orangu.js, a local session, and a Playwright Chromium download that CI does not guarantee.
//
// What it does, end to end:
//   1. renders the session with `--include-text --strip-paths` (finding titles need text today;
//      strip-paths reduces absolute paths to basenames so no home directory is legible),
//   2. serves the temp dir from node:http on 127.0.0.1 (random port),
//   3. opens #overview at 1280 wide, light theme, reduced motion (freezes animation so reruns compare),
//   4. hides the illustrative-sample note if present, replaces the sidebar's project slug (the local
//      folder name, which embeds the home directory and is not covered by --strip-paths) with
//      --project (default: the repository's basename), and screenshots the viewport,
//   5. writes the PNG and prints its byte size + sha256 so the digest can be pasted into
//      scripts/assert-public-tree.mjs (`binaryDigests`).
//
// Review the PNG at 100% and read every visible string before committing. It is published as-is.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const ix = args.indexOf(name)
  return ix >= 0 && args[ix + 1] ? args[ix + 1] : fallback
}
const session = flag('--session', 'latest')
const out = resolve(root, flag('--out', 'site/assets/report-overview.png'))
const prerendered = flag('--html', '')
const height = Number(flag('--height', '900'))
const projectLabel = flag('--project', basename(root))
const width = 1280

const cli = join(root, 'dist/orangu.js')
if (!prerendered && !existsSync(cli)) {
  console.error('missing dist/orangu.js: run `npm run build` first')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'orangu-shot-'))
const htmlPath = join(dir, 'overview.html')
if (prerendered) {
  writeFileSync(htmlPath, readFileSync(resolve(root, prerendered)))
} else {
  execFileSync(process.execPath, [cli, 'report', session, '--include-text', '--strip-paths', '--no-open', '--quiet', '-o', htmlPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

// ~15-line throwaway static server; deliberately not the browser-test server.
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (basename(path) !== basename(htmlPath)) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(readFileSync(htmlPath))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const url = `http://127.0.0.1:${server.address().port}/${basename(htmlPath)}#overview`

const { chromium } = await import('@playwright/test')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const errors = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('main.main .overview-hero', { timeout: 30_000 })
  await page.evaluate((label) => {
    for (const note of document.querySelectorAll('.sample-note')) note.remove()
    const sid = document.querySelector('.sesscard .sid')
    if (sid) sid.textContent = (sid.textContent ?? '').replace(/ · .*$/, ` · ${label}`)
    document.documentElement.setAttribute('data-theme', 'light')
  }, projectLabel)
  await page.waitForTimeout(250)
  if (errors.length) {
    console.error('console errors while rendering the report:\n' + errors.join('\n'))
    process.exit(1)
  }
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, animations: 'disabled' })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, png)
  const digest = createHash('sha256').update(png).digest('hex')
  console.log(`${out.replace(root + '/', '')}: ${png.length} bytes, ${width}x${height}, sha256 ${digest}`)
  console.log('paste that digest into scripts/assert-public-tree.mjs binaryDigests, then review the PNG for readable private text before committing')
} finally {
  await browser.close()
  server.close()
}
