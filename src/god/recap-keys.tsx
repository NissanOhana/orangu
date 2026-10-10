// The engine shell of the Recap of the god pane: what x does on the Recap tab, with no rule of its own. The rules are
// in src/god/act/recap.ts. Every function that takes `$` is a function declaration at the top of the file, as the
// engine asks.
// - x is a Button of the Recap tab of 1 session, so it names that session. Only x starts a model call.
// - 1 Recap runs at a time: an x while one runs does nothing (2 x in 1 frame too), and the tab draws no x key while
//   one runs.
// - The engine state holds the running Recap, then its result, so the pane draws each step.
import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { runRecap } from './act/recap.js'
import { engineClock, engineEffects } from './engine.js'
import { textCleaner } from './sanitize.js'
import { BOARD, RECAP } from './state.js'

/** The Recap of 1 load of the module: true while a model call of x runs. */
export type RecapRuntime = { isRunning: boolean }

/** x on the Recap tab of the session: 1 model call over its last turns, and its result in the engine state. */
export async function makeRecap($: EngineInterface, runtime: RecapRuntime, sessionId: string): Promise<void> {
  if (runtime.isRunning) return
  // the mark comes before the first await, so a second x in the same frame finds it
  runtime.isRunning = true
  try {
    const session = ((await read($, BOARD)) ?? undefined)?.sessions.find((candidate) => candidate.sessionId === sessionId)
    if (session === undefined) return
    const clean = textCleaner((await $.env.get('HOME')) ?? '')
    await update($, RECAP, () => ({ status: 'running' as const, sessionId, startedAt: engineClock() }))
    const recap = await runRecap({ complete: engineEffects($).complete, clock: engineClock, clean }, session)
    await update($, RECAP, () => recap)
  } finally {
    runtime.isRunning = false
  }
}
