/**
 * The shell permission dialog of Claude Code 2.1.296 draws the command between 2 dashed rules (U+254C) as wide as the
 * tab, here 99 columns. A command line that fits takes 1 plain row. A wider line wraps at the box width, inside a
 * word, and then each command row starts with the gutter ` │ `, so the first row of a wrap ends at the box width.
 * Every screen here is synthetic. A match joins the rows of 1 wrapped line only when each row before the last fills
 * the box, and compares the joined text with the confirmed line for equality: any other shape gives a refusal.
 */
import { describe, expect, it } from 'vitest'
import { cleanText, cleanValue } from '../sanitize.js'
import { matchPermission, readScreen } from './screen-match.js'

const W = 99
const DASHED = '╌'.repeat(W)
const GUTTER = ' │ '
const DESCRIPTION = 'Create empty gx.txt file in /tmp'
const TIP = `Tip: auto mode handles these prompts for you ${String.fromCharCode(0x2014)} choose "switch to auto mode" below`
const CHANGED = { isMatch: false, refusal: 'screen-changed' }
const YES = { isMatch: true, digit: 1 }

type Shape = { description?: string | null; close?: string | null; after?: readonly string[] }

/** The screen of a 2.1.296 Bash dialog with the rows of `box` between the 2 dashed rules, as the live check saw it. */
function boxScreen(box: readonly string[], shape: Shape = {}): string {
  const { description = DESCRIPTION, close = DASHED, after = [] } = shape
  return [
    '❯ Make the probe file.',
    '',
    '⏺ Bash(touch /tmp/gx.txt)',
    '',
    '─'.repeat(W),
    ' Bash command',
    ` ${TIP}`,
    ...(description === null ? [] : [` ${description}`]),
    DASHED,
    ...box,
    ...(close === null ? [] : [close]),
    ...after,
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to /tmp from this project',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n')
}

/** The gutter rows of 1 command line that wraps at the box width: each row but the last holds W - 3 characters. */
function wrapped(line: string): string[] {
  const rows: string[] = []
  for (let at = 0; at < line.length; at += W - GUTTER.length) rows.push(`${GUTTER}${line.slice(at, at + W - GUTTER.length)}`)
  return rows
}

/** The confirmed Bash request: its command and its description. */
const bash = (command: string, choice: 'yes' | 'no' = 'yes', description = DESCRIPTION) => ({ tool: 'Bash', input: JSON.stringify({ command, description }), choice })
const match = (box: readonly string[], command: string, shape?: Shape) => matchPermission(readScreen(boxScreen(box, shape)), bash(command))

/** the wrap of the live check, cut to fit 99 columns: row 1 is the gutter and 96 characters, and the break falls inside a word */
const ROW_1 = ` │ touch /private/tmp/scratch-0123456789abcdef/${'a'.repeat(50)}/s`
const ROW_2 = ' │ cratchpad/god-live/plain/yes.txt'
const LONG = `touch /private/tmp/scratch-0123456789abcdef/${'a'.repeat(50)}/scratchpad/god-live/plain/yes.txt`
/** a command line of 202 characters: 3 rows, 96 + 96 + 10 */
const LONGER = `touch /private/tmp/scratch-0123456789abcdef/${'b'.repeat(150)}/yes.txt`

describe('matchPermission: the command box of 2.1.296', () => {
  it('matches a short command on 1 plain row, for Yes and for No', () => {
    expect(match([' touch /tmp/gx.txt'], 'touch /tmp/gx.txt')).toEqual(YES)
    expect(matchPermission(readScreen(boxScreen([' touch /tmp/gx.txt'])), bash('touch /tmp/gx.txt', 'no'))).toEqual({ isMatch: true, digit: 4 })
  })

  it('joins a command line that wraps over 2 rows, when row 1 fills the box', () => {
    expect([...ROW_1].length).toBe(W)
    expect(wrapped(LONG)).toEqual([ROW_1, ROW_2])
    expect(match([ROW_1, ROW_2], LONG)).toEqual(YES)
  })

  it('joins a command line that wraps over 3 rows, when rows 1 and 2 fill the box', () => {
    expect(wrapped(LONGER).map((row) => [...row].length)).toEqual([W, W, 13])
    expect(match(wrapped(LONGER), LONGER)).toEqual(YES)
  })

  it('matches a command of more lines: 1 plain row each, or gutter rows when 1 line wraps', () => {
    expect(match([' cd /tmp', ' touch gx.txt'], 'cd /tmp\ntouch gx.txt')).toEqual(YES)
    expect(match([...wrapped(LONG), ' │ ls /tmp'], `${LONG}\nls /tmp`)).toEqual(YES)
    expect(match([' │ ls /tmp', ...wrapped(LONGER)], `ls /tmp\n${LONGER}`)).toEqual(YES)
  })

  it('keeps the old form with no box', () => {
    const old = boxScreen([' touch /tmp/gx.txt']).replace(`${DASHED}\n`, '').replace(`${DASHED}\n`, '')
    expect(matchPermission(readScreen(old), bash('touch /tmp/gx.txt'))).toEqual(YES)
  })
})

describe('matchPermission: each box shape that refuses', () => {
  it('refuses a row before the last that is 1 cell short of the box, or 1 cell wider', () => {
    expect(match([ROW_1.slice(0, -1), ` │ s${ROW_2.slice(GUTTER.length)}`], LONG)).toEqual(CHANGED)
    expect(match([`${ROW_1}s`, ` │ ${ROW_2.slice(GUTTER.length + 1)}`], LONG)).toEqual(CHANGED)
    const [first = '', second = '', third = ''] = wrapped(LONGER)
    expect(match([first, second.slice(0, -1), ` │ ${second.at(-1) ?? ''}${third.slice(GUTTER.length)}`], LONGER)).toEqual(CHANGED)
  })

  it('refuses an extra row in the box, with or without the gutter', () => {
    expect(match([ROW_1, ROW_2, ' │ rm -rf build'], LONG)).toEqual(CHANGED)
    expect(match([' touch /tmp/gx.txt', ' rm -rf build'], 'touch /tmp/gx.txt')).toEqual(CHANGED)
  })

  it('refuses a box with no closing rule, a closing rule of another width, and a third rule', () => {
    expect(match([ROW_1, ROW_2], LONG, { close: null })).toEqual(CHANGED)
    expect(match([' touch /tmp/gx.txt'], 'touch /tmp/gx.txt', { close: null })).toEqual(CHANGED)
    expect(match([ROW_1, ROW_2], LONG, { close: '╌'.repeat(W - 1) })).toEqual(CHANGED)
    expect(match([' touch /tmp/gx.txt', DASHED, ' rm -rf build'], 'touch /tmp/gx.txt')).toEqual(CHANGED)
  })

  it('refuses a cut command: a missing last row, a last row cut short, and a screen with fewer lines', () => {
    expect(match([ROW_1], LONG)).toEqual(CHANGED)
    expect(match([ROW_1, ' │ cratchpad/god-live/plain/ye…'], LONG)).toEqual(CHANGED)
    expect(match(wrapped(LONG), `${LONG}\nls /tmp`)).toEqual(CHANGED)
  })

  it('refuses a command that only starts the same, on either side', () => {
    expect(match([ROW_1, `${ROW_2}.bak`], LONG)).toEqual(CHANGED)
    expect(match([ROW_1, ROW_2], `${LONG}.bak`)).toEqual(CHANGED)
    expect(match([ROW_1, ROW_2], ROW_1.slice(GUTTER.length))).toEqual(CHANGED)
    expect(match([' touch /tmp/gx.txt'], 'touch /tmp/gx')).toEqual(CHANGED)
  })

  it('refuses a gutter row in a box that does not wrap, and a plain row in a box that wraps', () => {
    expect(match([' │ touch /tmp/gx.txt'], 'touch /tmp/gx.txt')).toEqual(CHANGED)
    expect(match([...wrapped(LONG), ' ls /tmp'], `${LONG}\nls /tmp`)).toEqual(CHANGED)
    expect(match([...wrapped(LONG), ' rm -rf build'], LONG)).toEqual(CHANGED)
  })

  it('refuses 2 lines that the screen shows as 1 wrapped line, and 1 line that the screen shows as 2', () => {
    expect(match([ROW_1, ROW_2], `${ROW_1.slice(GUTTER.length)}\n${ROW_2.slice(GUTTER.length)}`)).toEqual(CHANGED)
    expect(match([' touch /private', ' /tmp/gx.txt'], 'touch /private /tmp/gx.txt')).toEqual(CHANGED)
  })

  it('refuses a row between the closing rule and the question, a description in the box, and a command over the box', () => {
    expect(match([' touch /tmp/gx.txt'], 'touch /tmp/gx.txt', { after: [' Permission rule Bash asks for this command.'] })).toEqual(CHANGED)
    expect(match([` ${DESCRIPTION}`, ' touch /tmp/gx.txt'], 'touch /tmp/gx.txt', { description: null })).toEqual(CHANGED)
    expect(match([], 'touch /tmp/gx.txt', { description: `${DESCRIPTION}\n touch /tmp/gx.txt` })).toEqual(CHANGED)
  })
})

const HOME = '/tmp/god-home'
const clean = (text: string): string => cleanText(text, HOME)
/** `n` characters in runs of 4 letters, so no rule of the redaction takes them for a secret or a blob */
const filler = (n: number): string => 'word-'.repeat(Math.ceil(n / 5)).slice(0, n)
/** The confirmed Bash request as the transcript source gives it: each value through the text cleaner of the home folder. */
const cleanedBash = (command: string) => ({ tool: 'Bash', input: JSON.stringify(cleanValue({ command, description: DESCRIPTION }, clean)), choice: 'yes' as const })
/** The deliver path: the view of the cleaned screen, the cleaned input, and the raw side: the same read, the raw command and the cleaner. */
const withRaw = (command: string, screen = boxScreen(wrapped(command)), raw = screen) => matchPermission(readScreen(clean(screen)), cleanedBash(command), { text: raw, command, clean })
/** a wrapped command with the home folder whole on row 1 */
const AT_HOME = `touch ${HOME}/${filler(90)}/yes.txt`

describe('matchPermission: the box measured on the raw text of the same read', () => {
  it('matches a home folder that a row before the last holds whole, or that the wrap splits, over 2 and 3 rows', () => {
    expect(withRaw(AT_HOME)).toEqual(YES)
    expect(withRaw(`touch ${filler(85)}${HOME}/yes.txt`)).toEqual(YES)
    expect(wrapped(`cp ${HOME}/${filler(100)} ${HOME}/${filler(100)}`)).toHaveLength(3)
    expect(withRaw(`cp ${HOME}/${filler(100)} ${HOME}/${filler(100)}`)).toEqual(YES)
  })

  it('matches a run that the redaction masks as a blob, a short command and a command of more lines', () => {
    expect(withRaw(LONG)).toEqual(YES)
    expect(withRaw(`touch ${HOME}/gx.txt`, boxScreen([` touch ${HOME}/gx.txt`]))).toEqual(YES)
    expect(withRaw(`${AT_HOME}\nls ${HOME}`, boxScreen([...wrapped(AT_HOME), ` │ ls ${HOME}`]))).toEqual(YES)
  })

  it('still refuses a raw row before the last that does not fill the box, an extra row and a cut command', () => {
    const [first = '', second = ''] = wrapped(AT_HOME)
    expect(withRaw(AT_HOME, boxScreen([first.slice(0, -1), `${GUTTER}${first.at(-1) ?? ''}${second.slice(GUTTER.length)}`]))).toEqual(CHANGED)
    expect(withRaw(AT_HOME, boxScreen([first, second, ' │ rm -rf build']))).toEqual(CHANGED)
    expect(withRaw(AT_HOME, boxScreen([first]))).toEqual(CHANGED)
    expect(withRaw(`${AT_HOME}.bak`, boxScreen([first, second]))).toEqual(CHANGED)
  })

  it('refuses a raw text that does not line up with the cleaned screen, and a raw text that shows another command', () => {
    const screen = boxScreen(wrapped(AT_HOME))
    expect(withRaw(AT_HOME, screen, `❯ one more row\n${screen}`)).toEqual(CHANGED)
    expect(withRaw(AT_HOME, screen, screen.replace(' Do you want to proceed?', ' Do you want to make this edit?'))).toEqual(CHANGED)
    expect(withRaw(AT_HOME, screen, screen.replace(`${DASHED}\n Do you`, `${'╌'.repeat(W - 1)}\n Do you`))).toEqual(CHANGED)
    expect(withRaw(AT_HOME, boxScreen(wrapped(AT_HOME)), boxScreen(wrapped(AT_HOME.replace('yes.txt', 'no.txt'))))).toEqual(CHANGED)
  })
})

describe('matchPermission: the shapes that a crafted command can use', () => {
  it('refuses a command with its own dashed row, of the box width or shorter: the box then has 3 rules', () => {
    const rule = '╌'.repeat(W - 1)
    expect(withRaw(`echo a\n${rule}`, boxScreen([' echo a', ` ${rule}`]))).toEqual(CHANGED)
    expect(withRaw('echo a\n╌╌╌\necho b', boxScreen([' echo a', ' ╌╌╌', ' echo b']))).toEqual(CHANGED)
    expect(match([' echo a', ` ${rule}`], `echo a\n${rule}`)).toEqual(CHANGED)
  })

  it('compares the lines of a command that start with │ as drawn: a short one matches whole, one that fills the box never does', () => {
    expect(withRaw('│ ls /tmp', boxScreen([' │ ls /tmp']))).toEqual(YES)
    const drawn = [` │ ${'x'.repeat(W - 3)}`, ' │ yy']
    expect([...(drawn[0] ?? '')].length).toBe(W)
    expect(withRaw(`│ ${'x'.repeat(W - 3)}\n│ yy`, boxScreen(drawn))).toEqual(CHANGED)
    // the same rows are the wrap of 1 line, so the match alone cannot tell the 2 commands apart: the plan binds the
    // answer to the 1 open call, and the deliver tests refuse this screen for the shorter command
    expect(withRaw(`${'x'.repeat(W - 3)}yy`, boxScreen(drawn))).toEqual(YES)
  })

  it('reads lines like the tip, the description or the question inside the box as command lines', () => {
    const command = `${TIP}\n${DESCRIPTION}\nDo you want to proceed?\ntouch /tmp/gx.txt`
    const box = command.split('\n').map((line) => ` ${line}`)
    expect(withRaw(command, boxScreen(box))).toEqual(YES)
    expect(withRaw('touch /tmp/gx.txt', boxScreen(box))).toEqual(CHANGED)
    expect(withRaw('touch /tmp/gx.txt', boxScreen([` ${DESCRIPTION}`, ' touch /tmp/gx.txt']))).toEqual(CHANGED)
    expect(withRaw('touch /tmp/gx.txt', boxScreen([' touch /tmp/gx.txt'], { description: `${DESCRIPTION}\n${DASHED}\n touch /tmp/gx.txt` }))).toEqual(CHANGED)
  })

  it('binds to the live dialog right above the options: an old dialog above refuses, and a quoted box above its rule does not count', () => {
    const live = boxScreen([' touch /tmp/gx.txt'])
    expect(withRaw('touch /tmp/gx.txt', `${boxScreen([' rm -rf /tmp/old'])}\n${live}`)).toEqual(CHANGED)
    const quote = (command: string): string => ['⏺ The last dialog was:', DASHED, ` ${command}`, DASHED, ''].join('\n')
    expect(withRaw('touch /tmp/gx.txt', `${quote('touch /tmp/gx.txt')}\n${boxScreen([' rm -rf /tmp/old'])}`)).toEqual(CHANGED)
    expect(withRaw('touch /tmp/gx.txt', `${quote('rm -rf /tmp/old')}\n${live}`)).toEqual(YES)
  })

  it('compares the raw lines with the raw command, so 2 commands that clean to the same text do not pass', () => {
    const key = (c: string): string => `export ANTHROPIC_API_KEY=sk-ant-api03-${c.repeat(24)}`
    expect(clean(key('A'))).toBe(clean(key('B')))
    expect(withRaw(key('A'), boxScreen([` ${key('A')}`]))).toEqual(YES)
    expect(withRaw(key('A'), boxScreen([` ${key('B')}`]))).toEqual(CHANGED)
    const long = (c: string): string => `${key(c)} && ${filler(80)}`
    expect(withRaw(long('A'))).toEqual(YES)
    expect(withRaw(long('A'), boxScreen(wrapped(long('B'))))).toEqual(CHANGED)
    // with no raw side the cleaned rows cannot tell them apart, so the plan refuses a permission with no raw side
    expect(matchPermission(readScreen(clean(boxScreen([` ${key('B')}`]))), cleanedBash(key('A')))).toEqual(YES)
  })

  it('refuses a ~ that the screen shows as the home folder, and another run that the redaction masks as the same blob', () => {
    expect(clean('ls ~/notes')).toBe(clean(`ls ${HOME}/notes`))
    expect(withRaw('ls ~/notes', boxScreen([` ls ${HOME}/notes`]))).toEqual(CHANGED)
    expect(withRaw(`touch ~/${filler(100)}`, boxScreen(wrapped(`touch ${HOME}/${filler(100)}`)))).toEqual(CHANGED)
    const blob = (c: string): string => `cat /tmp/${c.repeat(70)}`
    expect(clean(blob('A'))).toBe(clean(blob('B')))
    expect(withRaw(blob('A'), boxScreen([` ${blob('B')}`]))).toEqual(CHANGED)
  })

  it('compares the raw command in the form with no box too: 2 commands that clean to the same text do not pass', () => {
    const old = (command: string): string => boxScreen([` ${command}`]).replace(`${DASHED}\n`, '').replace(`${DASHED}\n`, '')
    const key = (c: string): string => `export ANTHROPIC_API_KEY=sk-ant-api03-${c.repeat(24)}`
    expect(withRaw(key('A'), old(key('A')))).toEqual(YES)
    expect(withRaw(key('A'), old(key('B')))).toEqual(CHANGED)
    expect(withRaw('ls ~/notes', old(`ls ${HOME}/notes`))).toEqual(CHANGED)
    expect(withRaw(`ls ${HOME}/notes`, old(`ls ${HOME}/notes`))).toEqual(YES)
  })
})

describe('matchPermission: with no raw text, the box measured on the cleaned rows', () => {
  /** The screen and the input, each through the text cleaner of the home folder, and no raw text. */
  const cleaned = (command: string) => matchPermission(readScreen(clean(boxScreen(wrapped(command)))), cleanedBash(command))

  it('matches when the cleaner changes only the last row of the wrap: like with like', () => {
    expect(wrapped(`touch ${filler(90)} ${HOME}/yes.txt`)[1]).toBe(`${GUTTER} ${HOME}/yes.txt`)
    expect(cleaned(`touch ${filler(90)} ${HOME}/yes.txt`)).toEqual(YES)
  })

  it('refuses a home folder that a row before the last holds whole, so the row no longer fills the box', () => {
    expect(cleaned(`touch ${HOME}/${filler(90)}/yes.txt`)).toEqual(CHANGED)
  })

  it('refuses a home folder that the wrap splits: the screen keeps it raw, and the input shows ~', () => {
    expect(wrapped(`touch ${filler(85)}${HOME}/yes.txt`)[1]).toBe(`${GUTTER}god-home/yes.txt`)
    expect(cleaned(`touch ${filler(85)}${HOME}/yes.txt`)).toEqual(CHANGED)
  })

  it('refuses a run of 60 or more letters, digits and slashes in a row before the last: the redaction masks it as a blob', () => {
    expect(clean(LONG)).not.toBe(LONG)
    expect(cleaned(LONG)).toEqual(CHANGED)
  })
})
