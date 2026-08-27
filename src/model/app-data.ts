/**
 * AppData: the ONE shape the app client renders from.
 * File mode: embedded in the report's `#orangu-data` by render.ts. Serve mode: returned by GET /api/app.
 * Platform-neutral (type-only imports; no node). Additive changes only; breaking → bump APP_DATA_VERSION.
 */
import type { Analysis } from './analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'
import type { SuggestionRecord } from '../suggest/types.js'

/** A server-computed display claim. It is never accepted as a persisted lifecycle artifact. */
export interface SuggestionViewRecord extends SuggestionRecord {
  verificationTrusted?: true
}

export const APP_DATA_VERSION = '1' as const
/** Placeholder the redactor substitutes for a stripped count-map key. Rendered as a hidden-count note, never as data. */
export const STRIPPED_KEY = '\u2039stripped\u203a'
export type AppMode = 'file' | 'serve'
/** policy: live < 5 min · idle 5–30 min · ended > 30 min, from the transcript's mtime */
export type LiveBadge = 'live' | 'idle' | 'ended'

export interface AppCapabilities {
  live: boolean
  aggregates: boolean
  kickoffRun: boolean
  exportHtml: boolean
  includeText: boolean
}

/** One entry of a session's recent-events ring for the fleet feed; redacted server-side. */
export interface RowEventView {
  ts?: number
  name: string
  category: string
  summary: string
}

/** one row per session: picker · live nav · fleet cards · Live KPIs */
export interface SessionSummaryRow {
  id: string
  projectSlug: string
  cwd?: string
  title?: string
  path: string
  /** discovery source key ('claude-code' | 'cowork' | 'desktop' | …); the client maps it to a label (policy) */
  source: string
  sizeBytes: number
  mtimeMs: number
  badge: LiveBadge
  ageMs: number
  /** trailing partial last line; changes the copy only ("Watching · possibly live") */
  possiblyLive: boolean
  // optional numerics exist once an Analysis does
  startedAt?: number
  turns?: number
  toolCalls?: number
  toolErrors?: number
  tokens?: number
  contextFinal?: number
  contextWindow?: number
  cacheHitRatio?: number
  compactions?: number
  agentsTotal?: number
  agentsRunning?: number
  lastEvent?: { ts?: number; name: string; category: string; summary: string }
  /** recent-events ring (≤ 5 entries, serve-only) merged into the fleet feed */
  lastEvents?: RowEventView[]
}

export interface AppData {
  v: typeof APP_DATA_VERSION
  mode: AppMode
  /** orangu version that produced the data */
  version: string
  /** CLI clock at render / response time; never used as data by the client */
  generatedAt: number
  /** explicit public-demo marker; absent for user reports and the localhost app */
  illustrative?: boolean
  capabilities: AppCapabilities
  /** file: the one session; serve: ?s= or latest */
  selectedId?: string
  /** file: always; serve: present on GET /api/app?s=<id> */
  session?: Analysis
  /** file: [the one]; serve: all discovered */
  sessions: SessionSummaryRow[]
  /** file: {} (policy serve-only); serve: filled on demand */
  aggregates: { repo?: Aggregate; global?: Aggregate }
  /** file: []; serve: current state per id */
  suggestions: SuggestionViewRecord[]
  redaction?: { applied: number; strippedText: boolean; strippedPaths: boolean }
}
