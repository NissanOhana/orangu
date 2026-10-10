/**
 * The jump of the god pane: what j does for the selected session, as pure code over the host port.
 *
 * - The plan shows the cmux tab of the session with 2 calls in order: `cmux select-workspace --workspace <ws>`
 *   selects its workspace, then `cmux focus-panel --panel <surface> --workspace <ws>` focuses its tab there. 1
 *   focus-panel alone does not select the tab when the workspace changes.
 * - The 2 refs come from the mapped tab of the session (src/god/source/cmux.ts), and only in the forms that the key
 *   guard takes (src/god/act/deliver-plan.ts): `workspace:N` and `surface:N`, or UUIDs. A bare index is refused,
 *   because cmux resolves it in the current window. So no value of the argv is session text, and no value can start
 *   with `-`. No call of the plan has a positional value, so no argv takes `--`.
 * - The jump is off, with its reason and no command, when no session is selected (no-session), when cmux is not on
 *   the machine (no-cmux), or when the session has no tab in a form that the guard takes (no-tab).
 * - runJump runs the steps in order and stops at the first one that fails (an exit code that is not 0, or a reject
 *   of the host port), so focus-panel never runs after a failed select-workspace.
 * - A jump that is off for lack of a tab, or that failed, leaves a note of the session for the key row. A jump, no
 *   cmux (the key row already says why) and no session leave none.
 */
import type { Host } from '../host.js'
import type { BoardSnapshot, TabRef } from '../types.js'
import { SURFACE_REF, WORKSPACE_REF } from './deliver-plan.js'

/** Why a jump runs no command. */
export type JumpOff = 'no-session' | 'no-cmux' | 'no-tab'

/** The 2 refs of a tab that the guard takes. */
export type TabRefs = { workspaceRef: string; surfaceRef: string }

/** The plan of 1 press of j: the argv lists to run in order, or the reason that it runs none. */
export type JumpPlan =
  | { kind: 'jump'; sessionId: string; steps: readonly (readonly string[])[] }
  | { kind: 'off'; reason: Exclude<JumpOff, 'no-session'>; sessionId: string }
  | { kind: 'off'; reason: 'no-session' }

/** What 1 press of j gave: the tab shows, a step failed, or the reason that nothing ran. */
export type JumpOutcome =
  | { result: 'jumped' | 'failed' | Exclude<JumpOff, 'no-session'>; sessionId: string }
  | { result: 'no-session' }

/** The note of the last j that did not jump, for the key row of the pane while its session is selected. */
export type JumpNote = { sessionId: string; reason: 'no-tab' | 'failed' }

/** The 2 refs when both are in a form that the guard takes, else undefined. */
export function guardedRefs(workspaceRef: string, surfaceRef: string): TabRefs | undefined {
  return WORKSPACE_REF.test(workspaceRef) && SURFACE_REF.test(surfaceRef) ? { workspaceRef, surfaceRef } : undefined
}

/** The refs of a tab when both are in a form that the guard takes, else undefined. */
export const tabRefs = (tab: TabRef | undefined): TabRefs | undefined => (tab === undefined ? undefined : guardedRefs(tab.workspaceRef, tab.surfaceRef))

/** The plan of j for the selected row of the board. */
export function jumpPlan(snapshot: BoardSnapshot | undefined, selectedKey: string | undefined): JumpPlan {
  const session = snapshot?.sessions.find((candidate) => candidate.sessionId === selectedKey)
  if (snapshot === undefined || session === undefined) return { kind: 'off', reason: 'no-session' }
  const { sessionId } = session
  if (snapshot.sources.cmux.status === 'missing') return { kind: 'off', reason: 'no-cmux', sessionId }
  const refs = tabRefs(session.tab)
  if (refs === undefined) return { kind: 'off', reason: 'no-tab', sessionId }
  return {
    kind: 'jump',
    sessionId,
    steps: [
      ['cmux', 'select-workspace', '--workspace', refs.workspaceRef],
      ['cmux', 'focus-panel', '--panel', refs.surfaceRef, '--workspace', refs.workspaceRef],
    ],
  }
}

/** Runs the steps of a plan in order, and stops at the first one that fails. A plan that is off runs nothing. */
export async function runJump(host: Host, plan: JumpPlan): Promise<JumpOutcome> {
  if (plan.kind === 'off') return plan.reason === 'no-session' ? { result: 'no-session' } : { result: plan.reason, sessionId: plan.sessionId }
  for (const argv of plan.steps) {
    const exitCode = await host.run(argv).then(
      (result) => result.exitCode,
      () => undefined,
    )
    if (exitCode !== 0) return { result: 'failed', sessionId: plan.sessionId }
  }
  return { result: 'jumped', sessionId: plan.sessionId }
}

/** The note that a press of j leaves for the key row, or null for none. */
export function jumpNoteOf(outcome: JumpOutcome): JumpNote | null {
  return outcome.result === 'no-tab' || outcome.result === 'failed' ? { sessionId: outcome.sessionId, reason: outcome.result } : null
}

/** The session that a press of j showed, which it marks seen, or undefined when it did not jump. */
export const jumpedSessionOf = (outcome: JumpOutcome): string | undefined => (outcome.result === 'jumped' ? outcome.sessionId : undefined)
