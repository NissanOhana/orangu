/**
 * The screen read of the Screen tab: 1 `cmux read-screen` of the mapped tab of 1 session, over the host port.
 *
 * - The argv reads the last SCREEN_LINES rows of 1 surface in 1 workspace. Both refs pass the tab guard of the jump
 *   (src/god/act/jump.ts, the forms that the key guard takes), so no value is session text and none can start with
 *   `-`. A target that the guard refuses runs no command.
 * - The text goes through the text cleaner (src/god/sanitize.ts: no control character, the secrets masked, the home
 *   folder as `~`) before it enters a ScreenRead. The read time is the clock after the command ends.
 * - A read that exits with a code that is not 0, or that the host port rejects (a timeout), gives nothing: the
 *   Screen tab then says that the read failed and keeps the last good read of the session (src/god/screen-loop.ts).
 * The Screen tab only shows the read. The key path reads the screen again for itself, just before it types.
 */
import { guardedRefs } from '../act/jump.js'
import type { Host } from '../host.js'
import type { ScreenRead } from '../types.js'

/** The rows of the tab that 1 read takes: the bottom of the screen, where a dialog and the prompt are. */
export const SCREEN_LINES = 40

/** The tab that the Screen tab reads: the session and the 2 refs of its mapped tab. */
export type ScreenTarget = { sessionId: string; workspaceRef: string; surfaceRef: string }

/**
 * The Screen tab of 1 session, as the engine state keeps it: the last good read of its screen, and whether the newest
 * read failed.
 */
export type ScreenState = { sessionId: string; read?: ScreenRead; isFailed: boolean }

/** The argv of 1 read of the tab. */
export function screenArgv(target: ScreenTarget): readonly string[] {
  return ['cmux', 'read-screen', '--workspace', target.workspaceRef, '--surface', target.surfaceRef, '--lines', String(SCREEN_LINES)]
}

/** 1 read of the tab, cleaned, or undefined when the refs are refused or the read failed. */
export async function readScreenOf(host: Host, target: ScreenTarget, clean: (text: string) => string, clock: () => number): Promise<ScreenRead | undefined> {
  const refs = guardedRefs(target.workspaceRef, target.surfaceRef)
  if (refs === undefined) return undefined
  try {
    const result = await host.run(screenArgv(target))
    if (result.exitCode !== 0) return undefined
    return { sessionId: target.sessionId, ...refs, text: clean(result.stdout), readAt: clock() }
  } catch {
    return undefined
  }
}
