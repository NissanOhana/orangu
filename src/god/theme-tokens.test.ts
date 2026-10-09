/**
 * The god pane takes its colors from src/report/client/tokens.css, the one definition of the design tokens.
 * scripts/build.mjs writes them to src/god/generated/tokens.ts. This test parses tokens.css on its own and
 * holds the module equal to it, so a token change reaches the pane through the build and never through a copy.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GOD_TOKENS, GOD_TOKEN_NAMES } from './generated/tokens.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const CSS = readFileSync(join(ROOT, 'src/report/client/tokens.css'), 'utf8')

/** The custom properties of the first rule whose selector is exactly `selector`. */
function variables(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector}{`)
  if (start < 0) throw new Error(`tokens.css has no ${selector} rule`)
  const body = CSS.slice(start + selector.length + 1, CSS.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    const name = declaration.slice(0, colon).trim()
    if (name.startsWith('--')) out[name] = declaration.slice(colon + 1).trim()
  }
  return out
}

const LIGHT = variables(':root')
const DARK = { ...LIGHT, ...variables(':root[data-theme="dark"]') }

describe('the god pane colors come from tokens.css', () => {
  it('names the 10 tokens that the pane draws with', () => {
    expect(GOD_TOKEN_NAMES).toEqual(['--accent', '--accent-ink', '--bad', '--good', '--warn', '--cat-read', '--cat-edit', '--ink1', '--ink2', '--ink3'])
    expect(Object.keys(GOD_TOKENS.light)).toEqual([...GOD_TOKEN_NAMES])
    expect(Object.keys(GOD_TOKENS.dark)).toEqual([...GOD_TOKEN_NAMES])
  })

  it('holds each light value as the :root rule writes it', () => {
    for (const name of GOD_TOKEN_NAMES) expect(GOD_TOKENS.light[name], name).toBe(LIGHT[name])
  })

  it('holds each dark value: the light set with the dark overrides on top', () => {
    for (const name of GOD_TOKEN_NAMES) expect(GOD_TOKENS.dark[name], name).toBe(DARK[name])
  })

  it('keeps the accent in dark, because tokens.css overrides only its ink there', () => {
    expect(GOD_TOKENS.dark['--accent']).toBe(GOD_TOKENS.light['--accent'])
    expect(GOD_TOKENS.dark['--accent-ink']).not.toBe(GOD_TOKENS.light['--accent-ink'])
  })
})
