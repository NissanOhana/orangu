import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { APP_URL } from './app-url.js'
import { paintedTheme, projectTheme, seedLandingTheme, withTheme } from './theme.js'

const SITE = 'http://127.0.0.1:4173'
const APP = APP_URL
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

/**
 * The page is no wider than the viewport of the project. A narrow project emulates a phone (`isMobile`), and there the
 * layout viewport grows with the content, so `innerWidth` grows with an overflow and cannot show it.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const report = await page.evaluate((viewport) => ({
    viewport,
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
      .filter((item) => item.left < -1 || item.right > viewport + 1)
      .slice(0, 12),
  }), page.viewportSize()!.width)
  expect(report.document, JSON.stringify(report)).toBeLessThanOrEqual(report.viewport + 1)
}

/** WCAG contrast ratio between an element's text colour and the page background, as painted. */
async function contrastOnPage(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const rgb = (value: string) => (value.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number)
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
    }
    const text = luminance(rgb(getComputedStyle(document.querySelector(sel)!).color))
    const ground = luminance(rgb(getComputedStyle(document.body).backgroundColor))
    return (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05)
  }, selector)
}

/**
 * The paint method of contrastOnPage, for each element that `selector` matches, against its own ground: the
 * nearest ancestor (or the element itself) that paints an opaque background.
 */
async function contrastOnOwnGround(page: Page, selector: string): Promise<number[]> {
  return page.evaluate((sel) => {
    const rgb = (value: string) => (value.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 4).map(Number)
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
    }
    const groundOf = (element: Element): number[] => {
      for (let at: Element | null = element; at; at = at.parentElement) {
        const paint = rgb(getComputedStyle(at).backgroundColor)
        if (paint.length === 3 || paint[3] === 1) return paint
      }
      return rgb(getComputedStyle(document.body).backgroundColor)
    }
    return Array.from(document.querySelectorAll(sel)).map((element) => {
      const text = luminance(rgb(getComputedStyle(element).color))
      const ground = luminance(groundOf(element))
      return (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05)
    })
  }, selector)
}

/**
 * The Improvements screen shows one card per cross finding the page embeds. Every card names its
 * improvement while it is closed: the "Improvement:" line, followed by that finding's `improvement` (its
 * whole `recommendation` only for an aggregate written before the rule text had parts). Each title is the
 * example title, and one caption above the cards says that its figures come from one example session.
 */
async function expectImprovementOnEveryClosedCard(page: Page, scope: 'repo' | 'global', where: string): Promise<void> {
  const embedded = await page.evaluate((s) => {
    const data = (window as unknown as { __ORANGU__: { aggregates: Record<string, { crossFindings: Array<{ title: string; exampleTitle?: string; improvement?: string; recommendation?: string }> } | undefined> } }).__ORANGU__
    return (data.aggregates[s]?.crossFindings ?? []).map((f) => ({ lead: f.improvement || f.recommendation || '', title: f.exampleTitle || f.title }))
  }, scope)
  expect(embedded.length, `${where}: embedded cross findings`).toBeGreaterThan(0)
  const cards = page.locator('details.finding')
  await expect(cards, where).toHaveCount(embedded.length)
  const shown: string[] = []
  const titles: string[] = []
  for (let i = 0; i < embedded.length; i++) {
    const card = cards.nth(i)
    await expect(card, `${where} card ${i + 1}`).not.toHaveAttribute('open')
    const lead = card.locator(':scope > summary .sg-lead')
    await expect(lead, `${where} card ${i + 1}`).toBeVisible()
    const text = (await lead.textContent()) ?? ''
    expect(text, `${where} card ${i + 1}`).toMatch(/^Improvement: \S/)
    shown.push(text.slice('Improvement: '.length))
    titles.push((await card.locator(':scope > summary > b').textContent()) ?? '')
  }
  expect([...shown].sort(), `${where}: each card shows its own finding's improvement`).toEqual(embedded.map((f) => f.lead).sort())
  expect([...titles].sort(), `${where}: each card shows its example title`).toEqual(embedded.map((f) => f.title).sort())
  expect(titles.join('\n'), `${where}: no title repeats the marker`).not.toContain('In one session')
  await expect(page.getByText('Each title shows the figures of one example session.'), `${where}: one caption`).toHaveCount(1)
}

/**
 * The Recurring findings card on Repo and Global: each row shows the title of one example session, so one caption
 * under the card title says it, once, above the first row, and no row repeats the "In one session" marker.
 */
async function expectOneRecurringCaption(page: Page, where: string): Promise<void> {
  const recurring = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Recurring findings' }) })
  await expect(recurring, where).toHaveCount(1)
  await expect(page.getByText('Each title shows the figures of one example session.'), `${where}: one caption on the screen`).toHaveCount(1)
  const caption = recurring.locator('.sg-cap')
  await expect(caption, `${where}: the caption in the Recurring findings card`).toHaveText('Each title shows the figures of one example session.')
  await expect(caption, where).toBeVisible()
  expect(await recurring.evaluate((card) => card.querySelector('.sg-cap + .rrow') !== null), `${where}: the caption sits above the first row`).toBe(true)
  await expect(recurring.locator('.rrow', { hasText: 'In one session' }), `${where}: a row repeats the marker`).toHaveCount(0)
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

/** The fonts of the landing come from Google Fonts: the tests answer them empty, so a run reads no network. */
async function routeFonts(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }))
}

/**
 * The boxes of the visible zoom level of the hero that end outside the window: the window clips them, so a reader
 * cannot see their text. The window holds no scroll box, so each box of the level must fit inside it.
 */
async function cutInWindow(page: Page): Promise<string[]> {
  // a level zooms in from scale(2.2) or scale(.96) in 0.6 s: measure it at rest
  await page.waitForFunction(() => {
    const level = document.getElementById(document.querySelector('.ztab[aria-selected="true"]')!.getAttribute('aria-controls')!)!
    return getComputedStyle(level).transform === 'none'
  })
  return page.evaluate(() => {
    const port = document.querySelector('.zoomport')!.getBoundingClientRect()
    // the level of the selected tab: a level that zooms out stays visible while it fades, scaled past the window
    const level = document.getElementById(document.querySelector('.ztab[aria-selected="true"]')!.getAttribute('aria-controls')!)!
    return Array.from(level.querySelectorAll<HTMLElement>('*'))
      .filter((el) => {
        const box = el.getBoundingClientRect()
        return box.width > 0 && (box.left < port.left - 1 || box.right > port.right + 1 || box.bottom > port.bottom + 1)
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 40)}"`)
  })
}

test('landing tells the chain in 6 sections and stays keyboard operable', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  const narrow = info.project.name.startsWith('narrow')
  await routeFonts(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE })
  await seedLandingTheme(page, info)
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Improve your agent harness and your setup.')
  await expect(page.locator('.hero .lead')).toHaveText('Better results with fewer tokens. orangu measures every agent session, proposes changes that fit how you work, and keeps the ones that work.')
  await expect(page.locator('main > section')).toHaveCount(6)
  const sampleLinks = page.locator('a[href="sample.html"]')
  await expect(sampleLinks).toHaveCount(2)
  for (const link of await sampleLinks.all()) {
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /(?:^|\s)noopener(?:\s|$)/)
  }
  // on a phone the header keeps only GitHub and the theme button; on a wide screen a section link moves by the keyboard
  const howItWorks = page.getByRole('link', { name: 'How it works' })
  await expect(page.getByRole('link', { name: /GitHub/ })).toBeVisible()
  if (narrow) await expect(howItWorks).toBeHidden()
  else {
    await howItWorks.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#chain$/)
  }

  // the hero command copies itself and tells a screen reader
  await page.locator('.hero .cmd-btn').click()
  await expect(page.locator('.hero .cmd-btn [data-lbl]')).toHaveText('Copied')
  await expect(page.locator('#copyNote')).toHaveText('Copied to the clipboard.')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx orangu')

  // the zoom tabs: a click and the keys pick a level, and the address in the window follows
  const zoom = page.getByRole('tablist', { name: 'Zoom' })
  await zoom.getByRole('tab', { name: 'Sessions and agents' }).click()
  await expect(page.locator('#hz-p-sessions')).toBeVisible()
  await expect(page.locator('#hz-p-machine')).toBeHidden()
  await expect(page.locator('#hz')).toHaveText('sessions')
  await expect(page.locator('#heroPause')).toHaveText('Replay')
  expect(await cutInWindow(page), 'Sessions and agents').toEqual([])
  await page.keyboard.press('ArrowLeft')
  await expect(zoom.getByRole('tab', { name: 'One session' })).toBeFocused()
  await expect(zoom.getByRole('tab', { name: 'One session' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#hz-p-session')).toBeVisible()
  expect(await cutInWindow(page), 'One session').toEqual([])
  await page.keyboard.press('End')
  await expect(zoom.getByRole('tab', { name: 'This machine' })).toBeFocused()
  await expect(page.locator('#hz')).toHaveText('machine')
  expect(await cutInWindow(page), 'This machine').toEqual([])
  // the field: 6 columns on a wide screen and 4 on a phone, 1 cell for each of the 11 sample sessions
  const columns = await page.locator('.field .cell').evaluateAll((cells) => new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left))).size)
  expect(columns).toBe(narrow ? 4 : 6)
  await expect(page.locator('.field .cell')).toHaveCount(11)

  // the stepper: a click picks a step, the keys move the focus and the step, and only the selected panel shows
  const chain = page.getByRole('tablist', { name: 'The orangu chain' })
  await chain.getByRole('tab', { name: /Improve/ }).click()
  await expect(page.locator('#panel-improve')).toBeVisible()
  await expect(page.locator('#panel-see')).toBeHidden()
  await expect(page.locator('#panel-tune')).toBeHidden()
  await expect(page.locator('#chainPause')).toHaveText('Replay')
  await expect(page.locator('.stepof')).toHaveText('Step 2 of 3')
  await page.keyboard.press('ArrowRight')
  await expect(chain.getByRole('tab', { name: /Tune/ })).toBeFocused()
  await expect(page.locator('#panel-tune')).toBeVisible()
  await expect(page.locator('#panel-improve')).toBeHidden()
  await page.keyboard.press('Home')
  await expect(chain.getByRole('tab', { name: /See/ })).toBeFocused()
  await expect(page.locator('#panel-see')).toBeVisible()
  // a step of the stepper moves nothing below it: the 3 panels share 1 box
  const finds = async () => page.locator('#finds').evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY))
  const below = await finds()
  for (const step of [/Improve/, /Tune/]) {
    await chain.getByRole('tab', { name: step }).click()
    expect(await finds(), `${step}`).toBe(below)
  }

  // a copy button of a host copies its own command
  await page.getByRole('button', { name: 'Copy the command npx orangu export' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx orangu export')

  await expectNoHorizontalOverflow(page)
  // the step 1 terminal keeps its 80 columns: a narrow screen scrolls the terminal, never the page
  if (narrow) expect(await page.locator('#panel-see pre').evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true)
  // each Sample tag, the fine print and the labels of the steps reach AA on their own ground
  const meaningful = await contrastOnOwnGround(page, '.smp, .hero .fine, .who, .kicker, .stepof, .prop-e')
  expect(meaningful.length).toBeGreaterThanOrEqual(12)
  for (const [at, ratio] of meaningful.entries()) expect(ratio, `text ${at + 1} in ${projectTheme(info)}`).toBeGreaterThanOrEqual(4.5)
  // The landing follows its stored preference, never the system one: the emulated preference is live
  // and only the seeded value decides what paints, and the visible label names the state it is in.
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(projectTheme(info) === 'dark')
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  await expect(page.locator('#themeLabel')).toHaveText(projectTheme(info))
  await expect(page.locator('#themeBtn')).toHaveAccessibleName(new RegExp(`^theme ${projectTheme(info)},`))
  expect(errors).toEqual([])
})

test('landing copy buttons draw their text at 4.5:1 or more on the command ground', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('narrow'), 'a contrast depends on the theme, not on the width: wide-light and wide-dark check it')
  const errors = runtimeErrors(page)
  await routeFonts(page)
  await seedLandingTheme(page, info)
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  const ratios = await contrastOnOwnGround(page, '#hosts .cp2')
  expect(ratios, 'copy buttons in #hosts').toHaveLength(5)
  for (const [at, ratio] of ratios.entries()) expect(ratio, `copy button ${at + 1} in ${projectTheme(info)}`).toBeGreaterThanOrEqual(4.5)
  expect(errors).toEqual([])
})

test('landing plays the hero and the stepper once with a working Pause, and stays still under reduced motion', async ({ browser }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one deterministic motion lifecycle is enough')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference' })
  const page = await context.newPage()
  const errors = runtimeErrors(page)
  await routeFonts(page)
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  const win = page.locator('#heroWin')
  const pause = page.locator('#heroPause')
  await expect(pause).toHaveText('Pause')
  await expect(pause).toHaveAttribute('aria-pressed', 'false')
  // the run reads the field, rings the tool errors, then zooms in
  await expect(win).toHaveClass(/\bp-read\b/, { timeout: 3_000 })
  await expect(win).toHaveClass(/\bp-hit\b/, { timeout: 4_000 })
  // Pause holds the run where it is, and Play goes on
  await pause.click()
  await expect(pause).toHaveText('Play')
  await expect(pause).toHaveAttribute('aria-pressed', 'true')
  await expect(win).toHaveClass(/\bpaused\b/)
  const held = await win.getAttribute('class')
  await page.waitForTimeout(3_000)
  expect(await win.getAttribute('class')).toBe(held)
  await pause.click()
  await expect(pause).toHaveText('Pause')
  await expect(win).toHaveClass(/\bz-sessions\b/, { timeout: 5_000 })
  await expect(page.locator('#hz')).toHaveText('sessions')

  // the stepper plays its lap when the chain is in view: 7 s for each step, then Pause holds it
  const chainPause = page.locator('#chainPause')
  await expect(chainPause).toHaveText('Play')
  await page.locator('#chain').scrollIntoViewIfNeeded()
  await expect(chainPause).toHaveText('Pause', { timeout: 3_000 })
  await expect(page.locator('.chain')).toHaveClass(/\bauto\b/)
  await expect(page.locator('#panel-see')).toBeVisible()
  await expect(page.locator('#panel-improve')).toBeVisible({ timeout: 9_000 })
  await chainPause.click()
  await expect(chainPause).toHaveText('Play')
  await page.waitForTimeout(1_500)
  await expect(page.locator('#panel-improve')).toBeVisible()
  await expect(page.locator('.stepof')).toHaveText('Step 2 of 3')
  expect(errors).toEqual([])
  await context.close()

  // reduced motion: no run and no Pause. The steps stay stacked as plain blocks, and the zoom tabs still work.
  const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const quiet = await still.newPage()
  const quietErrors = runtimeErrors(quiet)
  await routeFonts(quiet)
  await quiet.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  await expect(quiet.locator('#heroWin')).toHaveClass('win z-machine hp p-end')
  await expect(quiet.locator('#heroPause')).toBeHidden()
  await expect(quiet.getByRole('tablist', { name: 'The orangu chain' })).toHaveCount(0)
  for (const id of ['#panel-see', '#panel-improve', '#panel-tune']) {
    await expect(quiet.locator(id)).toBeVisible()
    await expect(quiet.locator(id)).not.toHaveAttribute('role', /./)
  }
  expect(await quiet.evaluate(() => document.getAnimations().length)).toBe(0)
  // the field paints its final state: 224 read dots, and 12 of them in the color of the tool-error swatch of the legend
  const paint = await quiet.evaluate(() => {
    const color = (el: Element): string => getComputedStyle(el).backgroundColor
    return {
      dots: Array.from(document.querySelectorAll('.field i')).map(color),
      error: color(document.querySelector('.legend .sw.err')!),
      call: color(document.querySelector('.legend .sw:not(.err):not(.box)')!),
    }
  })
  expect(paint.dots).toHaveLength(224)
  expect(paint.error).not.toBe(paint.call)
  expect(paint.dots.filter((color) => color === paint.error)).toHaveLength(12)
  expect(paint.dots.filter((color) => color === paint.call)).toHaveLength(212)
  await quiet.getByRole('tab', { name: 'One session' }).click()
  await expect(quiet.locator('#hz-p-session')).toBeVisible()
  expect(await quiet.evaluate(() => document.getAnimations().length)).toBe(0)
  expect(quietErrors).toEqual([])
  await still.close()
})

test('wide landing keeps the copy beside the app window, and the steps begin above the fold', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the 1440px geometry contract only needs one deterministic theme')
  await routeFonts(page)
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
    return { copy: box('.hero-copy'), title: box('.hero h1'), actions: box('.hero .actions'), win: box('#heroWin'), chain: box('#chain'), height: window.innerHeight }
  })
  // the copy at the left and the window at the right, side by side
  expect(geometry.win.left, JSON.stringify(geometry)).toBeGreaterThan(geometry.copy.right)
  expect(geometry.title.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.copy.right + 1)
  expect(Math.min(geometry.copy.bottom, geometry.win.bottom) - Math.max(geometry.copy.top, geometry.win.top), JSON.stringify(geometry)).toBeGreaterThan(0)
  // the command and the whole window in the first screen, and the steps start in it
  expect(geometry.actions.bottom, JSON.stringify(geometry)).toBeLessThan(geometry.height)
  expect(geometry.win.bottom, JSON.stringify(geometry)).toBeLessThan(geometry.height)
  expect(geometry.chain.top, JSON.stringify(geometry)).toBeLessThan(geometry.height)
})

test('landing fits the hero across desktop breakpoints, with no cut in the app window', async ({ browser }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one deterministic desktop breakpoint matrix is sufficient')
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'light', isMobile: false, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = runtimeErrors(page)
  await routeFonts(page)
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' })
  for (const width of [900, 1024, 1100, 1200]) {
    await page.setViewportSize({ width, height: 900 })
    await expectNoHorizontalOverflow(page)
    for (const level of ['This machine', 'Sessions and agents', 'One session']) {
      await page.getByRole('tab', { name: level }).click()
      expect(await cutInWindow(page), `${width}px ${level}`).toEqual([])
    }
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
  await page.goto(withTheme(`${SITE}/sample.html#overview`, info), { waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('note')).toContainText('This sample is synthetic.')
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
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(projectTheme(info) === 'dark')
  expect(await paintedTheme(page)).toBe(projectTheme(info))
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
    for (const [screen, heading] of [['timeline', 'Timeline'], ['tools', 'Tools & calls'], ['suggest', 'Improvements']] as const) {
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

/**
 * Every element that an ellipsis cuts, on every screen of both samples. The check knows no selector: it opens each
 * screen that the sidebar links to (and the repo and global scopes of Improvements) and takes each element whose
 * computed text-overflow is ellipsis and whose text overflows its box. It measures each screen twice: as it loads,
 * with each card closed (a rule can cut only a closed card, as the old 2-line clamp did), and again with every
 * disclosure open (the Timeline calls, More charts). Each cut element must carry a title equal to its whole text:
 * its words, with a space where one element ends and the next begins (the kind tag and the prompt of a Timeline
 * row, the agent and its model). A new ellipsis rule with no title fails here as soon as a sample has a cell that
 * it cuts.
 */
test('each element that an ellipsis cuts carries its whole text in a title, on every screen of both samples', async ({ page }, info) => {
  test.skip(info.project.name.endsWith('dark'), 'a cut depends on the width, not on the theme: wide-light and narrow-light check it')
  const errors = runtimeErrors(page)
  let checked = 0
  const wrong: string[] = []
  const measure = (): Promise<Array<{ cell: string; title: string | null; text: string }>> =>
    page.evaluate(() => {
      // the text and the title fold their whitespace the same way, so a title with 2 spaces or a line break still matches
      const fold = (s: string): string => s.replace(/\s+/g, ' ').trim()
      const words = (el: Element): string => {
        const parts: string[] = []
        const walk = (node: Node): void => node.childNodes.forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) parts.push((child as Text).data)
          else if (child.nodeType === Node.ELEMENT_NODE) { parts.push(' '); walk(child); parts.push(' ') }
        })
        walk(el)
        return fold(parts.join(''))
      }
      return Array.from(document.body.querySelectorAll<HTMLElement>('*'))
        .filter((el) => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth)
        .map((el) => {
          const title = el.getAttribute('title')
          return { cell: `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')}`, title: title === null ? null : fold(title), text: words(el) }
        })
    })
  for (const file of ['sample.html', 'sample-repo.html']) {
    await page.goto(`${SITE}/${file}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const links = await page.locator('nav[aria-label="Report"] a[href^="#"]').evaluateAll((all) => all.map((a) => a.getAttribute('href')!))
    const screens = [...new Set([...links, '#suggest?scope=repo', '#suggest?scope=global'])]
    expect(screens.length, `${file}: screens`).toBeGreaterThan(3)
    for (const screen of screens) {
      await page.goto('about:blank')
      await page.goto(`${SITE}/${file}${screen}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { level: 1 }), `${file}${screen}`).toBeVisible()
      for (const state of ['closed', 'open'] as const) {
        if (state === 'open') await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true }))
        const cut = await measure()
        checked += cut.length
        for (const c of cut.filter((c) => c.title !== c.text))
          wrong.push(`${file}${screen} (${state}) ${c.cell} "${c.text.slice(0, 50)}": title ${c.title === null ? 'missing' : JSON.stringify(c.title.slice(0, 50))}`)
      }
    }
  }
  expect(checked, 'the samples have cells that an ellipsis cuts').toBeGreaterThan(0)
  expect(wrong, `cut cells whose title is not the whole text (${wrong.length} of ${checked})`).toEqual([])
  expect(errors).toEqual([])
})

test('generated repository sample renders the repo scope and the two samples link each other with the theme kept', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const external: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:4173') external.push(request.url())
  })
  await page.goto(withTheme(`${SITE}/sample-repo.html#repo`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('note')).toContainText('This sample is synthetic.')
  await expect(page.getByRole('heading', { level: 1, name: 'Repo' })).toBeVisible()
  await expect(page.getByText('Recurring findings', { exact: false }).first()).toBeVisible()
  await expect(page.locator('.rrow')).not.toHaveCount(0)
  await expectOneRecurringCaption(page, 'sample-repo.html Repo')
  await expectNoHorizontalOverflow(page)
  expect(await paintedTheme(page)).toBe(projectTheme(info))

  // the cross-link is the only sample-specific element; it copies theme and audience from the hash
  const back = page.getByRole('link', { name: /See one session step by step/ })
  await expect(back).toBeVisible()
  const backHref = await back.getAttribute('href')
  expect(backHref).toMatch(/^sample\.html#overview/)
  if (projectTheme(info) === 'dark') expect(backHref).toContain('theme=dark')
  else expect(backHref).not.toContain('theme=')

  await page.goto(withTheme(`${SITE}/sample.html#overview`, info), { waitUntil: 'domcontentloaded' })
  const forward = page.getByRole('link', { name: /See the repository as its own file/ })
  await expect(forward).toBeVisible()
  expect(await forward.getAttribute('href')).toMatch(/^sample-repo\.html#repo/)

  // the session sample carries the repo and global aggregates beside its session: both across-session
  // screens and both Suggestions scope chips have evidence, and the session card is still the session's
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  await expect(page.locator('.sesscard .sid')).toContainText('5a91c73e')
  const repoNav = page.getByRole('link', { name: /^Repo · \d+ sessions$/ })
  const globalNav = page.getByRole('link', { name: /^Global · \d+ sessions$/ })
  await expect(repoNav).toBeVisible()
  await expect(globalNav).toBeVisible()
  await globalNav.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: /^Global/ })).toBeVisible()
  await expect(page.getByText('Tokens by project')).toBeVisible()
  await expect(page.locator('.rrow')).not.toHaveCount(0)
  await expectOneRecurringCaption(page, 'sample.html Global')
  await expectNoHorizontalOverflow(page)
  await page.goto(withTheme(`${SITE}/sample.html#suggest?scope=repo`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  await expect(page.getByText('This scope needs orangu serve')).toHaveCount(0)
  await expect(page.locator('details.finding')).not.toHaveCount(0)
  expect(external).toEqual([])
  expect(errors).toEqual([])
})

// The repository sample carries the repo aggregate; the session sample carries the repo and global
// aggregates beside its session. A reader gets to the cards by clicks: the sidebar, then a scope chip.
test('both samples name the improvement on every closed repo and global card, reached by clicks', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${SITE}/sample-repo.html#repo`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Repo' })).toBeVisible()
  await page.getByRole('link', { name: 'Improvements', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  // a file about the repository opens the screen on its own scope
  await expect(page.getByRole('button', { name: /^Repo · \d+$/ })).toHaveClass(/\bactive\b/)
  await expectImprovementOnEveryClosedCard(page, 'repo', 'sample-repo.html repo')
  expect(await paintedTheme(page)).toBe(projectTheme(info))

  await page.goto(withTheme(`${SITE}/sample.html#overview`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  await page.getByRole('link', { name: 'Improvements', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  for (const [scope, label] of [['repo', 'Repo'], ['global', 'Global']] as const) {
    const chip = page.getByRole('button', { name: new RegExp(`^${label} · \\d+$`) })
    await chip.click()
    await expect(chip).toHaveClass(/\bactive\b/)
    await expectImprovementOnEveryClosedCard(page, scope, `sample.html ${scope}`)
  }
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  expect(errors).toEqual([])
})
