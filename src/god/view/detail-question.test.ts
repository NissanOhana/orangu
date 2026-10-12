/**
 * The open question in the Now tab: the options always numbered `1:`, `2:`, and 1 line under them that says what to do.
 * A dialog with 2 or more single-select questions shows 1 question at a time, with the picks before it and the key that
 * goes back 1 question. Any other dialog keeps the line that says to answer it in its tab.
 */
import { describe, expect, it } from 'vitest'
import { detailSession } from '../../../test/fixtures/god/detail.js'
import { MINUTE, NOW, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import { ANSWER_NO_CMUX } from '../copy.js'
import type { GodSession, Question } from '../types.js'
import type { Picks } from './bar.js'
import { MULTI_DIALOG, MULTI_DIALOG_NO_CMUX } from './confirm.js'
import { detailView, type DetailInput, type DetailView } from './detail.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const detail = (session: GodSession, over: Partial<DetailInput> = {}): Extract<DetailView, { kind: 'detail' }> => {
  const view = detailView({ session, width: 79, rows: 60, now: NOW, tab: 'now', scroll: 0, isCmuxMissing: false, ...over })
  if (view.kind !== 'detail') throw new Error(view.kind)
  return view
}
/** the lines of the Now tab above the last reply */
const top = (view: Extract<DetailView, { kind: 'detail' }>): string[] => {
  const lines = view.body.map(text)
  return lines.slice(0, lines.indexOf(' Last reply'))
}
const MULTI = detailSession('s-multi')
const picks = (...digits: number[]): Picks => ({ sessionId: 's-multi', toolUseId: 'tu-multi', digits })

describe('a question of 1 question', () => {
  it('numbers each option `1:` and ends with the line that names the digits and y', () => {
    expect(top(detail(detailSession('s-wait')))).toEqual([' ☐ Eval set · waits 6h', expect.any(String), ' 1: Small  Only the fast tests.', ' 2: All', ' 3: None  Skip the eval.', ' Press 1-3, then y to send.'])
  })

  it('draws the digits dim with no hotkey and says to answer in the tab when cmux is not on the machine', () => {
    const view = detail(detailSession('s-wait'), { isCmuxMissing: true })
    expect(top(view).slice(2)).toEqual([' 1: Small  Only the fast tests.', ' 2: All', ' 3: None  Skip the eval.', ` ${ANSWER_NO_CMUX}`])
    expect(view.body.find((line) => line.key === 'option:1')!.segments[1]).toEqual({ text: '1:', dim: true })
    expect(view.body.every((line) => line.hotkey === undefined)).toBe(true)
  })

  it('draws the action line dim while a draft is open', () => {
    const view = detail(detailSession('s-wait'), { isDraftOpen: true })
    const action = view.body.find((line) => text(line) === ' Press 1-3, then y to send.')
    expect(action?.segments.at(-1)).toMatchObject({ dim: true })
  })
})

describe('a dialog with 2 or more single-select questions', () => {
  it('shows question 1 with its digit Buttons and the line that names the next question', () => {
    const view = detail(MULTI)
    expect(top(view)).toEqual([' ☐ Port · waits 4m', ' Which port do you want?', ' 1: 3000', ' 2: 8080', ' Question 1 of 2. Press 1-2 to pick, then go on to the next question.'])
    expect(view.options).toEqual([1, 2].map((digit) => ({ key: `option:${digit}`, digit, isOff: false })))
  })

  it('shows the picks before the next question, the line of the last question, and p that goes back', () => {
    const view = detail(MULTI, { picks: picks(2) })
    expect(top(view)).toEqual([' ☒ Port: 2 8080', ' ☐ Host · waits 4m', ' Which host do you want?', ' 1: Local', ' 2: Shared', ' Question 2 of 2. Press 1-2 to pick, then y to send.', ' p: back to question 1'])
    const back = view.body.find((line) => text(line) === ' p: back to question 1')!
    expect(back.segments.find((segment) => segment.press !== undefined)?.press).toEqual({ hotkey: 'p', label: 'back to question 1' })
    expect(top(detail(MULTI, { picks: picks(2, 1) }))).toEqual(top(view))
  })

  it('takes picks of another question or another session as none', () => {
    const first = top(detail(MULTI))
    expect(top(detail(MULTI, { picks: { ...picks(2), toolUseId: 'tu-old' } }))).toEqual(first)
    expect(top(detail(MULTI, { picks: { ...picks(2), sessionId: 's-wait' } }))).toEqual(first)
  })

  it('draws the digits and p dim with no key while a draft is open or with no cmux', () => {
    const drafting = detail(MULTI, { picks: picks(1), isDraftOpen: true })
    expect(drafting.body.every((line) => line.hotkey === undefined && line.segments.every((segment) => segment.press === undefined))).toBe(true)
    expect(top(drafting).at(-1)).toBe(' p: back to question 1')
    const noCmux = detail(MULTI, { isCmuxMissing: true })
    expect(top(noCmux).at(-1)).toBe(` ${ANSWER_NO_CMUX}`)
    expect(noCmux.options.every((option) => option.isOff)).toBe(true)
  })
})

describe('a dialog that the pane does not answer', () => {
  const both = (questions: Question[]): GodSession =>
    snapshotOf([waiting('s-two', { name: 'web-8', statusSince: NOW - 2 * MINUTE, transcript: transcript({ openQuestion: { toolUseId: 'tu-two', questions } }) })]).sessions[0]!

  it('numbers the options with dim digits, with no Button, and keeps the line that says to answer it in its tab', () => {
    const view = detail(detailSession('s-pick'))
    expect(top(view)).toEqual([' ☐ Checks · waits 2m', ' Which checks do you want?', ' 1: Lint', ' 2: Types', ' 3: Tests', ...top(view).slice(5)])
    expect(top(view).slice(5).join(' ').replace(/\s+/g, ' ').trim()).toBe(MULTI_DIALOG)
    expect(view.options).toEqual([])
  })

  it('shows every question of a dialog with 2 questions when 1 of them takes more than 1 choice, or has no option', () => {
    const port: Question = { text: 'Which port?', header: 'Port', multiSelect: false, options: [{ label: '3000' }] }
    for (const other of [{ ...port, header: 'Host', multiSelect: true }, { ...port, header: 'Host', options: [] }]) {
      const view = detail(both([port, other]), { isCmuxMissing: true })
      const lines = top(view)
      expect(lines.slice(0, 4)).toEqual([' ☐ Port · waits 2m', ' Which port?', ' 1: 3000', ' ☐ Host'])
      expect(lines.slice(-2).join(' ').replace(/\s+/g, ' ').trim()).toBe(MULTI_DIALOG_NO_CMUX)
      expect(view.options).toEqual([])
    }
  })

  it('says that the pane does not answer a question of 1 question with no option', () => {
    const view = detail(both([{ text: 'Which port?', header: 'Port', multiSelect: false, options: [] }]))
    expect(top(view).slice(2).join(' ').replace(/\s+/g, ' ').trim()).toBe(MULTI_DIALOG)
  })
})
