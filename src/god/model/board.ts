/**
 * The board snapshot from the facts of 1 refresh, from rules only:
 * - 1 row per session id. When the facts hold 2 sessions with the same id, the row is the one whose status
 *   changed last, then the one with the newest transcript write, then the first;
 * - the god session gets no row, no group entry and no flag;
 * - each row gets its seenAt, level, levelSince, summary, flags and muted state;
 * - the rows are in board order: the level order, then the longest time in the level first, then the name and the
 *   id, so the same facts always give the same order;
 * - the rows hold every live session whatever the mode. The mode filters the groups only: the repos mode keeps a
 *   session whose repo name is in the stored set, so a linked worktree counts as its repo. An empty set keeps none;
 * - by level: 1 group for each level that has rows, in the level order. The stale group starts closed and shows
 *   its count;
 * - by repo: 1 group for each git common dir, in the board order of its first row, named by its main worktree when
 *   a row has it, and 1 group with the key '' for the rows with no repo. No repo group starts closed.
 * The clock comes in as `now`.
 */
import { LEVEL_ORDER, type BoardGroup, type BoardSnapshot, type Facts, type GodSession, type RepoRef, type SessionFacts, type Settings, type StoreState } from '../types.js'
import { classify, seenAtOf, type Classified } from './classify.js'
import { overlapFlags } from './overlap.js'
import { summaryOf } from './summary.js'

/** What 1 board snapshot reads. */
export type BoardInput = {
  facts: Facts
  store: StoreState
  settings: Settings
  /** the session id of the god session: the board leaves it out */
  selfId: string
  /** when the god pane started: the seenAt of a session that the store does not hold */
  paneStartedAt: number
  now: number
  /** false until the first refresh ends */
  firstRefreshDone: boolean
  /** when the newest facts were read */
  factsAt?: number
  /** the last snapshot: a level whose facts give no time keeps its time from it */
  previous?: BoardSnapshot
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The status time, then the transcript write time, of 1 session: the larger pair is the newer session. */
const recency = (session: SessionFacts): readonly [number, number] => [session.statusSince ?? -1, session.lastWriteAt ?? -1]

/** 1 session per session id, in the order of the first entry of each id. */
function uniqueSessions(sessions: readonly SessionFacts[]): SessionFacts[] {
  const byId = new Map<string, SessionFacts>()
  for (const session of sessions) {
    const kept = byId.get(session.sessionId)
    if (kept === undefined) {
      byId.set(session.sessionId, session)
      continue
    }
    const [status, write] = recency(session)
    const [keptStatus, keptWrite] = recency(kept)
    if (status > keptStatus || (status === keptStatus && write > keptWrite)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

/** The board order: the level order, then the longest time in the level first, then the name, then the id. */
function boardOrder(a: GodSession, b: GodSession): number {
  return LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.levelSince - b.levelSince || compareText(a.name, b.name) || compareText(a.sessionId, b.sessionId)
}

/** True when the mode keeps the session in the groups: every session in the all mode, else a session of a stored repo. */
function keptByMode(session: SessionFacts, store: Pick<StoreState, 'mode' | 'repos'>): boolean {
  return store.mode === 'all' || (session.repo !== undefined && store.repos.includes(session.repo.name))
}

function levelGroups(sessions: readonly GodSession[]): BoardGroup[] {
  return LEVEL_ORDER.flatMap((level) => {
    const sessionIds = sessions.filter((session) => session.level === level).map((session) => session.sessionId)
    return sessionIds.length === 0 ? [] : [{ key: level, level, sessionIds, startsClosed: level === 'stale' }]
  })
}

function repoGroups(sessions: readonly GodSession[]): BoardGroup[] {
  const groups = new Map<string, { repo?: RepoRef; sessionIds: string[] }>()
  for (const session of sessions) {
    const key = session.repo?.commonDir ?? ''
    const group = groups.get(key) ?? { sessionIds: [] }
    group.sessionIds.push(session.sessionId)
    if (session.repo !== undefined && (group.repo === undefined || (group.repo.isWorktree && !session.repo.isWorktree))) group.repo = session.repo
    groups.set(key, group)
  }
  return [...groups].map(([key, group]) => ({ key, ...(group.repo === undefined ? {} : { repo: group.repo }), sessionIds: group.sessionIds, startsClosed: false }))
}

/** 1 board snapshot from the facts of 1 refresh, the stored choices and the settings. */
export function buildBoard(input: BoardInput): BoardSnapshot {
  const { facts, store, settings, selfId, paneStartedAt, now } = input
  const live = uniqueSessions(facts.sessions).filter((session) => session.sessionId !== selfId)
  const before = new Map<string, Classified>((input.previous?.sessions ?? []).map((session) => [session.sessionId, { level: session.level, levelSince: session.levelSince }]))
  const flags = overlapFlags(live, now)
  const muted = new Set(store.muted)

  const sessions = live
    .map((session): GodSession => {
      const seenAt = seenAtOf(session.sessionId, store.seenAt, paneStartedAt)
      const previous = before.get(session.sessionId)
      const { level, levelSince } = classify({ session, seenAt, settings, now, ...(previous === undefined ? {} : { previous }) })
      const summary = summaryOf(session, level)
      return { ...session, seenAt, level, levelSince, summary, flags: flags.get(session.sessionId) ?? [], muted: muted.has(session.sessionId) }
    })
    .sort(boardOrder)
  const kept = sessions.filter((session) => keptByMode(session, store))

  return {
    at: now,
    selfId,
    firstRefreshDone: input.firstRefreshDone,
    sessions,
    groups: store.groupBy === 'repo' ? repoGroups(kept) : levelGroups(kept),
    mode: store.mode,
    repos: store.repos,
    groupBy: store.groupBy,
    sources: facts.sources,
    ...(input.factsAt === undefined ? {} : { factsAt: input.factsAt }),
    stats: facts.stats,
  }
}
