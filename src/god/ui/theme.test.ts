/**
 * The colors of the god pane:
 * - a theme that starts with `dark`, or no theme, uses the dark tokens (the Claude Code default theme is dark);
 * - a theme that starts with `light` uses the light tokens, and each one that the pane draws as text holds 4.5:1
 *   or more against the light ground;
 * - any other theme (`auto`, a custom theme) uses the Claude Code theme keys by meaning, which follow the
 *   person's terminal.
 * Every token value comes from tokens.css through the generated module.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NOW, boardSnapshot, byRepoSnapshot, degradedSnapshot } from '../../../test/fixtures/god/snapshots.js'
import { GOD_TOKENS, GOD_TOKEN_NAMES, type GodTokenName } from '../generated/tokens.js'
import { LEVEL_ORDER } from '../types.js'
import { paneLines, paneView } from '../view/pane.js'
import { ACCENT, FLAG_PAINT, LEVEL_PAINT, OLD_FACTS, colorOf, themeOf } from './theme.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const ENGINE_TYPES = join(ROOT, 'god/.claude-plugin/types/claude-code/index.d.ts')

/** The --bg value of the first tokens.css rule whose selector is exactly `selector`. */
function background(selector: string): string {
  const css = readFileSync(join(ROOT, 'src/report/client/tokens.css'), 'utf8')
  const start = css.indexOf(`${selector}{`)
  const value = /--bg:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(start, css.indexOf('}', start)))?.[1]
  if (value === undefined) throw new Error(`tokens.css has no --bg in ${selector}`)
  return value
}

/** The WCAG contrast ratio of 2 colors written as #rrggbb. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

/** Every token that the pane draws: each paint, and each token on a segment of the fixture panes. */
function drawnTokens(): GodTokenName[] {
  const paints = [...Object.values(LEVEL_PAINT), ...Object.values(FLAG_PAINT), ACCENT, OLD_FACTS]
  const segments = [boardSnapshot(), byRepoSnapshot(), degradedSnapshot({ agents: { status: 'off' } }, 30_000)].flatMap((snapshot) =>
    [60, 110].flatMap((bodyColumns) =>
      paneLines(paneView({ snapshot, bodyColumns, bodyRows: 40, now: NOW, selectedKey: 's-wait', openGroups: ['stale'], promptHoldsKeys: true })).flatMap((line) => line.segments),
    ),
  )
  return [...new Set([...paints, ...segments].flatMap((paint) => (paint.token === undefined ? [] : [paint.token])))]
}

describe('themeOf: the colors of the session theme', () => {
  it('uses the dark tokens for a theme that starts with dark, and for no theme', () => {
    for (const value of ['dark', 'dark-daltonized', 'dark-ansi', undefined, null, '']) expect(themeOf(value), String(value)).toBe('dark')
  })

  it('uses the light tokens for a theme that starts with light', () => {
    for (const value of ['light', 'light-daltonized', 'light-ansi']) expect(themeOf(value), value).toBe('light')
  })

  it('uses the Claude Code theme keys for any other theme, because they follow the terminal of the person', () => {
    for (const value of ['auto', 'my-theme', 'solarized']) expect(themeOf(value), value).toBe('theme-keys')
  })
})

describe('the paint of each level and flag', () => {
  it('gives each level its token, and the idle and stale levels dim', () => {
    expect(LEVEL_PAINT).toEqual({
      'needs-you': { token: '--bad' },
      'your-turn': { token: '--good' },
      stuck: { token: '--warn' },
      working: { token: '--cat-read' },
      idle: { dim: true },
      stale: { dim: true },
    })
    expect(Object.keys(LEVEL_PAINT).sort()).toEqual([...LEVEL_ORDER].sort())
  })

  it('gives same-tree the bad color, same-files the edit color, and same-repo dim', () => {
    expect(FLAG_PAINT).toEqual({ 'same-tree': { token: '--bad' }, 'same-files': { token: '--cat-edit' }, 'same-repo': { dim: true } })
  })

  it('marks the brand and the selection with the accent, and old facts with the warn color', () => {
    expect(ACCENT).toEqual({ token: '--accent' })
    expect(OLD_FACTS).toEqual({ token: '--warn' })
  })
})

describe('colorOf: a token as a color of the theme', () => {
  it('reads each dark value from the generated tokens of tokens.css', () => {
    for (const name of GOD_TOKEN_NAMES) expect(colorOf(name, 'dark'), name).toBe(GOD_TOKENS.dark[name])
  })

  it('draws the accent and the edit color with the accent ink and the read color with the search color on the light set', () => {
    expect(colorOf('--accent', 'light')).toBe(GOD_TOKENS.light['--accent-ink'])
    expect(colorOf('--cat-edit', 'light')).toBe(GOD_TOKENS.light['--accent-ink'])
    expect(colorOf('--cat-read', 'light')).toBe(GOD_TOKENS.light['--cat-search'])
    for (const name of GOD_TOKEN_NAMES.filter((token) => !['--accent', '--cat-edit', '--cat-read'].includes(token))) expect(colorOf(name, 'light'), name).toBe(GOD_TOKENS.light[name])
  })

  it('holds each token that the pane draws at 4.5:1 or more against the ground of its set', () => {
    const tokens = drawnTokens()
    expect(tokens).toEqual(expect.arrayContaining(['--accent', '--bad', '--good', '--warn', '--cat-read', '--cat-edit']))
    for (const [theme, selector] of [['light', ':root'], ['dark', ':root[data-theme="dark"]']] as const) {
      const ground = background(selector)
      for (const token of tokens) expect(contrast(colorOf(token, theme), ground), `${token} on the ${theme} ground ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('names a Claude Code theme key by meaning for any other theme', () => {
    expect(colorOf('--bad', 'theme-keys')).toBe('error')
    expect(colorOf('--good', 'theme-keys')).toBe('success')
    expect(colorOf('--warn', 'theme-keys')).toBe('warning')
    expect(colorOf('--cat-read', 'theme-keys')).toBe('suggestion')
    expect(colorOf('--accent', 'theme-keys')).toBe('claude')
    expect(colorOf('--cat-edit', 'theme-keys')).toBe('claude')
  })

  it.skipIf(!existsSync(ENGINE_TYPES))('names only keys of the ThemeKey union of the engine types', () => {
    const union = /export type ThemeKey = ([^;]+);/.exec(readFileSync(ENGINE_TYPES, 'utf8'))?.[1] ?? ''
    const keys = new Set([...union.matchAll(/'([^']+)'/g)].map((match) => match[1]))
    expect(keys.size).toBeGreaterThan(10)
    for (const name of GOD_TOKEN_NAMES) expect(keys.has(colorOf(name, 'theme-keys')), `${name} -> ${colorOf(name, 'theme-keys')}`).toBe(true)
  })
})
