// The motion of the god pane on the terminal and the desktop surfaces, over the fake machine: the spinner of a WORKING
// row moves 1 frame each 125 ms, the NEEDS YOU row switches its bold each 500 ms, and the header of the terminal
// shows the sparkline as 1 Raster. The motion timer is the clock.every timer of 125 ms or 500 ms: the motion option
// off starts none, a board with no working and no waiting row starts none until a session works, and the pane that
// closes or that no surface draws stops it. The desktop tree has no Raster. The test engine draws again on an
// invalidate only when the test reads the drawing, so a test with no read draws nothing.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, PANE, PLUGIN, SURFACES, edit, installMachine, paneProps, prompt, question, reply, type FakeSession, type Machine } from './fake-host'

const A = '/tmp/god-test/repo-a'
const PLAIN = '/tmp/god-test/plain'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const MOTION_MS = [125, 500]

/** A working session, a waiting session with a question, and an idle session. */
function movingAt(t0: number): FakeSession[] {
  return [
    { pid: 47001, sessionId: 'ses-work', cwd: A, name: 'work-a', status: 'busy', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Fix the parser.', t0 - 60_000), edit('toolu_e1', `${A}/parse.ts`, t0 - 5_000)], transcriptMtimeMs: t0 - 5_000, fileMtimeMs: t0 - 60_000 },
    { pid: 47002, sessionId: 'ses-wait', cwd: A, name: 'ask-a', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: t0 - 60_000, transcript: [prompt('Pick a color.', t0 - 90_000), question('toolu_q1', 'Which color?', ['Red', 'Green'], t0 - 60_000)], transcriptMtimeMs: t0 - 60_000, fileMtimeMs: t0 - 60_000 },
    { pid: 47003, sessionId: 'ses-idle', cwd: PLAIN, name: 'idle-p', status: 'idle', statusUpdatedAt: t0 - 3_600_000, transcript: [prompt('Fix the docs.', t0 - 3_700_000), ...reply('Done.', t0 - 3_600_000)], transcriptMtimeMs: t0 - 3_600_000, fileMtimeMs: t0 - 3_600_000 },
  ]
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

/**
 * The motion timer record (beneath the plugin and above the mock clock, so the clock still holds each wait), the fake
 * machine, the session start, /god, the first refresh, and the pane mounted. Each period of a timer dispatches
 * clock.every once, so the record grows by 1 for each tick of a live motion timer.
 */
async function begin($: Engine, on: On, surface: (typeof SURFACES)[number], sessions: (t0: number) => FakeSession[] = movingAt) {
  const timers: number[] = []
  on('clock.every', { ms: MOTION_MS }, (_$, e, next) => {
    timers.push(e.ms)
    return next(e)
  })
  const t0 = Date.now()
  const machine: Machine = { sessions: sessions(t0), repos: { [A]: [`${A}/.git`, `${A}/.git`, A] } }
  installMachine(on, machine)
  const clock = mock.clock(on, { now: t0 })
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: PLAIN, surface, isInteractive: true })
  await $.command.run(god())
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(110, 30) })
  return { timers, clock, ui, machine, t0 }
}

type Ui = Mounted<'terminal' | 'desktop', 'Pane'>

/** The glyph of a session row: the second character of its Button text, after the selection mark. */
async function glyphOf(ui: Ui, sessionId: string): Promise<string> {
  await ui.redraw()
  return [...((await ui.find({ key: sessionId }))?.text ?? '')][1] ?? ''
}

/** Whether the glyph of the NEEDS YOU row draws bold now: the bold of the Text in the row Button that holds the glyph. */
async function isPulseBold(ui: Ui): Promise<boolean> {
  await ui.redraw()
  const row = await ui.find({ key: 'ses-wait' })
  const glyph = row?.children.find((child) => (child as { children?: unknown[] }).children?.join('') === '⚠') as { props?: Record<string, unknown> } | undefined
  return glyph?.props?.['bold'] === true
}

for (const surface of SURFACES) {
  test(`${surface}: the spinner of a WORKING row moves 1 frame each 125 ms, and the NEEDS YOU row switches its bold each 500 ms`, async ($, on) => {
    const { clock, ui, timers } = await begin($, on, surface)
    expect(timers).toEqual([125])
    const frames = [await glyphOf(ui, 'ses-work')]
    for (let step = 0; step < 3; step += 1) {
      await clock.advance(125)
      frames.push(await glyphOf(ui, 'ses-work'))
    }
    expect(frames).toEqual([...SPINNER.slice(0, 4)])
    expect(await isPulseBold(ui)).toBe(false)
    await clock.advance(125)
    expect(await isPulseBold(ui)).toBe(true)
    await clock.advance(500)
    expect(await isPulseBold(ui)).toBe(false)
  })

  test(`${surface}: the motion option off starts no motion timer, and the rows keep the static frame`, { options: { motion: 'off' } }, async ($, on) => {
    const { clock, ui, timers } = await begin($, on, surface)
    const glyphs: string[] = []
    for (let step = 0; step < 4; step += 1) {
      glyphs.push(await glyphOf(ui, 'ses-work'))
      expect(await isPulseBold(ui)).toBe(false)
      await clock.advance(250)
    }
    expect(timers).toEqual([])
    expect(glyphs).toEqual(['⠋', '⠋', '⠋', '⠋'])
    expect(await ui.findAll({ type: 'Raster' })).toEqual([])
  })

  test(`${surface}: a board with no working and no waiting row starts no motion timer, and a session that starts to work starts it`, async ($, on) => {
    const quiet = (t0: number): FakeSession[] => movingAt(t0).map((session) => ({ ...session, status: 'idle', waitingFor: undefined, transcript: [prompt('Fix the docs.', t0 - 3_700_000), ...reply('Done.', t0 - 3_600_000)], transcriptMtimeMs: t0 - 3_600_000 }))
    const { clock, ui, timers, machine, t0 } = await begin($, on, surface, quiet)
    await ui.redraw()
    await clock.advance(1000)
    await ui.redraw()
    expect(timers).toEqual([])
    const working = machine.sessions.find((session) => session.sessionId === 'ses-work')!
    Object.assign(working, { status: 'busy', statusUpdatedAt: t0 + 1_500, fileMtimeMs: t0 + 1_500, transcript: [prompt('Fix the parser.', t0 + 1_000), edit('toolu_e2', `${A}/parse.ts`, t0 + 1_500)], transcriptMtimeMs: t0 + 1_500 })
    await clock.advance(1000)
    await ui.redraw()
    expect(timers).toEqual([125])
    expect(await glyphOf(ui, 'ses-work')).toBe('⠋')
  })

  test(`${surface}: the motion timer stops when no surface draws the pane, and when the pane closes`, { plugins: [CLOSER] }, async ($, on) => {
    const { clock, ui, timers } = await begin($, on, surface)
    // no redraw: the pane is on no screen, so the timer stops after its lease of 2 ticks
    await clock.advance(1000)
    const hidden = timers.length
    expect(hidden).toBeLessThanOrEqual(5)
    await clock.advance(1000)
    expect(timers.length).toBe(hidden)
    await ui.redraw()
    const restarted = timers.length
    expect(restarted).toBe(hidden + 1)
    await $.command.run({ ...god(), command: 'close-god' })
    await clock.advance(1000)
    expect(timers.length).toBe(restarted)
  })
}

test('terminal: the header shows the sparkline of the last 30 min as 1 Raster of 30 columns and 1 row, with its label', async ($, on) => {
  const { clock, ui } = await begin($, on, 'terminal')
  await clock.advance(2000)
  await ui.redraw()
  const rasters = await ui.findAll({ type: 'Raster' })
  expect(rasters.map((raster) => [raster.key, raster.props['columns'], raster.props['rows']])).toEqual([['spark', 30, 1]])
  expect(await ui.find({ type: 'Text', text: ' 30m' })).toBeDefined()
  // each cell is 3 little-endian u32: the glyph, the color and the background. 1 session works in the last minute
  // (and in the minute before, when the 2 ticks fall in 2 minutes), in the WORKING color of the dark set.
  const bytes = Uint8Array.from(atob(String(rasters[0]!.props['cells'])), (char) => char.charCodeAt(0))
  const words = new DataView(bytes.buffer)
  const glyphs = String.fromCodePoint(...Array.from({ length: 30 }, (_, cell) => words.getUint32(cell * 12, true)))
  expect(glyphs).toMatch(/^ {28}[ █]█$/)
  expect(words.getUint32(29 * 12 + 4, true)).toBe(Number.parseInt('7fa8d8', 16))
})

test('desktop: the tree has no Raster, and the header has no sparkline label', async ($, on) => {
  const { clock, ui } = await begin($, on, 'desktop')
  await clock.advance(2000)
  await ui.redraw()
  expect(await ui.findAll({ type: 'Raster' })).toEqual([])
  expect(await ui.find({ type: 'Text', text: ' 30m' })).toBeUndefined()
})
