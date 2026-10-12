// A dialog with 2 single-select questions, answered from the pane on the terminal and the desktop surfaces, over the
// fake machine of multi-machine.ts. A digit picks for the shown question and the detail shows the next one, p goes back
// 1 question, and the last pick opens the confirm bar of every pick. Only y sends: 1 digit for each question and then 1
// on the review screen, each after a fresh read of the screen. A review screen with another label stops the keys before
// the submit, and the Screen tab says that the dialog keeps some picks.
import { expect, test } from 'claude-code/testing'
import { SURFACES } from './fake-host'
import { cmuxSince, detailText, has, keysSince, lines, press, readScreen, select, sendText } from './act-machine'
import { ASKED, SF, WS, beginMulti, flow, reviewScreen } from './multi-machine'

for (const surface of SURFACES) {
  test(`${surface}: 2 digits pick 1 question at a time, p goes back, and y sends 2, 1 and then 1 on the review screen`, async ($, on) => {
    const { machine, calls, ui } = await beginMulti($, on, surface)
    await select($, 'ses-multi')
    const first = detailText(await lines(ui))
    expect(first, first).toContain('Question 1 of 2. Press 1-3 to pick, then go on to the next question.')
    expect((await ui.find({ key: 'option:3' }))?.props['hotkey']).toBe('3')
    await press(ui, 'option:2')
    const second = await lines(ui)
    expect(detailText(second)).toContain('☒ Colour: 2 Green ☐ Size · waits 1m Which test size?')
    expect(detailText(second)).toContain('Question 2 of 2. Press 1-2 to pick, then y to send.')
    expect(has(second, 'p: back to question 1')).toBe(true)
    expect(has(second, 'y: send')).toBe(false)
    await press(ui, 'key:p')
    expect(detailText(await lines(ui))).toContain('Question 1 of 2.')
    await press(ui, 'option:2')
    await press(ui, 'option:1')
    const bar = await lines(ui)
    expect(bar, bar.join('\n')).toContain(' Send to multi-m? Colour: 2 Green · Size: 1 Small  y: send  c: cancel')
    expect(keysSince(calls, 0)).toEqual([])
    const atY = calls.runs.length
    await press(ui, 'key:y')
    const read = readScreen(WS, SF)
    expect(cmuxSince(calls, atY)).toEqual([read, sendText(WS, SF, '2'), read, sendText(WS, SF, '1'), read, sendText(WS, SF, '1')])
    expect(machine.cmux!.answered).toEqual({ [SF]: ['2', '1', '1'] })
    expect(await lines(ui)).toContain(' Sent to multi-m. The next refresh checks it.')
  })

  test(`${surface}: a review screen with another label gets no submit, and the Screen tab says that the dialog keeps some picks`, async ($, on) => {
    const { machine, calls, ui } = await beginMulti($, on, surface)
    machine.cmux!.screens![SF] = (typed, answered) => (answered.length === ASKED.length ? reviewScreen(['Green', 'Large']) : flow(typed, answered))
    await select($, 'ses-multi')
    await press(ui, 'option:2')
    await press(ui, 'option:1')
    const atY = calls.runs.length
    await press(ui, 'key:y')
    expect(keysSince(calls, atY)).toEqual([sendText(WS, SF, '2'), sendText(WS, SF, '1')])
    const shown = await lines(ui)
    expect(has(shown, '[Screen]'), shown.join('\n')).toBe(true)
    expect(detailText(shown)).toContain('The pane stopped after 1 or more answers, so the dialog stays open with some picks in it. Press j to answer the rest in its tab.')
    expect(detailText(shown)).toContain('→ Large')
  })

  test(`${surface}: c closes the bar of the picks and the detail shows question 1 again, with no key`, async ($, on) => {
    const { calls, ui } = await beginMulti($, on, surface)
    await select($, 'ses-multi')
    await press(ui, 'option:3')
    await press(ui, 'option:2')
    expect(has(await lines(ui), 'Send to multi-m? Colour: 3 Blue · Size: 2 Large')).toBe(true)
    await press(ui, 'key:c')
    const shown = await lines(ui)
    expect(has(shown, 'Send to multi-m?')).toBe(false)
    expect(detailText(shown)).toContain('Question 1 of 2.')
    expect(keysSince(calls, 0)).toEqual([])
  })
}
