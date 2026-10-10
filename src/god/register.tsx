// The hooks module of orangu god: wiring only, with no rule. scripts/build.mjs bundles it to god/hooks/god.mjs.
// register is a function declaration, because the engine validator refuses an exported arrow, and every function
// that takes `$` is a function declaration at the top of the file, because the engine loads a module only when it
// can follow `$` to its call sites. The state of 1 load lives in the Runtime that register makes.
// - session.start registers /god. When ORANGU_GOD is 1, it also opens the pane and starts the board. Else nothing
//   runs before /god: no host command, no file read, no timer, no pane.
// - /god opens the pane and starts the board once: the collector over the host port, the board loop over the
//   engine state and store, and 1 timer of TICK_MS. The rules of each form are in src/god/control.ts.
// - The pane draws the last snapshot from the engine state through the view (src/god/view/pane.ts). The selected
//   row comes from the moves of the focus ring (ui.focus), n, a press on a row, and a press on a count line of the
//   board, which also moves the ring onto the row that it selects. Each new selection starts the detail at its
//   top. The keys j, n, f, g, t and b are hotkey Buttons of the key row, and w and z the count lines of the detail.
//   The rules of the detail controls are in src/god/detail-control.ts.
// - j jumps to the cmux tab of the selected session (src/god/act/jump.ts). A jump and a press on a session row (an
//   open) mark the session seen. The note of a j that did not jump goes to the engine state for the key row.
// - The Screen tab: each draw tells the screen loop (src/god/screen-loop.ts) which tab the shared state asks for and
//   whether this draw shows it. The loop reads that tab every 1 s through the host port and writes each read to the
//   engine state. The pane that closes stops it.
// - The 2 tools (src/god/tools.ts) register once, the first time the pane opens (before the first prompt when
//   ORANGU_GOD is 1), with their schema in the prompt. Each tool.call hook answers from the last snapshot that the
//   board took. The tools only read.
// - /god stats answers from the stats of the last refreshes of the board, and opens nothing.
// - The pane asks for its rows inline above the prompt and for its columns in the dock.
// - The pane is on the screen from its first draw (the engine can place an unasked pane later) until ui.close. The
//   status line shows only while it is not.
// - Each hook that can fail has a .catch: the pane then draws the line that says it cannot draw.
import { read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { jumpNoteOf, jumpPlan, jumpedSessionOf, runJump } from './act/jump.js'
import { createBoardLoop, type BoardLoop } from './board-loop.js'
import { TICK_MS, createCollector } from './collector.js'
import { STORE_KEYS, commandAnswer, commandChoice, nextNeedsYou, openGroupsAfterPress, openedSessionOf, parseGodArgs, selectionOf, settingsOf, statsAnswer, storeOf, toggledGroup, toggledMode, type BoardChoice } from './control.js'
import { GOD_ARGUMENT_HINT, GOD_COMMAND_DESCRIPTION, GOD_FAILED, PANE_TITLE, TOOL_FAILED } from './copy.js'
import { detailAfterBack, detailAfterNextTab, detailAfterRowPress, detailAfterScroll, detailAfterSelect, detailAfterTab } from './detail-control.js'
import { engineClock, engineHost } from './engine.js'
import { textCleaner } from './sanitize.js'
import { createScreenLoop, isScreenShown, screenWanted, type ScreenLoop } from './screen-loop.js'
import { readScreenOf } from './source/screen.js'
import { BOARD, DETAIL, JUMP, OPEN_GROUPS, SCREEN, SELECTED, THEME } from './state.js'
import { BOARD_TOOL, SESSION_TOOL, boardToolAnswer, sessionToolAnswer, type ToolBoard } from './tools.js'
import type { Settings, StoreState } from './types.js'
import { drawPane, type PaneActions } from './ui/board.js'
import { themeOf } from './ui/theme.js'
import type { DetailState } from './view/detail-pane.js'
import { cannotDrawView, layoutOf, paneView } from './view/pane.js'
import type { PaneLayout } from './view/types.js'

/** The id of the pane, the width that it asks for beside a fullscreen transcript, and the rows above the prompt. */
const PANE = 'god'
const PANE_COLUMNS = 110
const PANE_ROWS = 20

/**
 * The state of 1 load of the module: the settings, whether the pane is on the screen, the board and the screen loop
 * once they run, the last theme that it read, and whether the 2 tools are registered.
 */
type Runtime = { settings: Settings; isPaneOpen: boolean; starting?: Promise<BoardLoop>; board?: BoardLoop; screen?: ScreenLoop; theme?: string; hasTools?: boolean }

async function readTheme($: EngineInterface, runtime: Runtime): Promise<void> {
  const next = themeOf((await $.config.list()).find((row) => row.key === 'theme')?.value)
  if (next === runtime.theme) return
  await update($, THEME, () => next)
  runtime.theme = next
}

async function startBoard($: EngineInterface, runtime: Runtime): Promise<BoardLoop> {
  const home = (await $.env.get('HOME')) ?? ''
  const stored = await Promise.all(STORE_KEYS.map(async (key) => [key, await $.store.get(key)] as const))
  const host = engineHost($)
  const collector = createCollector({ host, home, clock: engineClock })
  const clean = textCleaner(home)
  runtime.screen = createScreenLoop({
    read: (target) => readScreenOf(host, target, clean, engineClock),
    write: async (state) => {
      await update($, SCREEN, () => state)
    },
    every: (ms, fn) => $.clock.every(ms, fn),
  })
  const loop = createBoardLoop({
    ports: {
      refresh: () => collector.refresh(),
      clock: engineClock,
      selfId: () => $.session.id(),
      writeSnapshot: async (snapshot) => {
        await update($, BOARD, () => snapshot)
      },
      writeStore: (key, value) => $.store.set(key, value),
      showStatus: (text) => $.ui.status(text),
      redraw: () => $.ui.invalidate('ui.render'),
    },
    store: storeOf(Object.fromEntries(stored)),
    settings: runtime.settings,
    paneStartedAt: engineClock(),
    isPaneOpen: runtime.isPaneOpen,
  })
  const tick = (): void => {
    void loop.tick()
    void readTheme($, runtime).catch(() => undefined)
  }
  $.clock.every(TICK_MS, tick)
  tick()
  runtime.board = loop
  return loop
}

/** The board, started once. A start that failed starts again on the next call. */
function start($: EngineInterface, runtime: Runtime): Promise<BoardLoop> {
  runtime.starting ??= startBoard($, runtime).catch((error: unknown) => {
    delete runtime.starting
    throw error
  })
  return runtime.starting
}

/** Registers the 2 tools once. A registration that fails leaves the pane as it is, and the next open tries again. */
async function registerTools($: EngineInterface, runtime: Runtime): Promise<void> {
  if (runtime.hasTools === true) return
  await $.tool.register(BOARD_TOOL)
  await $.tool.register(SESSION_TOOL)
  runtime.hasTools = true
}

/** The board that the tools read: whether it runs in this load, and the last snapshot that it took. */
function toolBoard(runtime: Runtime): ToolBoard {
  const snapshot = runtime.board?.snapshot()
  return { isRunning: runtime.board !== undefined || runtime.starting !== undefined, ...(snapshot === undefined ? {} : { snapshot }) }
}

/** Opens the pane, starts the board, and tells the board whether the pane is on the screen. */
async function openPane($: EngineInterface, runtime: Runtime): Promise<{ loop: BoardLoop; isPlaced: boolean }> {
  await registerTools($, runtime).catch(() => undefined)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
  runtime.isPaneOpen = opened.isPlaced
  const loop = await start($, runtime)
  loop.setPaneOpen(opened.isPlaced)
  return { loop, isPlaced: opened.isPlaced }
}

/** The pane draws, so the engine placed it: the status line goes. */
function markPaneShown(runtime: Runtime): void {
  if (runtime.isPaneOpen) return
  runtime.isPaneOpen = true
  runtime.board?.setPaneOpen(true)
}

async function choose($: EngineInterface, runtime: Runtime, choice: (store: StoreState) => BoardChoice): Promise<void> {
  const loop = await start($, runtime)
  await loop.choose(choice(loop.store()))
}

/** Selects the row `key`. A new selected row starts the detail at the top of its tab. */
async function select($: EngineInterface, key: string): Promise<void> {
  const before = await read($, SELECTED)
  if (before === key) return
  await update($, SELECTED, () => key)
  await update($, DETAIL, (state) => detailAfterSelect(state, before, key))
  await update($, JUMP, () => null)
}

/** Selects the row `key` and moves the focus ring onto it, so the arrows and Tab go on from there. */
async function selectAndFocus($: EngineInterface, key: string): Promise<void> {
  await select($, key)
  await $.ui.focus({ requestId: PANE, key })
}

async function selectNext($: EngineInterface): Promise<void> {
  const next = nextNeedsYou((await read($, BOARD)) ?? undefined, (await read($, SELECTED)) || undefined)
  if (next !== undefined) await selectAndFocus($, next)
}

async function pressRow($: EngineInterface, runtime: Runtime, key: string, layout: PaneLayout): Promise<void> {
  const snapshot = (await read($, BOARD)) ?? undefined
  await update($, OPEN_GROUPS, (groups) => openGroupsAfterPress(groups, key, snapshot))
  await select($, key)
  await update($, DETAIL, (state) => detailAfterRowPress(state, key, snapshot, layout))
  const opened = openedSessionOf(key, snapshot)
  if (opened !== undefined) await runtime.board?.seen(opened, engineClock())
}

/** j: the jump to the tab of the selected session, the note of a j that did not jump, and the seen mark of a jump. */
async function jumpSelected($: EngineInterface, runtime: Runtime): Promise<void> {
  const outcome = await runJump(engineHost($), jumpPlan((await read($, BOARD)) ?? undefined, (await read($, SELECTED)) || undefined))
  await update($, JUMP, () => jumpNoteOf(outcome))
  const jumped = jumpedSessionOf(outcome)
  if (jumped !== undefined) await runtime.board?.seen(jumped, engineClock())
}

async function changeDetail($: EngineInterface, change: (state: DetailState) => DetailState): Promise<void> {
  await update($, DETAIL, change)
}

/** b: the board again, with the focus ring on the selected row. */
async function backToBoard($: EngineInterface): Promise<void> {
  await update($, DETAIL, detailAfterBack)
  const selected = await read($, SELECTED)
  if (selected !== '') await $.ui.focus({ requestId: PANE, key: selected })
}

/** The presses of the pane. A press that fails changes nothing, and the next press tries again. */
function actionsOf($: EngineInterface, runtime: Runtime, layout: PaneLayout): PaneActions {
  const quiet = (work: Promise<void>): void => void work.catch(() => undefined)
  return {
    onRow: (key) => quiet(pressRow($, runtime, key, layout)),
    onMore: (key) => quiet(selectAndFocus($, key)),
    keys: {
      j: () => quiet(jumpSelected($, runtime)),
      n: () => quiet(selectNext($)),
      f: () => quiet(choose($, runtime, toggledMode)),
      g: () => quiet(choose($, runtime, toggledGroup)),
      t: () => quiet(changeDetail($, detailAfterNextTab)),
      b: () => quiet(backToBoard($)),
    },
    detail: {
      onTab: (tab) => quiet(changeDetail($, (state) => detailAfterTab(state, tab))),
      onScroll: (scroll) => quiet(changeDetail($, (state) => detailAfterScroll(state, scroll))),
      // the digits and the answer come with the answer path: until then a press on an option does nothing
      onOption: () => undefined,
    },
  }
}

/** The presses of the line that says the pane cannot draw: it has no Button. */
const NO_ACTIONS: PaneActions = { onRow: () => undefined, onMore: () => undefined, keys: {}, detail: { onTab: () => undefined, onScroll: () => undefined, onOption: () => undefined } }

export function register(on: On, options: PluginOptions): void {
  const runtime: Runtime = { settings: settingsOf(options), isPaneOpen: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'god', description: GOD_COMMAND_DESCRIPTION, argumentHint: GOD_ARGUMENT_HINT })
    if ((await $.env.get('ORANGU_GOD')) === '1') {
      // awaited here, so the first prompt of the session lists the tools
      await registerTools($, runtime).catch(() => undefined)
      void openPane($, runtime).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'god' }, async ($, e) => {
    const command = parseGodArgs(e.args)
    if (command.kind === 'unknown') return { text: commandAnswer(command, { isPlaced: false, repos: [] }) }
    if (command.kind === 'stats') return { text: statsAnswer(runtime.board?.recentStats()) }
    if (command.kind === 'show-repos') {
      const repos = runtime.board?.store().repos ?? storeOf({ repos: await $.store.get('repos') }).repos
      return { text: commandAnswer(command, { isPlaced: false, repos }) }
    }
    const { loop, isPlaced } = await openPane($, runtime)
    const choice = commandChoice(command)
    if (choice !== undefined) await loop.choose(choice)
    return { text: commandAnswer(command, { isPlaced, repos: loop.store().repos }) }
  }).catch(() => ({ text: GOD_FAILED }))

  on('ui.render', { component: 'Pane', requestId: 'god' }, async ($, e) => {
    markPaneShown(runtime)
    const [snapshot, selected, openGroups, colors, detail, screen, jumpNote] = await Promise.all([read($, BOARD), read($, SELECTED), read($, OPEN_GROUPS), read($, THEME), read($, DETAIL), read($, SCREEN), read($, JUMP)])
    const view = paneView({
      ...(snapshot === null ? {} : { snapshot }),
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      now: engineClock(),
      ...(selected === '' ? {} : { selectedKey: selected }),
      openGroups,
      promptHoldsKeys: !e.props.isFocused,
      detail,
      screen,
      jumpNote,
    })
    const wanted = screenWanted(snapshot ?? undefined, selected || undefined, detail.tab)
    runtime.screen?.want(wanted, isScreenShown(view, wanted))
    return drawPane($.ui.resolve(e), view, colors, actionsOf($, runtime, layoutOf(e.props.bodyColumns)))
  }).catch(($, e) => drawPane($.ui.resolve(e), cannotDrawView('failed', e.props.bodyColumns), 'dark', NO_ACTIONS))

  on('ui.focus', { component: 'Pane', requestId: 'god' }, async ($, e, next) => {
    const moved = await next(e)
    const key = moved.deny === undefined ? selectionOf(e.element, (await read($, BOARD)) ?? undefined) : undefined
    if (key !== undefined) await select($, key)
    return moved
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: 'god' }, async ($, e, next) => {
    const closed = await next(e)
    runtime.isPaneOpen = false
    runtime.board?.setPaneOpen(false)
    runtime.screen?.stop()
    return closed
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__orangu-god__board' }, async () => ({ result: boardToolAnswer(toolBoard(runtime), engineClock()) })).catch(() => ({ deny: TOOL_FAILED }))

  on('tool.call', { tool: 'mcp__orangu-god__session' }, async ($, e) => ({ result: sessionToolAnswer(toolBoard(runtime), e.name, engineClock()) })).catch(() => ({ deny: TOOL_FAILED }))
}
