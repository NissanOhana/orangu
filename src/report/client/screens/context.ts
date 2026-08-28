/**
 * Context & tokens (Detailed-only): one headline sentence from three measured facts, the context
 * curve and "Where the tokens went" at full weight, the other charts under "More charts" (A5).
 */
import type { Ctx } from '../app.js'
import { catColor, esc, pct, plural, tok } from '../format.js'
import { h } from '../dom.js'
import { kpi } from '../components/kpi.js'
import { degradedBanner } from '../components/banner.js'
import { noSession } from '../components/empty.js'
import { compactionMarkers, contextHeadline } from '../derive.js'
import { lineChart, proportionRows, stackedArea, stackedBar } from '../charts.js'
import { card } from '../components/card.js'

export function renderContext(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a) return noSession()
  const c = a.context
  const main = c.series.filter((p) => !p.agentId)
  const compMarkers = compactionMarkers(c.compactions, main)
  const ctxLine = lineChart(
    main.map((p) => p.contextSize),
    { threshold: c.contextWindow ? { y: c.contextWindow, label: 'window ' + tok(c.contextWindow) } : undefined, markers: compMarkers, yMax: c.contextWindow, fmtY: tok },
  )
  const stack = stackedArea(
    [main.map((p) => p.cacheRead), main.map((p) => p.cacheWrite), main.map((p) => p.input), main.map((p) => p.output)],
    ['var(--cat-read)', 'var(--cat-edit)', 'var(--cat-write)', 'var(--cat-agent)'],
    { markers: compMarkers, labels: ['cache read', 'cache write', 'fresh input', 'output'] },
  )
  const co = a.tokens
  const byKind = [
    { value: co.byKind.cacheRead, color: 'var(--cat-read)', label: 'cache read ' + tok(co.byKind.cacheRead) },
    { value: co.byKind.cacheWrite5m, color: 'var(--cat-skill)', label: 'cache write 5m ' + tok(co.byKind.cacheWrite5m) },
    { value: co.byKind.cacheWrite1h, color: 'var(--cat-edit)', label: 'cache write 1h ' + tok(co.byKind.cacheWrite1h) },
    { value: co.byKind.input, color: 'var(--cat-write)', label: 'fresh input ' + tok(co.byKind.input) },
    { value: co.byKind.output, color: 'var(--cat-agent)', label: 'output ' + tok(co.byKind.output) },
  ]
  const byModel = proportionRows(
    co.byModel.map((m) => ({ label: m.displayName, value: m.totalTokens, color: catColor('edit'), sub: m.estimatedMatch ? '~est. match' : '' })),
    (v) => tok(v),
  )
  const serverTools = co.serverToolRequests.webSearch + co.serverToolRequests.webFetch
  const cum = lineChart(
    co.byTurn.map((t) => t.cumulativeTokens),
    { color: 'var(--accent-ink)', fmtY: tok },
  )
  const more = [
    card('Token composition per request', `<div class="scroll-x">${stack}</div><div class="legend">${['read', 'edit', 'write', 'agent'].map((c, i) => `<span><i class="sw" style="background:var(--cat-${c})"></i>${['cache read', 'cache write', 'fresh input', 'output'][i]}</span>`).join('')}</div>`, 'mb16'),
    card('By model', `${byModel}<p class="small muted" style="margin-top:8px">Main thread ${esc(tok(co.mainThread))} · agents ${esc(tok(co.agents))}</p>`, 'mb16'),
    card('Cumulative tokens over turns', `<div class="scroll-x">${cum}</div>`),
  ].join('')
  return h(`<section>
${degradedBanner(a, ctx.audience)}
<p class="ctx-lead">${esc(contextHeadline(a))}</p>
<div class="kpis">
${kpi('Peak context', tok(c.peak), c.contextWindow ? pct(c.peak / c.contextWindow) + ' of ' + tok(c.contextWindow) : '')}
${kpi('Cache hit ratio', pct(c.cacheHitRatio, 1), 'context re-read rather than re-sent')}
${kpi('Context re-read', c.reReadMultiplier.toFixed(1) + '×', 'context carried ÷ peak')}
${kpi('Long-lived cache writes', pct(c.cacheWrite1hShare), 'of cache writes (the 1h tier)')}
${kpi('Fixed weight per request', tok(c.baseline), 'system + tools + CLAUDE.md, every request')}
${kpi('Compactions', String(c.compactions.length), c.compactions.length ? 'context was reset' : 'none')}
</div>
${card('Context size over the session', `<div class="scroll-x">${ctxLine}</div><div class="legend"><span>Each point is one API request; dashed lines are compactions.</span></div>`, 'mb16')}
${card(`Where the tokens went · ${esc(tok(co.totalTokens))} total`, `${stackedBar(byKind, { height: 22 })}<div class="legend">${byKind.filter((b) => b.value > 0).map((b) => `<span><i class="sw" style="background:${b.color}"></i>${esc(b.label)}</span>`).join('')}</div>${serverTools ? `<div class="smt8">${plural(serverTools, 'server-tool request')} (web search/fetch), counted per request, not in tokens</div>` : ''}`, 'mb16')}
<details class="more-charts"><summary><span class="chev" aria-hidden="true">▸</span>More charts · composition per request, by model, cumulative</summary><div class="mt8">${more}</div></details>
</section>`)
}
