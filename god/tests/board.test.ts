// The god pane on the terminal and the desktop surfaces, over a fake machine: /god draws 1 row per live session in
// level order, a registry file that turns to waiting shows in NEEDS YOU within 1 tick, /god repos keeps only the
// rows of the named repo and its worktree, the board alone draws below 90 columns, and the host port keeps its
// rules (the 5 s timeout and only TZ on every command, only the commands of the allowlist).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, apiError, edit, installMachine, paneProps, prompt, question, reply, screenOf, type FakeSession, type Machine } from './fake-host'

const A = '/tmp/god-test/repo-a'
const A_WT = '/tmp/god-test/repo-a-wt'
const B = '/tmp/god-test/repo-b'
const PLAIN = '/tmp/god-test/plain'
const ALLOWED = ['claude', 'cmux', 'ps', 'git', 'tail', 'head', 'stat']

/** 4 sessions, 1 for each of 4 levels, in an order that is not the level order. */
function machineAt(t0: number): Machine {
  const sessions: FakeSession[] = [
    { pid: 41004, sessionId: 'ses-idle', cwd: PLAIN, name: 'idle-p', status: 'idle', statusUpdatedAt: t0 - 3_600_000, transcript: [prompt('Fix the docs.', t0 - 3_700_000), ...reply('Done.', t0 - 3_600_000)], transcriptMtimeMs: t0 - 3_600_000, fileMtimeMs: t0 - 3_600_000 },
    { pid: 41003, sessionId: 'ses-work', cwd: A_WT, name: 'work-wt', status: 'busy', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Fix the parser.', t0 - 60_000), edit('toolu_e1', `${A_WT}/parse.ts`, t0 - 5_000)], transcriptMtimeMs: t0 - 5_000, fileMtimeMs: t0 - 60_000 },
    { pid: 41002, sessionId: 'ses-stuck', cwd: B, name: 'stuck-b', status: 'busy', statusUpdatedAt: t0 - 120_000, transcript: [prompt('Run the build.', t0 - 120_000), apiError('The API is busy.', t0 - 30_000)], transcriptMtimeMs: t0 - 30_000, fileMtimeMs: t0 - 120_000 },
    { pid: 41001, sessionId: 'ses-wait', cwd: A, name: 'ask-a', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Pick a color.', t0 - 90_000), question('toolu_q1', 'Which color?', ['Red', 'Green'], t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
  ]
  const repos: Machine['repos'] = {
    [A]: [`${A}/.git`, `${A}/.git`, A],
    [A_WT]: [`${A}/.git/worktrees/repo-a-wt`, `${A}/.git`, A_WT],
    [B]: [`${B}/.git`, `${B}/.git`, B],
  }
  return { sessions, repos }
}

/** The name of the row of each session: no session has a cmux tab here, so each row shows its transcript title, the first prompt. */
const ROW = { 'ask-a': 'Pick a color.', 'work-wt': 'Fix the parser.', 'stuck-b': 'Run the build.', 'idle-p': 'Fix the docs.' } as const

type Setup = { machine: Machine; t0: number; clock: ReturnType<typeof mock.clock> }

/** The fake machine, the clock, the store and the environment beneath the plugin, then the session start. */
async function begin($: Engine, on: On, surface: (typeof SURFACES)[number], over: Partial<Machine> = {}, env: Record<string, string> = {}) {
  const t0 = Date.now()
  const machine: Machine = { ...machineAt(t0), ...over }
  const calls = installMachine(on, machine)
  const clock = mock.clock(on, { now: t0 })
  mock.env(on, { HOME, ...env })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: PLAIN, surface, isInteractive: true })
  const setup: Setup = { machine, t0, clock }
  return { ...setup, calls }
}

const god = (args = '') => ({ command: 'god', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } })

/** An inline plugin with 1 command that closes the god pane, as the close mark of the person does. */
const CLOSER = {
  name: 'closer',
  register(on: On) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'close-god', description: 'Closes the god pane.' })
      return next(e)
    })
    on('command.run', { command: 'close-god' }, async ($) => {
      await $.ui.close({ id: 'god' })
      return { text: 'closed' }
    })
  },
}

for (const surface of SURFACES) {
  test(`${surface}: /god draws 1 row per live session in level order, and leaves out the god session`, async ($, on) => {
    const { clock, calls } = await begin($, on, surface)
    const out = await $.command.run(god())
    expect(out.text).toBe('The god pane is open.')
    expect(calls.opens).toEqual([{ id: PANE, title: 'orangu god', columns: 1000, rows: 20, focus: true }])
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
    const lines = screenOf(await ui.drawn())
    const order = ['NEEDS YOU', ROW['ask-a'], 'STUCK', ROW['stuck-b'], 'WORKING', ROW['work-wt'], 'IDLE', ROW['idle-p']].map((word) => lines.findIndex((line) => line.includes(word)))
    expect(order.every((index) => index >= 0), lines.join('\n')).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const name of Object.values(ROW)) expect(lines.filter((line) => line.includes(name))).toHaveLength(1)
    const rows = (await ui.findAll({ type: 'Button' })).map((button) => button.key)
    expect(rows.filter((key) => key?.startsWith('ses-'))).toEqual(['ses-wait', 'ses-stuck', 'ses-work', 'ses-idle'])
    expect(rows).not.toContain('god-self-session')
  })

  test(`${surface}: a registry file that turns to waiting shows in NEEDS YOU with its question after the clock moves 2 s`, async ($, on) => {
    const { machine, clock, t0 } = await begin($, on, surface)
    const asking = machine.sessions.find((session) => session.sessionId === 'ses-work')!
    asking.transcript = [prompt('Pick a size.', t0 - 60_000), question('toolu_q2', 'Which size?', ['Small', 'Large'], t0 - 2_000)]
    asking.transcriptMtimeMs = t0 - 2_000
    await $.command.run(god())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
    const before = screenOf(await ui.drawn())
    expect(before.findIndex((line) => line.includes('Pick a size.'))).toBeGreaterThan(before.findIndex((line) => line.includes('WORKING')))
    Object.assign(asking, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 + 500, fileMtimeMs: t0 + 500 })
    await clock.advance(2000)
    await ui.redraw()
    const after = screenOf(await ui.drawn())
    const heading = after.findIndex((line) => line.includes('NEEDS YOU'))
    const row = after.findIndex((line) => line.includes('Pick a size.'))
    expect(row, after.join('\n')).toBeGreaterThan(heading)
    expect(row).toBeLessThan(after.findIndex((line) => line.includes('STUCK')))
    expect(after[row]).toContain('Which size?')
  })

  test(`${surface}: /god repos repo-a keeps only the rows of repo-a and its worktree, /god repos prints the set, f and /god all show every row`, async ($, on) => {
    const { clock } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    const set = await $.command.run(god('repos repo-a'))
    expect(set.text).toBe('The god pane shows the sessions of these repos: repo-a.')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
    const shown = async (): Promise<string[]> => {
      await ui.redraw()
      const lines = screenOf(await ui.drawn())
      return Object.entries(ROW).flatMap(([name, row]) => (lines.some((line) => line.includes(row)) ? [name] : []))
    }
    expect(await shown()).toEqual(['ask-a', 'work-wt'])
    expect((await $.command.run(god('repos'))).text).toBe('The repos mode shows these repos: repo-a.')
    await ui.press({ key: 'key:f' })
    expect(await shown()).toEqual(['ask-a', 'work-wt', 'stuck-b', 'idle-p'])
    await ui.press({ key: 'key:f' })
    expect(await shown()).toEqual(['ask-a', 'work-wt'])
    expect((await $.command.run(god('all'))).text).toBe('The god pane shows every live session.')
    expect(await shown()).toEqual(['ask-a', 'work-wt', 'stuck-b', 'idle-p'])
    expect((await $.command.run(god('repos'))).text).toBe('No repo is selected. Run /god repos <name> to select one.')
    await ui.press({ key: 'key:f' })
    await ui.redraw()
    const empty = screenOf(await ui.drawn())
    expect(empty).toContain(' No repo is selected. Type /god repos and a repo name.')
    expect(await shown()).toEqual([])
    await ui.press({ key: 'key:f' })
    expect(await shown()).toEqual(['ask-a', 'work-wt', 'stuck-b', 'idle-p'])
  })

  test(`${surface}: below 90 columns only the board draws, and from 90 the detail column sits right of a rule and asks for a selection`, async ($, on) => {
    const { clock } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(89, 30) })
    const narrow = screenOf(await ui.drawn())
    expect(narrow.join('\n')).not.toMatch(/[│┬┴]/)
    expect(narrow.join('\n')).not.toContain('Select a session')
    await ui.redraw(paneProps(110, 30))
    const wide = screenOf(await ui.drawn())
    expect(wide.some((line) => line.includes('┬'))).toBe(true)
    expect(wide.some((line) => line.includes('│ Select a session on the board to show its detail.')), wide.join('\n')).toBe(true)
    for (const line of narrow) expect([...line].length, line).toBeLessThanOrEqual(89)
    for (const line of wide) expect([...line].length, line).toBeLessThanOrEqual(110)
  })

  test(`${surface}: the header says who holds the keys and the key that hands them over, and the key row does not`, async ($, on) => {
    const { clock } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(160, 30) })
    const head = async (): Promise<string> => screenOf(await ui.drawn()).slice(0, 2).join('\n')
    expect(await head()).toContain('  keys: pane · Esc: prompt')
    await ui.redraw({ ...paneProps(160, 30), isFocused: false })
    expect(await head()).toContain('  keys: prompt · ctrl+x tab: pane')
    expect(screenOf(await ui.drawn()).slice(2).join('\n')).not.toContain('ctrl+x tab')
    // r writes a prompt and m a peer note: 2 labels that do not look like 1 action
    expect(screenOf(await ui.drawn()).join('\n')).toContain('  r: prompt  m: peer note  ')
  })

  test(`${surface}: every host command runs with the 5 s timeout, only the TZ variable and a command of the allowlist`, async ($, on) => {
    const { clock, calls } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    await clock.advance(2000)
    expect(calls.runs.length).toBeGreaterThan(4)
    for (const run of calls.runs) {
      expect(ALLOWED).toContain(run.argv[0])
      expect(run.init?.timeoutMs, run.argv.join(' ')).toBe(5000)
      expect(Object.keys(run.init?.env ?? {}).filter((key) => key !== 'TZ')).toEqual([])
    }
  })

  test(`${surface}: the snapshot is written only when it changed, and the first-sight times reach the store`, async ($, on) => {
    const { clock, calls, machine, t0 } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    const written = calls.boardWrites
    expect(written).toBeGreaterThan(0)
    const seen = calls.storeSets.find(([key]) => key === 'seenAt')
    expect(Object.keys((seen?.[1] ?? {}) as Record<string, number>).sort()).toEqual(['ses-idle', 'ses-stuck', 'ses-wait', 'ses-work'])
    await clock.advance(2000)
    expect(calls.boardWrites).toBe(written)
    expect(calls.storeSets.filter(([key]) => key === 'seenAt')).toHaveLength(1)
    Object.assign(machine.sessions[0]!, { status: 'busy', statusUpdatedAt: t0 + 100, fileMtimeMs: t0 + 100 })
    await clock.advance(2000)
    expect(calls.boardWrites).toBe(written + 1)
  })

  test(`${surface}: n selects the session that needs you, g groups by repo, a move of the ring selects its row`, async ($, on) => {
    const { clock, calls } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
    const marked = async (): Promise<string[]> => {
      await ui.redraw()
      return screenOf(await ui.drawn()).filter((line) => line.startsWith('▌'))
    }
    expect(await marked()).toEqual([])
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'ses-idle', origin: { kind: 'person' } })
    expect((await marked()).join('')).toContain(ROW['idle-p'])
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'key:n', origin: { kind: 'person' } })
    expect((await marked()).join('')).toContain(ROW['idle-p'])
    await ui.press({ key: 'key:n' })
    expect((await marked()).join('')).toContain(ROW['ask-a'])
    await ui.press({ key: 'key:g' })
    const lines = screenOf(await ui.drawn())
    expect(lines.some((line) => line.trim() === 'repo-a')).toBe(true)
    expect(calls.storeSets).toContainEqual(['groupBy', 'repo'])
  })

  test(`${surface}: while the pane is not on the screen the status line counts the sessions that need you`, async ($, on) => {
    const { clock, calls } = await begin($, on, surface, { unplacedOpens: 1 }, { ORANGU_GOD: '1' })
    await clock.settle()
    expect(calls.statuses).toEqual(['god: 1 needs you'])
    await $.command.run(god())
    expect(calls.statuses).toEqual(['god: 1 needs you', undefined])
  })

  test(`${surface}: the status line goes when the engine places the pane later, and comes back when the pane closes`, { plugins: [CLOSER] }, async ($, on) => {
    const { clock, calls } = await begin($, on, surface, { unplacedOpens: 1 }, { ORANGU_GOD: '1' })
    await clock.settle()
    expect(calls.statuses).toEqual(['god: 1 needs you'])
    await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(110, 30) })
    expect(calls.statuses).toEqual(['god: 1 needs you', undefined])
    await $.command.run({ ...god(), command: 'close-god' })
    expect(calls.statuses).toEqual(['god: 1 needs you', undefined, 'god: 1 needs you'])
  })

  test(`${surface}: when the id of the god session changes with no session.start (a /clear), the new id gets no row`, async ($, on) => {
    const { clock } = await begin($, on, surface, { selfIdAtStart: 'god-self-before', selfId: 'god-self-after' })
    await $.command.run(god())
    await clock.settle()
    // the first tick read the id before the /clear; the next tick reads the new one
    await clock.advance(2000)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
    const keys = (await ui.findAll({ type: 'Button' })).map((button) => button.key)
    expect(keys.filter((key) => key?.startsWith('god-self'))).toEqual([])
    expect(keys.filter((key) => key?.startsWith('ses-'))).toHaveLength(4)
  })

  test(`${surface}: the pane draws with the colors of the session theme, and follows a change of it`, async ($, on) => {
    const { clock, machine } = await begin($, on, surface)
    await $.command.run(god())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
    const headingColor = async (): Promise<unknown> => {
      await ui.redraw()
      return (await ui.findAll({ type: 'Text', text: 'NEEDS YOU' })).find((text) => text.props['color'] !== undefined)?.props['color']
    }
    // the --bad token of src/report/client/tokens.css: the dark set with no theme row, the light set for `light`
    expect(await headingColor()).toBe('#f0a08b')
    machine.theme = 'light'
    await clock.advance(2000)
    expect(await headingColor()).toBe('#a03016')
  })
}

/** The board of a machine where work-wt went busy 3 min ago and last wrote 2 min ago. */
async function silentBoard($: Engine, on: On): Promise<string[]> {
  const { clock, machine, t0 } = await begin($, on, 'terminal')
  Object.assign(machine.sessions.find((session) => session.sessionId === 'ses-work')!, { statusUpdatedAt: t0 - 180_000, transcriptMtimeMs: t0 - 120_000 })
  await $.command.run(god())
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(80, 30) })
  return screenOf(await ui.drawn())
}

const levelOf = (lines: readonly string[], name: string): string | undefined => {
  const row = lines.findIndex((line) => line.includes(name))
  return lines.slice(0, row).reverse().find((line) => /^ (NEEDS YOU|YOUR TURN|STUCK|WORKING|IDLE|STALE)\b/.test(line))?.trim()
}

test('the stuck limit comes from the userConfig value: 1 min of silence is stuck under stuckAfterMin 1', { options: { stuckAfterMin: 1 } }, async ($, on) => {
  expect(levelOf(await silentBoard($, on), ROW['work-wt'])).toBe('STUCK')
})

test('the stuck limit is 10 min when the userConfig value is not set', async ($, on) => {
  expect(levelOf(await silentBoard($, on), ROW['work-wt'])).toBe('WORKING')
})
