// The fake machine of the plugin test of a dialog with 2 questions (god/tests/act-multi.test.ts): 1 session that waits
// on a dialog with 2 single-select questions, with its cmux tab, over the fake host. Its screen is a function of the
// digits that the dialog took, in the layout of the live dialog of Claude Code 2.1.296: the chip row, the shown
// question, then the review screen after the last question, then the empty prompt after the submit. Every value is
// synthetic.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, installMachine, paneProps, prompt, questions, type Machine } from './fake-host'

const CWD = '/tmp/god-test/plain'
const RULE = '─'.repeat(72)
const NBSP = String.fromCharCode(0xa0)
export const WS = '00000000-0000-4000-8000-00000000a021'
export const SF = '00000000-0000-4000-8000-00000000b021'

/** The 2 questions of the dialog. */
export const ASKED = [
  { header: 'Colour', text: 'Which test colour?', options: [{ label: 'Red', description: 'Use red as the test colour.' }, { label: 'Green', description: 'Use green as the test colour.' }, { label: 'Blue', description: 'Use blue as the test colour.' }] },
  { header: 'Size', text: 'Which test size?', options: [{ label: 'Small' }, { label: 'Large' }] },
] as const

const tabsRow = (answered: number): string => `←  ${ASKED.map((one, index) => `${index < answered ? '☒' : '☐'} ${one.header}`).join('  ')}  ✔ Submit  →`
const FOOTER = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
const ABOVE = ['❯ Pick the test colour and size.', '', RULE]

/** The screen of question `step` (from 0), with the cursor on option 1. */
export function questionScreen(step: number): string {
  const question = ASKED[step]!
  const rows = question.options.flatMap((option, index) => [`${index === 0 ? '❯' : ' '} ${index + 1}. ${option.label}`, ...('description' in option ? [`     ${option.description}`] : [])])
  const count = question.options.length
  return [...ABOVE, tabsRow(step), question.text, ...rows, `  ${count + 1}. Type something.`, RULE, `  ${count + 2}. Chat about this`, '', FOOTER].join('\n')
}

/** The review screen with the labels that the dialog took. */
export const reviewScreen = (labels: readonly string[]): string =>
  [...ABOVE, tabsRow(ASKED.length), 'Review your answers', ...ASKED.flatMap((one, index) => [` ● ${one.text}`, `   → ${labels[index] ?? ''}`]), 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel', '', FOOTER].join('\n')

/** The empty prompt after the submit. */
const PROMPT = ['❯ Pick the test colour and size.', '', RULE, `❯${NBSP}`, RULE, '  ? for shortcuts'].join('\n')

/** The screen after the digits that the dialog took: question 1, question 2, the review, then the prompt. */
export const flow = (_typed: string, answered: readonly string[]): string => {
  if (answered.length < ASKED.length) return questionScreen(answered.length)
  if (answered.length === ASKED.length) return reviewScreen(answered.map((digit, index) => ASKED[index]!.options[Number(digit) - 1]?.label ?? ''))
  return PROMPT
}

/** The fake machine beneath the plugin, the session start, /god, the first refresh, and the pane mounted. */
export async function beginMulti($: Engine, on: On, surface: (typeof SURFACES)[number]) {
  const t0 = Date.now()
  const transcript = [prompt('Pick the test colour and size.', t0 - 90_000), questions('toolu_multi', ASKED, t0 - 60_000)]
  const machine: Machine = {
    sessions: [{ pid: 46021, sessionId: 'ses-multi', cwd: CWD, name: 'multi-m', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 - 60_000, transcript, transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 }],
    repos: {},
    cmux: { tabs: { 46021: { tty: 'ttys021', workspaceRef: WS, surfaceRef: SF, title: 'multi' } }, screens: { [SF]: flow } },
  }
  const calls = installMachine(on, machine)
  const clock = mock.clock(on, { now: t0 })
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: CWD, surface, isInteractive: true })
  await $.command.run({ command: 'god', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(110, 40) })
  return { machine, calls, clock, ui }
}
