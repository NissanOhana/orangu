/**
 * The screen match of each step of an answers intent: 1 digit for each question of a dialog with 2 or more
 * single-select questions, then `1` on the review screen. The screens are synthetic, in the layout of the live dialog
 * of Claude Code 2.1.296 (test/fixtures/god/multi-dialog.ts). Every other screen gives a refusal, never a digit.
 */
import { describe, expect, it } from 'vitest'
import { COLOUR_SIZE, FOOTER, GREEN_SMALL, RULE, changeRow, questionScreen, reviewScreen, tabsRow } from '../../../test/fixtures/god/multi-dialog.js'
import type { Question } from '../types.js'
import { isSteppable, matchAnswersStep } from './question-dialog.js'

const WANT = { questions: COLOUR_SIZE, answers: GREEN_SMALL }
const CHANGED = { isMatch: false, refusal: 'screen-changed' }
const HEADERS = ['Colour', 'Size']
const Q1 = questionScreen(COLOUR_SIZE, 0)
const Q2 = questionScreen(COLOUR_SIZE, 1)
const REVIEW = reviewScreen(COLOUR_SIZE, ['Green', 'Small'])
const match = (text: string, step: number, want = WANT) => matchAnswersStep(text, want, step)

describe('matchAnswersStep: the screens of a dialog with 2 questions', () => {
  it('gives the digit of each confirmed option on its question, and 1 on the review screen', () => {
    expect(match(Q1, 0)).toEqual({ isMatch: true, digit: 2 })
    expect(match(Q2, 1)).toEqual({ isMatch: true, digit: 1 })
    expect(match(REVIEW, 2)).toEqual({ isMatch: true, digit: 1 })
  })

  it('reads the same screens with blank rows between their parts, and the cursor on another option', () => {
    expect(match(questionScreen(COLOUR_SIZE, 0, { gap: 1, cursor: 3 }), 0)).toEqual({ isMatch: true, digit: 2 })
    expect(match(questionScreen(COLOUR_SIZE, 1, { gap: 2 }), 1)).toEqual({ isMatch: true, digit: 1 })
    expect(match(reviewScreen(COLOUR_SIZE, ['Green', 'Small'], { gap: 1 }), 2)).toEqual({ isMatch: true, digit: 1 })
  })

  it('reads a chip row with more spaces between the chips', () => {
    const wide = Q2.replace(tabsRow(HEADERS, 1), '←  ☒ Colour   ☐ Size   ✔ Submit  →')
    expect(match(wide, 1)).toEqual({ isMatch: true, digit: 1 })
  })

  it('reads a question and a label that wrap on the review screen as 1 text', () => {
    const long: Question[] = [{ ...COLOUR_SIZE[0]!, text: 'Which test colour do you want for the first run of the suite?' }, COLOUR_SIZE[1]!]
    const wrapped = changeRow(reviewScreen(long, ['Green', 'Small']), ' ● Which test colour do you want for the first run of the suite?', ' ● Which test colour do you want\n   for the first run of the suite?')
    const answers = [{ ...GREEN_SMALL[0]!, question: long[0]!.text }, GREEN_SMALL[1]!]
    expect(match(wrapped, 2, { questions: long, answers })).toEqual({ isMatch: true, digit: 1 })
  })
})

describe('matchAnswersStep: a question screen that is not the confirmed one', () => {
  const refusals: ReadonlyArray<[string, string, number]> = [
    ['another header in a chip', Q1.replace(tabsRow(HEADERS, 0), tabsRow(['Color', 'Size'], 0)), 0],
    ['the chips in another order', Q1.replace(tabsRow(HEADERS, 0), tabsRow(['Size', 'Colour'], 0)), 0],
    ['a chip less', Q1.replace(tabsRow(HEADERS, 0), tabsRow(['Colour'], 0)), 0],
    ['a chip more', Q1.replace(tabsRow(HEADERS, 0), tabsRow([...HEADERS, 'Speed'], 0)), 0],
    ['no Submit tab', Q1.replace(tabsRow(HEADERS, 0), '←  ☐ Colour  ☐ Size  →'), 0],
    ['no arrows', Q1.replace(tabsRow(HEADERS, 0), '☐ Colour  ☐ Size  ✔ Submit'), 0],
    ['a chip of the first question marked as answered', Q1.replace(tabsRow(HEADERS, 0), tabsRow(HEADERS, 1)), 0],
    ['the chip of the first question not answered at step 2', Q2.replace(tabsRow(HEADERS, 1), tabsRow(HEADERS, 0)), 1],
    ['the chip of the second question answered at step 2', Q2.replace(tabsRow(HEADERS, 1), tabsRow(HEADERS, 2)), 1],
    ['another question text', changeRow(Q1, 'Which test colour?', 'Which test color?'), 0],
    ['the question 1 screen at step 2', Q1.replace(tabsRow(HEADERS, 0), tabsRow(HEADERS, 1)), 1],
    ['the question 2 screen at step 1', Q2, 0],
    ['another label at the confirmed digit', changeRow(Q1, '  2. Green', '  2. Lime'), 0],
    ['another label at another digit', changeRow(Q1, '  3. Blue', '  3. Navy'), 0],
    ['another description', changeRow(Q1, '     Use green as the test colour.', '     Use lime as the test colour.'), 0],
    ['a missing description', changeRow(Q1, '     Use blue as the test colour.', undefined), 0],
    ['an extra option', changeRow(changeRow(Q1, '  4. Type something.', '  4. Pink\n  5. Type something.'), '  5. Chat about this', '  6. Chat about this'), 0],
    ['a missing option', changeRow(changeRow(changeRow(changeRow(Q1, '  3. Blue', undefined), '     Use blue as the test colour.', undefined), '  4. Type something.', '  3. Type something.'), '  5. Chat about this', '  4. Chat about this'), 0],
    ['no cursor', changeRow(Q1, '❯ 1. Red', '  1. Red'), 0],
    ['the cursor on Type something', changeRow(changeRow(Q1, '❯ 1. Red', '  1. Red'), '  4. Type something.', '❯ 4. Type something.'), 0],
    ['a multi select', changeRow(Q1, '  4. Type something.', '  4. Type something'), 0],
    ['a prompt row under the dialog', `${Q1}\n${RULE}\n❯ \n${RULE}`, 0],
    ['a numbered row under the dialog', `${Q1}\n  1. Red`, 0],
  ]
  for (const [name, text, step] of refusals) {
    it(`refuses ${name}`, () => {
      expect(match(text, step)).toEqual(CHANGED)
    })
  }

  it('refuses a second chip row on the screen, as a dialog that the transcript quotes above', () => {
    const quoted = `${tabsRow(HEADERS, 0)}\nWhich test colour?\n\n${Q1}`
    expect(match(quoted, 0)).toEqual(CHANGED)
  })

  it('refuses a step out of range, and an answer that is not the confirmed one', () => {
    expect(match(Q1, -1)).toEqual(CHANGED)
    expect(match(REVIEW, 3)).toEqual(CHANGED)
    expect(match(Q1, 0, { ...WANT, answers: [{ ...GREEN_SMALL[0]!, label: 'Red' }, GREEN_SMALL[1]!] })).toEqual(CHANGED)
    expect(match(Q1, 0, { ...WANT, answers: [{ ...GREEN_SMALL[0]!, option: 7 }, GREEN_SMALL[1]!] })).toEqual(CHANGED)
    expect(match(Q1, 0, { ...WANT, answers: GREEN_SMALL.slice(0, 1) })).toEqual(CHANGED)
  })
})

describe('matchAnswersStep: a review screen that is not the confirmed one', () => {
  const refusals: ReadonlyArray<[string, string]> = [
    ['another label', reviewScreen(COLOUR_SIZE, ['Red', 'Small'])],
    ['an empty label', reviewScreen(COLOUR_SIZE, ['Green', ''])],
    ['another order', reviewScreen([COLOUR_SIZE[1]!, COLOUR_SIZE[0]!], ['Small', 'Green'])],
    ['another question text', changeRow(REVIEW, ' ● Which test size?', ' ● Which test speed?')],
    ['an extra question row', changeRow(REVIEW, 'Ready to submit your answers?', ' ● Which test speed?\n   → Fast\nReady to submit your answers?')],
    ['an extra row between the questions', changeRow(REVIEW, ' ● Which test size?', 'Pick again.\n ● Which test size?')],
    ['a missing question row', changeRow(changeRow(REVIEW, ' ● Which test size?', undefined), '   → Small', undefined)],
    ['a missing label row', changeRow(REVIEW, '   → Small', undefined)],
    ['no title row', changeRow(REVIEW, 'Review your answers', undefined)],
    ['another title row', changeRow(REVIEW, 'Review your answers', 'Check your answers')],
    ['no ready row', changeRow(REVIEW, 'Ready to submit your answers?', undefined)],
    ['another first option', changeRow(changeRow(REVIEW, '❯ 1. Submit answers', '❯ 1. Cancel'), '  2. Cancel', '  2. Submit answers')],
    ['a third option', changeRow(REVIEW, '  2. Cancel', '  2. Cancel\n  3. Submit again')],
    ['no cursor', changeRow(REVIEW, '❯ 1. Submit answers', '  1. Submit answers')],
    ['a chip that is not answered', REVIEW.replace(tabsRow(HEADERS, 2), tabsRow(HEADERS, 1))],
    ['a prompt row under the dialog', `${REVIEW}\n${RULE}\n❯ \n${RULE}`],
    ['a second chip row above', `${tabsRow(HEADERS, 2)}\n\n${REVIEW}`],
  ]
  for (const [name, text] of refusals) {
    it(`refuses ${name}`, () => {
      expect(match(text, 2)).toEqual(CHANGED)
    })
  }

  it('refuses the review screen at a question step, and a question screen at the review step', () => {
    expect(match(REVIEW, 1)).toEqual(CHANGED)
    expect(match(Q2.replace(tabsRow(HEADERS, 1), tabsRow(HEADERS, 2)), 2)).toEqual(CHANGED)
  })

  it('keeps the footer under the dialog', () => {
    expect(REVIEW.endsWith(FOOTER)).toBe(true)
  })
})

describe('isSteppable', () => {
  const single = COLOUR_SIZE[1]!
  it('takes 2 or more single-select questions, each with 1 to 8 options', () => {
    expect(isSteppable(COLOUR_SIZE)).toBe(true)
    expect(isSteppable([single, single, single, single])).toBe(true)
  })
  it('refuses 1 question, a multi select, a question with no option, and a question with 9 options', () => {
    expect(isSteppable([single])).toBe(false)
    expect(isSteppable([single, { ...single, multiSelect: true }])).toBe(false)
    expect(isSteppable([single, { ...single, options: [] }])).toBe(false)
    expect(isSteppable([single, { ...single, options: Array.from({ length: 9 }, (_, index) => ({ label: `L${index}` })) }])).toBe(false)
  })
})
