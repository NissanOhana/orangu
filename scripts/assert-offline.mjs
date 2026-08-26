// Offline gate.
//   node scripts/assert-offline.mjs                 render the latest session via dist/orangu.js and check it
//   node scripts/assert-offline.mjs --file <html>   check an already-rendered report file
//   node scripts/assert-offline.mjs --site          check site/index.html (fonts + explicit documentation/repository links allowed)
// Report checks exclude the embedded `#orangu-data` JSON block: data (e.g. outcomes.prLinks) may cite
// https:// URLs as text — the page itself must still make zero requests.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const fileIx = args.indexOf('--file')

let bad = 0
const fail = (label, sample) => { console.error('FAIL:', label, '->', String(sample).slice(0, 80)); bad++ }

if (args.includes('--site')) {
  const path = 'site/index.html'
  if (!existsSync(path)) { console.error('missing %s — run: node scripts/build.mjs --site', path); process.exit(1) }
  const html = readFileSync(path, 'utf8')
  const allowedHosts = new Set([
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'github.com',
    'code.claude.com',
    'learn.chatgpt.com',
  ])
  for (const url of html.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) {
    let host = ''
    try { host = new URL(url).host } catch { /* not a real URL */ }
    if (!allowedHosts.has(host)) fail('disallowed origin', url)
  }
  for (const [re, label] of [
    [/\bfetch\s*\(/, 'fetch()'],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/new\s+WebSocket/, 'WebSocket'],
    [/<iframe/i, 'iframe'],
    [/@import\s+url/i, '@import url'],
  ]) {
    const m = html.match(re)
    if (m) fail(label, m[0])
  }
  if (bad) process.exit(1)
  console.log('offline OK (site): only allowlisted font, repository, and official documentation origins, %d KB', Math.round(html.length / 1024))
  process.exit(0)
}

let html
if (fileIx >= 0) {
  const path = args[fileIx + 1]
  if (!path || !existsSync(path)) { console.error('missing report file:', path); process.exit(1) }
  html = readFileSync(path, 'utf8')
} else {
  const CLI = 'dist/orangu.js'
  if (!existsSync(CLI)) { console.error('build first'); process.exit(1) }
  html = execFileSync('node', [CLI, 'report', 'latest', '--stdout', '--quiet'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

// Check the full document, including the <head>, where a font <link> or <script src> is the
// likeliest regression). Only two inert spans are excluded:
// the #orangu-data JSON block (data may cite https:// URLs as text) and the <title> text (user text,
// already scrubbed; a URL there is words, not a request).
const text = html
  .replace(/<script type="application\/json" id="orangu-data">[\s\S]*?<\/script>/, '')
  .replace(/<title>[\s\S]*?<\/title>/, '<title></title>')
const checks = [
  [/https?:\/\/(?!localhost|127\.0\.0\.1)/, 'external http(s) URL'],
  [/<link\b/i, '<link> tag'],
  [/<script[^>]*\bsrc\s*=/i, '<script src>'],
  [/<img[^>]+src\s*=\s*["']https?:/i, 'remote image'],
  [/@import\s+url/i, '@import url'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/new\s+WebSocket/, 'WebSocket'],
  [/<iframe/i, 'iframe'],
]
for (const [re, label] of checks) {
  const m = text.match(re)
  if (m) fail(label, m[0])
}
// exact CSP match (src/report/render.ts CSP const) — a loosened directive fails, not just a missing one
const EXPECTED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
if (!html.includes(`<meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP}"/>`)) fail('missing or loosened CSP', '')
if (bad) process.exit(1)
console.log('offline OK: no external references, CSP present, %d KB', Math.round(html.length / 1024))
