/**
 * Verification-only Claude session loader.
 *
 * A lifecycle receipt is untrusted skill output. Unlike general CLI selectors,
 * it may only name a complete UUID or an exact path already present in Orangu's
 * supported Claude discovery roots. The selected transcript is then consumed
 * through the immutable evidence manifest, so an arbitrary JSONL file cannot be
 * promoted to later verification evidence.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { analyzeSession } from '../../analyze/analyze.js'
import type { Analysis } from '../../model/analysis.js'
import { claudeRoots, listSessions, SESSION_ID_RE, type SessionRef } from '../../discover/discover.js'
import { parseClaudeCodeSession } from './parse.js'
import {
  evidenceManifestLatestChangeMs,
  MAX_EVIDENCE_SESSION_BYTES,
  prevalidateEvidenceSession,
  readEvidenceSessionManifest,
} from './evidence-input.js'

export const MAX_VERIFICATION_DISCOVERED_SESSIONS = 10_000
export const MIN_VERIFICATION_QUIET_MS = 30 * 60_000

export interface DiscoveredClaudeAnalysisLoaderOptions {
  /** Verification requires a stable 30-minute manifest; proposal review does not. */
  requireQuiet?: boolean
  /** Injectable wall clock for the quiet-age gate only. */
  now?: () => number
}

interface DiscoveredInventory {
  refs: SessionRef[]
  byCanonicalPath: Map<string, SessionRef | null>
}

async function discoveredInventory(): Promise<DiscoveredInventory> {
  const refs = (
    await listSessions({ roots: await claudeRoots(), maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS })
  ).filter((ref) => SESSION_ID_RE.test(ref.sessionId))
  if (refs.length > MAX_VERIFICATION_DISCOVERED_SESSIONS) {
    throw new Error(`verification discovery exceeds ${MAX_VERIFICATION_DISCOVERED_SESSIONS} sessions`)
  }
  const byCanonicalPath = new Map<string, SessionRef | null>()
  // Intentionally sequential: a crafted/very large root cannot create an FD spike.
  for (const ref of refs) {
    try {
      const canonical = await realpath(ref.path)
      const prior = byCanonicalPath.get(canonical)
      if (prior === undefined) byCanonicalPath.set(canonical, ref)
      else if (prior !== null && resolve(prior.path) !== resolve(ref.path)) byCanonicalPath.set(canonical, null)
    } catch {
      // A disappearing entry cannot be verification evidence.
    }
  }
  return { refs, byCanonicalPath }
}

async function exactDiscoveredRef(selector: string, inventory: DiscoveredInventory): Promise<SessionRef | undefined> {
  const value = selector.trim()
  if (!value) return undefined
  let matches: SessionRef[]
  if (SESSION_ID_RE.test(value)) {
    matches = inventory.refs.filter((ref) => ref.sessionId.toLowerCase() === value.toLowerCase())
  } else if (value.endsWith('.jsonl') || value.includes('/') || value.includes('\\')) {
    let canonical: string
    try {
      canonical = await realpath(isAbsolute(value) ? value : resolve(process.cwd(), value))
    } catch {
      return undefined
    }
    const indexed = inventory.byCanonicalPath.get(canonical)
    matches = indexed ? [indexed] : []
  } else {
    // Prefixes and aliases such as "latest" are intentionally not stable enough
    // for a persisted verification receipt.
    return undefined
  }
  const unique = new Map(matches.map((ref) => [resolve(ref.path), ref]))
  return unique.size === 1 ? [...unique.values()][0] : undefined
}

/** Create one sequential verification loader with a shared transcript-byte cap. */
export function createDiscoveredClaudeAnalysisLoader(
  maxTotalBytes = MAX_EVIDENCE_SESSION_BYTES,
  options: DiscoveredClaudeAnalysisLoaderOptions = {},
): (selector: string) => Promise<Analysis | undefined> {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > MAX_EVIDENCE_SESSION_BYTES) {
    throw new Error(`verification read budget must be an integer from 1-${MAX_EVIDENCE_SESSION_BYTES} bytes`)
  }
  let remainingBytes = maxTotalBytes
  // One immutable discovery snapshot per verification keeps selector lookup
  // O(inventory + selectors), instead of rescanning every Claude root per id.
  const inventory = discoveredInventory()
  return async (selector: string): Promise<Analysis | undefined> => {
    try {
      if (remainingBytes < 1) return undefined
      const ref = await exactDiscoveredRef(selector, await inventory)
      if (!ref) return undefined
      const manifest = await prevalidateEvidenceSession(ref.path)
      if (options.requireQuiet) {
        const changedAt = evidenceManifestLatestChangeMs(manifest)
        const observedAt = (options.now ?? Date.now)()
        if (
          changedAt === undefined ||
          !Number.isFinite(observedAt) ||
          observedAt < changedAt ||
          observedAt - changedAt < MIN_VERIFICATION_QUIET_MS
        ) return undefined
      }
      const loaded = await readEvidenceSessionManifest(manifest, remainingBytes)
      remainingBytes -= loaded.bytesRead
      if (
        options.requireQuiet
        && (loaded.parseInput.trailingPartial || loaded.parseInput.subagents?.some((sidecar) => sidecar.trailingPartial))
      ) return undefined
      const session = await parseClaudeCodeSession(loaded.parseInput)
      // Verification compares transcript facts only. Keep this loader independent
      // of wall-clock time so the deterministic analysis contract stays intact.
      const analysis = analyzeSession(session, { version: 'verification', now: 0 })
      if (analysis.session.source !== 'claude-code' || analysis.session.id.toLowerCase() !== ref.sessionId.toLowerCase()) return undefined
      return analysis
    } catch {
      return undefined
    }
  }
}
