/**
 * Default cohort discovery and loading: every supported Claude root, filtered to the workspace's project
 * directories, each session read through its immutable evidence manifest with the 30-minute quiet gate.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  loadSettledAnalysis,
  MAX_VERIFICATION_DISCOVERED_SESSIONS,
} from '../adapters/claude-code/discovered-analysis.js'
import { claudeRoots, listSessions, SESSION_ID_RE } from '../discover/discover.js'
import { canonicalWorkspace } from './artifacts.js'
import { metricValues, type CohortDeps } from './cohort.js'

export function createCohortDeps(options: { now?: () => number } = {}): CohortDeps {
  return {
    async listCandidates(cwd) {
      const refs = await listSessions({ roots: await claudeRoots(), cwd, maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS })
      return refs
        .filter((ref) => SESSION_ID_RE.test(ref.sessionId))
        .map((ref) => ({ sessionId: ref.sessionId.toLowerCase(), path: ref.path, mtimeMs: ref.mtimeMs }))
    },
    async loadCandidate(candidate, maxBytes) {
      const loaded = await loadSettledAnalysis({ path: candidate.path, sessionId: candidate.sessionId }, maxBytes, {
        requireQuiet: true,
        ...(options.now ? { now: options.now } : {}),
      })
      if ('skip' in loaded) return loaded
      const { analysis, bytesRead } = loaded
      const { cwd, startedAt, endedAt, live } = analysis.session
      if (live !== false) return { skip: 'still-settling', bytesRead }
      if (
        typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0 ||
        typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt < startedAt ||
        typeof cwd !== 'string' || !isAbsolute(cwd)
      ) return { skip: 'unreadable', bytesRead }
      let canonicalCwd = cwd
      try {
        canonicalCwd = await realpath(cwd)
      } catch {
        // A cwd that no longer exists cannot match the (existing) workspace; it is skipped as another workspace.
      }
      let metrics: ReturnType<typeof metricValues>
      try {
        metrics = metricValues(analysis)
      } catch {
        return { skip: 'unreadable', bytesRead }
      }
      return { session: { id: analysis.session.id, path: candidate.path, cwd: canonicalCwd, startedAt, endedAt, metrics }, bytesRead }
    },
    canonicalWorkspace,
  }
}
