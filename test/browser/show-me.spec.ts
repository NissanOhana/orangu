import { expect, test, type Page } from '@playwright/test'
import { paintedTheme, projectTheme } from './theme.js'

// The two /orangu:show-me files, as `orangu show-me --render` wrote them for a fixture session with hostile words
// (test/browser/show-me-render.ts). Each opens in light and dark with no console error; the deck moves by keyboard,
// keeps the slide and the theme in the hash, and T changes the theme. The words stay text, and only the pinned
// runtime runs.
const BASE = 'http://127.0.0.1:4173/show-me'

function runtimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('dialog', (dialog) => {
    errors.push(`dialog: ${dialog.message()}`)
    void dialog.dismiss()
  })
  return errors
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

test('the slide deck opens in its theme, moves by keyboard and keeps its place in the hash', async ({ page }, info) => {
  const theme = projectTheme(info)
  const errors = runtimeErrors(page)
  await page.goto(`${BASE}/slides.html${theme === 'dark' ? '#theme=dark' : ''}`)
  expect(await paintedTheme(page)).toBe(theme)
  await expect(page.locator('#theme')).toHaveText(`◐ theme · ${theme}`)
  const slides = page.locator('section[aria-roledescription="slide"]')
  // 5 fixed slides and one for each finding the fixture session has (1 to 3)
  const total = await slides.count()
  expect(total).toBeGreaterThan(5)
  expect(total).toBeLessThanOrEqual(8)
  await expect(slides.first()).toHaveAttribute('aria-label', `1 of ${total}`)
  await expect(slides.first().locator('.pg')).toHaveText(`1 / ${total}`)
  // the hash names the slide across the middle of the viewport. A wide slide fills the viewport, so that is slide
  // 1 and then slide 2. A phone card has the height of its text: a short title card leaves slide 2 across the
  // middle at the top of the page, so there the check is that the arrow key moves the hash forward.
  const slideInHash = async (): Promise<number> => Number(/n=(\d+)/.exec(new URL(page.url()).hash)?.[1] ?? 0)
  await expect.poll(slideInHash).toBeGreaterThan(0)
  const start = await slideInHash()
  const wide = info.project.name.startsWith('wide')
  if (wide) expect(start).toBe(1)

  await page.keyboard.press('ArrowRight')
  if (wide) {
    await expect(page).toHaveURL(/#n=2/)
    await expect(slides.nth(1)).toBeInViewport({ ratio: 0.6 })
  } else await expect.poll(slideInHash).toBeGreaterThan(start)
  if (theme === 'dark') await expect(page).toHaveURL(/theme=dark/)

  await page.keyboard.press('t')
  const other = theme === 'dark' ? 'light' : 'dark'
  await expect(page.locator('#theme')).toHaveText(`◐ theme · ${other}`)
  expect(await paintedTheme(page)).toBe(other)
  if (info.project.name.startsWith('narrow')) await noHorizontalOverflow(page)
  expect(errors).toEqual([])
})

test('a deck link with a slide number opens on that slide', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('wide'), 'the slide hash is the same at every width')
  const errors = runtimeErrors(page)
  await page.goto(`${BASE}/slides.html#n=4&theme=${projectTheme(info)}`)
  const slides = page.locator('section[aria-roledescription="slide"]')
  await expect(slides.nth(3)).toBeInViewport({ ratio: 0.6 })
  await page.keyboard.press('End')
  await expect(page).toHaveURL(new RegExp(`#n=${await slides.count()}`))
  await page.keyboard.press('Home')
  await expect(page).toHaveURL(/#n=1/)
  expect(errors).toEqual([])
})

// No length cap on content: the deck shows each improvement, each finding title and the improvements title whole.
// A line clamp would hide the rest of the text, so the box of each one holds all of its text (4 px for rounding).
test('the deck shows each improvement, title and improvement text whole, with no line clamp', async ({ page }, info) => {
  await page.goto(`${BASE}/slides.html${projectTheme(info) === 'dark' ? '#theme=dark' : ''}`)
  const cut = await page.evaluate(() =>
    Object.fromEntries(
      ['.it', '.st', '.rec .tx'].map((selector) => {
        const all = Array.from(document.querySelectorAll<HTMLElement>(selector))
        return [selector, `${all.filter((el) => el.scrollHeight > el.clientHeight + 4).length} of ${all.length}`]
      }),
    ),
  )
  expect(Number(/of (\d+)/.exec(cut['.it']!)![1]), 'the fixture has improvements').toBeGreaterThan(0)
  expect(cut).toEqual(Object.fromEntries(Object.entries(cut).map(([selector, value]) => [selector, value.replace(/^\d+/, '0')])))
})

// The deck is a fixed 16:9 frame that clips. With no line clamp, the longest texts that the rules ship must still fit:
// the long deck holds the 5 longest improvement texts of src/analyze/insights.ts (test/browser/show-me-render.ts),
// on the 3 finding slides and the Improvements slide. A rule rewrite that makes a slide overflow fails here.
test('the 5 longest shipped improvements fit each 16:9 slide at 1440x900 and 1280x720', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the frame is the same in each theme, and a phone card grows with its text')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport)
    await page.goto(`${BASE}-long/slides.html`)
    await expect(page.locator('.it')).toHaveCount(5)
    const over = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.frame')).map((frame) => frame.scrollHeight - frame.clientHeight))
    expect(over.length, `${viewport.width}x${viewport.height} slides`).toBe(8)
    expect(over.map((px, i) => `slide ${i + 1}: ${px > 4 ? `${px} px over` : 'fits'}`), `${viewport.width}x${viewport.height}`).toEqual(over.map((_, i) => `slide ${i + 1}: fits`))
  }
})

// The words that Claude wrote are hostile here. orangu wrote them as text, so the page shows each one, runs no
// script of theirs, and makes no CSP report: there is nothing to block.
test('the hostile words show as text, and only the pinned runtime runs', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const words = (await (await page.request.get(`${BASE}/words.json`)).json()) as { verdict: string; summary: string; improvementsTitle: string }
  expect(words.verdict).toContain('<script>')
  for (const file of ['slides', 'report']) {
    await page.goto(`${BASE}/${file}.html${projectTheme(info) === 'dark' ? '#theme=dark' : ''}`)
    await expect(page.locator('#theme')).toHaveText(`◐ theme · ${projectTheme(info)}`)
    await expect(page.locator('[data-slot="verdict"]')).toHaveText(words.verdict)
    if (file === 'report') await expect(page.locator('[data-slot="summary"]')).toHaveText(words.summary)
    else await expect(page.locator('[data-slot="improvements-title"]')).toHaveText(words.improvementsTitle)
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
    expect(await page.evaluate(() => document.scripts.length)).toBe(1)
    expect(await page.evaluate(() => document.querySelectorAll('set, animate, iframe, base, [onload], [onerror]').length)).toBe(0)
  }
  expect(errors).toEqual([])
})

// A defence in depth: if a missed escape ever put raw markup in a rendered file, the page must still run nothing but
// its own runtime. The CSP pins that script by hash, so an injected <script> or event handler stays inert.
test('an unescaped injection in a rendered slot runs no script, and the pinned runtime still runs', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'the CSP behaves the same in every project')
  const rendered = await (await page.request.get(`${BASE}/slides.html`)).text()
  const title = /<h1 class="dp" data-slot="title">[^<]*<\/h1>/.exec(rendered)?.[0]
  expect(title, 'the rendered title slot').toBeTruthy()
  const hostile = rendered.replace(title!, '<h1 class="dp" data-slot="title"><img src="data:," onerror="window.__xss=1"><script>window.__xss=2</script>hostile</h1>')
  const total = (rendered.match(/aria-roledescription="slide"/g) ?? []).length
  await page.route(`${BASE}/hostile.html`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: hostile }))
  const blocked: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => message.type() === 'error' && blocked.push(message.text()))
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${BASE}/hostile.html`)
  await expect(page.locator('#theme')).toHaveText('◐ theme · light')
  await expect(page.locator('.pg').first()).toHaveText(`1 / ${total}`)
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  expect(blocked.some((text) => /Content Security Policy/.test(text))).toBe(true)
  expect(pageErrors).toEqual([])
})

// A link that drops #theme=dark turns a dark reader light on the click; the check has to click, not read the href.
test('the links between the slide deck and the written report keep the dark theme', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-dark', 'one dark click path is enough')
  const errors = runtimeErrors(page)
  await page.goto(`${BASE}/slides.html#theme=dark`)
  await page.getByRole('link', { name: 'Read the written report →' }).click()
  await expect(page).toHaveURL(/report\.html#theme=dark$/)
  expect(await paintedTheme(page)).toBe('dark')
  await page.getByRole('link', { name: 'Open the slides →' }).click()
  await expect(page).toHaveURL(/slides\.html#.*theme=dark/)
  expect(await paintedTheme(page)).toBe('dark')
  expect(errors).toEqual([])
})

test('Space on the focused theme button presses the button and keeps the slide', async ({ page }, info) => {
  test.skip(info.project.name !== 'wide-light', 'one keyboard path is enough')
  await page.goto(`${BASE}/slides.html`)
  await expect(page).toHaveURL(/#n=1$/)
  await page.locator('#theme').focus()
  await page.keyboard.press(' ')
  await expect(page.locator('#theme')).toHaveText('◐ theme · dark')
  await expect(page).toHaveURL(/#n=1&theme=dark$/)
})

test('the written report opens in its theme, holds no sample value and links back to the slides', async ({ page }, info) => {
  const theme = projectTheme(info)
  const errors = runtimeErrors(page)
  await page.goto(`${BASE}/report.html${theme === 'dark' ? '#theme=dark' : ''}`)
  expect(await paintedTheme(page)).toBe(theme)
  await expect(page.getByRole('heading', { level: 1 })).not.toBeEmpty()
  expect(await page.content()).not.toContain('EXAMPLE')
  const back = page.getByRole('link', { name: 'Open the slides →' })
  await expect(back).toHaveAttribute('href', theme === 'dark' ? 'slides.html#theme=dark' : 'slides.html')
  await page.getByRole('button', { name: `◐ theme · ${theme}` }).click()
  expect(await paintedTheme(page)).toBe(theme === 'dark' ? 'light' : 'dark')
  // the link follows the theme toggle, so the slides open in the theme the reader chose
  await expect(back).toHaveAttribute('href', theme === 'dark' ? 'slides.html' : 'slides.html#theme=dark')
  if (info.project.name.startsWith('narrow')) await noHorizontalOverflow(page)
  expect(errors).toEqual([])
})
