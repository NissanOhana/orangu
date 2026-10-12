// The hooks module of orangu god: wiring only, with no rule. scripts/build.mjs bundles it to god/hooks/god.mjs.
// register is a function declaration, because the engine validator refuses an exported arrow, and every function
// that takes `$` is a function declaration at the top of the file, because the engine loads a module only when it
// can follow `$` to its call sites. The state of 1 load lives in the Runtime that register makes.
// - session.start registers /god. When ORANGU_GOD is 1, it also opens the pane and starts the board. Else nothing
//   runs before /god: no host command, no file read, no timer, no pane.
// - /god opens the pane and starts the board once: the collector over the host port, the board loop over the
//   engine state and store, and 1 timer of TICK_MS. The rules of each form are in src/god/control.ts. A /god open
//   asks for the keys (focus), and the open of ORANGU_GOD does not: the engine gives the keys only to an open that
//   the person asked for.
// - The pane draws the last snapshot from the engine state through the view (src/god/view/pane.ts). The selected
//   row comes from the moves of the focus ring (ui.focus), n, a press on a row, and a press on a count line of the
//   board, which also moves the ring onto the row that it selects. Each new selection starts the detail at its
//   top. A choice of the board (f, g, a /god form) clears a selected row that the new board does not show. The keys
//   j, n, f, g, t, b and h are hotkey Buttons of the key row, and w and z the count lines of the detail.
// - h shows the help in place of the detail, and h again closes it. Esc closes it too: a draw while the prompt holds
//   the keys shows no help, and the next tick of the board writes the closed state, because a draw may not write the
//   engine state. Each draw notes whether the pane holds the keys.
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
// - The key path (src/god/deliver-keys.tsx): a digit on an option, the Yes or No of a Bash request, r and m open the
//   confirm bar or the draft, a digit and p pick in a dialog with 2 or more questions, and only y in the bar sends.
//   After each tick the check of the last send reads the newest facts.
// - The alerts (src/god/alert-keys.tsx): each tick of the board hands its turn to the alert loop, which plays the tone,
//   sends the notification and rings the cmux tab of an alert. s turns the tones off and on, and u mutes the selected
//   session. /god stats adds the counts of the alert loop.
// - The Recap (src/god/recap-keys.tsx): only x on the Recap tab of a session makes a model call, 1 at a time.
// - The selection keys are in src/god/select-keys.tsx.
// - The motion (src/god/motion-keys.tsx): each draw tells the motion loop its period, and ui.close stops the loop.
// - The pane asks for its rows inline above the prompt and for its columns in the dock: more columns than any
//   terminal has, so the dock takes the full width less the strip that the engine keeps for the transcript.
// - The pane is on the screen from its first draw (the engine can place an unasked pane later) until ui.close. The
//   status line shows only while it is not.
// - Each hook that can fail has a .catch: the pane then draws the line that says it cannot draw.
import { read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { alertLoopOf, toggleMute, toggleSound } from './alert-keys.js'
import type { AlertLoop } from './alert-loop.js'
import { createBoardLoop, type BoardLoop } from './board-loop.js'
import { TICK_MS, createCollector } from './collector.js'
import { STORE_KEYS, commandAnswer, commandChoice, parseGodArgs, selectionOf, settingsOf, statsAnswer, storeOf, toggledGroup, toggledMode, type BoardChoice } from './control.js'
import { GOD_ARGUMENT_HINT, GOD_COMMAND_DESCRIPTION, GOD_FAILED, PANE_TITLE, TOOL_FAILED } from './copy.js'
import { detailAfterHelp, detailAfterNextTab, detailAfterScroll, detailAfterTab, detailWithoutHelp } from './detail-control.js'
import { engineClock, engineHost } from './engine.js'
import { drawnMotion, motionLoopOf, recordSpark, type MotionLoop } from './motion-keys.js'
import { makeRecap, type RecapRuntime } from './recap-keys.js'
import { textCleaner } from './sanitize.js'
import { PANE, addDraftLine, cancelBar, checkSent, openAnswer, openDraft, openPermission, pickBack, scrollBar, sendConfirmed, type DeliverRuntime } from './deliver-keys.js'
import { createScreenLoop, isScreenShown, screenWanted, type ScreenLoop } from './screen-loop.js'
import { backToBoard, changeDetail, dropHiddenSelection, jumpSelected, pressRow, select, selectAndFocus, selectNext } from './select-keys.js'
import { readScreenOf } from './source/screen.js'
import { BOARD, DELIVER, DETAIL, JUMP, OPEN_GROUPS, RECAP, SCREEN, SELECTED, THEME } from './state.js'
import { BOARD_TOOL, SESSION_TOOL, boardToolAnswer, sessionToolAnswer, type ToolBoard } from './tools.js'
import type { Settings, StoreState } from './types.js'
import { NO_ACTIONS, drawPane, type PaneActions } from './ui/board.js'
import { themeOf } from './ui/theme.js'
import { motionPeriod } from './view/motion.js'
import { cannotDrawView, layoutOf, paneView } from './view/pane.js'
import type { PaneLayout } from './view/types.js'

/** The width that the pane asks for beside a fullscreen transcript (the full width), and the rows above the prompt. */
const PANE_COLUMNS = 1000
const PANE_ROWS = 20

/**
 * The state of 1 load of the module: the settings, whether the pane is on the screen, the board, the screen loop and
 * the alert loop once they run, the last theme that it read, whether the 2 tools are registered, the key path, the
 * Recap and the motion loop.
 */
type Runtime = {
  settings: Settings
  isPaneOpen: boolean
  starting?: Promise<BoardLoop>
  board?: BoardLoop
  screen?: ScreenLoop
  alerts?: AlertLoop
  theme?: string
  hasTools?: boolean
  deliver: DeliverRuntime
  recap: RecapRuntime
  motion?: MotionLoop
  /** whether the pane held the keys at its last draw; absent before the first draw */
  hasKeys?: boolean
}

async function readTheme($: EngineInterface, runtime: Runtime): Promise<void> {
  const next = themeOf((await $.config.list()).find((row) => row.key === 'theme')?.value)
  if (next === runtime.theme) return
  await update($, THEME, () => next)
  runtime.theme = next
}

/** The help closed once the prompt holds the keys: Esc gave them back. A draw cannot write, so the tick does. */
async function closeHelpAway($: EngineInterface, runtime: Runtime): Promise<void> {
  if (runtime.hasKeys !== false || (await read($, DETAIL)).isHelp !== true) return
  await update($, DETAIL, detailWithoutHelp)
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
  runtime.motion = motionLoopOf($)
  const alerts = alertLoopOf($, host, clean)
  runtime.alerts = alerts
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
      onRefresh: async (turn) => void (await Promise.all([alerts.onRefresh(turn), recordSpark($, turn)])),
    },
    store: storeOf(Object.fromEntries(stored)),
    settings: runtime.settings,
    paneStartedAt: engineClock(),
    isPaneOpen: runtime.isPaneOpen,
  })
  const tick = (): void => {
    void loop
      .tick()
      .then(() => checkSent($, loop.facts()))
      .catch(() => undefined)
    void readTheme($, runtime).catch(() => undefined)
    void closeHelpAway($, runtime).catch(() => undefined)
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

/**
 * Opens the pane, starts the board, and tells the board whether the pane is on the screen. An open that the person
 * asked for (/god) also asks for the keys.
 */
async function openPane($: EngineInterface, runtime: Runtime, isAsked: boolean): Promise<{ loop: BoardLoop; isPlaced: boolean }> {
  await registerTools($, runtime).catch(() => undefined)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS, ...(isAsked ? { focus: true as const } : {}) })
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

/** A choice of the board (f, g, a /god form), then no selection when the new board does not show the selected row. */
async function choose($: EngineInterface, runtime: Runtime, choice: (store: StoreState) => BoardChoice): Promise<void> {
  const loop = await start($, runtime)
  await loop.choose(choice(loop.store()))
  await dropHiddenSelection($)
}

/** s: every tone off, or on again, over the board, started once. */
async function soundKey($: EngineInterface, runtime: Runtime): Promise<void> {
  await toggleSound($, await start($, runtime))
}

/** u: the selected session muted, or unmuted again, over the board, started once. */
async function muteKey($: EngineInterface, runtime: Runtime): Promise<void> {
  await toggleMute($, await start($, runtime))
}

/** The presses of the pane. A press that fails changes nothing, and the next press tries again. */
function actionsOf($: EngineInterface, runtime: Runtime, layout: PaneLayout): PaneActions {
  const quiet = (work: Promise<void>): void => void work.catch(() => undefined)
  return {
    onRow: (key) => quiet(pressRow($, runtime.board, key, layout)),
    onMore: (key) => quiet(selectAndFocus($, key)),
    keys: {
      j: () => quiet(jumpSelected($, runtime.board)),
      n: () => quiet(selectNext($)),
      r: () => quiet(openDraft($, 'prompt')),
      m: () => quiet(openDraft($, 'peer')),
      f: () => quiet(choose($, runtime, toggledMode)),
      g: () => quiet(choose($, runtime, toggledGroup)),
      t: () => quiet(changeDetail($, detailAfterNextTab)),
      b: () => quiet(backToBoard($)),
      h: () => quiet(changeDetail($, detailAfterHelp)),
      s: () => quiet(soundKey($, runtime)),
      u: () => quiet(muteKey($, runtime)),
    },
    detail: {
      onTab: (tab) => quiet(changeDetail($, (state) => detailAfterTab(state, tab))),
      onScroll: (scroll) => quiet(changeDetail($, (state) => detailAfterScroll(state, scroll))),
      onOption: (digit) => quiet(openAnswer($, digit)),
      onPermission: (choice) => quiet(openPermission($, choice)),
      onRecap: (sessionId) => quiet(makeRecap($, runtime.recap, sessionId)),
      onBack: () => quiet(pickBack($)),
    },
    bar: {
      onSend: (shown) => quiet(sendConfirmed($, runtime.deliver, shown)),
      onCancel: (shown) => quiet(cancelBar($, runtime.deliver, shown)),
      onScroll: (scroll) => quiet(scrollBar($, scroll)),
      onDraft: (value) => quiet(addDraftLine($, value)),
    },
  }
}

export function register(on: On, options: PluginOptions): void {
  const runtime: Runtime = { settings: settingsOf(options), isPaneOpen: false, deliver: { isDelivering: false, isCancelled: false }, recap: { isRunning: false } }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'god', description: GOD_COMMAND_DESCRIPTION, argumentHint: GOD_ARGUMENT_HINT })
    if ((await $.env.get('ORANGU_GOD')) === '1') {
      // awaited here, so the first prompt of the session lists the tools
      await registerTools($, runtime).catch(() => undefined)
      void openPane($, runtime, false).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'god' }, async ($, e) => {
    const command = parseGodArgs(e.args)
    if (command.kind === 'unknown') return { text: commandAnswer(command, { isPlaced: false, repos: [] }) }
    if (command.kind === 'stats') return { text: statsAnswer(runtime.board?.recentStats(), runtime.alerts?.counts()) }
    if (command.kind === 'show-repos') {
      const repos = runtime.board?.store().repos ?? storeOf({ repos: await $.store.get('repos') }).repos
      return { text: commandAnswer(command, { isPlaced: false, repos }) }
    }
    const { loop, isPlaced } = await openPane($, runtime, true)
    const choice = commandChoice(command)
    if (choice !== undefined) await choose($, runtime, () => choice)
    return { text: commandAnswer(command, { isPlaced, repos: loop.store().repos }) }
  }).catch(() => ({ text: GOD_FAILED }))

  on('ui.render', { component: 'Pane', requestId: 'god' }, async ($, e) => {
    markPaneShown(runtime)
    runtime.hasKeys = e.props.isFocused
    const [snapshot, selected, openGroups, colors, detail, screen, jumpNote, deliverState, recap, motion] = await Promise.all([
      read($, BOARD),
      read($, SELECTED),
      read($, OPEN_GROUPS),
      read($, THEME),
      read($, DETAIL),
      read($, SCREEN),
      read($, JUMP),
      read($, DELIVER),
      read($, RECAP),
      drawnMotion($, runtime.motion?.elapsed() ?? 0, runtime.settings.motion, e.surface === 'terminal'),
    ])
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
      deliver: deliverState,
      recap,
      isSoundOff: runtime.board?.store().sound === false,
      motion,
    })
    const wanted = screenWanted(snapshot ?? undefined, selected || undefined, detail.tab)
    runtime.screen?.want(wanted, isScreenShown(view, wanted))
    runtime.motion?.want(motionPeriod(view, snapshot ?? undefined, runtime.settings.motion))
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
    runtime.motion?.stop()
    return closed
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__orangu-god__board' }, async () => ({ result: boardToolAnswer(toolBoard(runtime), engineClock()) })).catch(() => ({ deny: TOOL_FAILED }))

  on('tool.call', { tool: 'mcp__orangu-god__session' }, async ($, e) => ({ result: sessionToolAnswer(toolBoard(runtime), e.name, engineClock()) })).catch(() => ({ deny: TOOL_FAILED }))
}
