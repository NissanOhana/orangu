/**
 * The overlap flags of the sessions on the board. Each flag goes on both rows, and each row names the other:
 * - same-tree: the same worktree top level and the same branch. A row with no known branch gets no same-tree flag,
 *   because a session with no transcript wrote nothing yet;
 * - same-files: both sessions wrote the same path at or after `now` minus SAME_FILES_WINDOW_MS, in the transcript
 *   part that the mod read. The flag names the shared path with the newest write;
 * - same-repo: the same git common dir in different worktree top levels.
 * A session with no repo gets no same-tree and no same-repo flag. The flags of 1 row are in the kind order, then
 * in the order of the other name and the other id. The caller passes only the board sessions, so the god session
 * flags nothing.
 */
import type { Flag, FlagKind, SessionFacts } from '../types.js'

/** A write counts for same-files when it is this recent: 2 h. */
export const SAME_FILES_WINDOW_MS = 2 * 60 * 60_000

const KIND_ORDER: readonly FlagKind[] = ['same-tree', 'same-files', 'same-repo']

/** The members of each group, in input order. A session whose key is undefined is in no group. */
function groupsBy(sessions: readonly SessionFacts[], key: (session: SessionFacts) => string | undefined): SessionFacts[][] {
  const groups = new Map<string, SessionFacts[]>()
  for (const session of sessions) {
    const value = key(session)
    if (value === undefined) continue
    const members = groups.get(value)
    if (members === undefined) groups.set(value, [session])
    else members.push(session)
  }
  return [...groups.values()]
}

/** Calls `each` once for each pair of members, the first member before the second. */
function eachPair(members: readonly SessionFacts[], each: (first: SessionFacts, second: SessionFacts) => void): void {
  members.forEach((first, index) => {
    for (const second of members.slice(index + 1)) each(first, second)
  })
}

/** The newest write of 1 shared path for 1 pair of sessions. */
type SharedFile = { first: SessionFacts; second: SessionFacts; path: string; at: number }

/** For each pair of sessions that wrote the same path in the window: the shared path with the newest write. */
function sharedFiles(sessions: readonly SessionFacts[], now: number): SharedFile[] {
  const writers = new Map<string, Map<SessionFacts, number>>()
  for (const session of sessions) {
    for (const touch of session.transcript?.filesTouched ?? []) {
      if (touch.at < now - SAME_FILES_WINDOW_MS) continue
      const byWriter = writers.get(touch.path) ?? new Map<SessionFacts, number>()
      byWriter.set(session, Math.max(byWriter.get(session) ?? touch.at, touch.at))
      writers.set(touch.path, byWriter)
    }
  }
  const order = new Map(sessions.map((session, index) => [session, index]))
  const best = new Map<SessionFacts, Map<SessionFacts, SharedFile>>()
  for (const [path, byWriter] of writers) {
    const members = [...byWriter.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    eachPair(members, (first, second) => {
      const at = Math.max(byWriter.get(first) ?? 0, byWriter.get(second) ?? 0)
      const pairs = best.get(first) ?? new Map<SessionFacts, SharedFile>()
      const kept = pairs.get(second)
      if (kept === undefined || at > kept.at || (at === kept.at && path < kept.path)) pairs.set(second, { first, second, path, at })
      best.set(first, pairs)
    })
  }
  return [...best.values()].flatMap((pairs) => [...pairs.values()])
}

function flagOf(kind: FlagKind, other: SessionFacts, file?: string): Flag {
  return { kind, otherId: other.sessionId, otherName: other.name, ...(file === undefined ? {} : { file }) }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function flagOrder(a: Flag, b: Flag): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compareText(a.otherName, b.otherName) || compareText(a.otherId, b.otherId)
}

/** The overlap flags of each session, by session id. Each session has an entry, empty when it has no flag. */
export function overlapFlags(sessions: readonly SessionFacts[], now: number): Map<string, readonly Flag[]> {
  const flags = new Map<string, Flag[]>(sessions.map((session) => [session.sessionId, []]))
  const both = (kind: FlagKind, first: SessionFacts, second: SessionFacts, file?: string): void => {
    flags.get(first.sessionId)?.push(flagOf(kind, second, file))
    flags.get(second.sessionId)?.push(flagOf(kind, first, file))
  }

  const treeKey = (session: SessionFacts): string | undefined => {
    const branch = session.transcript?.branch
    return session.repo === undefined || branch === undefined ? undefined : JSON.stringify([session.repo.topLevel, branch])
  }
  for (const members of groupsBy(sessions, treeKey)) eachPair(members, (first, second) => both('same-tree', first, second))

  for (const shared of sharedFiles(sessions, now)) both('same-files', shared.first, shared.second, shared.path)

  for (const members of groupsBy(sessions, (session) => session.repo?.commonDir)) {
    eachPair(members, (first, second) => {
      if (first.repo?.topLevel !== second.repo?.topLevel) both('same-repo', first, second)
    })
  }

  return new Map([...flags].map(([id, list]) => [id, list.sort(flagOrder)]))
}
