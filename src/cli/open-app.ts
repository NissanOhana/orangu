/**
 * The browser handoff of the local app (bare `orangu`, `orangu serve`, `orangu feedback`). The capability URL opens
 * every session with its transcript text, and `ps` shows the argv of each process to every local account. So the URL
 * never goes into the argv of the opener. orangu writes a redirect page into a private folder of the orangu home and
 * hands the opener only the path of that page, as Jupyter does with use_redirect_file. The page holds 1 meta refresh
 * to the loopback URL and nothing else, and the app removes it when it stops.
 *
 * In an SSH session orangu opens no browser: the opener would run on the remote host, and the URL is on the terminal.
 */
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from '../cache/index.js'
import { oranguHome } from '../util/home.js'
import { openInBrowser } from './open-browser.js'
import { oneLine } from './tty.js'

/** The only URL that a redirect page may name: the capability root of the local app, or a deep link of it. */
const APP_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/_orangu\/[A-Za-z0-9_-]{43}(?:\/#[A-Za-z0-9?=_-]+)?$/

/** The folder of the redirect pages, in the orangu home. */
export const PAGE_FOLDER = 'open'

export interface AppHandoff {
  /** the redirect page that the opener got; absent when orangu opened no browser */
  page?: string
  /** removes the redirect page; safe to call more than once */
  remove(): void
  /** why orangu opened no browser, for 1 line on stderr; absent when it opened one, and in an SSH session */
  note?: string
}

export interface AppHandoffDeps {
  env?: NodeJS.ProcessEnv
  /** the OS opener; the default is openInBrowser */
  open?: (target: string) => unknown
  /** runs `fn` once at the exit of the process, as the last removal of the page; the default is process.once('exit') */
  onExit?: (fn: () => void) => void
}

/** The redirect page: 1 meta refresh to the app. The URL check keeps the page on 127.0.0.1 and inside its attribute. */
export function redirectPage(url: string): string {
  if (!APP_URL.test(url)) throw new Error('orangu writes a redirect page only for the loopback URL of its app')
  return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${url}">\n`
}

/** Open the app at `url` through a private redirect page. It never throws: a failure is a note, and the app runs on. */
export async function openApp(url: string, deps: AppHandoffDeps = {}): Promise<AppHandoff> {
  const env = deps.env ?? process.env
  if (env['SSH_CONNECTION']) return { remove: () => undefined }
  const folder = join(oranguHome(env), PAGE_FOLDER)
  const page = join(folder, `${randomBytes(16).toString('hex')}.html`)
  let written = false
  const remove = (): void => {
    if (!written) return
    try {
      unlinkSync(page)
    } catch {
      /* removed already */
    }
  }
  try {
    const html = redirectPage(url)
    await ensurePrivateDirectory(folder)
    // wx: a new file only, so the write never follows a link that another process put in its place
    await writeFile(page, html, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
    written = true
    ;(deps.onExit ?? ((fn) => process.once('exit', fn)))(remove)
    ;(deps.open ?? openInBrowser)(page)
    return { page, remove }
  } catch (e) {
    remove()
    return { remove, note: `orangu opened no browser: ${oneLine(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')}. Open the app URL by hand.` }
  }
}
