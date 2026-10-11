// The engine shell of the alerts of the god pane: the ports of the alert loop over `$`, and what s and u do, with no
// rule of their own. The rules are in src/god/alert-loop.ts, src/god/act/alerts.ts and src/god/control.ts. Every
// function that takes `$` is a function declaration at the top of the file, as the engine asks.
// - The alert state lives in the engine state, so a reload of the code keeps the limit of 1 alert in 5 min.
// - A tone and a notification go through the Effects of the engine adapter, and the ring through the host port.
// - The sound and the muted sessions come from the store on each alert turn, and s and u read them from the store just
//   before they write: /god in a second session runs a second board on the same store, so the copy of this board can
//   be old. A store read that fails sends no alert, and a press whose read fails changes nothing.
// - s and u go to the store through the board loop. A change of u changes the snapshot, so the pane draws again. A
//   change of s changes no snapshot, so s asks the pane to draw again for its header chip.
import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { createAlertLoop, type AlertLoop } from './alert-loop.js'
import type { BoardLoop } from './board-loop.js'
import { storeOf, toggledMute, toggledSound } from './control.js'
import { engineEffects } from './engine.js'
import type { Host } from './host.js'
import { ALERTS, SELECTED } from './state.js'
import type { StoreState } from './types.js'

/** The sound and the muted sessions in the store now, each checked, else its default. */
async function storedChoices($: EngineInterface): Promise<Pick<StoreState, 'sound' | 'muted'>> {
  const [sound, muted] = await Promise.all([$.store.get('sound'), $.store.get('muted')])
  const stored = storeOf({ sound, muted })
  return { sound: stored.sound, muted: stored.muted }
}

/** The alert loop over the engine state, the store, the Effects of the engine and the host port. */
export function alertLoopOf($: EngineInterface, host: Host, clean: (text: string) => string): AlertLoop {
  const { play, notify } = engineEffects($)
  return createAlertLoop({
    readState: () => read($, ALERTS),
    writeState: async (state) => {
      await update($, ALERTS, () => state)
    },
    readChoices: () => storedChoices($),
    effects: { play, notify },
    host,
    clean,
  })
}

/** s: every tone off, or on again, from the sound in the store now. */
export async function toggleSound($: EngineInterface, loop: BoardLoop): Promise<void> {
  await loop.choose(toggledSound(await storedChoices($)))
  $.ui.invalidate('ui.render')
}

/** u: the selected session muted, or unmuted again, in the muted sessions of the store now. A heading or no selection changes nothing. */
export async function toggleMute($: EngineInterface, loop: BoardLoop): Promise<void> {
  const selected = (await read($, SELECTED)) || undefined
  const choice = toggledMute(await storedChoices($), selected, loop.snapshot())
  if (choice !== undefined) await loop.choose(choice)
}
