// The detail of the god pane on the terminal and the desktop surfaces, over the fake machine: below 90 columns Enter
// on a row opens the detail in place of the board and b goes back; t walks the 5 tabs; Now shows the open question
// with each option as a Button that has no hotkey yet; w and z page a long History, and the scroll starts at the
// top again on a new session and on a new tab; the board and the detail split at 90 columns. In a short pane, the
// count lines of the board are Buttons, so presses alone reach every session (the ring reaches only drawn rows).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, installMachine, paneProps, prompt, question, reply, screenOf, turns, type FakeSession, type Machine } from './fake-host'

const A = '/tmp/god-test/repo-a'
const PLAIN = '/tmp/god-test/plain'
const TABS = ['Now', 'History', 'Agents', 'Screen', 'Recap']

/** A session that waits on a question, and an idle session with 10 whole turns: a History longer than the pane. */
function machineAt(t0: number): Machine {
  const sessions: FakeSession[] = [
    { pid: 42001, sessionId: 'ses-wait', cwd: A, name: 'ask-a', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Pick a color.', t0 - 90_000), question('toolu_q1', 'Which color?', ['Red', 'Green'], t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 42002, sessionId: 'ses-long', cwd: PLAIN, name: 'long-p', status: 'idle', statusUpdatedAt: t0 - 60_000, transcript: turns(10, t0), transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 42003, sessionId: 'ses-idle', cwd: PLAIN, name: 'idle-p', status: 'idle', statusUpdatedAt: t0 - 3_600_000, transcript: [prompt('Fix the docs.', t0 - 3_700_000), ...reply('Done.', t0 - 3_600_000)], transcriptMtimeMs: t0 - 3_600_000, fileMtimeMs: t0 - 3_600_000 },
  ]
  return { sessions, repos: { [A]: [`${A}/.git`, `${A}/.git`, A] } }
}

/** The fake machine beneath the plugin, the session start, /god and the first refresh, then the pane mounted. */
async function openAt($: Engine, on: On, surface: (typeof SURFACES)[number], columns: number, rows = 30, machine?: (t0: number) => Machine) {
  const t0 = Date.now()
  const calls = installMachine(on, (machine ?? machineAt)(t0))
  const clock = mock.clock(on, { now: t0 })
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: PLAIN, surface, isInteractive: true })
  await $.command.run({ command: 'god', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(columns, rows) })
  return { ui, calls }
}

const lines = async (ui: Mounted<'terminal' | 'desktop', 'Pane'>): Promise<string[]> => {
  await ui.redraw()
  return screenOf(await ui.drawn())
}
const keysOf = async (ui: Mounted<'terminal' | 'desktop', 'Pane'>): Promise<string[]> => (await ui.findAll({ type: 'Button' })).flatMap((button) => (button.key === undefined ? [] : [button.key]))
/** The open tab: the label that the tab row shows in brackets. */
const openTab = (shown: readonly string[]): string | undefined => shown.map((line) => /\[(\w+)\]/.exec(line)?.[1]).find((tab) => tab !== undefined)
const select = ($: Engine, element: string) => $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element, origin: { kind: 'person' } })

for (const surface of SURFACES) {
  test(`${surface}: at 80 columns Enter on a row opens the detail in place of the board, and b goes back`, async ($, on) => {
    const { ui } = await openAt($, on, surface, 80)
    expect(await keysOf(ui)).not.toContain('key:b')
    await ui.press({ key: 'ses-wait' })
    const detail = await lines(ui)
    expect(detail.some((line) => line.startsWith(' ask-a')), detail.join('\n')).toBe(true)
    expect(detail).toContain(' [Now]  History  Agents  Screen  Recap')
    expect(detail.some((line) => line.includes('long-p'))).toBe(false)
    expect(detail.join('\n')).not.toContain('↑↓ select')
    expect(detail.join('\n')).toContain('b: back')
    await ui.press({ key: 'key:b' })
    const board = await lines(ui)
    for (const name of ['ask-a', 'long-p', 'idle-p']) expect(board.some((line) => line.includes(name)), board.join('\n')).toBe(true)
    expect(openTab(board)).toBeUndefined()
    expect(await keysOf(ui)).not.toContain('key:b')
    for (const line of [...detail, ...board]) expect([...line].length, line).toBeLessThanOrEqual(80)
  })

  test(`${surface}: t walks the 5 tabs, from Recap back to Now`, async ($, on) => {
    const { ui } = await openAt($, on, surface, 110)
    await select($, 'ses-wait')
    const walked = [openTab(await lines(ui))]
    for (let step = 0; step < 5; step += 1) {
      await ui.press({ key: 'key:t' })
      walked.push(openTab(await lines(ui)))
    }
    expect(walked).toEqual([...TABS, 'Now'])
    expect((await ui.find({ key: 'key:t' }))?.props['hotkey']).toBe('t')
  })

  test(`${surface}: a press on a tab opens it, and the Screen and Recap tabs say that they are not in this build`, async ($, on) => {
    const { ui } = await openAt($, on, surface, 110)
    await select($, 'ses-wait')
    expect((await keysOf(ui)).filter((key) => key.startsWith('tab:'))).toEqual(['tab:now', 'tab:history', 'tab:agents', 'tab:screen', 'tab:recap'])
    await ui.press({ key: 'tab:screen' })
    const screen = await lines(ui)
    expect(openTab(screen)).toBe('Screen')
    expect(screen.some((line) => line.endsWith('│ The Screen tab is not in this build.'))).toBe(true)
    await ui.press({ key: 'tab:recap' })
    expect((await lines(ui)).some((line) => line.endsWith('│ The Recap tab is not in this build.'))).toBe(true)
  })

  test(`${surface}: Now shows the open question of the selected session, each option a Button with no hotkey yet`, async ($, on) => {
    const { ui } = await openAt($, on, surface, 110)
    await select($, 'ses-wait')
    const shown = await lines(ui)
    expect(openTab(shown)).toBe('Now')
    for (const part of ['☐ Pick', 'Which color?', '1 Red', '2 Green']) expect(shown.some((line) => line.includes(part)), `${part}\n${shown.join('\n')}`).toBe(true)
    const options = (await ui.findAll({ type: 'Button' })).filter((button) => button.key?.startsWith('option:'))
    expect(options.map((button) => button.key)).toEqual(['option:1', 'option:2'])
    for (const option of options) expect(option.props['hotkey']).toBeUndefined()
  })

  test(`${surface}: w and z page a long History, and the scroll starts at the top on a new session and a new tab`, async ($, on) => {
    const { ui } = await openAt($, on, surface, 110, 20)
    await select($, 'ses-long')
    await ui.press({ key: 'tab:history' })
    const top = await lines(ui)
    expect(top.some((line) => /│ z: \+\d+ lines$/.test(line)), top.join('\n')).toBe(true)
    expect(top.some((line) => /│ w: \+\d+ lines$/.test(line))).toBe(false)
    expect((await ui.find({ key: 'key:z' }))?.props['hotkey']).toBe('z')
    await ui.press({ key: 'key:z' })
    const page = await lines(ui)
    expect(page.some((line) => /│ w: \+\d+ lines$/.test(line)), page.join('\n')).toBe(true)
    expect((await ui.find({ key: 'key:w' }))?.props['hotkey']).toBe('w')
    expect(page.join('\n')).not.toBe(top.join('\n'))
    await ui.press({ key: 'key:w' })
    expect(await lines(ui)).toEqual(top)
    // a new session, then the same session again: the History starts at the top
    await ui.press({ key: 'key:z' })
    await select($, 'ses-wait')
    await select($, 'ses-long')
    expect(await lines(ui)).toEqual(top)
    // a new tab, then the History again: it starts at the top
    await ui.press({ key: 'key:z' })
    await ui.press({ key: 'tab:agents' })
    await ui.press({ key: 'tab:history' })
    expect(await lines(ui)).toEqual(top)
  })

  test(`${surface}: the pane splits at 90 columns: the board alone at 89, the board, a rule and the detail at 90`, async ($, on) => {
    const { ui } = await openAt($, on, surface, 89)
    await select($, 'ses-wait')
    const narrow = await lines(ui)
    expect(narrow.join('\n')).not.toMatch(/[│┬┴]/)
    expect(openTab(narrow)).toBeUndefined()
    await ui.redraw(paneProps(90, 30))
    const wide = screenOf(await ui.drawn())
    expect(wide.some((line) => line.includes('┬'))).toBe(true)
    expect(wide.some((line) => /│ ask-a · /.test(line) || line.endsWith('│ ask-a')), wide.join('\n')).toBe(true)
    expect(openTab(wide)).toBe('Now')
    for (const line of narrow) expect([...line].length, line).toBeLessThanOrEqual(89)
    for (const line of wide) expect([...line].length, line).toBeLessThanOrEqual(90)
  })
}

/** 12 busy sessions, so a short pane shows only some of them. */
function manyAt(t0: number): Machine {
  const sessions: FakeSession[] = Array.from({ length: 12 }, (_, index) => {
    const id = String(index + 1).padStart(2, '0')
    const at = t0 - (index + 1) * 60_000
    return { pid: 43000 + index, sessionId: `ses-${id}`, cwd: PLAIN, name: `run-${id}`, status: 'busy', statusUpdatedAt: at, transcript: [prompt(`Run job ${id}.`, at)], transcriptMtimeMs: t0 - 5_000, fileMtimeMs: at }
  })
  return { sessions, repos: {} }
}

const selectedRow = (shown: readonly string[]): string | undefined => shown.find((line) => line.startsWith('▌'))?.slice(1).trim().split(/\s+/)[1]

for (const surface of SURFACES) {
  test(`${surface}: in a short pane the count lines are Buttons, and presses alone reach the last session and the first`, async ($, on) => {
    const { ui, calls } = await openAt($, on, surface, 80, 40, manyAt)
    expect(calls.opens).toEqual([{ id: PANE, title: 'orangu god', columns: 110, rows: 20 }])
    // the board order, from a pane tall enough for every row; then the same pane 10 rows high
    const order = (await keysOf(ui)).flatMap((key) => (key.startsWith('ses-') ? [`run-${key.slice(4)}`] : []))
    expect(order).toHaveLength(12)
    await ui.redraw(paneProps(80, 10))
    const first = await lines(ui)
    expect(first.some((line) => /^ \+\d+ sessions \(↓\)$/.test(line)), first.join('\n')).toBe(true)
    expect(await keysOf(ui)).toContain('more-down')
    const names = (await ui.findAll({ type: 'Button' })).flatMap((button) => (button.key?.startsWith('ses-') ? [button.key] : []))
    expect(names.length).toBeLessThan(12)
    const reached: Array<string | undefined> = []
    for (let press = 0; press < 12 && (await keysOf(ui)).includes('more-down'); press += 1) {
      const drawn = (await keysOf(ui)).flatMap((key) => (key.startsWith('ses-') ? [`run-${key.slice(4)}`] : []))
      await ui.press({ key: 'more-down' })
      reached.push(selectedRow(await lines(ui)))
      // the press selects the first row under the window
      expect(reached.at(-1)).toBe(order[order.indexOf(drawn.at(-1)!) + 1])
    }
    expect(reached.at(-1)).toBe(order.at(-1))
    expect(new Set(reached).size).toBe(reached.length)
    expect(await keysOf(ui)).not.toContain('more-down')
    for (let press = 0; press < 12 && (await keysOf(ui)).includes('more-up'); press += 1) await ui.press({ key: 'more-up' })
    expect(selectedRow(await lines(ui))).toBe(order[0])
    expect(await keysOf(ui)).not.toContain('more-up')
    for (const line of await lines(ui)) expect([...line].length, line).toBeLessThanOrEqual(80)
  })
}
