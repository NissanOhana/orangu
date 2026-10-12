/**
 * The confirm bar of the answers of a dialog with 2 or more questions, and the line of a stop after 1 or more of them.
 * The bar names the session and every pick (`Header: <digit> <label>`) with y and c, and then each question whole as
 * a row that scrolls with w and z. A stop after a digit says that the dialog keeps those picks, and names j.
 */
import { describe, expect, it } from 'vitest'
import { INTENTS, NOW } from '../../../test/fixtures/god/detail.js'
import { ANSWERS_PARTIAL } from '../copy.js'
import type { DeliverIntent, DeliverOutcome } from '../types.js'
import { cellWidth } from './cells.js'
import { CONFIRM_HINTS, FAILURE_TEXT, confirmView, outcomeLines } from './confirm.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const ANSWERS = INTENTS.answers as Extract<DeliverIntent, { kind: 'answers' }>

describe('the confirm bar of answers', () => {
  it('names the session and each pick with y and c, then each question whole', () => {
    const view = confirmView({ intent: ANSWERS, width: 110, rows: 12, scroll: 0 })
    expect(view.lines.map(text)).toEqual([' Send to web-5? Port: 2 8080 · Host: 1 Local  y: send  c: cancel', ' ☐ Port  Which port do you want?', ' ☐ Host  Which host do you want?'])
    expect(view.hints).toEqual(CONFIRM_HINTS)
    expect(view.lines[0]!.segments.find((segment) => segment.text.startsWith('Send to'))).toMatchObject({ bold: true, token: expect.any(String) })
  })

  it('keeps the picks fixed and scrolls the questions in the row limit, with a count line', () => {
    const many = { ...ANSWERS, answers: Array.from({ length: 4 }, (_, index) => ({ header: `H${index + 1}`, question: `Which value ${index + 1} do you want?`, option: 1, label: 'Yes' })) }
    const lines = confirmView({ intent: many, width: 60, rows: 4, scroll: 0 }).lines.map(text)
    expect(lines.slice(0, 2)).toEqual([' Send to web-5? H1: 1 Yes · H2: 1 Yes · H3: 1 Yes · H4: 1', ' Yes  y: send  c: cancel'])
    expect(lines.slice(2)).toEqual([' ☐ H1  Which value 1 do you want?', ' ☐ H2  Which value 2 do you want?', ' z: +2 lines'])
    for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(60)
  })
})

describe('the line of a stop after 1 or more answers', () => {
  it('says that the dialog keeps some picks and names j, in the bad color', () => {
    expect(FAILURE_TEXT['partial']).toBe(ANSWERS_PARTIAL)
    expect(ANSWERS_PARTIAL).toBe('The pane stopped after 1 or more answers, so the dialog stays open with some picks in it. Press j to answer the rest in its tab.')
    const outcome: DeliverOutcome = { status: 'failed', intent: ANSWERS, at: NOW, reason: 'partial' }
    const lines = outcomeLines(outcome, 200)
    expect(lines.map(text)).toEqual([` ${ANSWERS_PARTIAL}`])
    expect(lines[0]!.segments.find((segment) => segment.text.includes('stopped'))).toMatchObject({ token: '--bad' })
  })
})
