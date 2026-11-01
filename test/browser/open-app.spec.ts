import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { openApp } from '../../src/cli/open-app.js'
import { APP_URL } from './app-url.js'

// The browser handoff of bare orangu, serve and feedback (src/cli/open-app.ts): the opener gets a file:// redirect page,
// never the capability URL. The meta refresh from file:// is a cross-site navigation, so the server must let a top-level
// document navigation reach the app page (src/serve/server.ts), or the browser lands on a 403 page.
test('the redirect page of the browser handoff lands on the app with no cross-site refusal', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  const opened: string[] = []
  const handoff = await openApp(APP_URL, {
    env: { ORANGU_HOME: mkdtempSync(join(tmpdir(), 'orangu-browser-open-')) },
    open: (target) => opened.push(target),
    onExit: () => undefined,
  })
  try {
    expect(handoff.note).toBeUndefined()
    expect(opened).toEqual([handoff.page])
    const landed = page.waitForResponse((response) => response.url().startsWith(APP_URL) && response.request().isNavigationRequest())
    await page.goto(pathToFileURL(handoff.page!).href)
    const response = await landed
    expect((await response.request().allHeaders())['sec-fetch-site'], 'a file:// page navigates cross-site').toBe('cross-site')
    expect(response.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(page.url().startsWith(APP_URL)).toBe(true)
    expect(await page.content()).not.toContain('cross-site browser GET blocked')
    expect(errors).toEqual([])
  } finally {
    handoff.remove()
  }
})
