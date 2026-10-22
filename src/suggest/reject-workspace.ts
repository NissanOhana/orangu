/**
 * The workspace of a rejection. A record with no proposal workspace names no folder, so a later workspace read
 * cannot find it once Claude Code deletes its evidence transcripts. At `--set <id> rejected` the CLI binds the
 * folder of its evidence sessions: it finds each evidence session through discovery, reads the cwd from the head of
 * the transcript (64,000 B at most) and resolves it to its canonical path. It binds the path only when every session
 * that discovery finds gives the same canonical path. Any other result binds nothing, and the rejection still goes
 * ahead. The value crosses a file boundary, so it must also pass the store's own form check.
 */
import { basename, isAbsolute } from 'node:path'
import { MAX_VERIFICATION_DISCOVERED_SESSIONS } from '../adapters/claude-code/discovered-analysis.js'
import { claudeRoots, listSessions, peekCwd, SESSION_ID_RE } from '../discover/discover.js'
import { isCanonicalWorkspaceCwd } from './store.js'
import type { SuggestionRecord } from './types.js'
import { liveWorkspaceIdentity } from './workspace-identity.js'

export interface RejectWorkspaceDeps {
  /** the transcript paths of the discovered sessions with these lowercase ids */
  findSessions(ids: ReadonlySet<string>): Promise<string[]>
  /** the cwd field near the head of a transcript, if it has one */
  peekCwd(path: string): Promise<string | undefined>
  /** the canonical path of an existing directory; throws when the folder is gone or is not a directory */
  canonical(path: string): Promise<string>
}

export function createRejectWorkspaceDeps(): RejectWorkspaceDeps {
  return {
    async findSessions(ids) {
      const refs = await listSessions({ roots: await claudeRoots(), maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS })
      return refs.filter((ref) => SESSION_ID_RE.test(ref.sessionId) && ids.has(ref.sessionId.toLowerCase())).map((ref) => ref.path)
    },
    peekCwd,
    // The same resolution as a reviewed proposal workspace: realpath, then a directory check.
    async canonical(path) {
      return (await liveWorkspaceIdentity(path)).cwd
    },
  }
}

/** The session ids that the evidence selectors name, as a UUID or as a transcript path. */
function evidenceIds(selectors: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const selector of selectors) {
    const trimmed = selector.trim()
    for (const candidate of [trimmed, basename(trimmed).replace(/\.jsonl$/i, '')]) {
      if (SESSION_ID_RE.test(candidate)) ids.add(candidate.toLowerCase())
    }
  }
  return ids
}

/**
 * The canonical workspace path to bind at the rejection of this record, or `undefined` to bind none. A global record
 * belongs to no workspace, and a record with a proposal workspace is bound by it already, so neither gets a path. It
 * never throws: a failed read binds nothing.
 */
export async function rejectWorkspaceCwd(record: SuggestionRecord, deps: RejectWorkspaceDeps = createRejectWorkspaceDeps()): Promise<string | undefined> {
  if (record.scope === 'global' || record.proposal?.workspace !== undefined) return undefined
  const ids = evidenceIds(record.sessionIds)
  if (!ids.size) return undefined
  try {
    const paths = await deps.findSessions(ids)
    let bound: string | undefined
    for (const path of paths) {
      const cwd = await deps.peekCwd(path)
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
      const canonical = await deps.canonical(cwd)
      if (!isCanonicalWorkspaceCwd(canonical)) return undefined
      if (bound !== undefined && canonical !== bound) return undefined
      bound = canonical
    }
    return bound
  } catch {
    return undefined
  }
}
