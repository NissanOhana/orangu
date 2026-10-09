/**
 * The confirm bar and the outcome lines of the key path. Nothing goes out until the person presses y, so the bar
 * names the session and what goes to it: the option with its digit and the question, the permission choice with
 * the tool and its whole input, or the first line of a prompt or a peer message and the count of the rest. Each
 * refusal code has 1 line. No line is wider than the pane, and nothing that the person approves is cut.
 */
import { describe, expect, it } from 'vitest'
import { INTENTS, OUTCOMES, QUESTION } from '../../../test/fixtures/god/detail.js'
import type { DeliverIntent, DeliverRefusal } from '../types.js'
import { cellWidth } from './cells.js'
import { CONFIRM_HINTS, NOT_DELIVERED, PEER_NOT_DELIVERED, REFUSAL_TEXT, SEND_FAILED, confirmView, outcomeLines } from './confirm.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const bar = (intent: DeliverIntent, width = 110): string[] => confirmView(intent, width).lines.map(text)
const squeeze = (value: string): string => value.replace(/\s+/g, '')

/** every refusal code of the contract: a code that the record misses fails the type check of REFUSAL_TEXT */
const CODES: readonly DeliverRefusal[] = ['no-cmux', 'no-tab', 'stale-screen', 'screen-changed', 'label-not-found', 'multi-question', 'empty', 'control-char', 'backslash-escape']

describe('the confirm bar', () => {
  it('names the option with its digit, the session, the keys, and then the question of an answer', () => {
    expect(bar(INTENTS.answer)).toEqual([' Send "2 All" to api-7?  y send  c cancel', ` ☐ Eval set  ${QUESTION}`])
    const first = confirmView(INTENTS.answer, 110).lines[0]!
    expect(first.segments[1]).toEqual({ text: 'Send "2 All" to api-7?', token: '--accent', bold: true })
    expect(first.segments.filter((segment) => segment.bold === true && segment.token === undefined).map((segment) => segment.text)).toEqual(['y', 'c'])
  })

  it('gives the y and c keys as hotkeys', () => {
    expect(confirmView(INTENTS.answer, 110).hints).toEqual(CONFIRM_HINTS)
    expect(CONFIRM_HINTS).toEqual([
      { keys: 'y', label: 'send', hotkey: 'y', isOff: false },
      { keys: 'c', label: 'cancel', hotkey: 'c', isOff: false },
    ])
  })

  it('names the permission choice and the tool, and shows the whole tool input', () => {
    expect(bar(INTENTS.permission)).toEqual([' Send "Yes" to the Bash request of ops-4?  y send  c cancel', ' Input', '   {"command":"npm test","description":"Run the tests"}'])
    expect(bar({ ...INTENTS.permission, choice: 'no' } as DeliverIntent)[0]).toBe(' Send "No" to the Bash request of ops-4?  y send  c cancel')
    const { input: _input, ...noInput } = INTENTS.permission as Extract<DeliverIntent, { kind: 'permission' }>
    expect(bar(noInput)).toEqual([' Send "Yes" to the Bash request of ops-4?  y send  c cancel', ' Input  none'])
  })

  it('never cuts the input of a permission, however long', () => {
    const input = JSON.stringify({ command: `echo ${'word '.repeat(80)}`, path: 'p'.repeat(150) })
    const lines = bar({ ...INTENTS.permission, input } as DeliverIntent, 60)
    for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(60)
    expect(squeeze(lines.slice(2).join(''))).toBe(squeeze(input))
  })

  it('shows the first line of a prompt and the count of the rest with the key that shows it', () => {
    expect(bar(INTENTS.prompt)).toEqual([' Send this prompt to api-7?  y send  c cancel', ' Run the eval tests again.  +2 lines (r)'])
    expect(bar({ ...INTENTS.prompt, text: 'Run the eval tests again.' } as DeliverIntent)).toEqual([' Send this prompt to api-7?  y send  c cancel', ' Run the eval tests again.'])
  })

  it('shows the first line of a peer message and the count of the rest with the key that shows it', () => {
    expect(bar(INTENTS.peer)).toEqual([' Send this peer message to api-7?  y send  c cancel', ' Stop the deploy now.  +1 line (m)'])
  })

  it('wraps a long first line and a long label whole, and puts the keys after them', () => {
    const label = 'A very long option label that goes on and on past the edge'
    const lines = bar({ ...INTENTS.answer, label } as DeliverIntent, 30)
    for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(30)
    expect(squeeze(lines.join(''))).toContain(squeeze(`Send "2 ${label}" to api-7?`))
    expect(lines.join('\n')).toMatch(/y send {2}c cancel/)
    const prompt = bar({ ...INTENTS.prompt, text: `${'long '.repeat(20)}end\nsecond` } as DeliverIntent, 30)
    for (const line of prompt) expect(cellWidth(line)).toBeLessThanOrEqual(30)
    const afterKeys = prompt.findIndex((line) => line.endsWith('c cancel')) + 1
    expect(squeeze(prompt.slice(afterKeys).join(''))).toBe(squeeze(`${'long '.repeat(20)}end +1 line (r)`))
  })
})

describe('the outcome lines', () => {
  it('has 1 line for each refusal code, each 1 sentence or 2 that end with a period', () => {
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual([...CODES].sort())
    for (const code of CODES) expect(REFUSAL_TEXT[code], code).toMatch(/^[^\n]+\.$/)
    expect(new Set(Object.values(REFUSAL_TEXT)).size).toBe(CODES.length)
    expect(REFUSAL_TEXT['screen-changed']).toBe('The screen changed, so nothing was sent.')
  })

  it('draws a refusal in the bad color, and the not-delivered line in the warn color', () => {
    expect(outcomeLines(OUTCOMES.refused, 110)).toEqual([{ segments: [{ text: ' ' }, { text: REFUSAL_TEXT['screen-changed'], token: '--bad' }] }])
    for (const code of CODES) expect(outcomeLines({ ...OUTCOMES.refused, refusal: code } as never, 110).map(text)).toEqual([` ${REFUSAL_TEXT[code]}`])
    expect(NOT_DELIVERED).toBe('Not delivered. Check the Screen tab.')
    expect(outcomeLines(OUTCOMES['not-delivered'], 110)).toEqual([{ segments: [{ text: ' ' }, { text: NOT_DELIVERED, token: '--warn' }] }])
  })

  it('says what became of a sent, a delivered, a failed and an undelivered peer message', () => {
    expect(outcomeLines(OUTCOMES.sent, 110).map(text)).toEqual([' Sent to api-7. The next refresh checks it.'])
    expect(outcomeLines(OUTCOMES.delivered, 110).map(text)).toEqual([' Delivered to api-7.'])
    expect(outcomeLines(OUTCOMES.failed, 110).map(text)).toEqual([` ${SEND_FAILED}`])
    expect(outcomeLines({ ...OUTCOMES['not-delivered'], intent: INTENTS.peer }, 110).map(text)).toEqual([` ${PEER_NOT_DELIVERED}`])
  })
})

describe('no line is wider than the pane', () => {
  it.each([30, 60, 89, 90, 110])('holds the bar of every intent and every outcome line to %i columns', (columns) => {
    const lines = [
      ...Object.values(INTENTS).flatMap((intent) => confirmView(intent, columns).lines),
      ...Object.values(OUTCOMES).flatMap((outcome) => outcomeLines(outcome, columns)),
      ...CODES.flatMap((refusal) => outcomeLines({ ...OUTCOMES.refused, refusal } as never, columns)),
    ]
    for (const line of lines) expect(cellWidth(text(line)), `${columns}: ${text(line)}`).toBeLessThanOrEqual(columns)
  })
})
