/**
 * The contrast of the text tokens, computed from the source:
 * - `--ink3` holds 4.5:1 or more on each ground that carries tertiary text (`--bg`, `--surface`, `--bg2`), in light
 *   and dark;
 * - each selected-state text on `--accent-weak` holds 4.5:1 or more in light and dark. They are the active nav item
 *   and its hint, the selected picker row and its folder (styles.css), and the active demo tab (site/index.src.html);
 * - the landing copy buttons hold 4.5:1 or more on `--cmd`, in light and dark. test/browser/public-surfaces.spec.ts
 *   measures the same pair as painted.
 * The dark set is the light set with the dark rule on top, as the cascade does it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** The #rrggbb custom properties of the tokens.css rule whose selector is exactly `selector` (after src/god/ui/theme.test.ts:26-32). */
function tokensOf(selector: string): Record<string, string> {
  const css = read('src/report/client/tokens.css')
  const start = css.indexOf(`${selector}{`)
  if (start < 0) throw new Error(`tokens.css has no ${selector} rule`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!]))
}

const LIGHT = tokensOf(':root')
const THEMES = { light: LIGHT, dark: { ...LIGHT, ...tokensOf(':root[data-theme="dark"]') } } as const

/** The WCAG contrast ratio of 2 colors written as #rrggbb (copied from src/god/ui/theme.test.ts:35-41). */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

/** The value of `token` in `theme`, or a thrown error that names the missing token. */
function valueOf(theme: keyof typeof THEMES, token: string): string {
  const value = THEMES[theme][token]
  if (value === undefined) throw new Error(`tokens.css has no ${token} in the ${theme} set`)
  return value
}

/**
 * The token that the one rule with exactly `selector` draws its text in. The rule pattern is the one of
 * test/lint.test.ts:157, so a rule inside an @media block is found as itself.
 */
function textTokenOf(css: string, selector: string): string {
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim() === selector)
  expect(rules, `the rules with the selector ${selector}`).toHaveLength(1)
  const token = /(?:^|;)\s*color\s*:\s*var\((--[\w-]+)\)/.exec(rules[0]![2]!)?.[1]
  if (token === undefined) throw new Error(`${selector} draws no var() text color`)
  return token
}

const STYLES = read('src/report/client/styles.css')
const SITE = read('site/index.src.html')
const SITE_STYLE = SITE.slice(SITE.indexOf('<style>'), SITE.indexOf('</style>'))

describe('the text tokens hold the WCAG AA ratio (4.5:1) on their grounds', () => {
  it('draws --ink3 at 4.5:1 or more on --bg, --surface and --bg2, in light and dark', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const ground of ['--bg', '--surface', '--bg2']) {
        const ratio = contrast(valueOf(theme, '--ink3'), valueOf(theme, ground))
        expect(ratio, `--ink3 on ${ground} in ${theme}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each([
    ['styles.css', 'nav a.navitem[aria-current="page"]', '--accent-weak'],
    ['styles.css', 'nav a.navitem[aria-current="page"] .hint', '--accent-weak'],
    ['styles.css', ".picklist [role='option'][aria-selected='true']", '--accent-weak'],
    ['styles.css', ".picklist [role='option'][aria-selected='true'] .proj", '--accent-weak'],
    ['site/index.src.html', '.demo-rail button.on', '--accent-weak'],
    ['site/index.src.html', '.cmd-sm button', '--cmd'],
  ])('draws the text of %s %s at 4.5:1 or more on %s, in light and dark', (file, selector, ground) => {
    const token = textTokenOf(file === 'styles.css' ? STYLES : SITE_STYLE, selector)
    for (const theme of ['light', 'dark'] as const) {
      const ratio = contrast(valueOf(theme, token), valueOf(theme, ground))
      expect(ratio, `${token} on ${ground} in ${theme}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
