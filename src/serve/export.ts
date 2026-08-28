/**
 * GET /export/:id.html.
 *
 * The served app's export button downloads exactly what `orangu report` writes: the self-contained,
 * offline, redacted single-file report, rendered by the same `renderReport` with the report defaults.
 *
 * Text policy is deliberately split from the viewer's: the loopback viewer shows the operator their own
 * transcript previews by default (`opts.includeText`), but this download is a shareable file that leaves
 * the machine, so it stays stripped unless the server was started with --include-text (`opts.exportIncludeText`).
 */
import type { RouteFactory } from './types.js'
import { HTML_ANTI_FRAMING_HEADERS } from './http-security.js'
import { SESSION_ID_RE } from '../discover/discover.js'

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
      const { html } = ctx.renderReport(analysis, { redact: { scrub: true, stripText: !ctx.opts.exportIncludeText } })
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // a transcript filename is the id: only a canonical one may name the download (header parameter injection)
        'Content-Disposition': `attachment; filename="orangu-${SESSION_ID_RE.test(id) ? id : 'session'}.html"`,
        ...HTML_ANTI_FRAMING_HEADERS,
      })
      res.end(html)
    },
  },
]
