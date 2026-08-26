/** Mascot composition box around the shell-provided, data-URI brand image. */
import { mascotSvg } from '../mascot.js'

export function mascotBox(size: number): string {
  return `<span class="mascot" style="display:block;width:${size}px;flex:none" aria-hidden="true">${mascotSvg(size)}</span>`
}
