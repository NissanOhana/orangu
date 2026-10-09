/**
 * The colors of the god pane. A pure .ts module in the ui folder: the view builders name a token for each segment,
 * and the engine shell turns the token into a color here.
 *
 * - The values come from src/report/client/tokens.css through the generated module (scripts/build.mjs), never as
 *   a copy, and src/god holds no hex color (src/god/purity.test.ts).
 * - A theme that starts with `dark`, or no theme, uses the dark tokens: the Claude Code default theme is dark.
 * - A theme that starts with `light` uses the light tokens. A terminal draws every segment as text, so each token
 *   that fails the AA contrast for text on the light ground draws with a darker token of the same meaning: the
 *   accent and the edit color with the accent ink, the read color with the search color.
 * - Any other theme (`auto`, a custom theme) uses the Claude Code theme keys by meaning, so the colors follow the
 *   terminal of the person. src/god/ui/theme.test.ts holds each key to the ThemeKey list of the engine types.
 */
import { GOD_TOKENS, type GodTokenName } from '../generated/tokens.js'
import type { FlagKind, Level } from '../types.js'
import type { Segment } from '../view/types.js'

/** The 3 ways the pane colors a token: the dark tokens, the light tokens, or the Claude Code theme keys. */
export type ThemeSet = 'dark' | 'light' | 'theme-keys'

/** The style of a segment that says what it is: a token, or dim. */
export type Paint = Pick<Segment, 'token' | 'dim'>

/** The colors of the session theme: the value of the `theme` config row. */
export function themeOf(theme: unknown): ThemeSet {
  if (typeof theme !== 'string' || theme === '' || theme.startsWith('dark')) return 'dark'
  return theme.startsWith('light') ? 'light' : 'theme-keys'
}

/** The paint of each attention level: the glyph and the group heading. */
export const LEVEL_PAINT: Readonly<Record<Level, Paint>> = {
  'needs-you': { token: '--bad' },
  'your-turn': { token: '--good' },
  stuck: { token: '--warn' },
  working: { token: '--cat-read' },
  idle: { dim: true },
  stale: { dim: true },
}

/** The paint of each overlap flag. */
export const FLAG_PAINT: Readonly<Record<FlagKind, Paint>> = {
  'same-tree': { token: '--bad' },
  'same-files': { token: '--cat-edit' },
  'same-repo': { dim: true },
}

/** The brand mark, the selection and the confirm bar. */
export const ACCENT: Paint = { token: '--accent' }

/** The age of facts that are more than 10 s old. */
export const OLD_FACTS: Paint = { token: '--warn' }

/** A chip of a source that failed, a key that does nothing now, a rule, a cut mark. */
export const DIM: Paint = { dim: true }

/** On the light set: the token that draws in place of 1 that is under 4.5:1 for text on the light ground. */
const LIGHT_TEXT: Readonly<Partial<Record<GodTokenName, GodTokenName>>> = {
  '--accent': '--accent-ink',
  '--cat-edit': '--accent-ink',
  '--cat-read': '--cat-search',
}

/** The Claude Code theme key with the same meaning as each token. */
const THEME_KEY: Readonly<Record<GodTokenName, string>> = {
  '--accent': 'claude',
  '--accent-ink': 'claude',
  '--bad': 'error',
  '--good': 'success',
  '--warn': 'warning',
  '--cat-read': 'suggestion',
  '--cat-search': 'suggestion',
  '--cat-edit': 'claude',
  '--ink1': 'text',
  '--ink2': 'inactive',
  '--ink3': 'subtle',
}

/** The color of a token in the theme set: a tokens.css value, or a Claude Code theme key. */
export function colorOf(token: GodTokenName, theme: ThemeSet): string {
  if (theme === 'theme-keys') return THEME_KEY[token]
  return GOD_TOKENS[theme][theme === 'light' ? (LIGHT_TEXT[token] ?? token) : token]
}
