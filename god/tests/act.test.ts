// The key path of the god pane on the terminal and the desktop surfaces, over the fake machine of act-machine.ts: a
// digit and the Yes or No of a Bash request open the confirm bar, and only y sends. Each y reads the registry file, the
// transcript tail and the screen of the target again, then sends only the keys of the plan: a digit alone. A screen or
// a state that changed gets no key, and the Screen tab shows the fresh screen under the refusal line. An old read keeps
// the bar open for y again. 1 y runs at a time. The next refreshes check that the keys reached the session.
import { expect, test } from 'claude-code/testing'
import { HOME, SURFACES, toolResult } from './fake-host'
import { PROMPT_SCREEN, QUESTION_SCREEN, SF, WS, begin, cmuxSince, has, keysSince, lines, press, readScreen, select, sendKey } from './act-machine'

for (const surface of SURFACES) {
  test(`${surface}: 1 then y records read-screen and then exactly 1 send-key -- 1, with the refs of the mapped tab`, async ($, on) => {
    const { calls, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    expect(await ui.find({ key: 'key:y' })).toBeUndefined()
    const option = await ui.find({ key: 'option:1' })
    expect(option?.props['hotkey']).toBe('1')
    const before = calls.runs.length
    await press(ui, 'option:1')
    const bar = await lines(ui)
    expect(bar).toContain(' Send "1 Red" to ask-a?  y: send  c: cancel')
    expect(cmuxSince(calls, before)).toEqual([])
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY)).toEqual([readScreen(WS.ask, SF.ask), sendKey(WS.ask, SF.ask, '1')])
    for (const run of calls.runs.slice(atY).filter((one) => one.argv[0] === 'cmux')) expect(run.init).toEqual({ timeoutMs: 5000 })
    const after = await lines(ui)
    expect(has(after, 'y: send')).toBe(false)
    expect(after).toContain(' Sent to ask-a. The next refresh checks it.')
  })
  test(`${surface}: 2 presses of y at once send the digit once`, async ($, on) => {
    const { calls, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    await ui.redraw()
    const atY = calls.runs.length
    await Promise.all([ui.press({ key: 'key:y' }), ui.press({ key: 'key:y' })])
    expect(keysSince(calls, atY)).toEqual([sendKey(WS.ask, SF.ask, '1')])
    expect(cmuxSince(calls, atY).filter((argv) => argv[1] === 'read-screen')).toHaveLength(1)
  })
  test(`${surface}: c closes the bar and records no argv`, async ($, on) => {
    const { calls, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    const before = calls.runs.length
    await press(ui, 'option:2')
    expect(await lines(ui)).toContain(' Send "2 Green" to ask-a?  y: send  c: cancel')
    await press(ui, 'key:c')
    expect(has(await lines(ui), 'Send "2 Green"')).toBe(false)
    expect(await ui.find({ key: 'key:y' })).toBeUndefined()
    expect(cmuxSince(calls, before)).toEqual([])
  })
  test(`${surface}: a screen that changed after the bar opened gets no send or send-key, and the Screen tab shows the fresh screen under the refusal line`, async ($, on) => {
    const { machine, calls, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    machine.cmux!.screens![SF.ask] = PROMPT_SCREEN
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(keysSince(calls, atY)).toEqual([])
    expect(cmuxSince(calls, atY)[0]).toEqual(readScreen(WS.ask, SF.ask))
    const shown = await lines(ui)
    expect(has(shown, '[Screen]'), shown.join('\n')).toBe(true)
    expect(shown.some((line) => line.endsWith('│ The screen or the session changed, so the pane sent nothing.')), shown.join('\n')).toBe(true)
    expect(shown.some((line) => line.endsWith('│ ⏺ The build is done.'))).toBe(true)
    expect(has(shown, 'y: send')).toBe(false)
  })
  test(`${surface}: each y reads the screen again, and never uses the read of the Screen tab`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'tab:screen')
    await lines(ui)
    await clock.settle()
    const tab = await lines(ui)
    expect(tab.some((line) => line.endsWith('│ ❯ 1. Red')), tab.join('\n')).toBe(true)
    // the Screen tab read a screen that matches, and then the dialog closes before y
    machine.cmux!.screens![SF.ask] = PROMPT_SCREEN
    await press(ui, 'tab:now')
    await press(ui, 'option:1')
    let atY = calls.runs.length
    await press(ui, 'key:y')
    // the y read the screen first and sent nothing; the Screen tab that the refusal opens reads on its own after it
    expect(cmuxSince(calls, atY)[0]).toEqual(readScreen(WS.ask, SF.ask))
    expect(keysSince(calls, atY)).toEqual([])
    // the dialog shows again: a second y reads it again and sends the digit
    machine.cmux!.screens![SF.ask] = QUESTION_SCREEN
    await press(ui, 'tab:now')
    await press(ui, 'option:1')
    atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY).slice(-2)).toEqual([readScreen(WS.ask, SF.ask), sendKey(WS.ask, SF.ask, '1')])
  })
  test(`${surface}: y reads the registry file and the transcript again, so a question that closed since the last tick gets no key`, async ($, on) => {
    const { machine, calls, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    // the session answered the question in its own tab, and no tick ran since: the board still shows it open
    const wait = machine.sessions[0]!
    wait.status = 'idle'
    delete wait.waitingFor
    wait.fileMtimeMs += 1000
    wait.transcript = [...wait.transcript!, toolResult('toolu_q1', 'Red', Date.now())]
    wait.transcriptMtimeMs = Date.now()
    const files = calls.files.length
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(calls.files.slice(files)).toContain(`read ${HOME}/.claude/sessions/46001.json`)
    expect(calls.runs.slice(atY).some((run) => run.argv[0] === 'tail')).toBe(true)
    expect(keysSince(calls, atY)).toEqual([])
    expect((await lines(ui)).some((line) => line.endsWith('│ The screen or the session changed, so the pane sent nothing.'))).toBe(true)
  })
  test(`${surface}: after an old read the bar stays open, and y reads again and sends`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    // cmux answers the screen read 1.5 s late, so the facts read before it are too old for the plan
    machine.cmux!.delay = (verb) => (verb === 'read-screen' ? clock.sleep(1500) : undefined)
    const atY = calls.runs.length
    const pressing = press(ui, 'key:y')
    await clock.settle()
    await clock.advance(1500)
    await pressing
    delete machine.cmux!.delay
    expect(keysSince(calls, atY)).toEqual([])
    const stale = await lines(ui)
    expect(stale, stale.join('\n')).toContain(' The screen or the session facts are too old, so the pane sent nothing. Press y again.')
    expect(stale).toContain(' Send "1 Red" to ask-a?  y: send  c: cancel')
    const again = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, again).slice(-2)).toEqual([readScreen(WS.ask, SF.ask), sendKey(WS.ask, SF.ask, '1')])
  })
  test(`${surface}: a Bash request gets Yes and No digit Buttons, and No sends the digit of the exact No on the screen`, async ($, on) => {
    const { calls, ui } = await begin($, on, surface)
    await select($, 'ses-perm')
    const shown = await lines(ui)
    expect(shown.some((line) => line.endsWith('│ 1: Yes')), shown.join('\n')).toBe(true)
    expect(shown.some((line) => line.endsWith('│ 2: No'))).toBe(true)
    expect((await ui.find({ key: 'permission:yes' }))?.props['hotkey']).toBe('1')
    expect((await ui.find({ key: 'permission:no' }))?.props['hotkey']).toBe('2')
    await press(ui, 'permission:no')
    const bar = await lines(ui)
    expect(bar).toContain(' Send "No" to the Bash request of perm-p?  y: send  c: cancel')
    expect(has(bar, '{"command":"touch probe-yes.txt","description":"Make an empty probe file"}')).toBe(true)
    let atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY)).toEqual([readScreen(WS.perm, SF.perm), sendKey(WS.perm, SF.perm, '4')])
    await press(ui, 'permission:yes')
    atY = calls.runs.length
    await press(ui, 'key:y')
    expect(keysSince(calls, atY)).toEqual([sendKey(WS.perm, SF.perm, '1')])
  })
  test(`${surface}: a request of any other tool gets no digit, only the line that says to answer it in its tab`, async ($, on) => {
    const { ui } = await begin($, on, surface)
    await select($, 'ses-edit')
    const shown = (await lines(ui)).join(' ').replace(/\s*│\s*/g, ' ').replace(/\s+/g, ' ')
    expect(shown).toContain('The pane answers only a Bash request with Yes or No. Press j to answer this request in its tab.')
    expect(await ui.find({ key: 'permission:yes' })).toBeUndefined()
    expect(await ui.find({ key: 'permission:no' })).toBeUndefined()
  })
  test(`${surface}: an answer that the next refreshes do not see says Not delivered`, async ($, on) => {
    const { calls, clock, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    await press(ui, 'key:y')
    expect(keysSince(calls, 0)).toEqual([sendKey(WS.ask, SF.ask, '1')])
    await clock.advance(2000)
    expect(await lines(ui)).not.toContain(' Not delivered. Check the Screen tab.')
    for (let tick = 0; tick < 3; tick += 1) await clock.advance(2000)
    expect(await lines(ui)).toContain(' Not delivered. Check the Screen tab.')
  })
  test(`${surface}: an answer that closes the question says Delivered on the next refresh`, async ($, on) => {
    const { machine, clock, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    await press(ui, 'key:y')
    const wait = machine.sessions[0]!
    wait.status = 'idle'
    delete wait.waitingFor
    wait.fileMtimeMs += 1000
    wait.transcript = [...wait.transcript!, toolResult('toolu_q1', 'Red', Date.now())]
    wait.transcriptMtimeMs = Date.now()
    await clock.advance(2000)
    expect(await lines(ui)).toContain(' Delivered to ask-a.')
  })
}
