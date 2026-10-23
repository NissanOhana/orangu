/**
 * The queue read of `GET /api/queue`, v1, as the app reads it. Types only: this file has no runtime code.
 *
 * The server shape is `SuggestionQueue` in src/suggest/queue.ts. No file under src/report/client imports that module
 * or the cohort modules, so the client can compute no group, no verdict and no "due" (test/lint.test.ts). This file
 * names the keys that the client reads, and queue-ui.test.ts holds them assignable from the server shape.
 */
import type { SuggestionScope, SuggestionStatus } from '../../suggest/types.js'

/** The 6 groups, in the order of the read. */
export type QueueGroupKey = 'verdict' | 'regressed' | 'apply' | 'review' | 'running' | 'wait'

/** 1 queue item, with the keys that the app reads. */
export interface QueueRow {
  group: QueueGroupKey
  id: string
  /** every folded record id, newest move first */
  ids: string[]
  status: SuggestionStatus
  scope: SuggestionScope
  changeClass?: string
  /** the stored title: it can be model text, so the app escapes it */
  title: string
  /** the scrubbed workspace path, or null */
  workspace: string | null
  lastMoveAt: number
  /** discovery counts: upper bounds, so the copy says "up to" */
  candidates?: { baseline: number; later: number }
  check?: 'ran' | 'deferred'
  checkpoint?: 'first' | 'complete' | null
  verdict?: string
  final?: boolean
  leaning?: 'worse'
  cannotVerify?: string
  earlier: Array<{ id: string; status: SuggestionStatus; verdict: string | null; reasonCode?: string }>
  earlierCount: number
  /** the handoff to paste, or null when no step can run now */
  next: string | null
}

export interface QueueRead {
  v: 1
  /** the scrubbed workspace path of the read, or `all` */
  scope: string
  now: number
  counts: Record<QueueGroupKey | 'due' | 'open', number>
  groups: Record<QueueGroupKey, QueueRow[]>
  globalOpen: number
}
