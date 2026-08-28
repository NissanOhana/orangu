// Developer-only: renders the landing hero (with the 3D triad) at 1200x630 as the link-unfurl card.
//   node scripts/og-card.mjs   -> site/assets/og.png ; then paste the printed digest into scripts/assert-public-tree.mjs
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = resolve('site/assets/og.png')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' })
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }))
await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ status: 204, body: '' }))
await page.goto(pathToFileURL(resolve('site/index.html')).href, { waitUntil: 'load' })
await page.waitForTimeout(1800) // let the triad settle
await page.evaluate(() => {
  document.querySelector('.ann')?.remove()
  document.querySelector('.hdr')?.remove()
  window.scrollTo(0, 0)
})
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } })
await browser.close()
console.log('wrote', out, createHash('sha256').update(readFileSync(out)).digest('hex'))
