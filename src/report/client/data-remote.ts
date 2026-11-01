/**
 * Serve-mode DataSource: fetch + EventSource over the loopback API. Bundled ONLY into
 * CLIENT_JS_SERVE (serve-entry.ts); the single-file report bundle must never contain this text.
 * Throttles: ≤ 1 session(id) re-fetch per 2 s per session; aggregate 202-progress is polled.
 */
import type { Analysis } from '../../model/analysis.js'
import type { Aggregate } from '../../analyze/aggregate.js'
import type { HarnessReport } from '../../harness/types.js'
import type { AppData, SuggestionViewRecord } from '../../model/app-data.js'
import type { KickoffRequest, KickoffResponse, SuggestionStatus } from '../../suggest/types.js'
import type { RejectReasonCode } from '../../suggest/reason-codes.js'
import type { ServeEvent } from '../../serve/types.js'
import type { DataSource, ProfileRead, ReadWatch } from './data.js'
import type { QueueRead } from './queue-types.js'
import type { ChangeRow, LessonRead } from './lesson-types.js'

const SESSION_THROTTLE_MS = 2_000
const AGG_POLL_MS = 800
const AGG_TIMEOUT_MS = 120_000

/** The served shell lives at the capability base; trim only its optional trailing slash. */
export function remoteBasePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/** 1 GET. A refused read gives a null body and the `error` text of its JSON body when it has one (the server scrubs it). */
async function getJson<T>(url: string): Promise<{ status: number; body: T | null; error?: string }> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    if (!r.ok && r.status !== 202) {
      const error = await r.json().then((b: { error?: unknown }) => (typeof b?.error === 'string' ? b.error : undefined), () => undefined)
      return { status: r.status, body: null, ...(error ? { error } : {}) }
    }
    return { status: r.status, body: (await r.json()) as T }
  } catch {
    return { status: 0, body: null }
  }
}

/**
 * 202 {progress} is polled until the 200 body arrives (aggregates and the harness report compute lazily). `watch` hears
 * the progress of each 202 body, and the reason when the read gives null.
 */
async function pollJson<T>(url: string, watch?: ReadWatch): Promise<T | null> {
  const t0 = Date.now()
  for (;;) {
    const { status, body, error } = await getJson<T>(url)
    if (status === 200 && body) return body
    if (status !== 202) {
      watch?.failed?.(status === 0 ? 'The request to localhost failed.' : error ?? `The server answered ${status}.`)
      return null
    }
    const progress = (body as { progress?: { done?: unknown; total?: unknown } } | null)?.progress
    if (typeof progress?.done === 'number' && typeof progress.total === 'number') watch?.progress?.(progress.done, progress.total)
    if (Date.now() - t0 > AGG_TIMEOUT_MS) {
      watch?.failed?.(`The read did not end in ${AGG_TIMEOUT_MS / 60_000} minutes.`)
      return null
    }
    await new Promise((r) => setTimeout(r, AGG_POLL_MS))
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
    async aggregate(scope, cwd, watch) {
      return pollJson<Aggregate>(scope === 'repo' ? base + '/api/repo' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '') : base + '/api/global', watch)
    },
    async harness() {
      return pollJson<HarnessReport>(base + '/api/harness')
    },
    async suggestions() {
      const { body } = await getJson<SuggestionViewRecord[]>(base + '/api/suggestions')
      return body ?? []
    },
    // no cwd: the route takes the --cwd of serve, so no path of the browser reaches it
    async queue(all) {
      return (await getJson<QueueRead>(base + '/api/queue' + (all ? '?all=1' : ''))).body
    },
    async history(all) {
      return (await getJson<ChangeRow[]>(base + '/api/history' + (all ? '?all=1' : ''))).body
    },
    async lessons(all) {
      return (await getJson<LessonRead>(base + '/api/lessons' + (all ? '?all=1' : ''))).body
    },
    // the body is exactly { exists, updatedAt }: no path and no answer of the person
    async profile() {
      return (await getJson<ProfileRead>(base + '/api/profile')).body
    },
    async kickoff(req) {
      let r: Response
      try {
        r = await fetch(base + '/api/kickoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
      } catch (error) {
        return { ok: false, kind: 'network', message: error instanceof Error ? error.message : 'The request to localhost failed.' }
      }
      let body: Partial<KickoffResponse> | null = null
      try {
        body = (await r.json()) as Partial<KickoffResponse>
      } catch {
        /* retain status below even when a proxy returned a non-JSON body */
      }
      if (!r.ok)
        return { ok: false, kind: 'http', status: r.status, message: body?.error || `The request to localhost failed (${r.status}).`, ...(body ? { response: body } : {}) }
      if (
        !body?.record ||
        typeof body.command !== 'string' ||
        !body.commands ||
        typeof body.commands.claude !== 'string' ||
        typeof body.commands.codex !== 'string' ||
        body.command !== body.commands.claude ||
        body.spawned !== false
      )
        return { ok: false, kind: 'protocol', status: r.status, message: 'localhost returned an incomplete response.', ...(body ? { response: body } : {}) }
      return { ok: true, response: body as KickoffResponse }
    },
    // the body holds the status and 1 reason code or none: never a text of the person, and never a path
    async setStatus(id, status: SuggestionStatus, reason?: RejectReasonCode) {
      try {
        const r = await fetch(base + '/api/suggestions/' + encodeURIComponent(id) + '/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reason ? { status, reason } : { status }),
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
