/**
 * Export route tests: GET /export/:id.html returns the same single-file report the
 * `orangu report` command produces (redacted, offline), with an attachment header. Offline assertion =
 * the same regex list scripts/assert-offline.mjs applies to a report body.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { goldenAnalysis, GOLDEN_FIXTURES } from '../../test/fixtures/corpus.js'
import type { Analysis } from '../model/analysis.js'
import { renderReport } from '../report/render.js'
import { exportRoutes } from './export.js'
import { extraRoutes } from './routes-extra.js'
import type { Route, RouteMatch, ServeContext, ServeOptions } from './types.js'

function makeCtx(analyses: Map<string, Analysis>, over: Partial<ServeOptions> = {}): ServeContext {
  const opts: ServeOptions = { open: false, includeText: false, noCache: true, version: 'test', ...over }
  return {
    opts,
    registry: { list: () => [], analysis: async (id: string) => analyses.get(id), pin: () => {} },
    store: {
      all: async () => [],
      get: async () => undefined,
      upsertNew: async () => {
        throw new Error('unused')
      },
      transition: async () => {
        throw new Error('unused')
      },
    },
    emit: () => {},
    now: () => 7_000,
    renderReport,
  }
}

function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk) state.body += chunk.toString()
      return res
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

async function get(route: Route, id: string) {
  const { res, state } = fakeRes()
  const m: RouteMatch = { params: { id }, query: new URLSearchParams() }
  await route.handler(m, {} as IncomingMessage, res)
  return state
}

function findRoute(ctx: ServeContext): Route {
  const route = exportRoutes(ctx).find((r) => r.method === 'GET' && r.path === '/export/:id.html')
  if (!route) throw new Error('GET /export/:id.html not registered')
  return route
}

// same list scripts/assert-offline.mjs runs over a report body (minus the #orangu-data JSON block)
const OFFLINE_CHECKS: Array<[RegExp, string]> = [
  [/https?:\/\/(?!localhost|127\.0\.0\.1)/, 'external http(s) URL'],
  [/<link\b/i, '<link> tag'],
  [/<img[^>]+src\s*=\s*["']https?:/i, 'remote image'],
  [/@import\s+url/i, '@import url'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/new\s+WebSocket/, 'WebSocket'],
  [/<iframe/i, 'iframe'],
]

describe('GET /export/:id.html', () => {
  const MARKER = 'private-export-marker-9073'
  it('serves the redacted single-file report with an attachment header, offline-clean', async () => {
    const a = await goldenAnalysis(GOLDEN_FIXTURES.find((f) => f.name === 'live-partial')!) // contains sk-ant-… + an email
    a.session.title = MARKER
    a.quality.gitCommits.push({ turnIndex: 0, ok: true, message: MARKER })
    const ctx = makeCtx(new Map([[a.session.id, a]]))
    const state = await get(findRoute(ctx), a.session.id)

    expect(state.status).toBe(200)
    expect(state.headers['Content-Type']).toContain('text/html')
    expect(state.headers['Content-Disposition']).toBe(`attachment; filename="orangu-${a.session.id}.html"`)
    expect(state.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(state.headers['X-Frame-Options']).toBe('DENY')
    expect(state.headers['Referrer-Policy']).toBe('no-referrer')

    // offline: the assert-offline body scan must be clean
    const body = state.body.slice(state.body.indexOf('</head>')).replace(/<script type="application\/json" id="orangu-data">[\s\S]*?<\/script>/, '')
    for (const [re, label] of OFFLINE_CHECKS) {
      expect(body.match(re), label).toBeNull()
    }
    expect(state.body).toContain("default-src 'none'")
    // redaction applied: the planted secret must not survive
    expect(state.body).not.toContain('sk-ant-')
    expect(state.body).not.toContain(MARKER)
  })

  it('produces the same bytes as renderReport with the report defaults (modulo the render clock)', async () => {
    const a = await goldenAnalysis(GOLDEN_FIXTURES.find((f) => f.name === 'canonical')!)
    const ctx = makeCtx(new Map([[a.session.id, a]]))
    const state = await get(findRoute(ctx), a.session.id)
    const direct = renderReport(a, { redact: { scrub: true, stripText: true } }).html
    const mask = (s: string) => s.replace(/"generatedAt":\d+/g, '"generatedAt":0').replace(/"ageMs":\d+/g, '"ageMs":0').replace(/"badge":"[a-z]+"/g, '"badge":"x"')
    expect(mask(state.body)).toBe(mask(direct))
  })

  it('honours --include-text (exportIncludeText) and ignores the viewer-only includeText', async () => {
    const a = await goldenAnalysis(GOLDEN_FIXTURES.find((f) => f.name === 'canonical')!)
    a.session.title = `${MARKER} sk-ant-api03-EXPORTMARKER9073`
    const ctx = makeCtx(new Map([[a.session.id, a]]), { includeText: true, exportIncludeText: true })
    // the viewer default (includeText: true, the cmdServe default) must not leak into the shareable download
    const stripped = await get(findRoute(makeCtx(new Map([[a.session.id, a]]), { includeText: true })), a.session.id)
    const kept = await get(findRoute(ctx), a.session.id)
    expect(kept.body.length).toBeGreaterThan(stripped.body.length)
    expect(stripped.body).not.toContain(MARKER)
    expect(kept.body).toContain(MARKER)
    expect(kept.body).not.toContain('sk-ant-api03-EXPORTMARKER9073')
  })

  it('404 on an unknown id', async () => {
    const ctx = makeCtx(new Map())
    const state = await get(findRoute(ctx), 'nope')
    expect(state.status).toBe(404)
  })

  it('is dispatched through the routes-extra registry', async () => {
    const a = await goldenAnalysis(GOLDEN_FIXTURES.find((f) => f.name === 'canonical')!)
    const ctx = makeCtx(new Map([[a.session.id, a]]))
    const routes = extraRoutes.flatMap((f) => f(ctx))
    expect(routes.find((r) => r.method === 'GET' && r.path === '/export/:id.html')).toBeDefined()
  })
})
