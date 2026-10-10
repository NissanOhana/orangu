/**
 * The bar of the key path, above the key row: the confirm bar of an intent, the draft of r or m with its text
 * field, or the note of the last outcome. Nothing goes out from the bar until the person presses y. The note shows
 * only while its session is selected, and not while the Screen tab of that session shows the same line.
 */
import { describe, expect, it } from 'vitest'
import { INTENTS, OUTCOMES } from '../../../test/fixtures/god/detail.js'
import { cellWidth } from './cells.js'
import { REFUSAL_TEXT, confirmView } from './confirm.js'
import { DRAFT_LABEL, DRAFT_PLACEHOLDER, DRAFT_SUBMIT, NO_DELIVERY, barView, draftKey, type BarInput, type DeliverState, type Draft } from './bar.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const input = (deliver: DeliverState, over: Partial<BarInput> = {}): BarInput => ({ deliver, width: 110, rows: 12, selectedKey: 's-wait', isScreenOpen: false, ...over })
const target = { sessionId: 's-wait', name: 'api-7' }

describe('the bar', () => {
  it('shows nothing with no intent, no draft and no outcome', () => {
    expect(barView(input(NO_DELIVERY))).toBeUndefined()
  })

  it('shows the confirm bar of the intent, open, with the scroll of its keys', () => {
    const bar = barView(input({ scroll: 0, intent: INTENTS.answer }))!
    expect(bar.isOpen).toBe(true)
    expect(bar.lines).toEqual(confirmView({ intent: INTENTS.answer, width: 110, rows: 12, scroll: 0 }).lines)
    expect(bar.field).toBeUndefined()
    expect(bar.scrollTo).toEqual({})
    const long = { ...INTENTS.prompt, text: Array.from({ length: 30 }, (_, index) => `Line ${index + 1}.`).join('\n') } as typeof INTENTS.prompt
    const cut = barView(input({ scroll: 0, intent: long }, { rows: 8 }))!
    expect(cut.lines).toHaveLength(8)
    expect(Object.keys(cut.scrollTo)).toEqual(['z'])
  })

  it('gives the intent that it shows, for y to send', () => {
    expect(barView(input({ scroll: 0, intent: INTENTS.answer }))!.intent).toEqual(INTENTS.answer)
    expect(barView(input({ scroll: 0, outcome: OUTCOMES.sent }))!.intent).toBeUndefined()
  })

  it('draws no y and no c while the keys go out', () => {
    const bar = barView(input({ scroll: 0, intent: INTENTS.answer, isSending: true }))!
    expect(bar.lines.flatMap((line) => line.segments).some((segment) => segment.press !== undefined)).toBe(false)
    expect(bar.isOpen).toBe(false)
  })

  it('shows the stale line above the bar, which stays open for y again', () => {
    const stale = { ...OUTCOMES.refused, refusal: 'stale-screen' as const }
    const bar = barView(input({ scroll: 0, intent: INTENTS.answer, outcome: stale }))!
    expect(text(bar.lines[0]!)).toBe(` ${REFUSAL_TEXT['stale-screen']}`)
    expect(bar.lines[0]!.segments[1]).toEqual({ text: REFUSAL_TEXT['stale-screen'], token: '--warn' })
    expect(text(bar.lines[1]!)).toBe(' Send "2 All" to api-7?  y: send  c: cancel')
  })

  it('shows the draft of r with its line count, c, and a text field that is new for each line', () => {
    const draft: Draft = { kind: 'prompt', target, lines: [] }
    const empty = barView(input({ scroll: 0, draft }))!
    expect(empty.isOpen).toBe(true)
    expect(empty.lines.map(text)).toEqual([' Write the prompt for api-7. It has 0 lines.  c: cancel'])
    expect(empty.lines[0]!.segments.at(-1)).toEqual({ text: 'c: cancel', press: { hotkey: 'c', label: 'cancel' } })
    expect(empty.field).toEqual({ key: 'draft:0', label: DRAFT_LABEL, placeholder: DRAFT_PLACEHOLDER, submitLabel: DRAFT_SUBMIT })
    const two = barView(input({ scroll: 0, draft: { ...draft, lines: ['Run the tests.', 'Then fix the lint.'] } }))!
    expect(two.lines.map(text)).toEqual([' Write the prompt for api-7. It has 2 lines.  c: cancel'])
    expect(two.field?.key).toBe('draft:2')
    expect(draftKey({ ...draft, lines: ['a'] })).toBe('draft:1')
    const peer = barView(input({ scroll: 0, draft: { kind: 'peer', target, lines: ['Stop.'] } }))!
    expect(peer.lines.map(text)).toEqual([' Write the peer message for api-7. It has 1 line.  c: cancel'])
  })

  it('shows the note of the last outcome only while its session is selected', () => {
    expect(barView(input({ scroll: 0, outcome: OUTCOMES.sent }))!.lines.map(text)).toEqual([' Sent to api-7. The next refresh checks it.'])
    expect(barView(input({ scroll: 0, outcome: OUTCOMES.sent }))!.isOpen).toBe(false)
    expect(barView(input({ scroll: 0, outcome: OUTCOMES.sent }, { selectedKey: 's-idle' }))).toBeUndefined()
    expect(barView(input({ scroll: 0, outcome: OUTCOMES.delivered }))!.lines.map(text)).toEqual([' Delivered to api-7.'])
  })

  it('leaves out a refusal, a failure or a miss that the open Screen tab already shows', () => {
    for (const outcome of [OUTCOMES.refused, OUTCOMES.failed, OUTCOMES['not-delivered']]) {
      expect(barView(input({ scroll: 0, outcome }, { isScreenOpen: true }))).toBeUndefined()
      expect(barView(input({ scroll: 0, outcome }))).toBeDefined()
    }
    expect(barView(input({ scroll: 0, outcome: OUTCOMES.sent }, { isScreenOpen: true }))).toBeDefined()
  })

  it.each([30, 60, 110])('holds every line to %i columns', (width) => {
    const states: DeliverState[] = [
      { scroll: 0, intent: INTENTS.permission },
      { scroll: 0, draft: { kind: 'peer', target: { sessionId: 's-wait', name: 'a-very-long-session-name-of-the-person' }, lines: ['x'] } },
      { scroll: 0, outcome: OUTCOMES['not-delivered'] },
    ]
    for (const state of states) for (const line of barView(input(state, { width }))!.lines) expect(cellWidth(text(line)), text(line)).toBeLessThanOrEqual(width)
  })
})
