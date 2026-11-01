/**
 * The start view of serve (#start), B8: each zoom tab by a click in the light and the dark projects, the hash and the
 * selected tab after each click, no page overflow at 390 px and at 1440 px against the viewport of the project, and 0
 * console errors. The fixture of test/browser/app-server.ts has 3 sessions (1 live, 1 idle, 1 ended), a store whose
 * queue has 1 item due for a check, and no interview profile.
 */
import { expect, test, type Page } from '@playwright/test'
import { APP_URL } from './app-url.js'
import { paintedTheme, projectTheme, withTheme } from './theme.js'

const APP = APP_URL

/**
 * The page is no wider than the viewport of the project. A narrow project emulates a phone (`isMobile`), and there the
 * layout viewport grows with the content, so `innerWidth` grows with an overflow and cannot show it.
 */
async function noHorizontalOverflow(page: Page): Promise<void> {
  const viewport = page.viewportSize()!.width
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport + 1)
}

function runtimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

const ZOOMS = [
  ['session', 'One session'],
  ['sessions', 'Sessions and agents'],
  ['machine', 'This machine'],
] as const

test('each zoom tab by a click: the hash keeps the theme, the tab is selected, its panel shows, and nothing overflows', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const dark = projectTheme(info) === 'dark'
  await page.goto(withTheme(`${APP}/#start`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'See what your agents do.' })).toBeVisible()
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  // the start view has its own head: no audience control and no export
  await expect(page.locator('.page-head')).toHaveCount(0)
  await expect(page.locator('.start-line')).toContainText('3 sessions')
  await expect(page.locator('.start-line')).toContainText('1 running')
  await expect(page.locator('.start-line')).toContainText('1 root')
  // the Start item leads the sidebar, with its house, and it is the current page
  const start = page.locator('nav[aria-label="Report"] a[aria-current="page"]')
  await expect(start).toHaveText('Start')
  await expect(start.locator('svg.navicon')).toHaveCount(1)
  const tabs = page.getByRole('tablist', { name: 'Zoom' })
  // 1 session is live in the fixture, so the view opens at One session
  await expect(tabs.getByRole('tab', { name: 'One session' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toContainText('Running now')
  await noHorizontalOverflow(page)

  for (const [zoom, name] of [ZOOMS[2], ZOOMS[1], ZOOMS[0]]) {
    const tab = tabs.getByRole('tab', { name })
    await tab.click()
    await expect(page).toHaveURL(new RegExp(`#start\\?(?:.*&)?zoom=${zoom}(?:&|$)`))
    if (dark) await expect(page).toHaveURL(/[?&]theme=dark(?:&|$)/)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(tab).toHaveAttribute('tabindex', '0')
    await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1)
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `zt-${zoom}`)
    expect(await paintedTheme(page)).toBe(projectTheme(info))
    if (zoom === 'machine') {
      // nothing reads the machine until the person asks: then its 4 totals, the harness wells and its findings show
      await expect(page.locator('#start-panel .zp-k')).toHaveText('This machine has 3 sessions.')
      await noHorizontalOverflow(page)
      await page.getByRole('button', { name: 'Read this machine' }).click()
      await expect(page.locator('#start-panel .kpi:not(.skel)')).toHaveCount(4)
      await expect(page.locator('#start-panel .zp-k')).toContainText('sessions on this machine.')
      await expect(page.locator('#start-panel .wells')).not.toHaveAttribute('aria-busy', 'true')
      await expect(page.locator('#start-panel .well').nth(1)).toContainText('skill')
      await expect(page.locator('.start-first .frow').first()).toContainText('Improvement:')
      await expect(page.locator('.start-first .fwhere').first()).toContainText('on this machine')
    }
    if (zoom === 'sessions') {
      await expect(page.locator('#start-panel a.srow')).toHaveCount(3)
      await expect(page.locator('#start-panel a.srow').first()).toContainText('running')
      // the findings of the listed sessions, from their reads, with a count of the sessions read
      await expect(page.locator('.start-first .fwhere').first()).toContainText('sessions on this list')
    }
    // the live session of the fixture has no finding
    if (zoom === 'session') await expect(page.locator('.start-first')).toContainText('orangu found nothing to improve in this session.')
    await noHorizontalOverflow(page)
  }

  // below the panel: the queue line of the fixture store and the Next card
  await expect(page.locator('.start-first .banner')).toContainText('due for a check.')
  await expect(page.locator('.start-next')).toContainText('Interview: not yet.')
  await expect(page.locator('.start-next button[data-copy="/orangu:improve"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('the zoom tabs move by key: the arrows wrap, Home and End jump, and the focus stays on the selected tab', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the keys do not depend on the theme or the width')
  const errors = runtimeErrors(page)
  await page.goto(`${APP}/#start`, { waitUntil: 'domcontentloaded' })
  const tab = (name: string) => page.getByRole('tab', { name })
  const selected = async (name: string, zoom: string) => {
    await expect(tab(name)).toHaveAttribute('aria-selected', 'true')
    await expect(tab(name)).toBeFocused()
    await expect(page).toHaveURL(new RegExp(`zoom=${zoom}(?:&|$)`))
  }
  await tab('One session').focus()
  await page.keyboard.press('ArrowRight')
  await selected('Sessions and agents', 'sessions')
  await page.keyboard.press('End')
  await selected('This machine', 'machine')
  await page.keyboard.press('ArrowRight')
  await selected('One session', 'session')
  await page.keyboard.press('ArrowLeft')
  await selected('This machine', 'machine')
  await page.keyboard.press('Home')
  await selected('One session', 'session')
  // 1 tab stop for the tablist: the next Tab goes into the panel
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tabpanel')).toBeFocused()
  expect(errors).toEqual([])
})

test('a render keeps the focus on the same control: a tab while the machine read reports its progress, and the panel after Read again', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the focus does not depend on the theme or the width')
  const errors = runtimeErrors(page)
  // a read that never ends: each 202 body draws the view again, about each 800 ms
  await page.route('**/api/global', (route) => route.fulfill({ status: 202, json: { progress: { done: 4, total: 11 } } }))
  await page.goto(`${APP}/#start?zoom=machine`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Read this machine' }).click()
  await expect(page.getByText('Reading 4 of 11 sessions.')).toBeVisible()
  // the control left the page, so the focus went to the panel
  await expect(page.locator('#start-panel')).toBeFocused()
  const tab = page.getByRole('tab', { name: 'This machine' })
  await tab.focus()
  await page.locator('#start-panel').evaluate((el) => el.setAttribute('data-drawn-before', ''))
  await expect(page.locator('#start-panel')).not.toHaveAttribute('data-drawn-before')
  await expect(tab).toBeFocused()

  // a read that fails, then Read again: the focus goes to the panel, and a later render keeps it there
  await page.unrouteAll()
  await page.route('**/api/global', (route) => route.fulfill({ status: 503, json: { error: 'aggregate capacity reached' } }))
  await page.goto('about:blank')
  await page.goto(`${APP}/#start?zoom=machine`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Read this machine' }).click()
  await page.getByRole('button', { name: 'Read again' }).click()
  await expect(page.getByRole('button', { name: 'Read again' })).toBeVisible()
  await expect(page.locator('#start-panel')).toBeFocused()
  // the browser logs each refused read: those 2 are the stub, and nothing else may log an error
  expect(errors.filter((error) => !error.includes('503'))).toEqual([])
})

test('the view starts no read of every session: the listed rows fill from their own reads, and only a control reads the machine', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the reads do not depend on the theme or the width')
  const errors = runtimeErrors(page)
  // the 3 reads that analyze each session of serve before their first reply
  const heavy: string[] = []
  const sessionReads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (/\/api\/(?:repo|global|harness)$/.test(path)) heavy.push(path.replace(/^.*\/api\//, '/api/'))
    if (/\/api\/session\//.test(path)) sessionReads.push(path)
  })
  await page.goto(`${APP}/#start?zoom=sessions`, { waitUntil: 'domcontentloaded' })
  const rows = page.locator('#start-panel a.srow')
  await expect(rows).toHaveCount(3)
  // serve did not analyze the ended session of the fixture, so its row fills from its own read
  await expect(rows.nth(2)).toContainText('Fix foo test')
  await expect(rows.nth(2)).toContainText('orchestrator')
  await expect(rows.nth(2).locator('.sk')).toContainText('tokens')
  await expect(page.locator('.start-first .cap').nth(1)).toHaveText('They come from the sessions on this list. Each title, each saving and each command use one example session.')
  await page.getByRole('tab', { name: 'One session' }).click()
  await expect(page.getByRole('tabpanel')).toContainText('Running now')
  await page.getByRole('tab', { name: 'This machine' }).click()
  await expect(page.getByRole('button', { name: 'Read this machine' })).toBeVisible()
  expect(heavy).toEqual([])
  expect(sessionReads.length).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Read this machine' }).click()
  await expect(page.locator('#start-panel .kpi:not(.skel)')).toHaveCount(4)
  await expect(page.locator('#start-panel .wells')).not.toHaveAttribute('aria-busy', 'true')
  expect(heavy).toContain('/api/global')
  expect(heavy).toContain('/api/harness')
  expect(heavy).not.toContain('/api/repo')
  expect(errors).toEqual([])
})

test('a file report has no start view: #start lands on the default screen of the file, with no Start item', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the route does not depend on the theme or the width')
  const errors = runtimeErrors(page)
  for (const [file, heading] of [['sample.html', 'Overview'], ['sample-repo.html', 'Repo']] as const) {
    await page.goto(`http://127.0.0.1:4173/${file}#start`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(page.locator('nav[aria-label="Report"] a[aria-current="page"]')).toContainText(heading)
    await expect(page.locator('nav[aria-label="Report"] a', { hasText: 'Start' })).toHaveCount(0)
    await expect(page.locator('#start-panel')).toHaveCount(0)
  }
  expect(errors).toEqual([])
})

test('the links of the start view keep the dark theme: the machine report, then back, then the session', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-dark', 'a link that drops the theme shows only in a dark project')
  const errors = runtimeErrors(page)
  await page.goto(`${APP}/#start?zoom=machine&theme=dark`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('tab', { name: 'This machine' })).toHaveAttribute('aria-selected', 'true')
  await page.locator('#start-panel').getByRole('link', { name: 'Open the machine report' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Global' })).toBeVisible()
  await expect(page).toHaveURL(/#global\?.*theme=dark/)
  expect(await paintedTheme(page)).toBe('dark')
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'This machine' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'One session' }).click()
  await page.getByRole('link', { name: 'Open the session' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  expect(await paintedTheme(page)).toBe('dark')
  expect(errors).toEqual([])
})
