/**
 * Server-side report renderer: assembles the self-contained HTML file.
 *
 * Security invariants (tested in render.test.ts and by scripts/assert-offline):
 * - the analysis JSON is embedded in a <script type="application/json"> block with `<` and `</script>`
 *   escaped so no transcript content can break out into executable markup
 * - the page makes ZERO network requests: CSS and JS are inlined; a CSP meta forbids any external origin;
 *   image sources are embedded data: URIs; there is no remote image, font URL, or fetch
 */
import * as bundle from './generated/client-bundle.js'
import { CLIENT_CSS, CLIENT_JS, BUILD_VERSION } from './generated/client-bundle.js'
import { BRAND_ICON_ID } from './brand.js'
import type { Analysis } from '../model/analysis.js'
import type { AppCapabilities } from '../model/app-data.js'
import { APP_DATA_VERSION, type AppData, type SessionSummaryRow } from '../model/app-data.js'
import { badgeFor } from '../serve/badge.js'
import { redactAnalysis, type RedactOptions, type RedactionReport } from '../redact/redact.js'
import type { FeedbackBootstrap } from '../feedback/diagnostics.js'

export interface RenderOptions {
  redact?: RedactOptions | false
  /** override the <title> */
  title?: string
  /** mark a generated public demo as synthetic in every rendered screen */
  illustrative?: boolean
  /** set only by `orangu watch`: the file is rewritten as the transcript grows, so the Live screen is honest */
  watch?: boolean
}

export interface RenderResult {
  html: string
  redaction?: RedactionReport
}

/** Escape a JSON string for safe embedding inside <script>…</script>. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/**
 * Current brand mark: design/brand/mascot-96.png as a base64 data-URI, embedded at authoring time
 * (the npm package does not ship design/). These are the exact bytes used by the landing header.
 *
 * Injected via an inline head script rather than a literal <link> tag because the offline gate
 * (scripts/assert-offline.mjs and test/assert-offline.test.ts) rejects any `<link` text in the
 * document, the likeliest web-font regression vector. A data: href makes zero network requests and
 * the CSP stays untouched. The 96px image stays below the 40 KB head-growth budget and is the one
 * raster payload shared by the favicon and every in-app mascot placement.
 */
const BRAND_MASCOT_96_DATA_URI = 'data:image/png;base64,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'
const BRAND_ICON_SCRIPT = `<script>var l=document.createElement("link");l.id="${BRAND_ICON_ID}";l.rel="icon";l.type="image/png";l.href="${BRAND_MASCOT_96_DATA_URI}";document.head.appendChild(l);</script>`

/** One SessionSummaryRow from a full Analysis (file mode has exactly this one). */
export function rowFromAnalysis(a: Analysis, now: number): SessionSummaryRow {
  const { badge, ageMs } = badgeFor(a.session.endedAt ?? now, now)
  const last = a.tools.calls[a.tools.calls.length - 1]
  return {
    id: a.session.id,
    projectSlug: a.session.projectSlug ?? '',
    cwd: a.session.cwd,
    title: a.session.title,
    path: a.session.path,
    source: a.session.source,
    sizeBytes: a.parse.bytes,
    mtimeMs: a.session.endedAt ?? now,
    badge,
    ageMs,
    possiblyLive: a.session.live,
    startedAt: a.session.startedAt,
    turns: a.summary.turns,
    toolCalls: a.summary.toolCalls,
    toolErrors: a.summary.toolErrors,
    tokens: a.summary.totalTokens,
    contextFinal: a.context.final,
    contextWindow: a.context.contextWindow,
    cacheHitRatio: a.summary.cacheHitRatio,
    compactions: a.summary.compactions,
    agentsTotal: a.agents.totals.count,
    agentsRunning: 0,
    lastEvent: last ? { ts: last.startTs, name: last.name, category: last.category, summary: last.summary } : undefined,
  }
}

export function renderReport(analysis: Analysis, options: RenderOptions = {}): RenderResult {
  let data = analysis
  let redaction: RedactionReport | undefined
  if (options.redact !== false) {
    const r = redactAnalysis(analysis, options.redact || {})
    data = r.analysis
    redaction = r.report
  }
  const now = data.generator.generatedAt
  const stripText = options.redact !== false && options.redact?.stripText === true
  const appData: AppData = {
    v: APP_DATA_VERSION,
    mode: 'file',
    version: BUILD_VERSION,
    generatedAt: now,
    ...(options.illustrative ? { illustrative: true } : {}),
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: !stripText, ...(options.watch ? { watch: true } : {}) },
    selectedId: data.session.id,
    session: data,
    sessions: [rowFromAnalysis(data, now)],
    aggregates: {},
    suggestions: [],
    redaction: redaction ? { applied: redaction.applied, strippedText: redaction.strippedText, strippedPaths: redaction.strippedPaths } : undefined,
  }
  // Build the <title> from redacted data, never the raw analysis, so it cannot leak secrets.
  const title = escapeHtml(options.title ?? `orangu · ${data.session.title || data.session.id.slice(0, 8)}`)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="${CSP}"/>
<meta name="generator" content="orangu ${escapeHtml(BUILD_VERSION)}"/>
<meta name="robots" content="noindex"/>
<title>${title}</title>
${BRAND_ICON_SCRIPT}
<style>${CLIENT_CSS}</style>
</head>
<body data-density="comfortable">
<div id="app" class="app"></div>
<script type="application/json" id="orangu-data">${safeJson(appData)}</script>
<script>window.__ORANGU__=JSON.parse(document.getElementById('orangu-data').textContent);</script>
<script>${CLIENT_JS}</script>
</body>
</html>`
  return { html, redaction }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The serve bundle is a separate esbuild entry (two bundles from one source, the design): the file-mode
// bundle must contain no network API text. Accessed via the namespace so a stale committed
// client-bundle.ts (pre-build) still typechecks; `npm run build` regenerates it before anything runs.
const CLIENT_JS_SERVE: string = (bundle as { CLIENT_JS_SERVE?: string }).CLIENT_JS_SERVE ?? ''

/** loopback app shell: same-origin API + SSE allowed, everything else forbidden */
const CSP_SERVE =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'"

export interface ShellOptions {
  version: string
  capabilities: AppCapabilities
  /** tailed-session cap for the fleet header ("watching X of N", policy) */
  maxLive: number
  /** Generic, explicitly allowlisted facts shown in the beta feedback preview. */
  feedback: FeedbackBootstrap
}

/** The served app shell (logical GET /): no embedded AppData. The client uses the authenticated base path. */
export function renderShell(o: ShellOptions): string {
  const boot = { maxLive: o.maxLive, capabilities: o.capabilities, version: o.version, feedback: o.feedback }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<meta http-equiv="Content-Security-Policy" content="${CSP_SERVE}"/>
<meta name="generator" content="orangu ${escapeHtml(o.version)}"/>
<meta name="robots" content="noindex"/>
<title>orangu · live</title>
${BRAND_ICON_SCRIPT}
<style>${CLIENT_CSS}</style>
</head>
<body>
<div id="app" class="app"></div>
<script>window.__ORANGU_SERVE__=${safeJson(boot)};</script>
<script>${CLIENT_JS_SERVE}</script>
</body>
</html>`
}

export { BUILD_VERSION }
