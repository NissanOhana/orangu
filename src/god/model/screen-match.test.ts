/**
 * The screen reader and the screen match of the key path. Each fixture under test/fixtures/god/screens is a
 * synthetic screen in the layout of Claude Code 2.1.295: a question dialog, a permission dialog, an empty or a
 * typed prompt, and screens that quote a dialog in the transcript. Every match fails closed: a screen that the
 * rules cannot read the way Claude Code draws it gives a refusal, never a digit.
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
const bash = (command: string, description = 'Make an empty probe file') => ({ tool: 'Bash', input: JSON.stringify({ command, description }) })
const TOUCH = bash('touch probe-yes.txt')
const CHANGED = { isMatch: false, refusal: 'screen-changed' }
const NOT_FOUND = { isMatch: false, refusal: 'label-not-found' }

/** The fixture with 1 row changed: the first row that equals `from` becomes `to`. */
function edit(name: string, from: string, to: string): string {
  const text = fixture(name)
  if (!text.includes(`${from}\n`)) throw new Error(`${name} has no row ${JSON.stringify(from)}`)
  return text.replace(`${from}\n`, `${to}\n`)
}

/** The fixture with each rule row cut to the given width: a narrow terminal. */
const narrow = (text: string, width: number): string => text.replace(/^─+$/gm, '─'.repeat(width))

describe('readScreen: a question dialog', () => {
  it('reads the header, the question, each option with its digit and description, and the 2 extra rows', () => {
    const screen = view('question')
    expect(screen.dialogs).toHaveLength(1)
    const dialog = screen.dialogs[0] as QuestionDialog
    expect(dialog.kind).toBe('question')
    expect(dialog).toMatchObject({ chips: 1, hasTabs: false, header: 'Color', question: 'Which color should the button use?', isMultiSelect: false })
    expect(dialog.options.map(({ digit, label, description, hasCursor, isWhole }) => ({ digit, label, description, hasCursor, isWhole }))).toEqual([
      { digit: 1, label: 'Red', description: 'A warm color for the main action.', hasCursor: true, isWhole: true },
      { digit: 2, label: 'Green', description: 'A calm color that means go.', hasCursor: false, isWhole: true },
      { digit: 3, label: 'Blue', description: 'A cool color that fits the brand.', hasCursor: false, isWhole: true },
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

  it('takes no row with a no-break space after the digit, or with a residue before the cursor, as an option row', () => {
    expect((readScreen(edit('question', '❯ 1. Red', '❯ 1.\u00a0Red')).dialogs[0] as QuestionDialog | undefined)?.options[0]?.label).not.toBe('Red')
    expect(readScreen(edit('question', '❯ 1. Red', '[0m❯ 1. Red')).dialogs).toEqual([])
  })
})

describe('readScreen: a permission dialog and the prompt', () => {
  it('reads the options of a permission dialog and the request rows between its rule and its question', () => {
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
    expect(dialog.request).toEqual(['Bash command', 'Make an empty probe file', 'touch probe-yes.txt'])
  })

  it('reads the last prompt row: empty after a no-break space, empty after a plain space, or the typed text', () => {
    expect(view('prompt-empty')).toMatchObject({ dialogs: [], promptText: '', isPromptFramed: true })
    expect(view('prompt-empty').promptLine).toBe(7)
    expect(readScreen(fixture('prompt-empty').replace('❯\u00a0', '❯ ')).promptText).toBe('')
    expect(view('prompt-typed').promptText).toBe('fix the flaky test')
  })

  it('takes no numbered row for a prompt row, and marks the numbered rows', () => {
    const screen = view('question')
    expect(screen.promptLine).toBe(0)
    expect(screen.lastMark).toBeGreaterThan(screen.promptLine)
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
    expect(matchAnswer(readScreen(noCursor.replace('  4. Type something.', '❯ 4. Type something.')), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(noCursor.replace('  5. Chat about this', '❯ 5. Chat about this')), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(noCursor), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(edit('question', '  2. Green', '❯ 2. Green')), RED)).toEqual(CHANGED)
  })

  it('refuses a header that matches with a label that does not', () => {
    expect(matchAnswer(readScreen(edit('question', '  2. Green', '  2. Teal')), GREEN)).toEqual(CHANGED)
  })

  it('refuses a label that is a prefix of the screen label, and a screen label that is a prefix of it', () => {
    expect(matchAnswer(readScreen(edit('question', '❯ 1. Red', '❯ 1. Red wine')), RED)).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, label: 'Red wine' })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, label: 'Re' })).toEqual(CHANGED)
  })

  it('refuses another question under the same header, another header, and a digit with no option', () => {
    expect(matchAnswer(view('question-changed'), { ...RED, option: 2 })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, header: 'Colour' })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, option: 4, label: 'Type something.' })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, option: 0 })).toEqual(CHANGED)
  })

  it('matches with the padding spaces at the end of each screen row', () => {
    const padded = readScreen(fixture('question').split('\n').map((row) => `${row}   `).join('\n'))
    expect(matchAnswer(padded, RED)).toEqual({ isMatch: true, digit: 1 })
  })

  it('compares the label, the header and the question as they are: no trim, no collapse, no lookalike', () => {
    expect(matchAnswer(view('question'), { ...RED, label: 'Red ' })).toEqual(CHANGED)
    expect(matchAnswer(readScreen(edit('question', '❯ 1. Red', '❯ 1. Red\u00a0')), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(edit('question', '❯ 1. Red', '❯ 1. Red[0m')), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(edit('question', '❯ 1. Red', '❯ 1. Rеd')), RED)).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, header: 'Color ' })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, header: ' Color' })).toEqual(CHANGED)
    expect(matchAnswer(readScreen(edit('question', ' ☐ Color', ' ☐ Main color')), { ...RED, header: 'Main  color' })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, question: 'Which  color should the button use?' })).toEqual(CHANGED)
    expect(matchAnswer(view('question'), { ...RED, question: 'Which color should the button use? ' })).toEqual(CHANGED)
    expect(matchAnswer(readScreen(edit('question', 'Which color should the button use?', 'Which  color should the button use?')), RED)).toEqual(CHANGED)
  })

  it('joins a question that wraps to 2 rows with 1 space', () => {
    const wrapped = readScreen(edit('question', 'Which color should the button use?', 'Which color should\nthe button use?'))
    expect(matchAnswer(wrapped, RED)).toEqual({ isMatch: true, digit: 1 })
  })

  it('refuses a label row whose next row can be the rest of the label, on a narrow screen', () => {
    const wrapped = narrow(edit('question', '     A warm color for the main action.', '     wine'), 14)
    expect(matchAnswer(readScreen(wrapped), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(narrow(fixture('question'), 40)), RED)).toEqual({ isMatch: true, digit: 1 })
  })

  it('refuses a label row with a row under it when the screen has no rule to give its width', () => {
    expect(matchAnswer(readScreen(fixture('question').replace(/^─+$/gm, '')), RED)).toEqual(CHANGED)
  })

  it('refuses a label of unknown width with a row under it, and measures a wide label as 2 columns', () => {
    const emoji = readScreen(edit('question', '❯ 1. Red', '❯ 1. Red 🔴'))
    expect(matchAnswer(emoji, { ...RED, label: 'Red 🔴' })).toEqual(CHANGED)
    const wide = readScreen(edit('question', '❯ 1. Red', '❯ 1. 赤'))
    expect(matchAnswer(wide, { ...RED, label: '赤' })).toEqual({ isMatch: true, digit: 1 })
    expect(matchAnswer(readScreen(narrow(edit('question', '❯ 1. Red', '❯ 1. 赤赤'), 15)), { ...RED, label: '赤赤' })).toEqual(CHANGED)
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
    expect(matchAnswer(view('two-dialogs'), RED)).toEqual(CHANGED)
    expect(matchAnswer(view('dialog-above-prompt'), RED)).toEqual(CHANGED)
    expect(matchAnswer(view('permission'), RED)).toEqual(CHANGED)
    expect(matchAnswer(view('prompt-empty'), RED)).toEqual(CHANGED)
  })

  it('refuses a dialog with a numbered row below it that no dialog holds, with or without the cursor', () => {
    expect(matchAnswer(readScreen(`${fixture('question')}❯ 1. Red\n  2. Green\n`), RED)).toEqual(CHANGED)
    expect(matchAnswer(readScreen(`${fixture('question')}  6. Red\n`), RED)).toEqual(CHANGED)
    expect(matchPermission(readScreen(`${fixture('permission')}❯ 1. Yes\n  2. No\n`), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(readScreen(`${fixture('permission')}  5. Yes\n`), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
  })
})

describe('matchPermission: the label', () => {
  it('finds the digit of the option labeled exactly Yes or exactly No, where the screen puts it', () => {
    expect(matchPermission(view('permission'), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    expect(matchPermission(view('permission'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: true, digit: 4 })
    expect(matchPermission(view('permission-older'), { ...TOUCH, choice: 'no' })).toEqual({ isMatch: true, digit: 3 })
  })

  it('never takes an option that starts with Yes, and', () => {
    expect(matchPermission(view('permission-amend'), { ...TOUCH, choice: 'yes' })).toEqual(NOT_FOUND)
    expect(matchPermission(view('permission-amend'), { ...TOUCH, choice: 'no' })).toEqual(NOT_FOUND)
    const onlyAlways = readScreen(edit('permission', ' ❯ 1. Yes', ' ❯ 1. Yes, and always allow this'))
    expect(matchPermission(onlyAlways, { ...TOUCH, choice: 'yes' })).toEqual(NOT_FOUND)
  })

  it('refuses the unicode lookalikes of Yes and No, a zero-width space, a residue, and 2 rows with the same label', () => {
    expect(matchPermission(view('permission-lookalike'), { ...TOUCH, choice: 'yes' })).toEqual(NOT_FOUND)
    expect(matchPermission(view('permission-lookalike'), { ...TOUCH, choice: 'no' })).toEqual(NOT_FOUND)
    expect(matchPermission(readScreen(edit('permission', ' ❯ 1. Yes', ' ❯ 1. Ye\u200bs')), { ...TOUCH, choice: 'yes' })).toEqual(NOT_FOUND)
    expect(matchPermission(readScreen(edit('permission', '   4. No', '   4. No[0m')), { ...TOUCH, choice: 'no' })).toEqual(NOT_FOUND)
    expect(matchPermission(readScreen(edit('permission', '   4. No', '   4. No\u00a0')), { ...TOUCH, choice: 'no' })).toEqual(NOT_FOUND)
    expect(matchPermission(readScreen(edit('permission', '   3. Yes, and switch to auto mode', '   3. Yes')), { ...TOUCH, choice: 'yes' })).toEqual(NOT_FOUND)
  })

  it('matches with the padding spaces at the end of each row', () => {
    const padded = readScreen(fixture('permission').split('\n').map((row) => `${row}   `).join('\n'))
    expect(matchPermission(padded, { ...TOUCH, choice: 'no' })).toEqual({ isMatch: true, digit: 4 })
  })

  it('refuses a Yes row whose next row can be the rest of its label', () => {
    const wrapped = narrow(edit('permission', ' ❯ 1. Yes', ' ❯ 1. Yes\n        and do it again'), 12)
    expect(matchPermission(readScreen(wrapped), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses a dialog with the cursor on no row', () => {
    expect(matchPermission(readScreen(edit('permission', ' ❯ 1. Yes', '   1. Yes')), { ...TOUCH, choice: 'no' })).toEqual(CHANGED)
  })
})

describe('matchPermission: the request', () => {
  it('refuses a dialog for another command, a longer command and a command that is a prefix', () => {
    expect(matchPermission(readScreen(edit('permission', '   touch probe-yes.txt', '   rm -rf build')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    const longer = readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt && rm -rf build'))
    expect(matchPermission(longer, { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(view('permission'), { ...bash('touch probe'), choice: 'yes' })).toEqual(CHANGED)
  })

  it('needs each line of a command with more lines, in order', () => {
    const twoLines = readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt\n   ls probe'))
    expect(matchPermission(twoLines, { ...bash('touch probe-yes.txt\nls probe'), choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    expect(matchPermission(twoLines, { ...bash('touch probe-yes.txt\nrm -rf probe'), choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses a command whose first or last rows are the confirmed command, and a second request block', () => {
    expect(matchPermission(readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt\n   rm -rf build')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(readScreen(edit('permission', '   touch probe-yes.txt', '   rm -rf build\n   touch probe-yes.txt')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    const second = readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt\n\n Bash command\n   rm -rf build'))
    expect(matchPermission(second, { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses a command whose row wraps or is cut, and a command with other spaces', () => {
    expect(matchPermission(readScreen(edit('permission', '   touch probe-yes.txt', '   touch\n   probe-yes.txt')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-ye…')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(view('permission'), { ...bash('touch  probe-yes.txt'), choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses a screen that shows fewer rows than the confirmed command', () => {
    expect(matchPermission(view('permission'), { ...bash('touch probe-yes.txt\nrm -rf build'), choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses the description and the command in the other order: the rows can swap', () => {
    const swapped = { ...bash('Make an empty probe file', 'touch probe-yes.txt'), choice: 'yes' as const }
    expect(matchPermission(view('permission'), swapped)).toEqual(CHANGED)
    expect(matchPermission(view('permission'), { ...bash('touch probe-yes.txt', ''), choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses an extra row in the request, another title and another question', () => {
    expect(matchPermission(readScreen(edit('permission', '   touch probe-yes.txt', '   touch probe-yes.txt\n Permission rule Bash asks for this command.')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(readScreen(edit('permission', ' Bash command', ' Edit file')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(readScreen(edit('permission', ' Do you want to proceed?', ' Do you want to make this edit?')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
  })

  it('takes the title variants and the auto mode tip row of this build', () => {
    expect(matchPermission(readScreen(edit('permission', ' Bash command', ' Bash command (unsandboxed)')), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    const tip = ' Bash command\n Tip: auto mode handles these prompts for you \u2014 choose "switch to auto mode" below'
    expect(matchPermission(readScreen(edit('permission', ' Bash command', tip)), { ...TOUCH, choice: 'yes' })).toEqual({ isMatch: true, digit: 1 })
    expect(matchPermission(readScreen(edit('permission', ' Bash command', ' Bash command\n Tip: say yes')), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses a request that the plan cannot tie to the screen: another tool, no input, an input that does not parse', () => {
    expect(matchPermission(view('permission'), { tool: 'Edit', input: JSON.stringify({ file_path: '/work/probe/a.ts' }), choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(view('permission'), { tool: 'Bash', choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(view('permission'), { tool: 'Bash', input: '{"command": "touch', choice: 'yes' })).toEqual(CHANGED)
  })

  it('refuses a dialog with no rule over it, a question dialog, and an empty prompt', () => {
    const noRule = readScreen(fixture('permission').replace(/^─+$/m, ''))
    expect(matchPermission(noRule, { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(view('question'), { ...TOUCH, choice: 'yes' })).toEqual(CHANGED)
    expect(matchPermission(view('prompt-empty'), { ...TOUCH, choice: 'no' })).toEqual(CHANGED)
  })
})

describe('matchPrompt', () => {
  it('passes an empty prompt row in the input box, with no dialog on the screen', () => {
    expect(matchPrompt(view('prompt-empty'))).toBeUndefined()
  })

  it('refuses a typed prompt, an open dialog, a quoted dialog above the prompt, and a screen with no prompt row', () => {
    expect(matchPrompt(view('prompt-typed'))).toBe('screen-changed')
    expect(matchPrompt(view('question'))).toBe('screen-changed')
    expect(matchPrompt(view('permission'))).toBe('screen-changed')
    expect(matchPrompt(view('dialog-above-prompt'))).toBe('screen-changed')
    expect(matchPrompt(readScreen('Restarting the session.\n'))).toBe('screen-changed')
  })

  it('refuses a numbered row below the empty prompt row, and a shell mode prompt', () => {
    expect(matchPrompt(readScreen(`${fixture('prompt-empty')}❯ 1. Yes\n  2. No\n`))).toBe('screen-changed')
    expect(matchPrompt(readScreen(`${fixture('prompt-empty')}  1. Yes\n`))).toBe('screen-changed')
    expect(matchPrompt(readScreen(fixture('prompt-empty').replace('❯\u00a0', '!\u00a0')))).toBe('screen-changed')
  })

  it('refuses a prompt row that no rule frames above and below, so a status line row is not the input box', () => {
    const rows = fixture('prompt-empty').split('\n')
    expect(matchPrompt(readScreen(rows.filter((_, i) => i !== 6).join('\n')))).toBe('screen-changed')
    expect(matchPrompt(readScreen(rows.filter((_, i) => i !== 8).join('\n')))).toBe('screen-changed')
    expect(matchPrompt(readScreen(`${fixture('prompt-typed')}❯\n`))).toBe('screen-changed')
  })

  it('refuses a prompt row with a no-break space or a residue left in it', () => {
    expect(matchPrompt(readScreen(fixture('prompt-empty').replace('❯\u00a0', '❯\u00a0\u00a0')))).toBe('screen-changed')
    expect(matchPrompt(readScreen(fixture('prompt-empty').replace('❯\u00a0', '❯\u00a0[0m')))).toBe('screen-changed')
  })
})
