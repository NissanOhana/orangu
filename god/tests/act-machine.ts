// The fake machine of the key path tests (god/tests/act.test.ts, god/tests/act-draft.test.ts): a session that waits on a
// question, an idle session, a session that waits on a Bash request and 1 on an Edit request, each with its cmux tab and
// the screen that Claude Code draws in it, over the fake host. Every value is synthetic. It also gives the helpers that
// press, type and read the pane as a person does: a press reaches only an element that the pane draws now.
import { mock } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, bash, edit, installMachine, paneProps, prompt, question, reply, screenOf, type FakeCmux, type FakeSession, type Machine } from './fake-host'

const A = '/tmp/god-test/repo-a'
const PLAIN = '/tmp/god-test/plain'
const RULE = '─'.repeat(72)
const NBSP = String.fromCharCode(0xa0)
export const KEY_VERBS = ['send', 'send-key']

/** The UUIDs of the tabs of the fake cmux. */
export const WS = { ask: '00000000-0000-4000-8000-00000000a011', idle: '00000000-0000-4000-8000-00000000a012', perm: '00000000-0000-4000-8000-00000000a013', edit: '00000000-0000-4000-8000-00000000a014' }
export const SF = { ask: '00000000-0000-4000-8000-00000000b011', idle: '00000000-0000-4000-8000-00000000b012', perm: '00000000-0000-4000-8000-00000000b013', edit: '00000000-0000-4000-8000-00000000b014' }

/** The screens as Claude Code draws them: the question dialog, an empty prompt, and a Bash permission dialog. */
export const QUESTION_SCREEN = ['❯ Pick a color.', '', RULE, ' ☐ Pick', '', 'Which color?', '', '❯ 1. Red', '     Red', '  2. Green', '     Green', '  3. Type something.', RULE, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n')
/** The screen of an idle session whose input box holds `typed`: the first line after the prompt mark, the next ones after 2 spaces. */
export function promptScreen(typed = ''): string {
  const [first = '', ...rest] = typed.split('\n')
  return ['❯ Run the build.', '', '⏺ The build is done.', '', RULE, `❯${NBSP}${first}`, ...rest.map((line) => `  ${line}`), RULE, '  ? for shortcuts'].join('\n')
}
export const PROMPT_SCREEN = promptScreen()
export const PERMISSION_SCREEN = [
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
export function machineAt(t0: number): Machine {
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
    screens: { [SF.ask]: QUESTION_SCREEN, [SF.idle]: promptScreen, [SF.perm]: PERMISSION_SCREEN, [SF.edit]: PROMPT_SCREEN },
  }
  return { sessions, repos: { [A]: [`${A}/.git`, `${A}/.git`, A] }, cmux }
}

const god = () => ({ command: 'god', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } })

/** The fake machine beneath the plugin, the session start, /god, the first refresh, and the pane mounted. */
export async function begin($: Engine, on: On, surface: (typeof SURFACES)[number]) {
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

export const lines = async (ui: Mounted<'terminal' | 'desktop', 'Pane'>): Promise<string[]> => {
  await ui.redraw()
  return screenOf(await ui.drawn())
}
export const select = ($: Engine, element: string) => $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element, origin: { kind: 'person' } })
export type Calls = ReturnType<typeof installMachine>
/** the cmux argv lists from `from` on */
export const cmuxSince = (calls: Calls, from: number): string[][] => calls.runs.slice(from).flatMap((run) => (run.argv[0] === 'cmux' ? [[...run.argv]] : []))
export const keysSince = (calls: Calls, from: number): string[][] => cmuxSince(calls, from).filter((argv) => KEY_VERBS.includes(argv[1] ?? ''))
export const readScreen = (ws: string, sf: string): string[] => ['cmux', 'read-screen', '--workspace', ws, '--surface', sf, '--lines', '40']
export const sendKey = (ws: string, sf: string, key: string): string[] => ['cmux', 'send-key', '--workspace', ws, '--surface', sf, '--', key]
export const sendText = (ws: string, sf: string, text: string): string[] => ['cmux', 'send', '--workspace', ws, '--surface', sf, '--', text]
export const has = (shown: readonly string[], part: string): boolean => shown.some((line) => line.includes(part))
/** The text of the detail column of the wide pane: the part of each line after the column rule, joined with 1 space. */
export const detailText = (shown: readonly string[]): string => shown.flatMap((line) => (line.includes('│') ? [line.slice(line.indexOf('│') + 1).trim()] : [])).join(' ')
/** Presses the Button keyed `key` of the pane as it draws now: a press reaches only an element that is drawn. */
export const press = async (ui: Mounted<'terminal' | 'desktop', 'Pane'>, key: string) => {
  await ui.redraw()
  return ui.press({ key })
}

/** Types each line into the draft and then Enter on an empty line, as a person does. */
export async function typeDraft(ui: Mounted<'terminal' | 'desktop', 'Pane'>, texts: readonly string[]): Promise<void> {
  for (const [index, text] of [...texts, ''].entries()) {
    await ui.redraw()
    await ui.input({ key: `draft:${index}`, text })
  }
}
