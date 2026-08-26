/** The --cmd command block with a copy button (design copyAny pattern; wired by wireCopyButtons). */
import { esc } from '../format.js'

export function commandBlock(text: string): string {
  return `<div class="cmd"><span class="p" aria-hidden="true">$</span><span class="txt">${esc(text)}</span><button class="copy" data-copy="${esc(text)}" aria-label="copy command">copy</button></div>`
}
