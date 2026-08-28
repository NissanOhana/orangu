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
  await expect(page.locator('.where-next a[data-screen="tools"]')).toBeVisible()
  await expect(page.locator('.where-next a[data-screen="suggest"]')).toBeVisible()
  await expect(page.locator('details.finding.top')).toBeVisible()
  const timeline = page.locator('.where-next a[data-screen="timeline"]')
  await timeline.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible()
  await expect(page.locator('details.turn')).not.toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(info.project.name.endsWith('dark'))
  expect(errors).toEqual([])
})

// A7: serve opens on the fleet when more than one session is live and the URL carries no hash;
// the explicit #overview?s= deep link above is unchanged.
test('localhost with no hash lands on the fleet when several sessions are live', async ({ page }) => {
  const errors = runtimeErrors(page)
  await page.route('**/api/app**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { sessions: Array<{ badge: string; ageMs: number }> }
    for (const row of body.sessions) {
      row.badge = 'live'
      row.ageMs = 1000
    }
    await route.fulfill({ response, json: body })
  })
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Live' })).toBeVisible()
  await expect(page.locator('.fleetcard')).toHaveCount(3)
  await expect(page.locator('.page-head .sub')).toContainText('3 running sessions')
  await expect(page.locator('nav[aria-label="Report"] a', { hasText: 'All live · 3' })).toBeVisible()
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

// A8: the harness reaches the app. The fixture repo declares one idle skill and one session carries a
// skill_listing attachment (app-server.ts), so the populated view renders: the idle card, the injected-
// listings table (which must scroll inside its own container at 390 px), and the copy-only command.
test('localhost #harness renders the populated harness view and the Overview carries its card', async ({ page }) => {
  const errors = runtimeErrors(page)
  await page.goto(`${APP}/#harness?s=${SESSION}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Harness' })).toBeVisible()
  await expect(page.locator('.herotitle', { hasText: '1 of 1 skills never fired' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.scroll-x table.grid td.mono', { hasText: 'skill_listing' })).toBeVisible()
  await expect(page.locator('[data-copy=\'claude "/orangu:harness --scope repo"\']')).toBeVisible()
  await expect(page.getByText('No harness config found')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.goto(`${APP}/#overview?s=${SESSION}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator(`a.harness-card[href="#harness?s=${SESSION}"]`)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('nav[aria-label="Report"] a', { hasText: 'Harness' })).toBeVisible()
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
  await expect(page.getByText('claude "/orangu:harness --scope repo"')).toBeVisible()
  await page.getByRole('button', { name: 'Copy whole-harness review' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(kickoffPosts).toBe(0)
  expect(errors).toEqual([])
})
