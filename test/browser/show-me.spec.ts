import { expect, test, type Page } from '@playwright/test'
import { paintedTheme, projectTheme } from './theme.js'

// The two /orangu:show-me templates render as a complete sample before the skill fills them. Each opens in
// light and dark with no console error; the deck moves by keyboard, keeps the slide and the theme in the
// hash, and T changes the theme.
const BASE = 'http://127.0.0.1:4173/show-me'

function runtimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
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
  await expect(slides).toHaveCount(6)
  await expect(slides.first()).toHaveAttribute('aria-label', '1 of 6')
  await expect(slides.first().locator('.pg')).toHaveText('1 / 6')
  await expect(page).toHaveURL(/#n=1/)

  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/#n=2/)
  // a wide slide fills the viewport; a phone card can be taller than it, so only the hash is checked there
  if (info.project.name.startsWith('wide')) await expect(slides.nth(1)).toBeInViewport({ ratio: 0.6 })
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
  await expect(page.locator('section[aria-roledescription="slide"]').nth(3)).toBeInViewport({ ratio: 0.6 })
  await page.keyboard.press('End')
  await expect(page).toHaveURL(/#n=6/)
  await page.keyboard.press('Home')
  await expect(page).toHaveURL(/#n=1/)
  expect(errors).toEqual([])
})

test('the written report opens in its theme and links back to the slides', async ({ page }, info) => {
  const theme = projectTheme(info)
  const errors = runtimeErrors(page)
  await page.goto(`${BASE}/report.html${theme === 'dark' ? '#theme=dark' : ''}`)
  expect(await paintedTheme(page)).toBe(theme)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('EXAMPLE')
  await expect(page.getByRole('link', { name: 'Open the slides →' })).toHaveAttribute('href', 'slides.html')
  await page.getByRole('button', { name: `◐ theme · ${theme}` }).click()
  expect(await paintedTheme(page)).toBe(theme === 'dark' ? 'light' : 'dark')
  if (info.project.name.startsWith('narrow')) await noHorizontalOverflow(page)
  expect(errors).toEqual([])
})
