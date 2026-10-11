// The key path on the Bash dialog of Claude Code 2.1.296, over the fake machine of act-machine.ts. The dialog draws the
// command between 2 dashed rules (U+254C) as wide as the tab, here 99 columns: a command that fits takes 1 plain row,
// and a wider command wraps with the gutter ` │ ` on each row, a full row 1 cell narrower than the rule, as the live
// check saw it. 1 then y reads the screen again and
// sends exactly 1 send of the digit 1, which answers the dialog. A home folder on row 1 of a wrap shows as ~ in the
// pane, and the match measures the raw row of the same read. With 2 open Bash calls the dialog can be for either one,
// so y sends no key. Every screen and every command is synthetic.
import { expect, test } from 'claude-code/testing'
import { HOME, SURFACES, bash, prompt, toolResult } from './fake-host'
import { SF, WS, begin, cmuxSince, detailText, has, lines, press, readScreen, select, sendText } from './act-machine'

const W = 99
const DASHED = '╌'.repeat(W)
const GUTTER = ' │ '
/** a full row of a wrap: the gutter and 95 characters, 98 cells, 1 less than the rule */
const FULL = W - 1
const CHUNK = FULL - GUTTER.length
/** a command of 119 characters: row 1 takes 95 of them after the gutter and is full, row 2 takes 24 */
const LONG = `touch /tmp/god-test/plain/${'word-'.repeat(16)}probe/yes.txt`

/** The screen of a 2.1.296 Bash dialog with the rows of `box` between the 2 dashed rules. */
function boxScreen(command: string, box: readonly string[]): string {
  return [
    '❯ Make the probe file.',
    '',
    `⏺ Bash(${command.slice(0, 40)})`,
    '',
    '─'.repeat(W),
    ' Bash command',
    ` Tip: auto mode handles these prompts for you ${String.fromCharCode(0x2014)} choose "switch to auto mode" below`,
    ' Make an empty probe file',
    DASHED,
    ...box,
    DASHED,
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to probe/ from this project',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n')
}

for (const surface of SURFACES) {
  test(`${surface}: 1 then y on a Bash dialog with the command in a dashed box records read-screen and then exactly 1 send -- 1`, async ($, on) => {
    const { machine, calls, ui } = await begin($, on, surface)
    machine.cmux!.screens![SF.perm] = boxScreen('touch probe-yes.txt', [' touch probe-yes.txt'])
    await select($, 'ses-perm')
    expect((await ui.find({ key: 'permission:yes' }))?.props['hotkey']).toBe('1')
    await press(ui, 'permission:yes')
    expect(await lines(ui)).toContain(' Send "Yes" to the Bash request of perm-p?  y: send  c: cancel')
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY)).toEqual([readScreen(WS.perm, SF.perm), sendText(WS.perm, SF.perm, '1')])
    expect(machine.cmux!.answered).toEqual({ [SF.perm]: ['1'] })
  })

  test(`${surface}: 1 then y on a boxed Bash dialog whose command wraps over 2 gutter rows sends exactly 1 send -- 1`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    // the session asks to run a longer command: the next refresh reads the new call
    const perm = machine.sessions[2]!
    perm.transcript = [prompt('Make the probe file.', Date.now() - 90_000), bash('toolu_b2', LONG, 'Make an empty probe file', Date.now() - 1000)]
    perm.transcriptMtimeMs = Date.now()
    perm.fileMtimeMs += 1000
    const rows = [`${GUTTER}${LONG.slice(0, CHUNK)}`, `${GUTTER}${LONG.slice(CHUNK)}`]
    expect(rows.map((row) => [...row].length)).toEqual([FULL, 27])
    machine.cmux!.screens![SF.perm] = boxScreen(LONG, rows)
    await clock.advance(2000)
    await select($, 'ses-perm')
    await press(ui, 'permission:yes')
    const bar = await lines(ui)
    expect(bar).toContain(' Send "Yes" to the Bash request of perm-p?  y: send  c: cancel')
    // the bar holds the new call, so the y below checks the screen against the long command
    expect(detailText(bar), bar.join('\n')).toContain('word-probe/yes.txt')
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY)).toEqual([readScreen(WS.perm, SF.perm), sendText(WS.perm, SF.perm, '1')])
    expect(machine.cmux!.answered).toEqual({ [SF.perm]: ['1'] })
  })

  test(`${surface}: 1 then y on a boxed Bash dialog whose command holds the home folder on row 1 of its wrap sends exactly 1 send -- 1`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    // the pane shows the home folder as ~, which makes row 1 narrower than the box: the match measures the raw row
    const command = `touch ${HOME}/${'word-'.repeat(18)}/yes.txt`
    const perm = machine.sessions[2]!
    perm.transcript = [prompt('Make the probe file.', Date.now() - 90_000), bash('toolu_b3', command, 'Make an empty probe file', Date.now() - 1000)]
    perm.transcriptMtimeMs = Date.now()
    perm.fileMtimeMs += 1000
    const rows = [`${GUTTER}${command.slice(0, CHUNK)}`, `${GUTTER}${command.slice(CHUNK)}`]
    expect(rows[0]).toContain(`${HOME}/`)
    expect([...rows[0]!].length).toBe(FULL)
    machine.cmux!.screens![SF.perm] = boxScreen(command, rows)
    await clock.advance(2000)
    await select($, 'ses-perm')
    await press(ui, 'permission:yes')
    const bar = await lines(ui)
    expect(detailText(bar), bar.join('\n')).toContain('touch ~/word-')
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY)).toEqual([readScreen(WS.perm, SF.perm), sendText(WS.perm, SF.perm, '1')])
    expect(machine.cmux!.answered).toEqual({ [SF.perm]: ['1'] })
  })

  test(`${surface}: 1 then y while 2 Bash calls of the session wait sends no key, even when the screen shows the confirmed command`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    // a second call with no result: the dialog on the screen can be for either one
    const perm = machine.sessions[2]!
    perm.transcript = [...perm.transcript!, bash('toolu_b4', 'rm -rf build', 'Clean the build', Date.now() - 500)]
    perm.transcriptMtimeMs = Date.now()
    perm.fileMtimeMs += 1000
    machine.cmux!.screens![SF.perm] = boxScreen('rm -rf build', [' rm -rf build']).replace(' Make an empty probe file', ' Clean the build')
    await clock.advance(2000)
    await select($, 'ses-perm')
    await press(ui, 'permission:yes')
    expect(has(await lines(ui), 'rm -rf build')).toBe(true)
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY).filter((argv) => argv[1] === 'send' || argv[1] === 'send-key')).toEqual([])
    expect(machine.cmux!.answered ?? {}).toEqual({})
  })

  test(`${surface}: y after the confirmed call closed and a new call with the same cleaned input opened sends no key`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    const curl = (n: string): string => `curl -H "Authorization: Bearer ghp_FAKE${n}${'a'.repeat(30)}" https://example.com/x`
    const perm = machine.sessions[2]!
    perm.transcript = [prompt('Fetch the page.', Date.now() - 90_000), bash('toolu_A', curl('1'), 'Fetch the page', Date.now() - 2000)]
    perm.transcriptMtimeMs = Date.now()
    perm.fileMtimeMs += 1000
    machine.cmux!.screens![SF.perm] = boxScreen(curl('1'), [` ${curl('1')}`]).replace(' Make an empty probe file', ' Fetch the page')
    await clock.advance(2000)
    await select($, 'ses-perm')
    await press(ui, 'permission:yes')
    expect(await lines(ui)).toContain(' Send "Yes" to the Bash request of perm-p?  y: send  c: cancel')
    // before y, call A closes and call B opens: B cleans to the same text as A, and the screen shows B
    perm.transcript = [...perm.transcript, toolResult('toolu_A', 'done', Date.now() - 1000), bash('toolu_B', curl('2'), 'Fetch the page', Date.now() - 500)]
    perm.transcriptMtimeMs = Date.now()
    perm.fileMtimeMs += 1000
    machine.cmux!.screens![SF.perm] = boxScreen(curl('2'), [` ${curl('2')}`]).replace(' Make an empty probe file', ' Fetch the page')
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY).filter((argv) => argv[1] === 'send' || argv[1] === 'send-key')).toEqual([])
    expect(machine.cmux!.answered ?? {}).toEqual({})
  })

  test(`${surface}: 1 then y on a dialog with no box that shows the home folder where the call wrote ~ sends no key, though both clean to the same text`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    const perm = machine.sessions[2]!
    perm.transcript = [prompt('Make the probe file.', Date.now() - 90_000), bash('toolu_b5', 'ls ~/notes', 'List the notes', Date.now() - 1000)]
    perm.transcriptMtimeMs = Date.now()
    perm.fileMtimeMs += 1000
    // the dialog of Claude Code 2.1.295, with no box: the raw command differs, and the cleaner gives ~ for both
    machine.cmux!.screens![SF.perm] = ['❯ List the notes.', '', '─'.repeat(72), ' Bash command', '', ' List the notes', '', `   ls ${HOME}/notes`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
    await clock.advance(2000)
    await select($, 'ses-perm')
    await press(ui, 'permission:yes')
    expect(has(await lines(ui), 'ls ~/notes')).toBe(true)
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY).filter((argv) => argv[1] === 'send' || argv[1] === 'send-key')).toEqual([])
    expect(machine.cmux!.answered ?? {}).toEqual({})
  })
}
