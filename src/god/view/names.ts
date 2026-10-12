/**
 * The name of a session as the pane shows it: the board row, the head of the detail and each line that names
 * another session. The person knows a session by its cmux tab, so the name is the title of that tab:
 * - the surface title of the mapped cmux tab, with a leading status glyph and the space after it left out. Claude Code
 *   starts the title with `✳` at rest and with a spinner frame while it works (`◐` to `◓`, or a braille frame from
 *   U+2800 to U+28FF), and that glyph changes on each refresh;
 * - with no tab title, or a title of a glyph alone: the transcript title;
 * - with neither: the session name. The detail facts line shows the session name too.
 * The collector cleans each title (src/god/sanitize.ts) before it comes here. Outside text shows on 1 line.
 */
import type { SessionFacts } from '../types.js'
import { flat } from './wrap.js'

/** A status glyph at the start of a cmux tab title, and the white space after it. */
const STATUS_GLYPH = /^(?:[✳◐◑◒◓]️?|[⠀-⣿])\s*/u

/** The name of the row of a session: the tab title with no status glyph, else the transcript title, else the session name. */
export function rowName(session: Pick<SessionFacts, 'name' | 'tab' | 'transcript'>): string {
  const tab = flat(session.tab?.surfaceTitle ?? '').replace(STATUS_GLYPH, '')
  return tab || flat(session.transcript?.title ?? '') || flat(session.name)
}
