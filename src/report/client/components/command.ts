/** The --cmd command block with a copy button (design copyAny pattern; wired by wireCopyButtons). */
import { esc } from '../format.js'
import { PLUGIN_INSTALL } from '../suggest-rows.js'

/**
 * `prompt` is the leading glyph: `$` for a shell command, `>` for a line typed inside Claude Code.
 * `what` names the command in the copy button's accessible name, so 2 bars side by side read apart.
 */
export function commandBlock(text: string, prompt = '$', what = 'command'): string {
  return `<div class="cmd"><span class="p" aria-hidden="true">${esc(prompt)}</span><span class="txt">${esc(text)}</span><button class="copy" data-copy="${esc(text)}" aria-label="copy ${what}">copy</button></div>`
}

/**
 * Where a copied `claude "…"` command goes. It is a shell command that starts Claude Code, so the
 * reader pastes it in a terminal, not in a running Claude Code prompt. Plain text: callers escape it.
 */
export function pasteLine(cwd?: string, repo?: boolean): string {
  return `Paste it in a terminal${cwd ? ` in ${cwd}` : repo ? ' in this repository' : ''}. It starts Claude Code.`
}

/** The one-time plugin install: 2 lines typed in Claude Code, so one copy bar each (one bar would copy a line that does not run). */
export function installLines(): string {
  return `<div class="small sg-install">First time only, type these 2 lines in Claude Code:</div>${PLUGIN_INSTALL.split(' · ').map((line, i) => commandBlock(line, '>', i ? 'the install command' : 'the marketplace command')).join('')}`
}
