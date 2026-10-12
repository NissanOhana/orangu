/**
 * The name of a session on the board: the cmux tab title with its leading status glyph left out, else the
 * transcript title, else the session name.
 */
import { describe, expect, it } from 'vitest'
import { busy, transcript } from '../../../test/fixtures/god/sessions.js'
import type { SessionFacts, TabRef } from '../types.js'
import { rowName } from './names.js'

const tab = (surfaceTitle?: string): TabRef => ({ pid: 1, tty: 'ttys001', workspaceRef: 'workspace:1', surfaceRef: 'surface:1', workspaceTitle: 'Space', ...(surfaceTitle === undefined ? {} : { surfaceTitle }) })
const named = (over: Partial<SessionFacts>): SessionFacts => busy('s-name', { name: 'api-7', ...over })

describe('the row name', () => {
  it('is the cmux tab title, with a leading status glyph and the space after it left out', () => {
    for (const glyph of ['✳', '◐', '◑', '◒', '◓', '⠀', '⠂', '⣿']) {
      expect(rowName(named({ tab: tab(`${glyph} Fix the parser`) })), `U+${glyph.codePointAt(0)!.toString(16)}`).toBe('Fix the parser')
    }
    expect(rowName(named({ tab: tab('Fix the parser') }))).toBe('Fix the parser')
    // only a glyph at the start is a status glyph
    expect(rowName(named({ tab: tab('Fix ✳ the parser') }))).toBe('Fix ✳ the parser')
  })

  it('is the transcript title when the tab has no title, or a title of a glyph alone, and the session name with neither', () => {
    const titled = transcript({ title: 'Pick the eval set' })
    expect(rowName(named({ transcript: titled }))).toBe('Pick the eval set')
    expect(rowName(named({ tab: tab(), transcript: titled }))).toBe('Pick the eval set')
    expect(rowName(named({ tab: tab('✳ '), transcript: titled }))).toBe('Pick the eval set')
    expect(rowName(named({ tab: tab('  '), transcript: transcript() }))).toBe('api-7')
    expect(rowName(named({ transcript: undefined }))).toBe('api-7')
  })

  it('shows the title on 1 line: each run of white space becomes 1 space', () => {
    expect(rowName(named({ tab: tab('✳  Fix\tthe\nparser ') }))).toBe('Fix the parser')
    expect(rowName(named({ transcript: transcript({ title: ' Pick\n the set ' }) }))).toBe('Pick the set')
  })
})
