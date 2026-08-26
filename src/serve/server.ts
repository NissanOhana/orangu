/**
 * orangu serve: zero-dependency node:http server, 127.0.0.1 ONLY (loopback is the auth,
 * §API). Routes = coreRoutes (api.ts) + extraRoutes . Logging contract: at most one stderr line
 * per request, never transcript content.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { cpus } from 'node:os'
import { AnalysisCache } from '../cache/index.js'
import { renderReport } from '../report/render.js'
import { SuggestionStore } from '../suggest/store.js'
import type { SuggestionStoreLike } from '../suggest/types.js'
import { coreRoutes } from './api.js'
import { Registry, type RegistryOptions } from './registry.js'
import { extraRoutes } from './routes-extra.js'
import { SseHub } from './sse.js'
import { SuggestionWatcher } from './suggestion-watcher.js'
import type { Route, ServeContext, ServeOptions } from './types.js'

const BODY_LIMIT = 1 << 20 // 1 MB

export interface ServeDeps {
  now?: () => number
  store?: SuggestionStoreLike
  cache?: AnalysisCache | null
  registry?: Registry
  analyze?: RegistryOptions['analyze']
  read?: RegistryOptions['read']
  /** registry size-poll interval override; tests use it to exercise start()'s timer path quickly */
  pollMs?: number
  /** registry full-rescan interval override (tests) */
  rescanMs?: number
  /** suppress the per-request stderr line (tests) */
  quiet?: boolean
  /** cross-process suggestion JSONL poll interval override (tests) */
  suggestionPollMs?: number
}

export interface ServeHandle {
  url: string
  port: number
  registry: Registry
  hub: SseHub
  suggestionWatcher: SuggestionWatcher
  close(): Promise<void>
}

interface Matched {
  route: Route
  params: Record<string, string>
}

/** ':name' segments, with an optional literal suffix (':id.html'). */
export function matchRoute(routes: Route[], method: string, pathname: string): Matched | undefined {
  const segs = pathname.split('/').filter((s) => s.length)
  for (const route of routes) {
    if (route.method !== method) continue
    const psegs = route.path.split('/').filter((s) => s.length)
    if (route.path === '/' && segs.length === 0) return { route, params: {} }
    if (psegs.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < psegs.length; i++) {
      const p = psegs[i]!
      const s = decodeURIComponent(segs[i]!)
      if (p.startsWith(':')) {
        const m = /^:([A-Za-z0-9_]+)(.*)$/.exec(p)!
        const suffix = m[2]!
        if (suffix && !s.endsWith(suffix)) {
          ok = false
          break
        }
        params[m[1]!] = suffix ? s.slice(0, -suffix.length) : s
      } else if (p !== s) {
        ok = false
        break
      }
    }
    if (ok) return { route, params }
  }
  return undefined
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let len = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    len += c.length
    if (len > BODY_LIMIT) throw new Error('body too large')
    chunks.push(c)
  }
  if (!len) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

interface RequestRejection {
  status: 403 | 415
  error: string
}

function requestHost(req: Pick<IncomingMessage, 'headers'>): string {
  return typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
}

/** Reject missing, non-loopback, and DNS-rebinding Host headers on every request. */
function rejectUntrustedHost(req: Pick<IncomingMessage, 'headers'>): RequestRejection | undefined {
  if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(requestHost(req)))
    return { status: 403, error: 'request host must be loopback' }
  return undefined
}

/**
 * A loopback bind prevents remote connections, but it does not prevent a web
 * page in the user's browser from sending a simple cross-origin request. Keep
 * mutations JSON-only and accept browser Origins only from this exact local
 * server. The shared Host allowlist also closes DNS-rebinding aliases.
 */
export function rejectUntrustedMutation(req: Pick<IncomingMessage, 'headers'>): RequestRejection | undefined {
  const hostRejection = rejectUntrustedHost(req)
  if (hostRejection) return hostRejection
  const host = requestHost(req)

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== host)
        return { status: 403, error: 'cross-origin mutation blocked' }
    } catch {
      return { status: 403, error: 'cross-origin mutation blocked' }
    }
  }

  const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';', 1)[0]!.trim().toLowerCase() : ''
  if (contentType !== 'application/json') return { status: 415, error: 'POST requests require application/json' }
  return undefined
}

/**
 * Browsers attach Origin and/or Sec-Fetch-Site to cross-site requests, including
 * blind GETs that do not need CORS to consume loopback CPU. Reject only an
 * explicit cross-site signal; command-line clients without browser metadata
 * remain supported. Host validation is repeated so this helper is safe alone.
 */
export function rejectCrossSiteBrowserGet(req: Pick<IncomingMessage, 'headers'>): RequestRejection | undefined {
  const hostRejection = rejectUntrustedHost(req)
  if (hostRejection) return hostRejection

  const fetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'].trim().toLowerCase() : ''
  if (fetchSite === 'cross-site') return { status: 403, error: 'cross-site browser GET blocked' }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  if (!origin) return undefined
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== requestHost(req))
      return { status: 403, error: 'cross-site browser GET blocked' }
  } catch {
    return { status: 403, error: 'cross-site browser GET blocked' }
  }
  return undefined
}

export async function startServe(opts: ServeOptions, deps: ServeDeps = {}): Promise<ServeHandle> {
  const now = deps.now ?? Date.now
  const cache = deps.cache !== undefined ? deps.cache : opts.noCache ? null : new AnalysisCache({ version: opts.version })
  const store = deps.store ?? new SuggestionStore()
  const hub = new SseHub()
  const suggestionWatcher = new SuggestionWatcher(store, (ev) => hub.emit(ev), deps.suggestionPollMs)
  const registry =
    deps.registry ??
    new Registry(
      { opts, cache, concurrency: Math.max(1, cpus().length - 1), now: deps.now, analyze: deps.analyze, read: deps.read, pollMs: deps.pollMs, rescanMs: deps.rescanMs },
      (ev) => hub.emit(ev),
    )
  const ctx: ServeContext = {
    opts,
    registry,
    store,
    emit: (ev) => hub.emit(ev),
    noteSuggestion: (record) => suggestionWatcher.observe(record),
    now,
    renderReport,
  }
  const routes: Route[] = [...coreRoutes(ctx, hub), ...extraRoutes.flatMap((f) => f(ctx))]

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let logPath = '[malformed request path]'
    if (!deps.quiet) res.on('finish', () => process.stderr.write(`${req.method} ${logPath} ${res.statusCode}\n`))
    const hostRejection = rejectUntrustedHost(req)
    if (hostRejection) {
      res.writeHead(hostRejection.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: hostRejection.error }))
      return
    }
    if (req.method === 'GET') {
      const readRejection = rejectCrossSiteBrowserGet(req)
      if (readRejection) {
        res.writeHead(readRejection.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: readRejection.error }))
        return
      }
    }
    let url: URL
    let m: Matched | undefined
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
      logPath = url.pathname
      m = matchRoute(routes, req.method ?? 'GET', url.pathname)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"error":"malformed request path"}')
      return
    }
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    let body: unknown
    if (req.method === 'POST') {
      const rejection = rejectUntrustedMutation(req)
      if (rejection) {
        res.writeHead(rejection.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: rejection.error }))
        return
      }
      try {
        body = await readBody(req)
      } catch {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end('{"error":"body too large"}')
        return
      }
    }
    try {
      await m.route.handler({ params: m.params, query: url.searchParams, body }, req, res)
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
      } else res.end()
    }
  }

  const server: Server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)
  await registry.start()
  await suggestionWatcher.start()

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registry,
    hub,
    suggestionWatcher,
    close: async () => {
      await suggestionWatcher.stop()
      hub.stop()
      await registry.stop()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
