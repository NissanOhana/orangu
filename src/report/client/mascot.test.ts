import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAND_ICON_ID } from '../brand.js'
import { mascotSvg } from './mascot.js'

afterEach(() => vi.unstubAllGlobals())

describe('mascotSvg', () => {
  it('renders the shell-provided raster brand mark instead of the legacy inline SVG', () => {
    const href = 'data:image/png;base64,aGVsbG8='
    const getElementById = vi.fn().mockReturnValue({ getAttribute: () => href })
    vi.stubGlobal('document', { getElementById })

    const html = mascotSvg(48)
    expect(getElementById).toHaveBeenCalledWith(BRAND_ICON_ID)
    expect(html).toContain(`<img class="logo" src="${href}"`)
    expect(html).toContain('width="48" height="48"')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<circle')
  })

  it('never emits an empty or external image source when the shell marker is unavailable', () => {
    const getElementById = vi.fn().mockReturnValue({ getAttribute: () => 'https://example.com/logo.png' })
    vi.stubGlobal('document', { getElementById })

    const html = mascotSvg(22)
    expect(html).toContain('<span class="logo"')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=')
    expect(html).not.toContain('https://')
  })
})
