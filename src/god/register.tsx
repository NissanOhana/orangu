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
//   top. The keys n, f, g, t and b are hotkey Buttons of the key row, and w and z the count lines of the detail.
//   The rules of the detail controls are in src/god/detail-control.ts.
// - The pane asks for its rows inline above the prompt and for its columns in the dock.
// - The pane is on the screen from its first draw (the engine can place an unasked pane later) until ui.close. The
//   status line shows only while it is not.
// - Each hook that can fail has a .catch: the pane then draws the line that says it cannot draw.
import { read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { createBoardLoop, type BoardLoop } from './board-loop.js'
import { TICK_MS, createCollector } from './collector.js'
import { STORE_KEYS, commandAnswer, commandChoice, nextNeedsYou, openGroupsAfterPress, parseGodArgs, selectionOf, settingsOf, storeOf, toggledGroup, toggledMode, type BoardChoice } from './control.js'
import { GOD_ARGUMENT_HINT, GOD_COMMAND_DESCRIPTION, GOD_FAILED, PANE_TITLE } from './copy.js'
import { detailAfterBack, detailAfterNextTab, detailAfterRowPress, detailAfterScroll, detailAfterSelect, detailAfterTab } from './detail-control.js'
import { engineClock, engineHost } from './engine.js'
import { BOARD, DETAIL, OPEN_GROUPS, SELECTED, THEME } from './state.js'
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
 * The state of 1 load of the module: the settings, whether the pane is on the screen, the board once it runs, and the
 * last theme that it read.
 */
type Runtime = { settings: Settings; isPaneOpen: boolean; starting?: Promise<BoardLoop>; board?: BoardLoop; theme?: string }

async function readTheme($: EngineInterface, runtime: Runtime): Promise<void> {
  const next = themeOf((await $.config.list()).find((row) => row.key === 'theme')?.value)
  if (next === runtime.theme) return
  await update($, THEME, () => next)
  runtime.theme = next
}

async function startBoard($: EngineInterface, runtime: Runtime): Promise<BoardLoop> {
  const home = (await $.env.get('HOME')) ?? ''
  const stored = await Promise.all(STORE_KEYS.map(async (key) => [key, await $.store.get(key)] as const))
  const collector = createCollector({ host: engineHost($), home, clock: engineClock })
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

/** Opens the pane, starts the board, and tells the board whether the pane is on the screen. */
async function openPane($: EngineInterface, runtime: Runtime): Promise<{ loop: BoardLoop; isPlaced: boolean }> {
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

async function pressRow($: EngineInterface, key: string, layout: PaneLayout): Promise<void> {
  const snapshot = (await read($, BOARD)) ?? undefined
  await update($, OPEN_GROUPS, (groups) => openGroupsAfterPress(groups, key, snapshot))
  await select($, key)
  await update($, DETAIL, (state) => detailAfterRowPress(state, key, snapshot, layout))
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
    onRow: (key) => quiet(pressRow($, key, layout)),
    onMore: (key) => quiet(selectAndFocus($, key)),
    keys: {
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
    if ((await $.env.get('ORANGU_GOD')) === '1') void openPane($, runtime).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'god' }, async ($, e) => {
    const command = parseGodArgs(e.args)
    if (command.kind === 'unknown') return { text: commandAnswer(command, { isPlaced: false, repos: [] }) }
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
    const [snapshot, selected, openGroups, colors, detail] = await Promise.all([read($, BOARD), read($, SELECTED), read($, OPEN_GROUPS), read($, THEME), read($, DETAIL)])
    const view = paneView({
      ...(snapshot === null ? {} : { snapshot }),
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      now: engineClock(),
      ...(selected === '' ? {} : { selectedKey: selected }),
      openGroups,
      promptHoldsKeys: !e.props.isFocused,
      detail,
    })
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
    return closed
  }).catch(($, e, next) => next(e))
}
