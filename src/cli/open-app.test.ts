/**
 * The browser handoff of the local app: the opener gets the path of a redirect page, never the capability URL,
 * because `ps` shows the argv of each process to every local account.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openApp, redirectPage } from './open-app.js'

const CAPABILITY = 'q2X8vB0Lw9kZ3mN1pR7sT5uV4xY6zA2bC8dE0fG1hI3'
const APP_URL = `http://127.0.0.1:53211/_orangu/${CAPABILITY}`
const FEEDBACK_URL = `${APP_URL}/#feedback?context=report`

/** A private orangu home, a fake opener and a fake exit hook: no browser runs, and no listener stays on the process. */
function handoff(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orangu-open-app-'))
  const opened: string[] = []
  const atExit: Array<() => void> = []
  const deps = { env: { ORANGU_HOME: home, ...env }, open: (target: string) => opened.push(target), onExit: (fn: () => void) => atExit.push(fn) }
  return { home, folder: join(home, 'open'), opened, atExit, deps }
}

describe('redirectPage', () => {
  it('holds 1 meta refresh to the app URL and nothing else', () => {
    expect(redirectPage(APP_URL)).toBe(`<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${APP_URL}">\n`)
    expect(redirectPage(FEEDBACK_URL)).toContain(`content="0;url=${FEEDBACK_URL}"`)
  })

  it('refuses each URL that is not the loopback app, so the page names no other host and breaks out of no attribute', () => {
    for (const url of [
      `http://localhost:53211/_orangu/${CAPABILITY}`,
      `https://127.0.0.1:53211/_orangu/${CAPABILITY}`,
      `http://127.0.0.1.example.com/_orangu/${CAPABILITY}`,
      `http://127.0.0.1:53211/_orangu/${CAPABILITY.slice(1)}`,
      `http://127.0.0.1:53211/_orangu/${CAPABILITY}/#x"><script>alert(1)</script>`,
      `http://127.0.0.1:53211/_orangu/${CAPABILITY}/#a&b`,
      'javascript:alert(1)',
    ]) {
      expect(() => redirectPage(url), url).toThrow('orangu writes a redirect page only for the loopback URL of its app')
    }
  })
})

describe('openApp', () => {
  it('hands the opener only the path of a 0600 page in a 0700 folder of the orangu home, and the name holds no capability', async () => {
    const h = handoff()
    const result = await openApp(APP_URL, h.deps)
    expect(result.note).toBeUndefined()
    expect(h.opened).toEqual([result.page])
    const page = result.page!
    expect(dirname(page)).toBe(h.folder)
    expect(basename(page)).toMatch(/^[0-9a-f]{32}\.html$/)
    expect(page).not.toContain(CAPABILITY)
    expect(readFileSync(page, 'utf8')).toBe(redirectPage(APP_URL))
    expect(statSync(page).mode & 0o777).toBe(0o600)
    expect(statSync(h.folder).mode & 0o777).toBe(0o700)
    // the process exit removes the page too, after a failed stop or an error
    expect(h.atExit).toEqual([result.remove])
  })

  it('removes the page, and a second remove is safe', async () => {
    const h = handoff()
    const result = await openApp(FEEDBACK_URL, h.deps)
    expect(readFileSync(result.page!, 'utf8')).toContain(FEEDBACK_URL)
    result.remove()
    expect(existsSync(result.page!)).toBe(false)
    expect(() => result.remove()).not.toThrow()
    expect(readdirSync(h.folder)).toEqual([])
  })

  it('gives each run its own page name', async () => {
    const h = handoff()
    const [a, b] = [await openApp(APP_URL, h.deps), await openApp(APP_URL, h.deps)]
    // both runs open a page: a name that repeats fails the exclusive write of the second run
    expect([a.note, b.note]).toEqual([undefined, undefined])
    expect(h.opened).toEqual([a.page, b.page])
    expect(new Set(h.opened).size).toBe(2)
  })

  it('opens no browser and writes no page in an SSH session: the URL is on the terminal', async () => {
    const h = handoff({ SSH_CONNECTION: '10.0.0.1 51234 10.0.0.2 22' })
    const result = await openApp(APP_URL, h.deps)
    expect(result.page).toBeUndefined()
    expect(result.note).toBeUndefined()
    expect(h.opened).toEqual([])
    expect(existsSync(h.folder)).toBe(false)
    expect(h.atExit).toEqual([])
  })

  it('opens no browser and says why when the folder is not a private folder', async () => {
    const h = handoff()
    // a symlink in the place of the folder: orangu never follows it
    const elsewhere = mkdtempSync(join(tmpdir(), 'orangu-open-app-elsewhere-'))
    symlinkSync(elsewhere, h.folder)
    const result = await openApp(APP_URL, h.deps)
    expect(result.page).toBeUndefined()
    expect(result.note).toMatch(/^orangu opened no browser: .+\. Open the app URL by hand\.$/)
    // the note names the folder of the pages in its own words, not the words of the cache
    expect(result.note).toContain(`the redirect page folder must be a real directory: ${h.folder}`)
    expect(result.note).not.toContain('cache')
    expect(h.opened).toEqual([])
    expect(readdirSync(elsewhere)).toEqual([])
    expect(lstatSync(h.folder).isSymbolicLink()).toBe(true)
  })

  it('opens no browser for a URL that is not the loopback app, and writes no page', async () => {
    const h = handoff()
    mkdirSync(h.folder, { mode: 0o700 })
    const result = await openApp('http://example.com/', h.deps)
    expect(result.note).toContain('orangu writes a redirect page only for the loopback URL of its app')
    expect(h.opened).toEqual([])
    expect(readdirSync(h.folder)).toEqual([])
  })
})
