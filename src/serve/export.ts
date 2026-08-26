/**
 * GET /export/:id.html.
 *
 * The served app's export button downloads exactly what `orangu report` writes: the self-contained,
 * offline, redacted single-file report, rendered by the same `renderReport` with the report defaults
 * (scrub on; transcript text stripped unless the server was started with --include-text).
 */
import type { RouteFactory } from './types.js'
import { HTML_ANTI_FRAMING_HEADERS } from './http-security.js'

export const exportRoutes: RouteFactory = (ctx) => [
  {
    method: 'GET',
    path: '/export/:id.html',
    handler: async (m, _req, res) => {
      const id = m.params.id ?? ''
      const analysis = await ctx.registry.analysis(id)
      if (!analysis) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `unknown session: ${id}` }))
        return
      }
      // render.ts now builds the <title> from the redacted data itself; no override needed.
      const { html } = ctx.renderReport(analysis, { redact: { scrub: true, stripText: !ctx.opts.includeText } })
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="orangu-${id}.html"`,
        ...HTML_ANTI_FRAMING_HEADERS,
      })
      res.end(html)
    },
  },
]
