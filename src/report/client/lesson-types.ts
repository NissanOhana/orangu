/**
 * The history read of `GET /api/history` and the lesson read of `GET /api/lessons`, v1, as the app reads them. Types
 * only: this file has no runtime code.
 *
 * The server shapes are `ChangeRow` and `LessonRead` in src/suggest/lessons.ts. No file under src/report/client imports
 * that module (src/suggest/queue.test.ts), so this file names the keys that the client reads, and history-ui.test.ts
 * holds them assignable from the server shapes. A verdict word is a plain string here: the client compares it with no
 * value of its own.
 */
import type { SuggestionScope, SuggestionStatus, SuggestionVerificationComparison, SuggestionVerificationMetric } from '../../suggest/types.js'

/** 1 graded check of a lesson. */
export interface LessonCheck {
  metric: SuggestionVerificationMetric
  comparison: SuggestionVerificationComparison
  verdict: string
}

/** 1 lesson: ids, codes, enum values, counts and times. */
export interface Lesson {
  id: string
  scope: SuggestionScope
  ruleId: string | null
  changeClass?: string
  status: SuggestionStatus
  reasonCode?: string
  /** null when no receipt grades again on this read */
  verdict: string | null
  verdictTrusted: boolean
  confoundedBy: string[]
  baseline: number
  later: number
  checks: LessonCheck[]
  appliedAt?: number
  decidedAt: number
}

/** The lesson read: `scope` is the scrubbed workspace path, `all` or `global`. */
export interface LessonRead {
  v: 1
  scope: string
  maxBytes: number | null
  omitted: number
  lessons: Lesson[]
}

/** 1 graded check of a change: the lesson check and its cohort means. A check of the earlier receipt form has no p-value. */
export interface ChangeCheck extends LessonCheck {
  before: number
  after: number
  pLower: number | null
  pHigher: number | null
}

/** 1 applied change: the lesson keys, the stored title, the files and the check means. The read has no workspace key. */
export interface ChangeRow extends Omit<Lesson, 'checks' | 'decidedAt'> {
  checks: ChangeCheck[]
  /** absent on an open row: `applied` or `regressed` */
  decidedAt?: number
  /** the stored title: it can be model text, so the app escapes it */
  title: string
  files: string[]
}
