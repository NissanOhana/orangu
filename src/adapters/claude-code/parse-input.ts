import type { JsonObject } from './jsonl.js'

/** Input contract shared by the disk boundary and the pure session parser. */
export interface ParseInput {
  /** main transcript path (used for meta + sidecar discovery); optional when records are supplied */
  path?: string
  /** pre-read records (tests / in-memory); when absent, `path` is read from disk */
  records?: JsonObject[]
  /** source line for each pre-read main record */
  lineNumbers?: number[]
  /** additional pre-read subagent transcripts (auto-discovered only when omitted) */
  subagents?: Array<{
    path: string
    records: JsonObject[]
    lineNumbers?: number[]
    agentIdHint?: string
    meta?: JsonObject
    totalLines?: number
    badLines?: number
    bytes?: number
    trailingPartial?: boolean
  }>
  /** skip sidecar discovery even when a path is given */
  noSidecar?: boolean
  /** keep full text of thinking/text blocks (default true; the redactor may turn it off) */
  keepText?: boolean
  // ---- file facts for the `records` path (serve-mode tail reader supplies them; defaults keep today's behaviour) ----
  /** last line was an unterminated partial write → `meta.possiblyLive` */
  trailingPartial?: boolean
  /** bytes of the main transcript on disk */
  bytes?: number
  /** lines that failed to parse as JSON */
  badLines?: number
  /** total lines in the main transcript (default: records.length) */
  totalLines?: number
}
