// The engine shell of the alerts of the god pane: the ports of the alert loop over `$`, and what s and u do, with no
// rule of their own. The rules are in src/god/alert-loop.ts, src/god/act/alerts.ts and src/god/control.ts. Every
// function that takes `$` is a function declaration at the top of the file, as the engine asks.
// - The alert state lives in the engine state, so a reload of the code keeps the limit of 1 alert in 5 min.
// - A tone and a notification go through the Effects of the engine adapter, and the ring through the host port.
// - s and u go to the store through the board loop. A change of u changes the snapshot, so the pane draws again. A
//   change of s changes no snapshot, so s asks the pane to draw again for its header chip.
import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { createAlertLoop, type AlertLoop } from './alert-loop.js'
import type { BoardLoop } from './board-loop.js'
import { toggledMute, toggledSound } from './control.js'
import { engineEffects } from './engine.js'
import type { Host } from './host.js'
import { ALERTS, SELECTED } from './state.js'

/** The alert loop over the engine state, the Effects of the engine and the host port. */
export function alertLoopOf($: EngineInterface, host: Host, clean: (text: string) => string): AlertLoop {
  const { play, notify } = engineEffects($)
  return createAlertLoop({
    readState: () => read($, ALERTS),
    writeState: async (state) => {
      await update($, ALERTS, () => state)
    },
    effects: { play, notify },
    host,
    clean,
  })
}

/** s: every tone off, or on again. */
export async function toggleSound($: EngineInterface, loop: BoardLoop): Promise<void> {
  await loop.choose(toggledSound(loop.store()))
  $.ui.invalidate('ui.render')
}

/** u: the selected session muted, or unmuted again. A heading or no selection changes nothing. */
export async function toggleMute($: EngineInterface, loop: BoardLoop): Promise<void> {
  const choice = toggledMute(loop.store(), (await read($, SELECTED)) || undefined, loop.snapshot())
  if (choice !== undefined) await loop.choose(choice)
}
