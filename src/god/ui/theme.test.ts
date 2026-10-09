/**
 * The colors of the god pane: the dark set when the session theme is dark or unset (the Claude Code default is
 * dark), else the light set. Each level and each flag has its token, and every value comes from tokens.css through
 * the generated module.
 */
import { describe, expect, it } from 'vitest'
import { GOD_TOKENS, GOD_TOKEN_NAMES } from '../generated/tokens.js'
import { LEVEL_ORDER } from '../types.js'
import { ACCENT, FLAG_PAINT, LEVEL_PAINT, OLD_FACTS, colorOf, themeOf } from './theme.js'

describe('themeOf: the token set of the session theme', () => {
  it('takes the dark set when the theme is dark or unset', () => {
    for (const value of ['dark', 'dark-daltonized', 'dark-ansi', undefined, '']) expect(themeOf(value), String(value)).toBe('dark')
  })

  it('takes the light set when the theme is light', () => {
    for (const value of ['light', 'light-daltonized', 'light-ansi']) expect(themeOf(value), value).toBe('light')
  })

  it('takes the dark set for a value that names no light theme, as the default of Claude Code', () => {
    expect(themeOf('auto')).toBe('dark')
    expect(themeOf(3)).toBe('dark')
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
  it('reads each value from the generated tokens of tokens.css', () => {
    for (const name of GOD_TOKEN_NAMES.filter((token) => token !== '--accent')) {
      expect(colorOf(name, 'dark'), name).toBe(GOD_TOKENS.dark[name])
      expect(colorOf(name, 'light'), name).toBe(GOD_TOKENS.light[name])
    }
  })

  it('draws the accent with the accent ink on the light set, because a terminal draws each segment as text', () => {
    expect(colorOf('--accent', 'dark')).toBe(GOD_TOKENS.dark['--accent'])
    expect(colorOf('--accent', 'light')).toBe(GOD_TOKENS.light['--accent-ink'])
  })
})
