/** The --cmd command block with a copy button (design copyAny pattern; wired by wireCopyButtons). */
import { esc } from '../format.js'

/** `prompt` is the leading glyph: `$` for a shell command, `>` for a line typed inside Claude Code. */
export function commandBlock(text: string, prompt = '$'): string {
  return `<div class="cmd"><span class="p" aria-hidden="true">${esc(prompt)}</span><span class="txt">${esc(text)}</span><button class="copy" data-copy="${esc(text)}" aria-label="copy command">copy</button></div>`
}
