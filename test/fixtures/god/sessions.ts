/**
 * Synthetic god sessions for the model tests: the facts of 1 live session as the collector gives them, on a fixed
 * clock. Every name, path and text here is made up, and no value comes from a real session. The texts are short
 * and STE-clean, so a view that draws them scores its own words, not the fixture words.
 */
import type {
  Facts,
  RepoRef,
  SessionFacts,
  SessionStatus,
  Settings,
  SourceName,
  SourceState,
  StoreState,
  TranscriptFacts,
} from '../../../src/god/types.js'

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE

/** the time of every model test: 2026-10-09 12:00 UTC */
export const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)

/** the god pane started 30 min before NOW */
export const PANE_START = NOW - 30 * MINUTE

/** the default settings: stuck after 10 min, stale after 24 h */
export const SETTINGS: Settings = { stuckAfterMin: 10, staleAfterH: 24, motion: 'on' }

/** a fresh store: all sessions, grouped by level, nothing seen and nothing muted */
export const STORE: StoreState = { mode: 'all', repos: [], groupBy: 'level', seenAt: {}, muted: [], sound: true }

/** the transcript facts of a session that has read nothing yet, with the given fields over them */
export function transcript(over: Partial<TranscriptFacts> = {}): TranscriptFacts {
  return { prLinks: [], filesTouched: [], history: [], agents: [], parseErrors: 0, ...over }
}

/** a repo identity: the main worktree at /work/<name>, or a linked worktree at the given top level */
export function repo(name: string, topLevel = `/work/${name}`): RepoRef {
  return { commonDir: `/work/${name}/.git`, topLevel, name, isWorktree: topLevel !== `/work/${name}` }
}

let nextPid = 4100

/** 1 live session with the given status, the cwd /work/api, and the given fields over the defaults */
export function session(sessionId: string, status: SessionStatus, over: Partial<SessionFacts> = {}): SessionFacts {
  nextPid += 1
  return { pid: nextPid, sessionId, cwd: '/work/api', name: sessionId, kind: 'interactive', status, subagents: [], ...over }
}

/** a busy session that wrote its transcript 1 min ago */
export function busy(sessionId: string, over: Partial<SessionFacts> = {}): SessionFacts {
  return session(sessionId, 'busy', { statusSince: NOW - 20 * MINUTE, lastWriteAt: NOW - MINUTE, transcript: transcript(), ...over })
}

/** an idle session whose last turn ended 2 h ago, before the pane start */
export function idle(sessionId: string, over: Partial<SessionFacts> = {}): SessionFacts {
  return session(sessionId, 'idle', {
    statusSince: NOW - 2 * HOUR,
    lastWriteAt: NOW - 2 * HOUR,
    transcript: transcript({ lastTurnEndedAt: NOW - 2 * HOUR, lastReply: 'Setup is done. The tests pass.' }),
    ...over,
  })
}

/** a session that waits for the person since 5 min */
export function waiting(sessionId: string, over: Partial<SessionFacts> = {}): SessionFacts {
  return session(sessionId, 'waiting', { waitingFor: 'input needed', statusSince: NOW - 5 * MINUTE, lastWriteAt: NOW - 5 * MINUTE, transcript: transcript(), ...over })
}

const OK: SourceState = { status: 'ok', lastOkAt: NOW - SECOND }

/** the facts of 1 refresh that read every source with no failure */
export function facts(sessions: readonly SessionFacts[]): Facts {
  const sources: Record<SourceName, SourceState> = { agents: OK, registry: OK, cmux: OK, git: OK }
  return { sessions, sources, stats: { at: NOW - SECOND, computeMs: 20, waitMs: 400, sessions: sessions.length } }
}
