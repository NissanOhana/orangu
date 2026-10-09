/**
 * Synthetic board snapshots for the view tests and the rendered#god STE row: the facts of test/fixtures/god/sessions.ts
 * through the real board model (src/god/model/board.ts), on the fixed clock NOW. Every name, path and text is made
 * up. The session texts are short and STE-clean, so the STE row scores the words of the pane, not fixture words.
 */
import { buildBoard, type BoardInput } from '../../../src/god/model/board.js'
import type { BoardSnapshot, SessionFacts, SourceName, SourceState, StoreState } from '../../../src/god/types.js'
import { HOUR, MINUTE, NOW, PANE_START, SECOND, SETTINGS, STORE, busy, facts, idle, repo, transcript, waiting } from './sessions.js'

export { NOW } from './sessions.js'

/** the session id of the god session itself */
export const SELF_ID = 'god-self'

/** the question that the waiting session asks: longer than any board row, so the row cuts it */
export const QUESTION = 'Which eval set do you want for the next run of the tests?'

/** 1 session for each level, 2 stale sessions, every overlap flag and 1 session with no transcript */
export function boardSessions(): SessionFacts[] {
  const api = repo('api')
  const apiWorktree = repo('api', '/work/api-fix')
  const shared = (at: number) => [{ path: '/work/web/notes.md', tool: 'Edit', at }]
  return [
    idle('s-stale-a', { name: 'old-a', statusSince: NOW - 30 * HOUR, transcript: transcript({ lastTurnEndedAt: NOW - 30 * HOUR, lastReply: 'The old work is done.' }) }),
    idle('s-stale-b', { name: 'old-b', statusSince: NOW - 50 * HOUR, transcript: transcript({ lastTurnEndedAt: NOW - 50 * HOUR, lastReply: 'The old work is done.' }) }),
    idle('s-idle', { name: 'api-1', repo: api, transcript: transcript({ lastTurnEndedAt: NOW - 2 * HOUR, lastReply: 'The vendor pick is in the notes.' }) }),
    busy('s-work', {
      name: 'api-9',
      repo: api,
      statusSince: NOW - 4 * MINUTE,
      transcript: transcript({ branch: 'main', activity: { toolUseId: 'tu-edit', tool: 'Edit', text: 'Edit parse.ts', isOpen: true, at: NOW - MINUTE }, filesTouched: shared(NOW - 20 * MINUTE) }),
    }),
    busy('s-new', { name: 'docs-1', statusSince: NOW - 2 * MINUTE, lastWriteAt: undefined, transcript: undefined }),
    busy('s-stuck', {
      name: 'api-3',
      repo: apiWorktree,
      transcript: transcript({ branch: 'fix', errorTail: { kind: 'api-error', text: 'The API refused the request.', at: NOW - 15 * MINUTE } }),
    }),
    idle('s-turn', {
      name: 'web-2',
      statusSince: NOW - 12 * MINUTE,
      transcript: transcript({ lastTurnEndedAt: NOW - 12 * MINUTE, lastReply: 'Setup is done. The tests pass.', filesTouched: shared(NOW - 15 * MINUTE) }),
    }),
    waiting('s-wait', {
      name: 'api-7',
      repo: api,
      statusSince: NOW - 6 * HOUR,
      transcript: transcript({
        branch: 'main',
        openQuestion: {
          toolUseId: 'tu-ask',
          askedAt: NOW - 6 * HOUR,
          questions: [{ text: QUESTION, header: 'Eval set', multiSelect: false, options: [{ label: 'Small' }, { label: 'All' }, { label: 'None' }] }],
        },
      }),
    }),
  ]
}

/** the snapshot of the given sessions, on the fixture clock, with the given fields over the defaults */
export function snapshotOf(sessions: readonly SessionFacts[], over: Partial<BoardInput> = {}, store: Partial<StoreState> = {}): BoardSnapshot {
  return buildBoard({
    facts: facts(sessions),
    store: { ...STORE, ...store },
    settings: SETTINGS,
    selfId: SELF_ID,
    paneStartedAt: PANE_START,
    now: NOW,
    firstRefreshDone: true,
    factsAt: NOW - SECOND,
    ...over,
  })
}

/** the full board: every level, every flag, the stale group */
export const boardSnapshot = (): BoardSnapshot => snapshotOf(boardSessions())

/** the pane before its first refresh ends */
export const readingSnapshot = (): BoardSnapshot => snapshotOf([], { firstRefreshDone: false }, {})

/** no live session but the god session itself */
export const emptySnapshot = (): BoardSnapshot => snapshotOf([idle(SELF_ID, { name: 'god' })])

/** the full board in the repos mode with a repo that no session has */
export const noRepoMatchSnapshot = (): BoardSnapshot => snapshotOf(boardSessions(), {}, { mode: 'repos', repos: ['shop'] })

/** the full board grouped by repo */
export const byRepoSnapshot = (): BoardSnapshot => snapshotOf(boardSessions(), {}, { groupBy: 'repo' })

/** the full board with the given source states over the read ones, and facts from `factsAge` ms ago */
export function degradedSnapshot(sources: Partial<Record<SourceName, SourceState>>, factsAge = SECOND): BoardSnapshot {
  const snapshot = snapshotOf(boardSessions(), { factsAt: NOW - factsAge })
  return { ...snapshot, sources: { ...snapshot.sources, ...sources } }
}
