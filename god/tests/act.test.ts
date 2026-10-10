// The key path of the god pane on the terminal and the desktop surfaces, over the fake machine: a digit, the Yes or No
// of a Bash request, r and m open the confirm bar, and only y sends. Each y reads the registry file, the transcript
// tail and the screen of the target again, then sends only the keys of the plan: a digit alone, or each line of a
// prompt with shift+enter between the lines and enter at the end. A screen or a state that changed gets no key, and
// the Screen tab shows the fresh screen under the refusal line. An old read keeps the bar open for y again. A peer
// message goes through the engine with no cmux call. The next refreshes check that the keys reached the session.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, bash, edit, installMachine, paneProps, prompt, question, reply, screenOf, toolResult, type FakeCmux, type FakeSession, type Machine } from './fake-host'

const A = '/tmp/god-test/repo-a'
const PLAIN = '/tmp/god-test/plain'
const RULE = '─'.repeat(72)
const NBSP = String.fromCharCode(0xa0)
const KEY_VERBS = ['send', 'send-key']

/** The UUIDs of the tabs of the fake cmux. */
const WS = { ask: '00000000-0000-4000-8000-00000000a011', idle: '00000000-0000-4000-8000-00000000a012', perm: '00000000-0000-4000-8000-00000000a013', edit: '00000000-0000-4000-8000-00000000a014' }
const SF = { ask: '00000000-0000-4000-8000-00000000b011', idle: '00000000-0000-4000-8000-00000000b012', perm: '00000000-0000-4000-8000-00000000b013', edit: '00000000-0000-4000-8000-00000000b014' }

/** The screens as Claude Code draws them: the question dialog, an empty prompt, and a Bash permission dialog. */
const QUESTION_SCREEN = ['❯ Pick a color.', '', RULE, ' ☐ Pick', '', 'Which color?', '', '❯ 1. Red', '     Red', '  2. Green', '     Green', '  3. Type something.', RULE, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n')
const PROMPT_SCREEN = ['❯ Run the build.', '', '⏺ The build is done.', '', RULE, `❯${NBSP}`, RULE, '  ? for shortcuts'].join('\n')
const PERMISSION_SCREEN = [
  '❯ Make the probe file.',
  '',
  '⏺ Bash(touch probe-yes.txt)',
  '',
  RULE,
  ' Bash command',
  '',
  ' Make an empty probe file',
  '',
  '   touch probe-yes.txt',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to probe/ from this project',
  '   3. Yes, and switch to auto mode',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

/** A session that waits on a question, an idle session, a session that waits on a Bash request, and 1 on an Edit request. */
function machineAt(t0: number): Machine {
  const sessions: FakeSession[] = [
    { pid: 46001, sessionId: 'ses-wait', cwd: A, name: 'ask-a', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Pick a color.', t0 - 90_000), question('toolu_q1', 'Which color?', ['Red', 'Green'], t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 46002, sessionId: 'ses-idle', cwd: PLAIN, name: 'idle-p', status: 'idle', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Run the build.', t0 - 90_000), ...reply('The build is done.', t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 46003, sessionId: 'ses-perm', cwd: PLAIN, name: 'perm-p', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Make the probe file.', t0 - 90_000), bash('toolu_b1', 'touch probe-yes.txt', 'Make an empty probe file', t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 46004, sessionId: 'ses-edit', cwd: PLAIN, name: 'edit-p', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Fix the notes.', t0 - 90_000), edit('toolu_e1', '/tmp/god-test/plain/notes.md', t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
  ]
  const cmux: FakeCmux = {
    tabs: {
      46001: { tty: 'ttys011', workspaceRef: WS.ask, surfaceRef: SF.ask, title: 'ask' },
      46002: { tty: 'ttys012', workspaceRef: WS.idle, surfaceRef: SF.idle, title: 'idle' },
      46003: { tty: 'ttys013', workspaceRef: WS.perm, surfaceRef: SF.perm, title: 'perm' },
      46004: { tty: 'ttys014', workspaceRef: WS.edit, surfaceRef: SF.edit, title: 'edit' },
    },
    screens: { [SF.ask]: QUESTION_SCREEN, [SF.idle]: PROMPT_SCREEN, [SF.perm]: PERMISSION_SCREEN, [SF.edit]: PROMPT_SCREEN },
  }
  return { sessions, repos: { [A]: [`${A}/.git`, `${A}/.git`, A] }, cmux }
}

const god = () => ({ command: 'god', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } })

/** The fake machine beneath the plugin, the session start, /god, the first refresh, and the pane mounted. */
async function begin($: Engine, on: On, surface: (typeof SURFACES)[number]) {
  const t0 = Date.now()
  const machine = machineAt(t0)
  const calls = installMachine(on, machine)
  const clock = mock.clock(on, { now: t0 })
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: PLAIN, surface, isInteractive: true })
  await $.command.run(god())
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(110, 40) })
  return { machine, calls, clock, ui }
}

const lines = async (ui: Mounted<'terminal' | 'desktop', 'Pane'>): Promise<string[]> => {
  await ui.redraw()
  return screenOf(await ui.drawn())
}
const select = ($: Engine, element: string) => $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element, origin: { kind: 'person' } })
type Calls = ReturnType<typeof installMachine>
/** the cmux argv lists from `from` on */
const cmuxSince = (calls: Calls, from: number): string[][] => calls.runs.slice(from).flatMap((run) => (run.argv[0] === 'cmux' ? [[...run.argv]] : []))
const keysSince = (calls: Calls, from: number): string[][] => cmuxSince(calls, from).filter((argv) => KEY_VERBS.includes(argv[1] ?? ''))
const readScreen = (ws: string, sf: string): string[] => ['cmux', 'read-screen', '--workspace', ws, '--surface', sf, '--lines', '40']
const sendKey = (ws: string, sf: string, key: string): string[] => ['cmux', 'send-key', '--workspace', ws, '--surface', sf, '--', key]
const sendText = (ws: string, sf: string, text: string): string[] => ['cmux', 'send', '--workspace', ws, '--surface', sf, '--', text]
const has = (shown: readonly string[], part: string): boolean => shown.some((line) => line.includes(part))
/** Presses the Button keyed `key` of the pane as it draws now: a press reaches only an element that is drawn. */
const press = async (ui: Mounted<'terminal' | 'desktop', 'Pane'>, key: string) => {
  await ui.redraw()
  return ui.press({ key })
}

/** Types each line into the draft and then Enter on an empty line, as a person does. */
async function typeDraft(ui: Mounted<'terminal' | 'desktop', 'Pane'>, texts: readonly string[]): Promise<void> {
  for (const [index, text] of [...texts, ''].entries()) {
    await ui.redraw()
    await ui.input({ key: `draft:${index}`, text })
  }
}

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
