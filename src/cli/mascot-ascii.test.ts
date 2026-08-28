/**
 * The art IS the surface here, so the variants are pinned byte for byte: reviewing this file is
 * reviewing what the terminal draws. AC31-AC35, plus the tier rule the dashboard and --help share.
 */
import { describe, it, expect } from 'vitest'
import * as clientMascot from '../report/client/mascot.js'
import { MASCOT_MINI, MASCOT_STACKED, MASCOT_WIDE, mascotArt, mascotLines } from './mascot-ascii.js'
import { displayWidth, stripAnsi, type Caps } from './tty.js'

const tty: Caps = { tty: true, color: 2, animate: true, hyperlinks: false, columns: 80, unicode: true }
const plain: Caps = { ...tty, color: 0 }
const EM_DASH = String.fromCharCode(0x2014)

// Face left, wordmark right, offset down one row: the logotype straddles the eye band and the
// tagline lands on the chin row.
const WIDE_ART = `  .-"""""""""""""""-.
 /      .-"""-.      \\     ####  ## ##  ####  ## ##   ##### ##  ##
|      /       \\      |   ##  ## ###       ## ### ## ##  ## ##  ##
|     |  o   o  |     |   ##  ## ##     ##### ##  ## ##  ## ##  ##
|    /    . .    \\    |   ##  ## ##    ##  ## ##  ##  ##### ##  ##
|   |   \\_____/   |   |    ####  ##     ##### ##  ##     ##  #####
 \\   '-.........-'   /                                ####
  '-...............-'     see what your agent did`

// The face costs 23 of 40 columns and 8 of the terminal's rows, so the middle tier keeps the
// wordmark (the identity) and drops the face.
const STACKED_ART = ` ####  ## ##  ####  ## ##   ##### ##  ##
##  ## ###       ## ### ## ##  ## ##  ##
##  ## ##     ##### ##  ## ##  ## ##  ##
##  ## ##    ##  ## ##  ##  ##### ##  ##
 ####  ##     ##### ##  ##     ##  #####
                            ####
see what your agent did`

// Nothing 40 wide fits a 40-column terminal inside the house indent; face and tagline are both
// exactly 23, so they align.
const MINI_ART = `  .-"""""""""""""""-.
 /      .-"""-.      \\
|      /       \\      |
|     |  o   o  |     |
|    /    . .    \\    |
|   |   \\_____/   |   |
 \\   '-.........-'   /
  '-...............-'
see what your agent did`

describe('mascot art', () => {
  it('draws exactly the three committed variants', () => {
    expect(MASCOT_WIDE.join('\n')).toBe(WIDE_ART)
    expect(MASCOT_STACKED.join('\n')).toBe(STACKED_ART)
    expect(MASCOT_MINI.join('\n')).toBe(MINI_ART)
  })

  it('is pure ASCII: --help prints it without consulting caps.unicode', () => {
    for (const [name, art] of [['wide', WIDE_ART], ['stacked', STACKED_ART], ['mini', MINI_ART]] as const) {
      for (const ch of art.replace(/\n/g, '')) {
        const cp = ch.codePointAt(0)!
        expect(cp >= 0x20 && cp <= 0x7e, `${name}: U+${cp.toString(16)} (${ch})`).toBe(true)
      }
    }
  })

  it('fits its tier: 66 / 40 / 23 columns, no trailing space', () => {
    for (const [rows, width] of [[MASCOT_WIDE, 66], [MASCOT_STACKED, 40], [MASCOT_MINI, 23]] as const) {
      expect(Math.max(...rows.map(displayWidth))).toBe(width)
      for (const row of rows) expect(row, row).not.toMatch(/\s$/)
    }
    // the layout ceilings: 80 and 40 columns minus the 2-space house indent
    expect(Math.max(...MASCOT_WIDE.map(displayWidth))).toBeLessThanOrEqual(78)
    expect(Math.max(...MASCOT_STACKED.map(displayWidth))).toBeLessThanOrEqual(40)
    expect(Math.max(...MASCOT_MINI.map(displayWidth))).toBeLessThanOrEqual(23)
  })

  it('carries no hex colour, no em-dash and no control byte', () => {
    for (const art of [WIDE_ART, STACKED_ART, MINI_ART]) {
      expect(art).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(art).not.toContain(EM_DASH)
      expect(art).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    }
  })

  it('leaves the report client tree: mascot.ts exports only mascotSvg', () => {
    expect(Object.keys(clientMascot)).toEqual(['mascotSvg'])
  })
})

describe('mascotArt tier rule', () => {
  it('picks the first variant whose width plus the house indent fits the layout', () => {
    const rows = (width: number): number => mascotArt(width).length
    expect([40, 41].map(rows)).toEqual([9, 9]) // MINI
    expect([42, 60, 66, 67].map(rows)).toEqual([7, 7, 7, 7]) // STACKED
    expect([68, 80, 160].map(rows)).toEqual([8, 8, 8]) // WIDE
  })

  it('returns MINI as the floor below its own width', () => {
    expect(mascotArt(20).length).toBe(9)
  })
})

describe('mascotLines', () => {
  it('centres each tier inside min(columns, 80) and never truncates at 40 or wider', () => {
    for (let columns = 40; columns <= 160; columns++) {
      const lines = mascotLines({ ...plain, columns })
      const budget = Math.min(columns, 80)
      for (const line of lines) {
        expect(displayWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(budget)
        expect(line, `${columns}: ${line}`).not.toContain('\u2026')
      }
      expect(lines.join('\n')).toContain('see what your agent did')
    }
  })

  it('paints the face accent, the wordmark accent+bold and the tagline dim', () => {
    const lines = mascotLines({ ...tty, columns: 80 })
    expect(lines[3], 'face row').toContain('\x1b[38;5;209m')
    expect(lines[3], 'wordmark segment').toContain('\x1b[38;5;209;1m')
    expect(lines[7], 'tagline segment').toContain('\x1b[2m')
    expect(stripAnsi(lines.join('\n'))).toBe(
      MASCOT_WIDE.map((row) => ' '.repeat(Math.max(2, Math.floor((80 - 66) / 2))) + row).join('\n'),
    )
  })

  it('truncates rather than overflowing a terminal narrower than any tier', () => {
    for (const line of mascotLines({ ...plain, columns: 20 })) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(20)
    }
    expect(mascotLines({ ...plain, columns: 20 }).join('\n')).toContain('\u2026')
  })
})
