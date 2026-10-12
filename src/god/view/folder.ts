/**
 * The folder line of the detail: the other sessions that work now in the folder of the session, by the names of
 * their rows (src/god/view/names.ts), in board order. 2 sessions that work in 1 folder can change the same files, so
 * the line shows only when 2 or more sessions of the folder work now: WORKING or STUCK, the levels of a busy
 * session. The folder is the top level of the worktree of a session, else its cwd, so a linked worktree is a folder
 * of its own. The line names 5 sessions at most, then the count of the rest, and wraps at whole words.
 */
import { sharesFolderText } from '../copy.js'
import type { GodSession } from '../types.js'
import { FLAG_PAINT } from '../ui/theme.js'
import { rowName } from './names.js'
import type { Line } from './types.js'
import { wrapSegments } from './wrap.js'

/** The most names that the line shows: it counts the rest. */
export const FOLDER_NAMES_MAX = 5

const folderOf = (session: GodSession): string => session.repo?.topLevel ?? session.cwd

const worksNow = (session: GodSession): boolean => session.level === 'working' || session.level === 'stuck'

/** The folder line of `session` among the board `sessions`: no line while fewer than 2 sessions of its folder work now. */
export function folderLines(session: GodSession, sessions: readonly GodSession[], width: number): Line[] {
  const folder = folderOf(session)
  const working = sessions.filter((other) => folderOf(other) === folder && worksNow(other))
  const others = working.filter((other) => other.sessionId !== session.sessionId)
  if (working.length < 2 || others.length === 0) return []
  const names = others.slice(0, FOLDER_NAMES_MAX).map(rowName)
  return wrapSegments([{ text: sharesFolderText(others.length, names, others.length - names.length), ...FLAG_PAINT['same-tree'] }], width, 1, 3)
}
