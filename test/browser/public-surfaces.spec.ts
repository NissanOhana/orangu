import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { APP_URL } from './app-url.js'

const SITE = 'http://127.0.0.1:4173'
const APP = APP_URL
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'
const EXPECTED_BRAND_SOURCE = `data:image/png;base64,${readFileSync(new URL('../../design/brand/mascot-96.png', import.meta.url)).toString('base64')}`
const CHANGE_CLASSES = [
  'Instruction files',
  'Scripts and CLIs',
  'Hooks',
  'Skills to create',
  'Skills to discover',
  'Subagents and agents',
  'MCP servers',
  'Plugins',
  'Workflow and configuration',
]

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
  await expect(page.getByRole('link', { name: /See the observe-to-proposal sample/ })).toBeVisible()
  const sampleLinks = page.locator('a[href="sample.html"]')
  await expect(sampleLinks).toHaveCount(2)
  for (const sampleLink of await sampleLinks.all()) {
    await expect(sampleLink).toHaveAttribute('target', '_blank')
    await expect(sampleLink).toHaveAttribute('rel', /(?:^|\s)noopener(?:\s|$)/)
  }

  const jobs = page.getByRole('link', { name: 'Two jobs' })
  await jobs.focus()
  await expect(jobs).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#jobs$/)

  await page.getByRole('button', { name: /Inspect a session/ }).first().click()
  await expect(page.getByRole('button', { name: /Copied/ }).first()).toBeVisible()

  const demo = page.locator('#appdemo')
  const motion = demo.locator('#demoMotion')
  await expect(motion).toHaveAccessibleName('Pause automatic preview')
  await motion.click()
  await expect(motion).toHaveAccessibleName('Play automatic preview')
  const suggestions = demo.locator('.demo-view[data-demo-view="suggest"]')
  await expect(demo.locator('.demo-view.on')).toHaveCount(1)
  await expect(suggestions).toHaveClass(/\bon\b/)
  await expect(demo.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('aria-selected', 'true')
  await expect(suggestions.locator('.demo-proposal')).toContainText('Proposal.')
  await expect(suggestions.locator('.demo-proposal')).toContainText('deterministic check with explicit pass and fail output')
  await expect(suggestions.locator('.demo-verify')).toContainText('Next-run verification.')
  await expect(suggestions.locator('.demo-verify')).toContainText('average failed test runs decreased')
  await expect(suggestions.locator('.demo-verify')).toContainText('without increasing tool errors')
  expect(await suggestions.locator('.demo-types span').allTextContents()).toEqual(CHANGE_CLASSES)

  await demo.getByRole('tab', { name: 'Overview' }).click()
  await expect(demo.locator('.demo-view.on')).toHaveAttribute('data-demo-view', 'overview')
  await expect(demo.getByText('Understand the run. Improve what happens next.')).toBeVisible()
  await demo.getByRole('tab', { name: 'Timeline' }).click()
  await expect(demo.locator('.demo-view.on')).toHaveAttribute('data-demo-view', 'timeline')
  await expect(demo.getByText('error result stays on this call')).toBeVisible()
  await demo.getByRole('tab', { name: 'Tools & calls' }).click()
  await expect(demo.locator('.demo-view.on')).toHaveAttribute('data-demo-view', 'tools')
  await expect(demo.getByText('Usage · errors · latency')).toBeVisible()
  await demo.getByRole('tab', { name: 'Tools & calls' }).focus()
  await page.keyboard.press('End')
  await expect(demo.locator('.demo-view.on')).toHaveAttribute('data-demo-view', 'suggest')
  await expect(demo.getByRole('tab', { name: 'Suggestions' })).toBeFocused()
  await expect(demo.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('aria-selected', 'true')
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('qtc-triad canvas')).toHaveCount(1)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(info.project.name.endsWith('dark'))
  expect(errors).toEqual([])
})

test('landing preview cycles while visible and becomes static for reduced motion', async ({ browser }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one deterministic animation lifecycle is sufficient')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference' })
  const page = await context.newPage()
  const errors = runtimeErrors(page)
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await page.goto(`${SITE}/#demo`, { waitUntil: 'domcontentloaded' })
  const demo = page.locator('#appdemo')
  await demo.scrollIntoViewIfNeeded()
  await expect(demo.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('aria-selected', 'true')
  const focusedBefore = await page.evaluate(() => document.activeElement?.tagName)
  await expect.poll(() => demo.locator('[role="tab"][aria-selected="true"]').textContent(), { timeout: 5_500 }).toBe('Overview')
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focusedBefore)

  const motion = demo.locator('#demoMotion')
  await expect(motion).toHaveAccessibleName('Pause automatic preview')
  await motion.click()
  const pausedView = await demo.locator('[role="tab"][aria-selected="true"]').textContent()
  await page.waitForTimeout(3_900)
  await expect(demo.locator('[role="tab"][aria-selected="true"]')).toHaveText(pausedView ?? '')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(demo.getByRole('button', { name: /Automatic preview disabled by reduced motion preference/ })).toBeDisabled()
  expect(errors).toEqual([])
  await context.close()
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
    const textSelectors = ['.eyebrow', '.hero-lead', '.hero-journey li', '.hero-copy > .fine']
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
    const visual = document.querySelector<HTMLCanvasElement>('.hero-viz canvas')!.getBoundingClientRect()
    const hero = document.querySelector<HTMLElement>('.hero')!.getBoundingClientRect()
    const jobs = document.querySelector<HTMLElement>('#jobs')!.getBoundingClientRect()
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
  // The canvas intentionally has transparent space around the drawing, so compare
  // its visual centre with the copy edge instead of treating the canvas box as ink.
  expect(geometry.visualCenterOffset, JSON.stringify(geometry)).toBeGreaterThan(0)
  expect(geometry.visualCenterOffset, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportWidth * 0.2)
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

test('generated sample and localhost overview "where to look next" links navigate to real app screens', async ({ page }, info) => {
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
      const capability = page.locator(`.where-next a[data-screen="${screen}"]`)
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
