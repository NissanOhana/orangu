/**
 * The screen reader and the screen match of the key path. Each fixture under test/fixtures/god/screens is a
 * synthetic screen in the layout of Claude Code 2.1.295: a question dialog, a permission dialog, an empty or a
 * typed prompt, and screens that quote a dialog in the transcript. Every match fails closed: a screen that the
 * rules cannot read gives a refusal, never a digit.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matchAnswer, matchPermission, matchPrompt, readScreen, type QuestionDialog } from './screen-match.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
const fixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')
const view = (name: string) => readScreen(fixture(name))

/** the answer that the person confirmed on the base question fixture */
const RED = { header: 'Color', question: 'Which color should the button use?', option: 1, label: 'Red' }
const GREEN = { ...RED, option: 2, label: 'Green' }
/** the permission that the person confirmed on the permission fixtures */
const TOUCH = { tool: 'Bash', input: JSON.stringify({ command: 'touch probe-yes.txt', description: 'Make an empty probe file' }) }

/** The fixture with 1 row changed: the first row that equals `from` becomes `to`. */
function edit(name: string, from: string, to: string): string {
  const text = fixture(name)
  if (!text.includes(`${from}\n`)) throw new Error(`${name} has no row ${JSON.stringify(from)}`)
  return text.replace(`${from}\n`, `${to}\n`)
}

describe('readScreen: a question dialog', () => {
  it('reads the header, the question, each option with its digit and description, and the 2 extra rows', () => {
    const screen = view('question')
    expect(screen.dialogs).toHaveLength(1)
    const dialog = screen.dialogs[0] as QuestionDialog
    expect(dialog.kind).toBe('question')
    expect(dialog).toMatchObject({ chips: 1, hasTabs: false, header: 'Color', question: 'Which color should the button use?', isMultiSelect: false })
    expect(dialog.options.map(({ digit, label, description, hasCursor }) => ({ digit, label, description, hasCursor }))).toEqual([
      { digit: 1, label: 'Red', description: 'A warm color for the main action.', hasCursor: true },
      { digit: 2, label: 'Green', description: 'A calm color that means go.', hasCursor: false },
      { digit: 3, label: 'Blue', description: 'A cool color that fits the brand.', hasCursor: false },
    ])
    expect(dialog.other).toMatchObject({ digit: 4, label: 'Type something.', hasCursor: false })
    expect(dialog.chat).toMatchObject({ digit: 5, label: 'Chat about this', hasCursor: false })
  })

  it('does not take the todo rows above the dialog for a chip row', () => {
    expect(view('question').dialogs.map((dialog) => dialog.kind)).toEqual(['question'])
    expect(view('prompt-empty').dialogs).toEqual([])
  })

  it('counts the chips and the tabs of a dialog with 2 questions, and the missing period of a multi select', () => {
    expect(view('question-two').dialogs[0]).toMatchObject({ kind: 'question', chips: 2, hasTabs: true })
    expect(view('question-multi-select').dialogs[0]).toMatchObject({ kind: 'question', chips: 1, hasTabs: true, isMultiSelect: true })
  })

  it('reads a dialog that the transcript quotes as a dialog too', () => {
    expect(view('two-dialogs').dialogs.map((dialog) => dialog.kind)).toEqual(['question', 'question'])
    expect(view('dialog-above-prompt').dialogs.map((dialog) => dialog.kind)).toEqual(['question'])
  })
})

describe('readScreen: a permission dialog and the prompt', () => {
  it('reads the options of a permission dialog and the request rows under its rule', () => {
    const [dialog] = view('permission').dialogs
    expect(dialog?.kind).toBe('permission')
    if (dialog?.kind !== 'permission') return
    expect(dialog.question).toBe('Do you want to proceed?')
    expect(dialog.options.map((option) => [option.digit, option.label, option.hasCursor])).toEqual([
      [1, 'Yes', true],
      [2, 'Yes, and always allow access to probe/ from this project', false],
      [3, 'Yes, and switch to auto mode', false],
      [4, 'No', false],
    ])
    expect(dialog.request?.map((row) => [row.text, row.indent])).toEqual([
      ['Bash command', 1],
      ['Make an empty probe file', 1],
      ['touch probe-yes.txt', 3],
      ['Do you want to proceed?', 1],
    ])
  })

  it('reads the last prompt row: empty after a no-break space, empty after a plain space, or the typed text', () => {
    expect(view('prompt-empty')).toMatchObject({ dialogs: [], promptText: '' })
    expect(view('prompt-empty').promptLine).toBe(7)
    expect(readScreen(fixture('prompt-empty').replace('❯\u00a0', '❯ ')).promptText).toBe('')
    expect(view('prompt-typed').promptText).toBe('fix the flaky test')
  })

  it('takes no numbered row for a prompt row, and no prompt row in a dialog', () => {
    const screen = view('question')
    expect(screen.promptLine).toBe(0)
    expect(screen.lastDialogMark).toBeGreaterThan(screen.promptLine)
  })
})

describe('matchAnswer', () => {
  it('gives the digit when the header, the question and the label at that digit match', () => {
    expect(matchAnswer(view('question'), RED)).toEqual({ isMatch: true, digit: 1 })
    expect(matchAnswer(view('question'), GREEN)).toEqual({ isMatch: true, digit: 2 })
  })

  it('follows the digit, not the cursor, when the cursor is on another option row', () => {
    const moved = readScreen(edit('question', '  3. Blue', '❯ 3. Blue').replace('❯ 1. Red', '  1. Red'))
    expect(matchAnswer(moved, RED)).toEqual({ isMatch: true, digit: 1 })
  })

  it('refuses when the cursor is on the Type something row, on the Chat row, on no row or on 2 rows', () => {
    const noCursor = fixture('question').replace('❯ 1. Red', '  1. Red')
    expect(matchAnswer(readScreen(noCursor.replace('  4. Type something.', '❯ 4. Type something.')), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(readScreen(noCursor.replace('  5. Chat about this', '❯ 5. Chat about this')), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(readScreen(noCursor), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(readScreen(edit('question', '  2. Green', '❯ 2. Green')), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a header that matches with a label that does not', () => {
    expect(matchAnswer(readScreen(edit('question', '  2. Green', '  2. Teal')), GREEN)).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a label that is a prefix of the screen label, and a screen label that is a prefix of it', () => {
    expect(matchAnswer(readScreen(edit('question', '❯ 1. Red', '❯ 1. Red wine')), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('question'), { ...RED, label: 'Red wine' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('question'), { ...RED, label: 'Re' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses another question under the same header, another header, and a digit with no option', () => {
    expect(matchAnswer(view('question-changed'), { ...RED, option: 2 })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('question'), { ...RED, header: 'Colour' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('question'), { ...RED, option: 4, label: 'Type something.' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('question'), { ...RED, option: 0 })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('matches with trailing spaces on the screen rows and on the confirmed label', () => {
    const padded = readScreen(fixture('question').split('\n').map((row) => `${row}   `).join('\n'))
    expect(matchAnswer(padded, RED)).toEqual({ isMatch: true, digit: 1 })
    expect(matchAnswer(view('question'), { ...RED, label: 'Red  ' })).toEqual({ isMatch: true, digit: 1 })
  })

  it('gives multi-question for 2 questions and for a multi select, by the tabs or by the missing period alone', () => {
    expect(matchAnswer(view('question-two'), RED)).toEqual({ isMatch: false, refusal: 'multi-question' })
    expect(matchAnswer(view('question-multi-select'), { ...RED, header: 'Toppings', question: 'Which toppings do you want?', label: 'Cheese' })).toEqual({
      isMatch: false,
      refusal: 'multi-question',
    })
    expect(matchAnswer(readScreen(edit('question', '  4. Type something.', '  4. Type something')), RED)).toEqual({ isMatch: false, refusal: 'multi-question' })
  })

  it('refuses a screen with 2 dialogs, a quoted dialog above the prompt, and a permission dialog', () => {
    expect(matchAnswer(view('two-dialogs'), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('dialog-above-prompt'), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('permission'), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchAnswer(view('prompt-empty'), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a dialog with a cursor row below it that no dialog holds', () => {
    expect(matchAnswer(readScreen(`${fixture('question')}❯ 1. Red\n  2. Green\n`), RED)).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchPermission(readScreen(`${fixture('permission')}❯ 1. Yes\n  2. No\n`), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })
})

describe('matchPermission', () => {
  it('finds the digit of the option labeled exactly Yes or exactly No, where the screen puts it', () => {
    expect(matchPermission(view('permission'), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    expect(matchPermission(view('permission'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: true, digit: 4 })
    expect(matchPermission(view('permission-older'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: true, digit: 3 })
  })

  it('never takes an option that starts with Yes, and', () => {
    expect(matchPermission(view('permission-amend'), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
    expect(matchPermission(view('permission-amend'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
    const onlyAlways = readScreen(edit('permission', ' ❯ 1. Yes', ' ❯ 1. Yes, and always allow this'))
    expect(matchPermission(onlyAlways, { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
  })

  it('refuses the unicode lookalikes of Yes and No, a zero-width space, and 2 rows with the same label', () => {
    expect(matchPermission(view('permission-lookalike'), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
    expect(matchPermission(view('permission-lookalike'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
    expect(matchPermission(readScreen(edit('permission', ' ❯ 1. Yes', ' ❯ 1. Ye\u200bs')), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
    expect(matchPermission(readScreen(edit('permission', '   3. Yes, and switch to auto mode', '   3. Yes')), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'label-not-found' })
  })

  it('matches with trailing spaces on each row', () => {
    const padded = readScreen(fixture('permission').split('\n').map((row) => `${row}  \u00a0`).join('\n'))
    expect(matchPermission(padded, { ...TOUCH, choice: 'no' })).toEqual({ isMatch: true, digit: 4 })
  })

  it('refuses a dialog for another command, a longer command and a command that is a prefix', () => {
    const other = readScreen(edit('permission', '   touch probe-yes.txt', '   rm -rf build'))
    expect(matchPermission(other, { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    const longer = readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt && rm -rf build'))
    expect(matchPermission(longer, { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    const prefix = { tool: 'Bash', input: JSON.stringify({ command: 'touch probe' }) }
    expect(matchPermission(view('permission'), { ...prefix, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('needs each line of a command with more lines, in order', () => {
    const twoLines = readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt\n   ls probe'))
    const both = { tool: 'Bash', input: JSON.stringify({ command: 'touch probe-yes.txt\nls probe' }) }
    expect(matchPermission(twoLines, { ...both, choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    const otherSecond = { tool: 'Bash', input: JSON.stringify({ command: 'touch probe-yes.txt\nrm -rf probe' }) }
    expect(matchPermission(twoLines, { ...otherSecond, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a command whose first or last rows are the confirmed command', () => {
    const after = readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt\n   rm -rf build'))
    expect(matchPermission(after, { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    const before = readScreen(edit('permission', '   touch probe-yes.txt', '   rm -rf build\n   touch probe-yes.txt'))
    expect(matchPermission(before, { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('passes the description under the command at the same indent, as older builds draw it', () => {
    expect(matchPermission(view('permission-older'), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    const noDescription = { tool: 'Bash', input: JSON.stringify({ command: 'touch probe-yes.txt' }) }
    expect(matchPermission(view('permission-older'), { ...noDescription, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a request that the plan cannot tie to the screen: another tool, no input, an input that does not parse', () => {
    expect(matchPermission(view('permission'), { tool: 'Edit', input: JSON.stringify({ file_path: '/work/probe/a.ts' }), choice: 'yes' })).toEqual({
      isMatch: false,
      refusal: 'screen-changed',
    })
    expect(matchPermission(view('permission'), { tool: 'Bash', choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchPermission(view('permission'), { tool: 'Bash', input: '{"command": "touch', choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a dialog with no rule over it, a question dialog, and an empty prompt', () => {
    const noRule = readScreen(fixture('permission').replace(/^─+$/m, ''))
    expect(matchPermission(noRule, { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchPermission(view('question'), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
    expect(matchPermission(view('prompt-empty'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })

  it('refuses a dialog with the cursor on no row', () => {
    expect(matchPermission(readScreen(edit('permission', ' ❯ 1. Yes', '   1. Yes')), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: false, refusal: 'screen-changed' })
  })
})

describe('matchPrompt', () => {
  it('passes an empty prompt row with no dialog on the screen', () => {
    expect(matchPrompt(view('prompt-empty'))).toBeUndefined()
  })

  it('refuses a typed prompt, an open dialog, a quoted dialog above the prompt, and a screen with no prompt row', () => {
    expect(matchPrompt(view('prompt-typed'))).toBe('screen-changed')
    expect(matchPrompt(view('question'))).toBe('screen-changed')
    expect(matchPrompt(view('permission'))).toBe('screen-changed')
    expect(matchPrompt(view('dialog-above-prompt'))).toBe('screen-changed')
    expect(matchPrompt(readScreen('Restarting the session.\n'))).toBe('screen-changed')
  })

  it('refuses a cursor row below the empty prompt row, and a shell mode prompt', () => {
    expect(matchPrompt(readScreen(`${fixture('prompt-empty')}❯ 1. Yes\n  2. No\n`))).toBe('screen-changed')
    expect(matchPrompt(readScreen(fixture('prompt-empty').replace('❯\u00a0', '!\u00a0')))).toBe('screen-changed')
  })
})
