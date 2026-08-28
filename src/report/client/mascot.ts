import { BRAND_ICON_ID } from '../brand.js'

const PNG_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/

/**
 * Render the current raster brand mark already embedded by the report shell.
 *
 * The legacy name is retained for call-site compatibility. Reading the shell's
 * marked brand icon keeps file and serve mode on the same asset, adds no network
 * request, and avoids copying image bytes into the client bundle.
 */
export function mascotSvg(size = 30): string {
  const dimensions = `width="${size}" height="${size}" style="display:block"`
  const href = typeof document === 'undefined' ? undefined : document.getElementById(BRAND_ICON_ID)?.getAttribute('href')
  if (!href || !PNG_DATA_URI.test(href)) return `<span class="logo" ${dimensions} role="img" aria-label="orangu"></span>`
  return `<img class="logo" src="${href}" ${dimensions} alt="orangu" draggable="false">`
}

export const MASCOT_ASCII = String.raw`
.-"""-.
/  o o  \   orangu
|  \___/()o  see what your agent did
\_______/`
