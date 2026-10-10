// The drafts of the key path on the terminal and the desktop surfaces, over the fake machine of act-machine.ts: r and
// m open a draft whose text field takes 1 line for each Enter, and an empty line opens the confirm bar with the whole
// text. Only y sends: a prompt as each line with shift+enter between the lines and enter at the end, a peer message
// through the engine with no cmux call. The bar names the mode that a prompt opens with its first character.
import { expect, test } from 'claude-code/testing'
import { SURFACES, prompt } from './fake-host'
import { KEY_VERBS, SF, WS, begin, cmuxSince, has, lines, press, readScreen, select, sendKey, sendText, typeDraft } from './act-machine'

for (const surface of SURFACES) {
  test(`${surface}: a 2-line prompt from r records read-screen and then the 4 argv in order, and the next refresh sees it as a human prompt`, async ($, on) => {
    const { machine, calls, clock, ui } = await begin($, on, surface)
    await select($, 'ses-idle')
    await press(ui, 'key:r')
    expect(await lines(ui)).toContain(' Write the prompt for idle-p. It has 0 lines.  c: cancel')
    const before = calls.runs.length
    await typeDraft(ui, ['Run the tests.', 'Then fix the lint.'])
    const bar = await lines(ui)
    for (const line of [' Send this prompt to idle-p?  y: send  c: cancel', '   Run the tests.', '   Then fix the lint.']) expect(bar, bar.join('\n')).toContain(line)
    expect(cmuxSince(calls, before)).toEqual([])
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(cmuxSince(calls, atY)).toEqual([
      readScreen(WS.idle, SF.idle),
      sendText(WS.idle, SF.idle, 'Run the tests.'),
      sendKey(WS.idle, SF.idle, 'shift+enter'),
      sendText(WS.idle, SF.idle, 'Then fix the lint.'),
      sendKey(WS.idle, SF.idle, 'enter'),
    ])
    const idle = machine.sessions[1]!
    idle.transcript = [...idle.transcript!, prompt('Run the tests.\nThen fix the lint.', Date.now())]
    idle.transcriptMtimeMs = Date.now()
    await clock.advance(2000)
    expect(await lines(ui)).toContain(' Delivered to idle-p.')
  })
  test(`${surface}: no key goes out without y, from a bar of each kind`, async ($, on) => {
    const { calls, clock, ui } = await begin($, on, surface)
    const before = calls.runs.length
    await select($, 'ses-wait')
    await press(ui, 'option:1')
    await clock.advance(4000)
    await select($, 'ses-perm')
    await press(ui, 'permission:yes')
    await clock.advance(4000)
    await select($, 'ses-idle')
    await press(ui, 'key:r')
    await typeDraft(ui, ['Run the tests.'])
    await clock.advance(4000)
    await press(ui, 'key:m')
    await typeDraft(ui, ['Stop the deploy.'])
    await clock.advance(4000)
    expect(cmuxSince(calls, before)).toEqual([])
    expect(calls.peers).toEqual([])
  })
  test(`${surface}: a peer message from m and y calls session.send once, and runs no cmux command`, async ($, on) => {
    const { calls, ui } = await begin($, on, surface)
    await select($, 'ses-wait')
    await press(ui, 'key:m')
    await typeDraft(ui, ['Stop the deploy now.', 'I check the logs first.'])
    expect(await lines(ui)).toContain(' Send this peer message to ask-a?  y: send  c: cancel')
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(calls.peers).toEqual([{ to: expect.stringContaining('ses-wait'), text: 'Stop the deploy now.\nI check the logs first.' }])
    expect(cmuxSince(calls, atY)).toEqual([])
    expect(await lines(ui)).toContain(' Delivered to ask-a.')
  })
  test(`${surface}: the bar names the mode that a prompt opens with its first character, and the draft closes on an empty first line`, async ($, on) => {
    const { calls, ui } = await begin($, on, surface)
    await select($, 'ses-idle')
    await press(ui, 'key:r')
    await typeDraft(ui, ['/compact'])
    const bar = await lines(ui)
    expect(bar).toContain(' The first line starts with /, so the session runs it as a command.')
    await press(ui, 'key:c')
    await press(ui, 'key:r')
    await typeDraft(ui, [])
    const closed = await lines(ui)
    expect(has(closed, 'Write the prompt')).toBe(false)
    expect(has(closed, 'Send this prompt')).toBe(false)
    expect(cmuxSince(calls, 0).filter((argv) => KEY_VERBS.includes(argv[1] ?? ''))).toEqual([])
  })
}
