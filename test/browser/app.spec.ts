import { expect, test, type Page } from '@playwright/test'
import { APP_URL } from './app-url.js'

const APP = APP_URL
const APP_ORIGIN = new URL(APP).origin
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'

function runtimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

async function openFirstSuggestion(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.goto(`${APP}/#suggest?s=${SESSION}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improve the next outcome' })).toBeVisible()
  const row = page.locator('details.finding').first()
  await expect(row).toBeVisible()
  await row.locator('summary').click()
  await expect(row.getByRole('button', { name: 'Copy improve command' })).toBeVisible()
  return row
}

test('localhost fixture is readable at the release viewport and theme', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(`${APP}/#overview?s=${SESSION}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Detailed' })).toBeVisible()
  await expect(page.locator('.cap-card[data-capability="tools"]')).toBeVisible()
  await expect(page.locator('.cap-card[data-capability="suggest"]')).toBeVisible()
  const timeline = page.locator('.cap-card[data-capability="timeline"]')
  await timeline.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible()
  await expect(page.locator('details.turn')).not.toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(info.project.name.endsWith('dark'))
  expect(errors).toEqual([])
})

test('localhost creates only a copy handoff and never offers automatic model launch', async ({ page, context }) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  const row = await openFirstSuggestion(page)
  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/kickoff'))
  await row.getByRole('button', { name: 'Copy improve command' }).click()
  const request = await posted
  expect(request.postDataJSON()).toMatchObject({ mode: 'copy' })
  await expect(row.locator('.kick-msg')).toContainText('Claude command copied')
  await expect(row.getByRole('button', { name: 'Draft proposal' })).toHaveCount(0)
  await expect(row.locator('.status-chip[data-status="running"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/orangu:improve')
  const handoffs = row.locator('.kick-cmd .sg-hand .copy')
  await expect(handoffs).toHaveCount(1)
  await expect(handoffs).toHaveAttribute('data-copy', /claude "\/orangu:improve/)
  await expect(row.locator('.kick-cmd')).not.toContainText('Codex')
  expect(errors).toEqual([])
})

test('localhost saved proposals are escaped, status-distinct, responsive, and expose copy-only apply handoffs', async ({ page, context }) => {
  const errors = runtimeErrors(page)
  const proposedId = 'sg_0000000000c1'
  const verifiedId = 'sg_0000000000c2'
  const proposal = {
    v: 1, title: '<img src=x onerror=alert(1)>', change: 'Update one instruction', effort: 'S',
    proposalPath: '/tmp/proposal.md', manifestPath: '/tmp/proposal.json', files: ['CLAUDE.md'], changeClass: 'instruction', evidence: 'Measured locally',
    expectedEffect: 'Avoid repeated reads', risk: 'One narrow file', verification: 'Check a later run',
    workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
    sources: [{ kind: 'research', label: '<unsafe source>', url: 'https://example.test/?q=<x>', verifiedAt: '2026-08-26' }],
  }
  const records = [
    { id: proposedId, v: 2, createdAt: 1, source: 'skill', scope: 'session', sessionIds: [SESSION], ruleId: 'saved-proposal', title: 'Saved', evidence: { estimated: true }, proposal, status: 'proposed', statusAt: 2 },
    {
      id: verifiedId, v: 2, createdAt: 1, source: 'skill', scope: 'session', sessionIds: [SESSION], ruleId: 'verified-proposal', title: 'Verified', evidence: { estimated: true },
      proposal: { ...proposal, title: 'Verified proposal', proposalPath: '/tmp/verified.md', verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }] },
      application: { v: 1, summary: 'Applied.', files: ['CLAUDE.md'], checks: [{ name: 'tests', ok: true }], receiptPath: '/tmp/applied.json' },
      verificationReceipt: { v: 1, summary: 'Later-session comparison passed: avgToolCalls decreased.', measuredSessionIds: ['later-session'], checks: [{ name: 'avgToolCalls decreased', metric: 'avgToolCalls', comparison: 'decreased', before: 8, after: 4, evidence: 'No repeat · zero', ok: true }], receiptPath: '/tmp/verified.json' },
      effect: { before: { avgToolCalls: 8 }, after: { avgToolCalls: 4 }, measuredSessionIds: ['later-session'] },
      verificationTrust: 'computed-v1', verificationTrusted: true, status: 'verified', statusAt: 1,
    },
  ]
  await page.route('**/api/suggestions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(records) }))
  await page.route('**/api/app**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    body['suggestions'] = records
    await route.fulfill({ response, json: body })
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  await page.goto(`${APP}/#suggest?s=${SESSION}`, { waitUntil: 'domcontentloaded' })

  const inbox = page.locator('.sg-inbox')
  await expect(inbox).toContainText('Saved proposals · 2')
  await expect(inbox.locator('img')).toHaveCount(0)
  const proposed = inbox.locator(`#saved-${proposedId}`)
  await proposed.locator('summary').click()
  await expect(proposed).toContainText('<img src=x onerror=alert(1)>')
  const copyButtons = proposed.locator('.sg-hand .copy')
  await expect(copyButtons).toHaveCount(1)
  await expect(copyButtons).toHaveAttribute('data-copy', `claude "/orangu:apply ${proposedId}"`)
  await expect(proposed).not.toContainText('Codex')
  await copyButtons.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`claude "/orangu:apply ${proposedId}"`)
  const verified = inbox.locator(`#saved-${verifiedId}`)
  await expect(verified.locator('.status-chip')).toHaveAttribute('data-status', 'verified')
  await verified.locator('summary').click()
  await expect(verified).toContainText('No repeat · zero')
  await expect(verified.locator('.sg-handoffs')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

test('repo whole-harness review is copy-only and never posts a kickoff', async ({ page, context }) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  let kickoffPosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/kickoff')) kickoffPosts++
  })
  await page.goto(`${APP}/#suggest?s=${SESSION}&scope=repo`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Whole-harness review')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('claude "/orangu:mega --scope repo"')).toBeVisible()
  await page.getByRole('button', { name: 'Copy whole-harness review' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(kickoffPosts).toBe(0)
  expect(errors).toEqual([])
})
