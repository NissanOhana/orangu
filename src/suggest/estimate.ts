/**
 * The estimate gate: before ANY LLM-facing read, compute how big the read would be.
 * Sizes the canonical evidence bundle (`projectEvidence`), the same bytes `orangu evidence --estimate`
 * reports, so the two gates never disagree. approxTokens = ceil(bytes / 4); over ~5,000 tokens
 * (~20 KB) the caller must ask.
 */
import type { Analysis } from '../model/analysis.js'
import { projectEvidence } from './evidence.js'
import { ESTIMATE_TOKEN_THRESHOLD, type Estimate, type SkippedSession } from './types.js'

/** what one session contributes to the read; the evidence bundle unless the caller sizes another projection */
export type SizeProjection = (a: Analysis) => number

export const evidenceBytes: SizeProjection = (a) => Buffer.byteLength(JSON.stringify(projectEvidence(a)))

/** One session's load: the analysis, or the reason there is none. A skipped session is never a silent 0. */
export type AnalysisLoad = { ok: true; analysis: Analysis } | { ok: false; reason: string }

export async function estimateFor(
  sessionIds: string[],
  load: (id: string) => Promise<AnalysisLoad>,
  size: SizeProjection = evidenceBytes,
): Promise<Estimate> {
  let bytes = 0
  let sessions = 0
  let files = 0
  const skipped: SkippedSession[] = []
  for (const id of sessionIds) {
    const loaded = await load(id)
    if (!loaded.ok) {
      skipped.push({ selector: id, reason: loaded.reason })
      continue
    }
    const a = loaded.analysis
    sessions++
    files += 1 + a.session.subagentPaths.length
    bytes += size(a)
  }
  const approxTokens = Math.ceil(bytes / 4)
  return { bytes, approxTokens, sessions, files, overThreshold: approxTokens > ESTIMATE_TOKEN_THRESHOLD, skipped }
}
