import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { APP_URL } from './app-url.js'
import { paintedTheme, projectTheme, withTheme } from './theme.js'

const APP = APP_URL
const APP_ORIGIN = new URL(APP).origin
const SITE = 'http://127.0.0.1:4173'
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'

async function noHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
}

function runtimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

async function openFirstSuggestion(page: Page, info: TestInfo): Promise<ReturnType<Page['locator']>> {
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  const row = page.locator('details.finding').first()
  await expect(row).toBeVisible()
  // the card's own summary: the Why disclosure inside the body has one too
  await row.locator(':scope > summary').click()
  await expect(row.getByRole('button', { name: 'Copy the Claude Code command' })).toBeVisible()
  return row
}

/**
 * The first Improvements card, by clicks and the keyboard. Closed, its summary names the change and never
 * the reason. Open, its body starts with a closed Why. Why opens to the reason, and to the method in the
 * muted style when the rule has one. A re-render of the same screen (the audience switch rebuilds every
 * node) keeps the card and Why open, because both carry an id. Enter on the focused Why closes it.
 */
async function expectWhyOpensAndSurvivesARerender(page: Page, where: string, method: boolean): Promise<void> {
  const card = page.locator('details.finding').first()
  const why = card.locator('details.why')
  const toggle = why.getByRole('button', { name: 'Why', exact: true })
  const reason = why.locator(':scope > p:not(.muted)')
  await expect(why, where).toHaveCount(1)
  const reasonText = ((await reason.textContent()) ?? '').trim()
  expect(reasonText.length, `${where}: the reason`).toBeGreaterThan(0)
  await expect(card, where).not.toHaveAttribute('open')
  await expect(card.locator(':scope > summary .sg-lead'), where).toContainText('Improvement:')
  await expect(card.locator(':scope > summary'), where).not.toContainText(reasonText)

  await card.locator(':scope > summary').click()
  await expect(toggle, where).toBeVisible()
  await expect(toggle, where).toHaveAttribute('aria-expanded', 'false')
  await expect(reason, where).toBeHidden()
  await toggle.click()
  await expect(toggle, where).toHaveAttribute('aria-expanded', 'true')
  await expect(reason, where).toBeVisible()
  await expect(why.locator(':scope > p.muted'), where).toHaveCount(method ? 1 : 0)
  if (method) await expect(why.locator(':scope > p.muted'), where).toBeVisible()

  // mark the drawn node, then switch the audience: the screen is built again from nothing
  await why.evaluate((el) => el.setAttribute('data-drawn-before', ''))
  await page.evaluate(() => { location.hash += (location.hash.includes('?') ? '&' : '?') + 'audience=plain' })
  await expect(page.getByRole('button', { name: 'Plain language' }), where).toHaveAttribute('aria-pressed', 'true')
  await expect(why, `${where}: a new node`).not.toHaveAttribute('data-drawn-before')
  await expect(card, `${where}: the card after the re-render`).toHaveAttribute('open', '')
  await expect(why, `${where}: Why after the re-render`).toHaveAttribute('open', '')
  await expect(toggle, `${where}: Why after the re-render`).toHaveAttribute('aria-expanded', 'true')
  await expect(reason, where).toBeVisible()

  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle, `${where}: Enter closes Why`).toHaveAttribute('aria-expanded', 'false')
  await expect(reason, where).toBeHidden()
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
  // Light is the only default: the emulated system preference is live and the app ignores it, so the
  // dark projects have to ask for dark in the hash before anything paints dark.
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(projectTheme(info) === 'dark')
  expect(await paintedTheme(page)).toBe('light')
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
  await page.goto(withTheme(`${APP}/#overview?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(projectTheme(info) === 'dark' ? 'dark' : null)
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

test('localhost creates only a copy handoff and never offers automatic model launch', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  const row = await openFirstSuggestion(page, info)
  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/kickoff'))
  await row.getByRole('button', { name: 'Copy the Claude Code command' }).click()
  const request = await posted
  expect(request.postDataJSON()).toMatchObject({ mode: 'copy' })
  await expect(row.locator('.kick-msg')).toContainText('The command is on your clipboard. Paste it in a terminal')
  // the paste instruction is body text, not the muted grey that fails AA for small text in light
  await expect(row.locator('.kick-msg')).not.toHaveClass(/\bmuted\b/)
  await expect(row.getByRole('button', { name: 'Draft proposal' })).toHaveCount(0)
  await expect(row.locator('.status-chip[data-status="running"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/orangu:improve')
  const handoffs = row.locator('.kick-cmd .sg-hand .copy')
  await expect(handoffs).toHaveCount(1)
  await expect(handoffs).toHaveAttribute('data-copy', /claude "\/orangu:improve/)
  await expect(row.locator('.kick-cmd')).not.toContainText('Codex')
  expect(errors).toEqual([])
})

test('localhost saved proposals are escaped, status-distinct, responsive, and expose copy-only apply handoffs', async ({ page, context }, info) => {
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
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })

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
test('localhost #harness renders the populated harness view and the Overview carries its card', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${APP}/#harness?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Harness' })).toBeVisible()
  await expect(page.locator('.herotitle', { hasText: '1 of 1 skills never fired' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.scroll-x table.grid td.mono', { hasText: 'skill_listing' })).toBeVisible()
  await expect(page.locator('[data-copy=\'claude "/orangu:harness --scope repo"\']')).toBeVisible()
  await expect(page.getByText('found no harness config')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.goto(withTheme(`${APP}/#overview?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  // the card links through cleanHash, so it carries whatever theme the current view is in
  await expect(page.locator(`a.harness-card[href="${withTheme(`#harness?s=${SESSION}`, info)}"]`)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('nav[aria-label="Report"] a', { hasText: 'Harness' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

test('repo whole-harness review is copy-only and never posts a kickoff', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  let kickoffPosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/kickoff')) kickoffPosts++
  })
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}&scope=repo`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Whole-harness review')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('claude "/orangu:harness --scope repo"')).toBeVisible()
  await page.getByRole('button', { name: 'Copy the whole-harness command' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(kickoffPosts).toBe(0)
  expect(errors).toEqual([])
})

// The hash is the only carrier of the theme now that nothing follows the system colour scheme, so the
// one click the Repo screen promotes to a primary CTA has to keep it. Loading a dark page proves the
// cascade; only clicking proves the link.
test('the Repo hero CTA keeps the reader in the theme and audience they are in', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${APP}/#repo?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Repo' })).toBeVisible()
  const cta = page.getByRole('link', { name: /Review repo improvements/ })
  await expect(cta).toBeVisible({ timeout: 20_000 })
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  await cta.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  const hash = await page.evaluate(() => location.hash)
  expect(hash).toContain('scope=repo')
  expect(hash.includes('theme=dark')).toBe(projectTheme(info) === 'dark')
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  await expect(page.locator('.eyebrow', { hasText: 'Whole-harness review' })).toBeVisible()
  expect(errors).toEqual([])
})

/**
 * A click used to be followed by nothing at all until the whole screen had been built in one task:
 * measured at 304 ms of blocked thread on a 50-turn Timeline, with the DOM swap as the first thing
 * the reader ever saw. The shell now marks the region busy and yields a painted frame first. A
 * MutationObserver installed before the app boots is what makes that provable: polling for a state
 * that lasts one frame is a race, but an observer sees every attribute flip in order.
 */
test('a sidebar click is acknowledged before the new screen is built', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.addInitScript(() => {
    const w = window as unknown as { __busyMarks: number }
    w.__busyMarks = 0
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement
        if (target.classList?.contains('main') && target.getAttribute('aria-busy') === 'true') w.__busyMarks++
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] })
  })
  await page.goto(withTheme(`${APP}/#overview?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __busyMarks: number }).__busyMarks)).toBe(0)

  await page.locator('nav[aria-label="Report"] a', { hasText: 'Timeline' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible()
  // the region was marked busy on the way, and the region that replaced it is not born busy
  expect(await page.evaluate(() => (window as unknown as { __busyMarks: number }).__busyMarks)).toBeGreaterThan(0)
  await expect(page.locator('main.main')).not.toHaveAttribute('aria-busy', 'true')

  // and the mark actually paints something. It has to be fully opaque with no delay: a blocked build
  // produces no further frames, so anything not visible in the one yielded frame is never seen.
  const painted = await page.evaluate(() => {
    const main = document.querySelector('main.main')!
    main.setAttribute('aria-busy', 'true')
    const bar = getComputedStyle(main, '::after')
    const seen = { name: bar.animationName, delay: bar.animationDelay, opacity: bar.opacity, height: bar.height, position: bar.position, cursor: getComputedStyle(main).cursor }
    main.removeAttribute('aria-busy')
    return seen
  })
  expect(painted).toEqual({ name: 'o-busy', delay: '0s', opacity: '1', height: '2px', position: 'fixed', cursor: 'progress' })
  expect(errors).toEqual([])
})

/**
 * Each Improvements card names its change while closed, and the way to an AI proposal is explained
 * once, above the cards. The plugin install is 2 lines typed in Claude Code, so each line has its own
 * bar: one bar with both copied a line that does not run. The reason and the method wait behind one Why
 * disclosure, and a re-render of the same screen keeps it open: on localhost (the serve bundle) and on
 * the published sample (the file bundle, whose first finding also has a method).
 */
test('each Improvements card names its improvement while closed, opens its reason under Why, keeps Why open on a re-render, and one explainer copies one install line per bar', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  const explainer = page.locator('.card', { has: page.locator('.eyebrow', { hasText: 'Get an AI proposal' }) })
  await expect(explainer).toHaveCount(1)
  await expect(explainer).toContainText('Paste it in a terminal')
  await expect(explainer).toContainText('It starts Claude Code.')
  const bars = explainer.locator('.cmd')
  await expect(bars).toHaveCount(2)
  await explainer.getByRole('button', { name: 'copy the install command' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/plugin install orangu')
  await explainer.getByRole('button', { name: 'copy the marketplace command' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/plugin marketplace add NissanOhana/orangu')
  const row = page.locator('details.finding').first()
  await expect(row).not.toHaveAttribute('open', '')
  await expect(row.locator('summary .sg-lead')).toBeVisible()
  await expect(row.locator('summary .sg-lead')).toContainText('Improvement:')
  await expect(row.locator('.steps')).toHaveCount(0)
  await noHorizontalOverflow(page)
  await expectWhyOpensAndSurvivesARerender(page, 'localhost session', false)
  await noHorizontalOverflow(page)
  expect(await paintedTheme(page)).toBe(projectTheme(info))

  await page.goto(withTheme(`${SITE}/sample.html#suggest`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  await expectWhyOpensAndSurvivesARerender(page, 'sample.html session', true)
  await noHorizontalOverflow(page)
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  expect(errors).toEqual([])
})

// No length cap on content: a closed card shows its whole improvement line at every width, and the reader opens
// the card only for the reason. A test that reads textContent cannot see what CSS hides, so the box of each
// closed lead must hold all of its text (2 px for rounding). A 2-line clamp cut 17 of the 18 session leads and
// 19 of the 20 repo leads of the published samples at 390 px, and none at 1440 px: the narrow projects check it.
test('each closed card shows its whole improvement line in a narrow window, with no line clamp', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('narrow'), 'a clamp cuts a lead where the window is narrow')
  const errors = runtimeErrors(page)
  for (const [url, heading] of [
    [`${SITE}/sample.html#suggest`, 'Improvements'],
    [`${SITE}/sample-repo.html#suggest`, 'Improvements'],
    [`${SITE}/sample.html#overview`, 'Overview'],
  ] as const) {
    // a fresh document each time, so the leads are the ones this screen drew
    await page.goto('about:blank')
    await page.goto(withTheme(url, info), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: heading }), url).toBeVisible()
    const leads = page.locator('main.main details.finding:not([open]) > summary > .sg-lead')
    await expect(leads.first(), `${url}: a closed card`).toBeVisible()
    const cut = await leads.evaluateAll((all) =>
      all.filter((el) => el.scrollHeight > el.clientHeight + 2).map((el) => `${(el.textContent ?? '').slice(0, 48)}: ${el.scrollHeight} px of text in ${el.clientHeight} px`),
    )
    expect(cut, `${url}: closed leads that CSS cuts`).toEqual([])
  }
  expect(errors).toEqual([])
})

// The page head of every screen offers the show-me command for what the page shows. Copy only.
test('Show me in the page head copies the session show-me command, opens and closes from the keyboard, and keeps the theme', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  await page.goto(withTheme(`${APP}/#overview?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  const control = page.locator('.page-head').getByRole('button', { name: 'Show me', exact: true })
  await expect(control).toHaveAttribute('aria-expanded', 'false')
  await control.click()
  await expect(control).toHaveAttribute('aria-expanded', 'true')
  const popover = page.locator('#show-me > .card')
  await expect(popover).toBeVisible()
  await expect(popover).toContainText('a slide deck and a written report')
  const command = `claude "/orangu:show-me ${SESSION}"`
  const bar = popover.locator('.cmd').first()
  await expect(bar.locator('.txt')).toHaveText(command)
  await popover.getByRole('button', { name: 'copy the show me command' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command)
  await expect(popover.locator('.cmd')).toHaveCount(3)
  await noHorizontalOverflow(page)
  await control.focus()
  await page.keyboard.press('Enter')
  await expect(control).toHaveAttribute('aria-expanded', 'false')
  await expect(popover).toBeHidden()
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  expect(errors).toEqual([])
})

test('Show me copies the scope command on the Repo screen and on a saved repository report', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE })
  const scoped = 'claude "/orangu:show-me --scope repo"'
  for (const url of [`${APP}/#repo?s=${SESSION}`, `${SITE}/sample-repo.html#repo`]) {
    await page.goto(withTheme(url, info), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: 'Repo' })).toBeVisible()
    await page.locator('.page-head').getByRole('button', { name: 'Show me', exact: true }).click()
    const bar = page.locator('#show-me > .card .cmd').first()
    await expect(bar.locator('.txt')).toHaveText(scoped)
    await bar.locator('.copy').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(scoped)
    expect(await paintedTheme(page)).toBe(projectTheme(info))
  }
  // the session sample ships the same bundle and copies its session instead
  await page.goto(withTheme(`${SITE}/sample.html#overview`, info), { waitUntil: 'domcontentloaded' })
  await page.locator('.page-head').getByRole('button', { name: 'Show me', exact: true }).click()
  await expect(page.locator('#show-me > .card .cmd .txt').first()).toHaveText(/^claude "\/orangu:show-me [0-9a-f-]+"$/)
  expect(errors).toEqual([])
})

// The link sits below the fold on common laptop and phone viewports, so the click scrolls first. A new
// screen opens at its top: the steps have to be on screen, not only in the DOM (toBeVisible cannot see that).
test('the Overview top card leads to the 3 steps on screen and keeps the theme and the audience', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const sizes = info.project.name.startsWith('wide') ? [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1366, height: 768 }] : [{ width: 390, height: 844 }]
  // the served app and the published sample (a longer Overview, so the link sits further down)
  for (const overview of [`${APP}/#overview?s=${SESSION}`, `${SITE}/sample.html#overview`]) {
    for (const size of sizes) {
      for (const audience of ['dev', 'plain']) {
        const where = `${overview} ${size.width}x${size.height} ${audience}`
        await page.setViewportSize(size)
        // a fresh document each time: a hash-only goto would keep the last screen's scroll
        await page.goto('about:blank')
        await page.goto(withTheme(`${overview}${overview.includes('?') ? '&' : '?'}audience=${audience}`, info), { waitUntil: 'domcontentloaded' })
        const top = page.locator('details.finding.top')
        await expect(top.locator('summary .sg-lead'), where).toBeVisible()
        await expect(top, where).toContainText('It starts Claude Code.')
        await top.getByRole('link', { name: 'See the 3 steps →' }).click()
        await expect(page.getByRole('heading', { level: 1, name: 'Improvements' }), where).toBeVisible()
        // the whole list, not one pixel of it: a list scrolled above the viewport can still overlap it
        await expect(page.getByRole('list', { name: 'Get an AI proposal' }), where).toBeInViewport({ ratio: 1 })
        const hash = await page.evaluate(() => location.hash)
        expect(hash, where).toContain(`audience=${audience}`)
        expect(hash.includes('theme=dark'), where).toBe(projectTheme(info) === 'dark')
        expect(await paintedTheme(page), where).toBe(projectTheme(info))
      }
    }
  }
  expect(errors).toEqual([])
})

// The other half of the rule above: a render of the same screen (a live tick, an audience switch) keeps
// the reader's place, and only a new screen opens at its top.
test('a re-render of the same screen keeps the scroll position, and a new screen opens at its top', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('wide'), '.main is the scroller only in the wide layout')
  const errors = runtimeErrors(page)
  // short enough that both screens scroll in the wide layout
  await page.setViewportSize({ width: 1440, height: 600 })
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  await page.locator('main.main').evaluate((m) => { m.scrollTop = 160 })
  const before = await page.locator('main.main').evaluate((m) => m.scrollTop)
  expect(before).toBeGreaterThan(0)
  await page.evaluate(() => { location.hash += '&audience=plain' })
  await expect(page.getByRole('button', { name: 'Plain language' })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.locator('main.main').evaluate((m) => m.scrollTop)).toBe(before)
  await page.evaluate(() => { location.hash = location.hash.replace('#suggest', '#overview') })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  // the screen is tall enough to have kept the old offset, so 0 is the reset and not a clamp
  expect(await page.locator('main.main').evaluate((m) => m.scrollHeight - m.clientHeight)).toBeGreaterThan(before)
  expect(await page.locator('main.main').evaluate((m) => m.scrollTop)).toBe(0)
  expect(errors).toEqual([])
})

test('an example session link on a repo improvement keeps the theme and the audience', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}&scope=repo&audience=plain`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  const row = page.locator('details.finding').first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.locator(':scope > summary').click()
  await row.locator('a.exch').first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  const hash = await page.evaluate(() => location.hash)
  expect(hash).toContain('audience=plain')
  expect(hash.includes('theme=dark')).toBe(projectTheme(info) === 'dark')
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  expect(errors).toEqual([])
})
