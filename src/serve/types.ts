/**
 * Serve-mode contract. Consumed by src/serve/* , routes-extra/kickoff/export  and the
 * remote client data source. Wave-C chunks may extend these types additively; never change the existing members.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Analysis } from '../model/analysis.js'
import type { AppCapabilities, LiveBadge, SessionSummaryRow } from '../model/app-data.js'
import type { SuggestionRecord, SuggestionStatus, SuggestionStoreLike } from '../suggest/types.js'

/** policy: live = mtime age < 5 min; idle = 5–30 min; ended = ≥ 30 min */
export const LIVE_THRESHOLDS_MS = { live: 5 * 60_000, idle: 30 * 60_000 } as const

export type ServeEvent =
  | { type: 'hello'; serverId: string; capabilities: AppCapabilities }
  /** one per completed analysis tick */
  | { type: 'session-updated'; id: string; seq: number; row: SessionSummaryRow }
  /** badge changed (mtime crossed a threshold) */
  | { type: 'session-live'; id: string; badge: LiveBadge; ageMs: number }
  | { type: 'session-added'; row: SessionSummaryRow }
  | { type: 'suggestion-updated'; id: string; status: SuggestionStatus }
  /** client-side only: the remote DataSource's EventSource connection state */
  | { type: 'connection'; state: 'connected' | 'reconnecting' }

export interface ServeOptions {
  port?: number
  open: boolean
  includeText: boolean
  configDir?: string
  roots?: string[]
  cwd?: string
  noCache: boolean
  version: string
  /** policy cap on concurrently tailed sessions; default 8, raise with --max-live */
  maxLive?: number
}

export interface RegistryLike {
  list(): SessionSummaryRow[]
  analysis(id: string): Promise<Analysis | undefined>
  pin(id: string): void
}

export interface ServeContext {
  opts: ServeOptions
  registry: RegistryLike
  store: SuggestionStoreLike
  emit(ev: ServeEvent): void
  /** records an in-process store write and emits it without a later poll duplicate */
  noteSuggestion?(record: SuggestionRecord): void
  now(): number
  renderReport: typeof import('../report/render.js').renderReport
}

export interface RouteMatch {
  params: Record<string, string>
  query: URLSearchParams
  body?: unknown
}
export type RouteHandler = (m: RouteMatch, req: IncomingMessage, res: ServerResponse) => Promise<void>
export interface Route {
  method: 'GET' | 'POST'
  /** pattern with `:name` params, e.g. '/export/:id.html' */
  path: string
  handler: RouteHandler
}
export type RouteFactory = (ctx: ServeContext) => Route[]
