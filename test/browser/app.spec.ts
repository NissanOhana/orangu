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
 * `top` is the Overview top card: it opens with the page, so the reader clicks only Why.
 */
async function expectWhyOpensAndSurvivesARerender(page: Page, where: string, method: boolean, top = false): Promise<void> {
  const card = page.locator(top ? 'details.finding.top' : 'details.finding').first()
  const why = card.locator('details.why')
  const toggle = why.getByRole('button', { name: 'Why', exact: true })
  const reason = why.locator(':scope > p:not(.muted)')
  await expect(why, where).toHaveCount(1)
  const reasonText = ((await reason.textContent()) ?? '').trim()
  expect(reasonText.length, `${where}: the reason`).toBeGreaterThan(0)
  if (top) await expect(card, `${where}: the top card opens with the page`).toHaveAttribute('open', '')
  else await expect(card, where).not.toHaveAttribute('open')
  await expect(card.locator(':scope > summary .sg-lead'), where).toContainText('Improvement:')
  await expect(card.locator(':scope > summary'), where).not.toContainText(reasonText)

  if (!top) await card.locator(':scope > summary').click()
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

test('localhost queue rows are escaped, show the stored proposal whole, stay responsive, and copy only their next step', async ({ page, context }, info) => {
  const errors = runtimeErrors(page)
  const proposedId = 'sg_0000000000c1'
  const proposal = {
    v: 1, title: '<img src=x onerror=alert(1)>', change: 'Update one instruction', effort: 'S',
    proposalPath: '/tmp/proposal.md', manifestPath: '/tmp/proposal.json', files: ['CLAUDE.md'], changeClass: 'instruction', evidence: 'Measured locally',
    expectedEffect: 'Avoid repeated reads', risk: 'One narrow file', verification: 'Check a later run',
    workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
    sources: [{ kind: 'research', label: '<unsafe source>', url: 'https://example.test/?q=<x>', verifiedAt: '2026-08-26' }],
  }
  // the proposed record stores more files than the list shows, and an evidence field past 600 characters
  const files = Array.from({ length: 9 }, (_, i) => `docs/file-${i + 1}.md`)
  const evidence = `Measured locally. ${'Each word stays on the page. '.repeat(30)}The evidence ends here.`
  const records = [
    { id: proposedId, v: 2, createdAt: 1, source: 'skill', scope: 'session', sessionIds: [SESSION], ruleId: 'saved-proposal', title: 'Saved', evidence: { estimated: true }, proposal: { ...proposal, files, evidence }, status: 'proposed', statusAt: 2 },
  ]
  const next = `claude "/orangu:apply ${proposedId}"`
  const row = { group: 'apply', id: proposedId, ids: [proposedId], status: 'proposed', scope: 'session', changeClass: 'instruction', title: '<img src=x onerror=alert(2)>', workspace: '/workspace/project', lastMoveAt: 2, earlier: [], earlierCount: 0, next }
  const queue = {
    v: 1, scope: '/workspace/project', now: 3, globalOpen: 0,
    counts: { verdict: 0, regressed: 0, apply: 1, review: 0, running: 0, wait: 0, due: 0, open: 1 },
    groups: { verdict: [], regressed: [], apply: [row], review: [], running: [], wait: [] },
  }
  await page.route('**/api/queue**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(queue) }))
  await page.route('**/api/suggestions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(records) }))
  await page.route('**/api/app**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    body['suggestions'] = records
    await route.fulfill({ response, json: body })
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })

  const home = page.locator('#home-queue')
  await expect(home.locator(':scope > summary')).toContainText('Queue · 1 open')
  await expect(home.locator('img')).toHaveCount(0)
  const proposed = home.locator(`#q-${proposedId}`)
  await expect(proposed.locator(':scope > summary .q-meta')).toHaveText(`${proposedId} · session · project · Instruction files · effort S · 1970-01-01`)
  // the row's own summary: the Proposal disclosure and the disclosure of the file list inside the body have one too
  await proposed.locator(':scope > summary').click()
  await expect(proposed).toContainText('<img src=x onerror=alert(2)>')
  const block = proposed.locator(`#qp-${proposedId}`)
  await block.locator(':scope > summary').click()
  await expect(block).toContainText('<img src=x onerror=alert(1)>')

  // No silent cut. 6 of the 9 files show, and a closed disclosure says so and opens from the keyboard to the other 3.
  const more = proposed.getByRole('button', { name: '6 of 9 files show above. Show 3 more.', exact: true })
  const file = (n: number) => proposed.getByText(`docs/file-${n}.md`, { exact: true })
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(file(6)).toBeVisible()
  await expect(file(7)).toBeHidden()
  await more.focus()
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  for (const n of [7, 8, 9]) await expect(file(n)).toBeVisible()
  // The evidence field shows whole. A test that reads text cannot see what CSS hides, so no box from the field up
  // to the row may hold less than its content (2 px for rounding).
  const field = proposed.locator('.sg-pfield', { hasText: 'The evidence ends here.' })
  await expect(field).toBeVisible()
  const clipped = await field.evaluate((el: HTMLElement) => {
    const cut: string[] = []
    for (let box: HTMLElement | null = el; box && !box.matches('.saved-proposal'); box = box.parentElement) {
      if (box.scrollHeight > box.clientHeight + 2 || box.scrollWidth > box.clientWidth + 2) cut.push(`${box.className}: ${box.scrollHeight}x${box.scrollWidth} in ${box.clientHeight}x${box.clientWidth}`)
    }
    return cut
  })
  expect(clipped, 'boxes that clip the evidence field').toEqual([])

  // The row copies its own next step. The stored block shows no second apply handoff.
  const copy = proposed.locator('.btn-primary[data-copy]')
  await expect(copy).toHaveCount(1)
  await expect(copy).toHaveAttribute('data-copy', next)
  await expect(proposed.locator('[aria-label="Apply handoff"]')).toHaveCount(0)
  await expect(proposed).not.toContainText('Codex')
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(next)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

  // A re-render builds the screen again from nothing (the audience switch does it). The open file list stays
  // open, because its disclosure carries an id that the re-render seam keys.
  await more.evaluate((el) => el.setAttribute('data-drawn-before', ''))
  await page.evaluate(() => { location.hash += (location.hash.includes('?') ? '&' : '?') + 'audience=plain' })
  await expect(page.getByRole('button', { name: 'Plain language' })).toHaveAttribute('aria-pressed', 'true')
  await expect(more, 'a new node').not.toHaveAttribute('data-drawn-before')
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(file(9)).toBeVisible()
  expect(errors).toEqual([])
})

/** The ratio of each visible text of `root` against its own painted ground (the method of the landing checks). */
async function textContrasts(page: Page, root: string): Promise<Array<{ text: string; ratio: number }>> {
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
    return Array.from(document.querySelectorAll(`${sel}, ${sel} *`))
      .filter((element) => !element.closest('[aria-hidden="true"]') && (element as HTMLElement).getClientRects().length > 0)
      .filter((element) => Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node as Text).data.trim()))
      .map((element) => {
        const text = luminance(rgb(getComputedStyle(element).color))
        const ground = luminance(groundOf(element))
        return { text: (element.textContent ?? '').trim().slice(0, 60), ratio: (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05) }
      })
  }, root)
}

// The improvement home on the served fixture store (app-server.ts): 1 open record in each group of the queue.
test('the Queue section shows the 6 groups in order, opens each row from the keyboard, and paints each text at 4.5:1 or more', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  const queue = page.locator('#home-queue')
  await expect(queue.locator(':scope > summary')).toContainText('Queue · 1 due · 6 open', { timeout: 20_000 })
  await expect(queue).toHaveAttribute('open', '')
  // the home sits after the hero and above the scope chips, and the heading of the findings closes it
  const order = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const at = (el: Element | null | undefined) => (el ? all.indexOf(el) : -1)
    const heading = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'Findings in this scope')
    return [at(document.querySelector('#screen-suggest .hero')), at(document.getElementById('home-queue')), at(heading), at(document.querySelector('#screen-suggest .chiprow'))]
  })
  expect(order.every((n, i) => n > (order[i - 1] ?? -1)), `hero, Queue, heading, chips: ${order.join(', ')}`).toBe(true)

  const groups = queue.locator('details.card[id^="q-0-"]')
  await expect(groups).toHaveCount(6)
  expect(await groups.evaluateAll((els) => els.map((el) => el.id))).toEqual(['q-0-verdict', 'q-0-regressed', 'q-0-apply', 'q-0-review', 'q-0-running', 'q-0-wait'])
  await expect(queue.locator('.tag')).toHaveCount(1)
  await expect(queue.locator('#q-0-verdict .tag.good')).toHaveText('Due')

  // each row opens from the keyboard, with its summary as the accessible name of the toggle
  const rows = queue.locator('details.saved-proposal')
  await expect(rows).toHaveCount(6)
  for (let i = 0; i < 6; i++) {
    const toggle = rows.nth(i).locator(':scope > summary')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  // 5 rows have a next step to copy, and the row that waits has none
  await expect(queue.locator('.btn-primary[data-copy]')).toHaveCount(5)
  await expect(queue.locator('#q-0-wait .cmd')).toHaveCount(0)
  await expect(queue.locator('#q-0-verdict .btn-primary')).toHaveAttribute('data-copy', 'claude "/orangu:improve --verify sg_0000000000b1"')

  // The read of every workspace runs on the first open of its disclosure. An earlier test of the suite can add a
  // record with no workspace (a kickoff), so the count is the read's own, and this workspace never shows again.
  const all = page.locator('#home-all-queue')
  await all.locator(':scope > summary').click()
  await expect(all.locator(':scope > summary')).toContainText(/All workspaces · \d+ open$/)
  await expect(all.locator(':scope > div')).not.toHaveAttribute('aria-busy', 'true')
  await expect(all.locator('details.saved-proposal[id^="q-sg_0000000000b"]')).toHaveCount(0)
  // The fixture store holds 1 proposal of a second workspace. The disclosure stays open when its read lands, and it
  // draws that workspace by its folder and its path, with its row in the group of its read.
  await expect(all).toHaveAttribute('open', '')
  await expect(all.locator('.card-title').first()).toHaveText('other')
  await expect(all.locator('.card-title').first().locator('xpath=following-sibling::div[1]')).toHaveText(/\/other$/)
  const other = all.locator('#q-1-apply details.saved-proposal')
  await expect(other).toHaveCount(1)
  await expect(other).toHaveAttribute('id', 'q-sg_0000000000d1')
  await expect(other.locator(':scope > summary')).toContainText('Keep one test command for the whole repository')

  // every row is open, so the check reads the summaries, the labels, the row copy, the commands and the controls
  const contrasts = await textContrasts(page, '#home-queue')
  expect(contrasts.length, 'visible texts measured').toBeGreaterThan(60)
  const low = contrasts.filter((t) => t.ratio < 4.5)
  expect(low, 'text under 4.5:1 in the Queue section').toEqual([])
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

test('a closed Queue section stays closed after a re-render, and the Overview carries the queue card', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  const toggle = page.locator('#home-queue > summary')
  await expect(toggle).toContainText('Queue · 1 due · 6 open', { timeout: 20_000 })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.locator('#home-queue').evaluate((el) => el.setAttribute('data-drawn-before', ''))
  await page.evaluate(() => { location.hash += (location.hash.includes('?') ? '&' : '?') + 'audience=plain' })
  await expect(page.getByRole('button', { name: 'Plain language' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#home-queue'), 'a new node').not.toHaveAttribute('data-drawn-before')
  await expect(page.locator('#home-queue')).not.toHaveAttribute('open')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // Plain: the queue card alone, between the top improvement and "Where to look next"
  await page.goto(withTheme(`${APP}/#overview?s=${SESSION}&audience=plain`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('a.harness-card[href^="#suggest"]')).toContainText('Improvements: 1 due, 1 regressed, 1 to apply')
  await expect(page.locator('a.harness-card[href^="#harness"]')).toHaveCount(0)
  // Detailed: the queue card first and the harness card second, in 1 row
  await page.goto(withTheme(`${APP}/#overview?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  const cards = page.locator('.two-up > a.harness-card')
  await expect(cards.first()).toHaveAttribute('href', withTheme(`#suggest?s=${SESSION}`, info))
  await expect(cards.nth(1)).toHaveAttribute('href', withTheme(`#harness?s=${SESSION}`, info))
  await cards.first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  expect(errors).toEqual([])
})

test('Review the whole harness moves focus to the copy control of the whole-harness card', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}&scope=repo`, info), { waitUntil: 'domcontentloaded' })
  const jump = page.getByRole('button', { name: 'Review the whole harness ↓' })
  await expect(jump).toBeVisible({ timeout: 20_000 })
  await jump.press('Enter')
  await expect(page.locator('#home-mega .btn-primary')).toBeFocused()
  expect(errors).toEqual([])
})

const REASON_LABELS = ['I do not want this change', 'It is already handled', 'The cause is somewhere else', 'It takes too much effort', 'Other reason']
const CONFIRM_NAME = 'Dismiss this item? You cannot undo it. Dismiss does not undo a change in your files.'

// The Dismiss confirm on the served fixture store. This test sends no write: a route that records each status call
// stands between the page and the store, and the test ends with no call.
test('the Dismiss confirm opens on its first reason, closes with Escape, and keeps its reason and its focus through a re-render', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const posts: string[] = []
  await page.route('**/api/suggestions/*/status', (route) => {
    posts.push(route.request().url())
    return route.abort()
  })
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  const queue = page.locator('#home-queue')
  await expect(queue.locator(':scope > summary')).toContainText('Queue · 1 due · 6 open', { timeout: 20_000 })
  // Dismiss shows in the rows of 4 groups, and in no row that verifies or waits
  for (const group of ['regressed', 'apply', 'review', 'running']) await expect(queue.locator(`#q-0-${group} [data-q-dismiss]`), group).toHaveCount(1)
  for (const group of ['verdict', 'wait']) await expect(queue.locator(`#q-0-${group} [data-q-dismiss]`), group).toHaveCount(0)

  const row = queue.locator('#q-0-apply details.saved-proposal')
  await row.locator(':scope > summary').click()
  const open = row.locator('[data-q-dismiss]')
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  await open.click()
  const box = row.getByRole('group', { name: CONFIRM_NAME })
  const reasons = box.getByRole('radio')
  const go = box.locator('[data-q-confirm]')
  await expect(box).toBeVisible()
  await expect(reasons.first()).toBeFocused()
  await expect(open).toBeHidden()
  await expect(open).toHaveAttribute('aria-expanded', 'true')
  await expect(go).toHaveAttribute('aria-disabled', 'true')
  expect(await reasons.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).labels?.[0]?.textContent))).toEqual(REASON_LABELS)
  await expect(box.locator('input:not([type="radio"]), textarea, [contenteditable]')).toHaveCount(0)
  expect(await paintedTheme(page)).toBe(projectTheme(info))

  // With no reason, Enter on the confirm's Dismiss sends nothing and puts focus on the first reason. The button is
  // aria-disabled, so Playwright does not click it, and the keyboard path is the one to prove.
  await go.focus()
  await page.keyboard.press('Enter')
  await expect(reasons.first()).toBeFocused()

  // Escape closes the confirm, and the row's Dismiss shows again with focus
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(open).toBeVisible()
  await expect(open).toBeFocused()
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  expect(await paintedTheme(page)).toBe(projectTheme(info))

  // from the keyboard: Enter opens it, an arrow key checks the next reason, and Dismiss is on
  await page.keyboard.press('Enter')
  await expect(reasons.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const second = box.getByRole('radio', { name: REASON_LABELS[1] })
  await expect(second).toBeChecked()
  await expect(second).toBeFocused()
  await expect(go).toHaveAttribute('aria-disabled', 'false')

  // A re-render builds the screen again from nothing (the audience switch does it). The confirm is drawn again, open,
  // with the same reason checked and focus on the same control.
  await box.evaluate((el) => el.setAttribute('data-drawn-before', ''))
  await page.evaluate(() => { location.hash += (location.hash.includes('?') ? '&' : '?') + 'audience=plain' })
  await expect(page.getByRole('button', { name: 'Plain language' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-drawn-before]'), 'a new node').toHaveCount(0)
  await expect(box).toBeVisible()
  await expect(second).toBeChecked()
  await expect(second).toBeFocused()

  // each text of the open confirm is 4.5:1 or more against its painted ground
  const contrasts = await textContrasts(page, '.dismiss')
  expect(contrasts.length, 'visible texts measured').toBeGreaterThan(7)
  expect(contrasts.filter((t) => t.ratio < 4.5), 'text under 4.5:1 in the confirm').toEqual([])

  // Cancel closes it too
  await box.getByRole('button', { name: 'Cancel' }).click()
  await expect(box).toHaveCount(0)
  await expect(open).toBeFocused()
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  await noHorizontalOverflow(page)
  expect(posts).toEqual([])
  expect(errors).toEqual([])
})

// The Dismiss writes, on a queue that the test serves, so no call reaches the shared fixture store. The status route of
// the test refuses the middle record of a folded item with a 500.
test('Dismiss sends 1 reason code for each folded record, newest first, says what changed, and moves focus when the row leaves', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  const single = 'sg_0000000000e9'
  const folded = ['sg_0000000000e3', 'sg_0000000000e2', 'sg_0000000000e1']
  const refused = folded[1]!
  const open = new Set([single, ...folded])
  const posted: Array<{ id: string; body: unknown }> = []
  const rowOf = (group: 'apply' | 'review', ids: string[]) => ({
    group, id: ids[0], ids, status: group === 'apply' ? 'proposed' : 'new', scope: 'repo', workspace: '/workspace/project', lastMoveAt: 2, earlier: [], earlierCount: 0,
    title: group === 'apply' ? 'Keep one test command for the whole repository' : 'Read each file once, then keep it in context',
    next: group === 'apply' ? `claude "/orangu:apply ${ids[0]}"` : `claude "/orangu:improve ${ids[0]}"`,
  })
  const read = () => {
    const apply = open.has(single) ? [rowOf('apply', [single])] : []
    const left = folded.filter((id) => open.has(id))
    const review = left.length ? [rowOf('review', left)] : []
    const counts = { verdict: 0, regressed: 0, apply: apply.length, review: review.length, running: 0, wait: 0, due: 0, open: apply.length + review.length }
    return { v: 1, scope: '/workspace/project', now: 3, globalOpen: 0, counts, groups: { verdict: [], regressed: [], apply, review, running: [], wait: [] } }
  }
  await page.route('**/api/queue**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(read()) }))
  await page.route('**/api/suggestions/*/status', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    const body = route.request().postDataJSON() as { reason?: string }
    posted.push({ id, body })
    if (id === refused) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the store refused the write' }) })
    open.delete(id)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, status: 'rejected', reasonCode: body.reason }) })
  })
  await page.goto(withTheme(`${APP}/#suggest?s=${SESSION}`, info), { waitUntil: 'domcontentloaded' })
  const queue = page.locator('#home-queue')
  const summary = queue.locator(':scope > summary')
  await expect(summary).toContainText('Queue · 2 open', { timeout: 20_000 })
  const status = page.locator('#home-status')

  // 1 record: the row leaves the queue, the status region outside the app says so, and focus moves to the Queue
  // summary, because the group had no other row
  const one = queue.locator(`#q-${single}`)
  await one.locator(':scope > summary').click()
  await one.locator('[data-q-dismiss]').click()
  await one.locator('.dismiss').getByText(REASON_LABELS[3]!).click()
  await one.locator('[data-q-confirm]').click()
  await expect(one).toHaveCount(0)
  await expect(summary).toContainText('Queue · 1 open')
  await expect(status).toHaveText('orangu dismissed the item.')
  expect(await status.evaluate((el) => el.getAttribute('aria-live') === 'polite' && !el.closest('.app'))).toBe(true)
  await expect(summary).toBeFocused()
  expect(posted).toEqual([{ id: single, body: { status: 'rejected', reason: 'too-much-effort' } }])

  // 3 folded records: the second call fails, so 1 record changed, the line says so, and no third call goes out
  const many = queue.locator('#q-0-review details.saved-proposal')
  await many.locator(':scope > summary').click()
  await many.locator('[data-q-dismiss]').click()
  const box = many.getByRole('group', { name: CONFIRM_NAME })
  await expect(box).toContainText('This dismisses 3 records of this finding.')
  await box.getByText(REASON_LABELS[2]!).click()
  await box.locator('[data-q-confirm]').click()
  const partial = 'orangu dismissed 1 of 3 records. Then it stopped. The rest did not change.'
  await expect(box.locator('p.small')).toHaveText(partial)
  await expect(status).toHaveText(partial)
  expect(posted.slice(1)).toEqual(folded.slice(0, 2).map((id) => ({ id, body: { status: 'rejected', reason: 'wrong-cause' } })))
  // the read again names the item by its next record, and the confirm stays open on the 2 records that did not change
  await expect(many).toHaveAttribute('id', `q-${refused}`)
  await expect(box).toContainText('This dismisses 2 records of this finding.')
  await expect(box.getByRole('radio', { name: REASON_LABELS[2] })).toBeChecked()

  // the first call fails now: nothing changed, and nothing reads as done
  await box.locator('[data-q-confirm]').click()
  const none = 'orangu could not dismiss the item. Nothing changed.'
  await expect(box.locator('p.small')).toHaveText(none)
  await expect(status).toHaveText(none)
  await expect(box.locator('[data-q-confirm]')).toHaveAttribute('aria-disabled', 'false')
  expect(posted.map((p) => p.id)).toEqual([single, folded[0], refused, refused])
  await expect(many).toBeVisible()
  expect(await paintedTheme(page)).toBe(projectTheme(info))
  // the browser logs each refused call of the test route, and nothing else
  expect(errors.filter((e) => !e.includes('the server responded with a status of 500'))).toEqual([])
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

/**
 * Why on the cards that only the published samples carry: a repo card (the repository file, reached from its
 * sidebar), a global card (a scope chip on the session file) and the Overview top card, which opens with the
 * page. A click opens Why, aria-expanded says so, the reason shows, a re-render keeps it open and Enter closes it.
 */
test('Why opens on a repo card, a global card and the Overview top card, and a re-render keeps it open', async ({ page }, info) => {
  const errors = runtimeErrors(page)
  await page.goto(withTheme(`${SITE}/sample-repo.html#repo`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Repo' })).toBeVisible()
  await page.getByRole('link', { name: 'Improvements', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Repo · \d+$/ })).toHaveClass(/\bactive\b/)
  await expectWhyOpensAndSurvivesARerender(page, 'sample-repo.html repo', false)
  expect(await paintedTheme(page)).toBe(projectTheme(info))

  await page.goto(withTheme(`${SITE}/sample.html#suggest`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Improvements' })).toBeVisible()
  const chip = page.getByRole('button', { name: /^Global · \d+$/ })
  await chip.click()
  await expect(chip).toHaveClass(/\bactive\b/)
  await expectWhyOpensAndSurvivesARerender(page, 'sample.html global', false)
  await noHorizontalOverflow(page)

  // a fresh document: the Overview opens with no open state left from the Improvements screen
  await page.goto('about:blank')
  await page.goto(withTheme(`${SITE}/sample.html#overview`, info), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  await expectWhyOpensAndSurvivesARerender(page, 'sample.html Overview top card', true, true)
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
