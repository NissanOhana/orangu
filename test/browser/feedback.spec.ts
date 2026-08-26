import { expect, test } from '@playwright/test'

const APP = 'http://127.0.0.1:4174/'

async function captureWindowOpen(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as typeof window & { __feedbackOpens?: unknown[][] }
    target.__feedbackOpens = []
    window.open = ((...args: unknown[]) => {
      target.__feedbackOpens!.push(args)
      return null
    }) as typeof window.open
  })
}

test('localhost feedback requires exact review, invalidates edits, and opens only the reviewed GitHub prefill', async ({ page }) => {
  const external: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') external.push(request.url())
  })
  await captureWindowOpen(page)
  await page.goto(APP + '#overview')
  await expect(page.locator('#feedback-launch')).toHaveText('Beta feedback')
  await page.locator('#feedback-launch').click()
  await expect(page).toHaveURL(/#feedback\?context=app$/)
  await expect(page.locator('h1')).toHaveText('Beta feedback')
  await expect(page.locator('#fb-reviewed')).toBeDisabled()
  await expect(page.locator('#fb-send')).toBeDisabled()
  expect(external).toEqual([])

  await page.locator('#fb-summary').fill('The local preview needs polish 🤧')
  await page.locator('#fb-category').selectOption('confusing')
  await page.locator('#fb-rant').fill('The flow made me guess what would be shared.')
  await page.locator('#fb-expected').fill('Show the exact report before leaving localhost.')
  await page.locator('#fb-reproduction').fill('Open the beta feedback form.')
  await page.locator('#fb-preview').click()

  const title = await page.locator('#fb-title-preview').textContent()
  const body = await page.locator('#fb-body-preview').textContent()
  expect(title).toBe('[beta feedback] The local preview needs polish 🤧')
  expect(body).toContain('The flow made me guess')
  expect(body).toContain('- Area: app')
  expect(body).toContain('- Surface: localhost')
  await expect(page.locator('#fb-reviewed')).toBeEnabled()
  await expect(page.locator('#fb-send')).toBeDisabled()
  expect(external).toEqual([])

  await page.locator('#fb-reviewed').check()
  await expect(page.locator('#fb-send')).toBeEnabled()
  await page.locator('#fb-send').click()
  const opened = await page.evaluate(() => (window as typeof window & { __feedbackOpens: unknown[][] }).__feedbackOpens)
  expect(opened).toHaveLength(1)
  expect(opened[0]?.[1]).toBe('_blank')
  expect(opened[0]?.[2]).toBe('noopener,noreferrer')
  const issue = new URL(String(opened[0]?.[0]))
  expect(issue.origin + issue.pathname).toBe('https://github.com/NissanOhana/orangu/issues/new')
  expect(issue.searchParams.get('title')).toBe(title)
  expect(issue.searchParams.get('body')).toBe(body)

  await page.locator('#fb-rant').fill('Edited after review')
  await expect(page.locator('#fb-reviewed')).toBeDisabled()
  await expect(page.locator('#fb-reviewed')).not.toBeChecked()
  await expect(page.locator('#fb-send')).toBeDisabled()
  expect(await page.evaluate(() => (window as typeof window & { __feedbackOpens: unknown[][] }).__feedbackOpens.length)).toBe(1)
})

test('oversized feedback is never truncated and falls back to complete copy plus a blank composer', async ({ page }) => {
  await captureWindowOpen(page)
  await page.goto(APP + '#feedback?context=global')
  const rant = '雪🤧'.repeat(4_000)
  await page.locator('#fb-summary').fill('A very long report')
  await page.locator('#fb-rant').fill(rant)
  await page.locator('#fb-preview').click()
  expect(await page.locator('#fb-body-preview').textContent()).toContain(rant.slice(0, 1_000))
  await expect(page.locator('#fb-review-status')).toContainText('Nothing was dropped')
  await page.locator('#fb-reviewed').check()
  await expect(page.getByRole('button', { name: 'Copy complete report' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open blank GitHub issue' })).toBeVisible()
  await expect(page.locator('#fb-send')).toBeDisabled()
  await page.getByRole('button', { name: 'Open blank GitHub issue' }).click()
  const opened = await page.evaluate(() => (window as typeof window & { __feedbackOpens: unknown[][] }).__feedbackOpens)
  expect(opened).toEqual([['https://github.com/NissanOhana/orangu/issues/new', '_blank', 'noopener,noreferrer']])
})
