/**
 * The pure rules of the detail controls: t and a press on a tab open a tab from its top, w and z take the scroll
 * that the view gave, a new selection starts the tab content at its top, a press on a session row opens the detail
 * in place of the board below 90 columns, and b goes back to the board. h opens the help in place of the detail and
 * closes it, and Esc, b and a tab close it.
 */
import { describe, expect, it } from 'vitest'
import { boardSnapshot } from '../../test/fixtures/god/snapshots.js'
import { detailAfterBack, detailAfterHelp, detailAfterNextTab, detailAfterRowPress, detailAfterScroll, detailAfterSelect, detailAfterTab, detailWithoutHelp } from './detail-control.js'
import { DEFAULT_DETAIL, type DetailState } from './view/detail-pane.js'
import { STALE_GROUP_KEY } from './view/board.js'
import { layoutOf } from './view/pane.js'

const scrolled: DetailState = { tab: 'history', scroll: 12, isOpen: false }

describe('the tabs', () => {
  it('starts on Now, from the top, with the board in the narrow pane', () => {
    expect(DEFAULT_DETAIL).toEqual({ tab: 'now', scroll: 0, isOpen: false })
  })

  it('t opens the next tab from its top, and goes from Recap back to Now', () => {
    expect(detailAfterNextTab(scrolled)).toEqual({ tab: 'agents', scroll: 0, isOpen: false })
    expect(detailAfterNextTab({ ...scrolled, tab: 'recap' }).tab).toBe('now')
  })

  it('a press on a tab opens it from its top, and a press on the open tab keeps its scroll', () => {
    expect(detailAfterTab(scrolled, 'screen')).toEqual({ tab: 'screen', scroll: 0, isOpen: false })
    expect(detailAfterTab(scrolled, 'history')).toBe(scrolled)
  })
})

describe('the scroll', () => {
  it('w and z take the scroll that the view gave for the key', () => {
    expect(detailAfterScroll(scrolled, 24)).toEqual({ ...scrolled, scroll: 24 })
    expect(detailAfterScroll(scrolled, 0)).toEqual({ ...scrolled, scroll: 0 })
  })

  it('starts the tab content at its top when the selected row changes, and keeps it when the row stays', () => {
    expect(detailAfterSelect(scrolled, 's-wait', 's-work')).toEqual({ ...scrolled, scroll: 0 })
    expect(detailAfterSelect(scrolled, '', 's-work')).toEqual({ ...scrolled, scroll: 0 })
    expect(detailAfterSelect(scrolled, 's-wait', 's-wait')).toBe(scrolled)
  })
})

describe('the narrow pane', () => {
  const snapshot = boardSnapshot()

  it('a press on a session row opens the detail below 90 columns, from the top of its tab', () => {
    expect(detailAfterRowPress(scrolled, 's-wait', snapshot, layoutOf(89))).toEqual({ tab: 'history', scroll: 0, isOpen: true })
  })

  it('a press on a heading, or any press at 90 columns or more, does not open it', () => {
    expect(detailAfterRowPress(scrolled, STALE_GROUP_KEY, snapshot, layoutOf(60))).toBe(scrolled)
    expect(detailAfterRowPress(scrolled, 's-gone', snapshot, layoutOf(60))).toBe(scrolled)
    expect(detailAfterRowPress(scrolled, 's-wait', snapshot, layoutOf(90))).toBe(scrolled)
    expect(detailAfterRowPress(scrolled, 's-wait', undefined, layoutOf(60))).toBe(scrolled)
  })

  it('b goes back to the board and keeps the tab', () => {
    expect(detailAfterBack({ tab: 'agents', scroll: 3, isOpen: true })).toEqual({ tab: 'agents', scroll: 3, isOpen: false })
  })
})

describe('the help', () => {
  const help: DetailState = { tab: 'history', scroll: 0, isOpen: false, isHelp: true }

  it('h opens the help from its top, and h again closes it and shows the detail from the top of its tab', () => {
    expect(detailAfterHelp(scrolled)).toEqual({ ...scrolled, scroll: 0, isHelp: true })
    expect(detailAfterHelp({ ...help, scroll: 9 })).toEqual({ tab: 'history', scroll: 0, isOpen: false })
  })

  it('Esc, b, t and a press on a tab close the help', () => {
    expect(detailWithoutHelp({ ...help, scroll: 9 })).toEqual({ tab: 'history', scroll: 0, isOpen: false })
    expect(detailWithoutHelp(scrolled)).toBe(scrolled)
    expect(detailAfterBack({ ...help, isOpen: true })).toEqual({ tab: 'history', scroll: 0, isOpen: false })
    expect(detailAfterNextTab(help)).toEqual({ tab: 'agents', scroll: 0, isOpen: false })
    expect(detailAfterTab(help, 'history')).toEqual({ tab: 'history', scroll: 0, isOpen: false })
  })
})
