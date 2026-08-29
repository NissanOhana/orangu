/**
 * Light is the only default, so an emulated dark colour scheme no longer changes what the product
 * paints: a project that wants dark has to ask for it. The report, the served app and the sample
 * read `theme=dark` out of the hash; the landing has no URL theme, so it reads the preference its
 * own toggle stores. Every project declares its theme in playwright.config.ts, and a project that
 * declares none fails loudly rather than quietly verifying light twice.
 */
import type { Page, TestInfo } from '@playwright/test'

export type Theme = 'light' | 'dark'

export function projectTheme(info: TestInfo): Theme {
  const declared = (info.project.metadata as { theme?: string }).theme
  if (declared !== 'light' && declared !== 'dark') {
    throw new Error(`project ${info.project.name} declares no theme metadata`)
  }
  return declared
}

/** Add `theme=dark` to a hash URL for the dark projects; light stays on the clean default hash. */
export function withTheme(url: string, info: TestInfo): string {
  if (projectTheme(info) === 'light') return url
  const at = url.indexOf('#')
  if (at < 0) throw new Error(`withTheme needs a hash URL, got ${url}`)
  return url + (url.slice(at).includes('?') ? '&' : '?') + 'theme=dark'
}

/** Seed the landing's stored preference before first paint, so a dark project renders dark. */
export async function seedLandingTheme(page: Page, info: TestInfo): Promise<void> {
  await page.addInitScript((value: string) => {
    try {
      localStorage.setItem('orangu-theme', value)
    } catch {
      /* a browser with site data blocked still renders the default */
    }
  }, projectTheme(info))
}

/**
 * What the page actually paints, read off the body background rather than the attribute: the
 * attribute is what the client sets, the background is what the cascade did with it.
 */
export async function paintedTheme(page: Page): Promise<Theme> {
  const rgb = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const channels = (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number)
  const total = channels.reduce((sum, channel) => sum + channel, 0)
  return total > 383 ? 'light' : 'dark'
}
