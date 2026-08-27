/**
 * The DataSource seam: the client talks ONLY to this interface. File mode parses the embedded
 * #orangu-data block once; serve mode  implements the same interface over HTTP.
 * This file must never contain network API text; the single-file bundle is grepped for it (offline.test.ts).
 */
import type { Analysis } from '../../model/analysis.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { HarnessReport } from '../../harness/types.js'
import type { AppData, AppMode, SuggestionViewRecord } from '../../model/app-data.js'
import type { KickoffRequest, KickoffResponse, SuggestionRecord, SuggestionStatus } from '../../suggest/types.js'
import type { ServeEvent } from '../../serve/types.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../../suggest/id.js'

export type KickoffResult =
  | { ok: true; response: KickoffResponse }
  | { ok: false; kind: 'http' | 'network' | 'protocol'; message: string; status?: number; response?: Partial<KickoffResponse> }

export interface DataSource {
  readonly mode: AppMode
  /** file: parse #orangu-data once; serve: GET the app bootstrap */
  load(): Promise<AppData>
  /** file: the embedded session or null; serve: by id */
  session(id: string): Promise<Analysis | null>
  /** file: null (designed empty state, policy); serve: on demand */
  aggregate(scope: 'repo' | 'global', cwd?: string): Promise<Aggregate | null>
  /** file: null (the screen needs orangu serve); serve: on demand, polled while it computes */
  harness(): Promise<HarnessReport | null>
  suggestions(): Promise<SuggestionViewRecord[]>
  /** file: local copy-text only; serve: POST kickoff */
  kickoff(req: KickoffRequest): Promise<KickoffResult>
  /** file: null; serve: status transition */
  setStatus(id: string, status: SuggestionStatus): Promise<SuggestionViewRecord | null>
  /** file: no-op; serve: server-sent events */
  subscribe(fn: (ev: ServeEvent) => void): () => void
  /** file: null (Blob download instead); serve: an export URL */
  exportHref(id: string): string | null
}

declare global {
  interface Window {
    __ORANGU__?: AppData
  }
}

/** Read the embedded AppData once (file mode). */
export function embeddedSource(): DataSource {
  let cached: AppData | null = null
  const read = (): AppData | null => {
    if (cached) return cached
    if (window.__ORANGU__) {
      cached = window.__ORANGU__
      return cached
    }
    const el = document.getElementById('orangu-data')
    if (!el) return null
    try {
      cached = JSON.parse(el.textContent || 'null') as AppData
    } catch {
      cached = null
    }
    return cached
  }
  return {
    mode: 'file',
    async load() {
      const d = read()
      if (!d) throw new Error('no embedded data')
      return d
    },
    async session(id) {
      const d = read()
      return d?.session && d.session.session.id === id ? d.session : null
    },
    async aggregate() {
      return null
    },
    async harness() {
      return null
    },
    async suggestions() {
      return read()?.suggestions ?? []
    },
    async kickoff(req) {
      // a file:// page cannot write ~/.orangu, so the copy text carries the finding args
      const f = req.finding
      const key = suggestionKey(f, 'report')
      const rec: SuggestionRecord = {
        id: req.suggestionId ?? suggestionIdV2(key),
        v: 2,
        key,
        createdAt: 0,
        source: 'report',
        scope: f.scope,
        sessionIds: key.sessionIds,
        ruleId: f.ruleId,
        title: f.title,
        insightId: f.insightId,
        cohortFingerprint: f.cohortFingerprint,
        evidence: f.evidence,
        status: 'new',
        statusAt: 0,
      }
      const commands = kickoffCommands(rec, 'file')
      return { ok: true, response: { record: rec, commands, command: commands.claude, spawned: false } }
    },
    async setStatus() {
      return null
    },
    subscribe() {
      return () => {}
    },
    exportHref() {
      return null
    },
  }
}
