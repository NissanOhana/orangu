/**
 * The colors of the god pane. A pure .ts module in the ui folder: the view builders name a token for each segment,
 * and the engine shell turns the token into a color here.
 *
 * - The values come from src/report/client/tokens.css through the generated module (scripts/build.mjs), never as
 *   a copy, and src/god holds no hex color (src/god/purity.test.ts).
 * - The pane takes the dark set when the session theme is dark or unset, because the Claude Code default theme is
 *   dark. It takes the light set when the theme names a light theme (`light`, `light-daltonized`, `light-ansi`).
 * - On the light set the accent draws with the accent ink: a terminal draws every segment as text, and the accent
 *   fails the AA contrast for text on a light ground.
 */
import { GOD_TOKENS, type GodTokenName } from '../generated/tokens.js'
import type { FlagKind, Level } from '../types.js'
import type { Segment } from '../view/types.js'

/** The 2 token sets of tokens.css. */
export type ThemeName = 'dark' | 'light'

/** The style of a segment that says what it is: a token, or dim. */
export type Paint = Pick<Segment, 'token' | 'dim'>

/** The token set of the session theme: the value of the `theme` config row. */
export function themeOf(theme: unknown): ThemeName {
  return typeof theme === 'string' && theme.startsWith('light') ? 'light' : 'dark'
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

/** The paint of each overlap flag chip. */
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

/** The color of a token in the theme. */
export function colorOf(token: GodTokenName, theme: ThemeName): string {
  return GOD_TOKENS[theme][theme === 'light' && token === '--accent' ? '--accent-ink' : token]
}
