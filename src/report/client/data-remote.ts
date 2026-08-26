/**
 * Serve-mode DataSource: fetch + EventSource over the loopback API. Bundled ONLY into
 * CLIENT_JS_SERVE (serve-entry.ts); the single-file report bundle must never contain this text.
 * Throttles: ≤ 1 session(id) re-fetch per 2 s per session; aggregate 202-progress is polled.
 */
import type { Analysis } from '../../model/analysis.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { AppData, SuggestionViewRecord } from '../../model/app-data.js'
import type { KickoffRequest, KickoffResponse, SuggestionStatus } from '../../suggest/types.js'
import type { ServeEvent } from '../../serve/types.js'
import type { DataSource } from './data.js'

const SESSION_THROTTLE_MS = 2_000
const AGG_POLL_MS = 800
const AGG_TIMEOUT_MS = 120_000

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    if (!r.ok && r.status !== 202) return { status: r.status, body: null }
    return { status: r.status, body: (await r.json()) as T }
  } catch {
    return { status: 0, body: null }
  }
}

export function remoteSource(base = ''): DataSource {
  const sessionCache = new Map<string, { at: number; analysis: Analysis | null; inflight?: Promise<Analysis | null> }>()
  const listeners = new Set<(ev: ServeEvent) => void>()
  let es: EventSource | null = null

  const fanout = (ev: ServeEvent): void => {
    for (const fn of listeners) fn(ev)
  }

  const ensureStream = (): void => {
    if (es) return
    es = new EventSource(base + '/events')
    es.onopen = () => fanout({ type: 'connection', state: 'connected' })
    es.onerror = () => fanout({ type: 'connection', state: 'reconnecting' }) // EventSource reconnects on its own (Last-Event-ID replays the ring)
    for (const t of ['hello', 'session-updated', 'session-live', 'session-added', 'suggestion-updated']) {
      es.addEventListener(t, (raw) => {
        try {
          fanout(JSON.parse((raw as MessageEvent<string>).data) as ServeEvent)
        } catch {
          /* malformed frame: skip */
        }
      })
    }
  }

  return {
    mode: 'serve',
    async load() {
      const s = /[?&#]s=([^&]+)/.exec(location.hash)?.[1]
      const { body } = await getJson<AppData>(base + '/api/app' + (s ? `?s=${encodeURIComponent(s)}` : ''))
      if (!body) throw new Error('orangu serve unreachable')
      if (body.session) sessionCache.set(body.session.session.id, { at: Date.now(), analysis: body.session })
      return body
    },
    async session(id) {
      const now = Date.now()
      const c = sessionCache.get(id)
      if (c?.inflight) return c.inflight
      if (c && now - c.at < SESSION_THROTTLE_MS) return c.analysis
      const p = getJson<Analysis>(base + '/api/session/' + encodeURIComponent(id)).then(({ body }) => {
        sessionCache.set(id, { at: Date.now(), analysis: body })
        return body
      })
      sessionCache.set(id, { at: now, analysis: c?.analysis ?? null, inflight: p })
      return p
    },
    async aggregate(scope, cwd) {
      const url = scope === 'repo' ? base + '/api/repo' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '') : base + '/api/global'
      const t0 = Date.now()
      for (;;) {
        const { status, body } = await getJson<Aggregate>(url)
        if (status === 200 && body) return body
        if (status !== 202 || Date.now() - t0 > AGG_TIMEOUT_MS) return null
        await new Promise((r) => setTimeout(r, AGG_POLL_MS))
      }
    },
    async suggestions() {
      const { body } = await getJson<SuggestionViewRecord[]>(base + '/api/suggestions')
      return body ?? []
    },
    async kickoff(req) {
      let r: Response
      try {
        r = await fetch(base + '/api/kickoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
      } catch (error) {
        return { ok: false, kind: 'network', message: error instanceof Error ? error.message : 'localhost request failed' }
      }
      let body: Partial<KickoffResponse> | null = null
      try {
        body = (await r.json()) as Partial<KickoffResponse>
      } catch {
        /* retain status below even when a proxy returned a non-JSON body */
      }
      if (!r.ok)
        return { ok: false, kind: 'http', status: r.status, message: body?.error || `localhost request failed (${r.status})`, ...(body ? { response: body } : {}) }
      if (
        !body?.record ||
        typeof body.command !== 'string' ||
        !body.commands ||
        typeof body.commands.claude !== 'string' ||
        typeof body.commands.codex !== 'string' ||
        body.command !== body.commands.claude ||
        body.spawned !== false
      )
        return { ok: false, kind: 'protocol', status: r.status, message: 'localhost returned an incomplete kickoff response', ...(body ? { response: body } : {}) }
      return { ok: true, response: body as KickoffResponse }
    },
    async setStatus(id, status: SuggestionStatus) {
      try {
        const r = await fetch(base + '/api/suggestions/' + encodeURIComponent(id) + '/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        })
        if (!r.ok) return null
        return (await r.json()) as SuggestionViewRecord
      } catch {
        return null
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      ensureStream()
      return () => {
        listeners.delete(fn)
      }
    },
    exportHref(id) {
      return id ? base + '/export/' + encodeURIComponent(id) + '.html' : null
    },
  }
}
