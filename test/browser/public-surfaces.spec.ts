import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const SITE = 'http://127.0.0.1:4173'
const APP = 'http://127.0.0.1:4174'
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'
const EXPECTED_BRAND_SOURCE = `data:image/png;base64,${readFileSync(new URL('../../design/brand/mascot-96.png', import.meta.url)).toString('base64')}`

function runtimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const report = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className,
          text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        }
      })
      .filter((item) => item.left < -1 || item.right > window.innerWidth + 1)
      .slice(0, 12),
  }))
  expect(report.document, JSON.stringify(report)).toBeLessThanOrEqual(report.viewport + 1)
}

async function rasterBrandSource(page: Page): Promise<string> {
  const brand = page.locator('.brand img.logo').first()
  await expect(brand).toBeVisible()
  await expect(page.locator('svg.logo')).toHaveCount(0)
  const source = await brand.getAttribute('src')
  expect(source).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
  const image = await brand.evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    width: element.naturalWidth,
    height: element.naturalHeight,
  }))
  expect(image.complete).toBe(true)
  expect(image.width).toBe(96)
  expect(image.height).toBe(96)
  expect(source).toBe(EXPECTED_BRAND_SOURCE)
  return source!
}

test('landing communicates the observe-to-improve loop and remains keyboard operable', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  // Keep visual QA deterministic and independent of the optional hosted font.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE })
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Turn your AI history into actionable insights.')
  await expect(page.locator('.hero .hero-lead')).toHaveText("Orangu reads your local AI sessions so you don't have to guess what went right (or wrong).")
  await expect(page.locator('.hero-journey .hero-step')).toHaveText([
    'Inspect: Dive deep into steps and tool calls from a single run.',
    'Discover: Spot recurring patterns across your whole repository.',
    'Improve: Use real evidence to build smarter, faster workflows.',
  ])
  await expect(page.getByRole('button', { name: /Inspect a session/ }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /See a real report/ }).first()).toBeVisible()
  const sampleLinks = page.locator('a[href="sample.html"]')
  await expect(sampleLinks).toHaveCount(3)
  for (const sampleLink of await sampleLinks.all()) {
    await expect(sampleLink).toHaveAttribute('target', '_blank')
    await expect(sampleLink).toHaveAttribute('rel', /(?:^|\s)noopener(?:\s|$)/)
  }

  const what = page.getByRole('link', { name: 'What it does' })
  await what.focus()
  await expect(what).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#what$/)

  await page.getByRole('button', { name: /Inspect a session/ }).first().click()
  await expect(page.getByRole('button', { name: /Copied/ }).first()).toBeVisible()

  // the hero visual is the real report screenshot; a missing static-server route would fail this
  const heroShot = page.locator('.hero-viz img')
  await expect(heroShot).toBeVisible()
  expect(await heroShot.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('qtc-triad')).toHaveAttribute('role', 'img')
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('qtc-triad canvas')).toHaveCount(1)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(info.project.name.endsWith('dark'))
  expect(errors).toEqual([])
})

test('wide landing keeps a two-line hero and the visual beside the copy above the fold', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the 1440px geometry contract only needs one deterministic theme')
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)

  const geometry = await page.evaluate(() => {
    const h1 = document.querySelector<HTMLHeadingElement>('.hero h1')!
    const spans = Array.from(h1.querySelectorAll<HTMLSpanElement>(':scope > span'))
    const lineRects = (element: Element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    }
    const spanLines = spans.map((span) => {
      const rects = lineRects(span)
      const tops = [...new Set(rects.map((rect) => Math.round(rect.top)))]
      return { text: span.textContent?.trim(), lines: tops.length, top: Math.min(...tops), right: Math.max(...rects.map((rect) => rect.right)) }
    })
    const textSelectors = ['.hero-lead', '.hero-journey li', '.hero-copy > .fine']
    const contentRights = textSelectors.flatMap((selector) => {
      const element = document.querySelector(selector)
      return element ? lineRects(element).map((rect) => rect.right) : []
    })
    contentRights.push(...spanLines.map((line) => line.right))
    contentRights.push(
      ...Array.from(document.querySelectorAll<HTMLElement>('.hero-copy .cta-row > *')).map(
        (element) => element.getBoundingClientRect().right,
      ),
    )
    const copy = document.querySelector<HTMLElement>('.hero-copy')!.getBoundingClientRect()
    const visual = document.querySelector<HTMLElement>('.hero-viz .hero-shot')!.getBoundingClientRect()
    const hero = document.querySelector<HTMLElement>('.hero')!.getBoundingClientRect()
    const jobs = document.querySelector<HTMLElement>('#what')!.getBoundingClientRect()
    const copyRight = Math.max(...contentRights)
    return {
      spans: spanLines,
      visualCenterOffset: visual.left + visual.width / 2 - copyRight,
      verticalOverlap: Math.min(copy.bottom, visual.bottom) - Math.max(copy.top, visual.top),
      heroHeight: hero.height,
      jobsTop: jobs.top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }
  })

  expect(geometry.spans.map(({ text }) => text)).toEqual(['Turn your AI history', 'into actionable insights.'])
  expect(geometry.spans.map(({ lines }) => lines)).toEqual([1, 1])
  expect(geometry.spans[1]!.top).toBeGreaterThan(geometry.spans[0]!.top)
  // Compare the screenshot frame's centre with the copy edge: beside the copy, not below it, and
  // not pushed to the far edge. The old canvas had transparent margins that pulled its centre in;
  // a framed screenshot has none, so the ceiling is 25% of the viewport instead of 20%.
  expect(geometry.visualCenterOffset, JSON.stringify(geometry)).toBeGreaterThan(0)
  expect(geometry.visualCenterOffset, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportWidth * 0.25)
  expect(geometry.verticalOverlap, JSON.stringify(geometry)).toBeGreaterThan(0)
  expect(geometry.heroHeight, JSON.stringify(geometry)).toBeLessThan(geometry.viewportHeight * 0.9)
  expect(geometry.jobsTop, JSON.stringify(geometry)).toBeLessThan(geometry.viewportHeight)
})

test('landing contains the hero visual across desktop breakpoints', async ({ browser }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one deterministic desktop breakpoint matrix is sufficient')
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'light', isMobile: false })
  const page = await context.newPage()
  const errors = runtimeErrors(page)
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  for (const width of [900, 1024, 1100, 1200]) {
    await page.setViewportSize({ width, height: 900 })
    await expectNoHorizontalOverflow(page)
  }
  expect(errors).toEqual([])
  await context.close()
})

test('generated sample exposes outcome, timeline, subagent evidence, and both language levels', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const external: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:4173') external.push(request.url())
  })
  await page.goto(`${SITE}/sample.html#overview`, { waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('note')).toContainText('Illustrative synthetic sample.')
  await expect(page.getByRole('note')).toContainText('made-up input')
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expect(page.getByRole('button', { name: 'Detailed' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Plain language' }).click()
  await expect(page.getByRole('button', { name: 'Plain language' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/audience=plain/)

  const timeline = page.getByRole('link', { name: 'Timeline', exact: true })
  await timeline.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible()
  await expect(page.locator('.turn')).not.toHaveCount(0)
  await expect(page.getByText(/subagent|helper (?:task|step)/i).first()).toBeVisible()
  await page.getByRole('button', { name: /With agents/ }).click()
  const agentTurn = page.locator('details.turn').first()
  await agentTurn.locator('summary').click()
  const actors = await agentTurn.locator('.evline .pill').allTextContents()
  expect(actors.some((actor) => actor.trim() !== 'main')).toBe(true)

  await expectNoHorizontalOverflow(page)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(info.project.name.endsWith('dark'))
  expect(external).toEqual([])
  expect(errors).toEqual([])
})

test('generated sample and served app use the same embedded raster brand', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the self-contained brand contract is theme and viewport independent')
  const errors = runtimeErrors(page)
  await page.goto(`${SITE}/sample.html#overview`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  const sampleBrand = await rasterBrandSource(page)

  await page.goto(`${APP}/#overview?s=${SESSION}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  const servedBrand = await rasterBrandSource(page)
  expect(servedBrand).toBe(sampleBrand)
  expect(errors).toEqual([])
})

test('generated sample and localhost overview capability cards navigate to real app screens', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one deterministic capability-navigation contract is sufficient')
  const errors = runtimeErrors(page)
  const surfaces = [
    { overview: `${SITE}/sample.html#overview?audience=plain`, session: '' },
    { overview: `${APP}/#overview?s=${SESSION}&audience=plain`, session: SESSION },
  ]
  for (const surface of surfaces) {
    for (const [screen, heading] of [['timeline', 'Timeline'], ['tools', 'Tools & calls'], ['suggest', 'Improve the next outcome']] as const) {
      await page.goto(surface.overview, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
      const capability = page.locator(`.cap-card[data-capability="${screen}"]`)
      await expect(capability).toBeVisible()
      await expect(capability).toHaveAttribute('href', new RegExp(`^#${screen}\\?s=.+audience=plain`))
      await capability.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      if (surface.session) await expect(page).toHaveURL(new RegExp(`s=${surface.session}`))
    }
  }
  expect(errors).toEqual([])
})

test('generated sample fits a 390px resized desktop viewport', async ({ browser }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one dedicated non-mobile narrow context is sufficient')
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: false })
  const page = await context.newPage()
  const errors = runtimeErrors(page)
  await page.goto(`${SITE}/sample.html`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  const findingTitle = await page.locator('details.finding > summary > b').first().boundingBox()
  expect(findingTitle?.width).toBeGreaterThan(180)
  expect(findingTitle?.height).toBeLessThan(90)
  expect(errors).toEqual([])
  await context.close()
})
