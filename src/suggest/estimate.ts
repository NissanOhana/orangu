/**
 * The estimate gate: before ANY LLM-facing read, compute how big the slim
 * projection would be. approxTokens = ceil(bytes / 4); over ~5,000 tokens (~20 KB) the caller must ask.
 */
import type { Analysis } from '../model/analysis.js'
import { slimAnalysis } from './slim.js'
import { ESTIMATE_TOKEN_THRESHOLD, type Estimate } from './types.js'

export async function estimateFor(sessionIds: string[], load: (id: string) => Promise<Analysis | undefined>): Promise<Estimate> {
  let bytes = 0
  let sessions = 0
  let files = 0
  for (const id of sessionIds) {
    const a = await load(id)
    if (!a) continue
    sessions++
    files += 1 + a.session.subagentPaths.length
    bytes += Buffer.byteLength(JSON.stringify(slimAnalysis(a)))
  }
  const approxTokens = Math.ceil(bytes / 4)
  return { bytes, approxTokens, sessions, files, overThreshold: approxTokens > ESTIMATE_TOKEN_THRESHOLD }
}
