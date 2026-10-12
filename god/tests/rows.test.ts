// The rows of the god pane on the terminal and the desktop surfaces, over a fake machine with cmux: each row shows
// the title of the cmux tab of its session with the status glyph left out, else the transcript title, else the
// session name, and the detail facts line names the session and its repo. The board takes about 40% of a wide body,
// 60 cells at most.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, installMachine, paneProps, prompt, question, reply, screenOf, type FakeCmux, type FakeSession, type Machine } from './fake-host'

const A = '/tmp/god-test/repo-a'
const PLAIN = '/tmp/god-test/plain'

/** The tab of the waiting session at rest (`✳`) and of the busy session with a braille spinner frame. */
const CMUX: FakeCmux = {
  tabs: {
    47001: { tty: 'ttys021', workspaceRef: '00000000-0000-4000-8000-00000000a021', surfaceRef: '00000000-0000-4000-8000-00000000b021', title: '✳ Pick a color' },
    47002: { tty: 'ttys022', workspaceRef: '00000000-0000-4000-8000-00000000a022', surfaceRef: '00000000-0000-4000-8000-00000000b022', title: '⠐ Fix the parser' },
  },
}

/** 2 sessions with a tab, 1 with no tab and a transcript, 1 with no tab and no transcript. */
function machineAt(t0: number): Machine {
  const sessions: FakeSession[] = [
    { pid: 47001, sessionId: 'ses-wait', cwd: A, name: 'ask-a', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Pick a color.', t0 - 90_000), question('toolu_q1', 'Which color?', ['Red', 'Green'], t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 47002, sessionId: 'ses-work', cwd: PLAIN, name: 'work-p', status: 'busy', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Run the build.', t0 - 60_000)], transcriptMtimeMs: t0 - 5_000, fileMtimeMs: t0 - 60_000 },
    { pid: 47003, sessionId: 'ses-idle', cwd: PLAIN, name: 'idle-p', status: 'idle', statusUpdatedAt: t0 - 3_600_000, transcript: [prompt('Fix the docs.', t0 - 3_700_000), ...reply('Done.', t0 - 3_600_000)], transcriptMtimeMs: t0 - 3_600_000, fileMtimeMs: t0 - 3_600_000 },
    { pid: 47004, sessionId: 'ses-new', cwd: PLAIN, name: 'new-p', status: 'busy', statusUpdatedAt: t0 - 30_000, fileMtimeMs: t0 - 30_000 },
  ]
  return { sessions, cmux: CMUX, repos: { [A]: [`${A}/.git`, `${A}/.git`, A] } }
}

async function openAt($: Engine, on: On, surface: (typeof SURFACES)[number], columns: number) {
  const t0 = Date.now()
  installMachine(on, machineAt(t0))
  const clock = mock.clock(on, { now: t0 })
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: PLAIN, surface, isInteractive: true })
  await $.command.run({ command: 'god', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(columns, 30) })
}

const rowOf = (lines: readonly string[], name: string): string | undefined => lines.find((line) => /^[ ▌]. /.test(line) && line.slice(3).startsWith(name))

for (const surface of SURFACES) {
  test(`${surface}: each row shows the cmux tab title with no status glyph, else the transcript title, else the session name`, async ($, on) => {
    const ui = await openAt($, on, surface, 160)
    const lines = screenOf(await ui.drawn())
    for (const name of ['Pick a color', 'Fix the parser', 'Fix the docs.', 'new-p']) expect(rowOf(lines, name), `${name}\n${lines.join('\n')}`).toBeDefined()
    expect(lines.join('\n')).not.toMatch(/[✳⠐]/)
    expect(lines.some((line) => /\b(ask-a|work-p|idle-p)\b/.test(line)), lines.join('\n')).toBe(false)
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'ses-wait', origin: { kind: 'person' } })
    await ui.redraw()
    const detail = screenOf(await ui.drawn())
    expect(detail.some((line) => line.endsWith('│ Pick a color')), detail.join('\n')).toBe(true)
    expect(detail.some((line) => line.endsWith('│ ask-a · repo-a')), detail.join('\n')).toBe(true)
  })

  test(`${surface}: the board takes about 40% of a wide body, 60 cells at most, and the board alone below 90 columns`, async ($, on) => {
    const ui = await openAt($, on, surface, 160)
    const ruleAt = async (): Promise<number> => screenOf(await ui.drawn()).find((line) => line.includes('┬'))?.indexOf('┬') ?? -1
    expect(await ruleAt()).toBe(60)
    await ui.redraw(paneProps(110, 30))
    expect(await ruleAt()).toBe(44)
    await ui.redraw(paneProps(90, 30))
    expect(await ruleAt()).toBe(36)
    await ui.redraw(paneProps(89, 30))
    expect(await ruleAt()).toBe(-1)
  })
}
