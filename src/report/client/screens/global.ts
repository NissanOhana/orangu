/** Global (§2.7): Aggregate scope='global' with the weekly trend, model/project rollups, source chips, then the evidence blocks Repo renders. */
import type { Ctx } from '../app.js'
import { esc, ms, pct, plural, tok } from '../format.js'
import { h } from '../dom.js'
import { kpi } from '../components/kpi.js'
import { emptyNote } from '../components/empty.js'
import { aggregateEmpty, aggregateEvidence, aggregateLead } from './repo.js'
import { sourceLabel, weekPoints } from '../derive.js'

export function renderGlobal(ctx: Ctx): HTMLElement {
  const g = ctx.data.aggregates.global
  if (!g) return h(`<section>${aggregateEmpty('global', ctx.data)}</section>`)
  const sources = new Map<string, number>()
  for (const s of g.sessions) sources.set(s.source, (sources.get(s.source) ?? 0) + 1)
  const kpis = [
    kpi('Sessions', String(g.sessionCount), plural(sources.size, 'source')),
    kpi('Total tokens', tok(g.totals.tokens), pct(g.averages.cacheHitRatio) + ' read from cache', { accent: true }),
    kpi('Per session', tok(g.averages.tokensPerSession)),
    kpi('Active time', ms(g.totals.activeMs), 'of ' + ms(g.totals.wallMs) + ' wall'),
    kpi('Per human turn', tok(g.averages.tokensPerHumanTurn)),
    kpi('Shipped', `${g.totals.prs} PRs`, `${g.totals.commits} commits`),
  ].join('')

  const weeksWithData = g.byWeek.filter((b) => b.sessions > 0).length
  const weekly = g.byWeek.map((b) => b.tokens).filter((c) => c > 0)
  const range = weekly.length ? `${tok(Math.min(...weekly))} – ${tok(Math.max(...weekly))} / week` : ''
  const trend =
    weeksWithData >= 2
      ? `<svg viewBox="0 0 600 110" style="width:100%;height:110px;display:block" preserveAspectRatio="none" role="img"><title>Weekly token trend</title><polyline points="${weekPoints(g.byWeek)}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"></polyline><line x1="0" y1="104" x2="600" y2="104" stroke="var(--border2)" stroke-width="1"></line></svg>
<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--ink3);margin-top:4px"><span>12w ago</span><span>8w</span><span>4w</span><span>this week</span></div>`
      : emptyNote('not enough history for a trend')

  const rollup = (items: Array<{ key: string; count: number; tokens: number }>, color: string): string => {
    if (!items.length) return emptyNote('nothing here yet')
    const max = Math.max(...items.map((i) => i.tokens), 0.0001)
    return items
      .slice(0, 6)
      .map(
        (i) =>
          `<div class="rollrow"><div class="rollhead"><span class="mono">${esc(i.key)}</span><span class="muted" style="font-size:11.5px">${plural(i.count, 'session')}</span><span class="mono" style="margin-left:auto;font-weight:700">${esc(tok(i.tokens))}</span></div><span class="trough" style="margin-top:5px"><i style="width:${((i.tokens / max) * 100).toFixed(1)}%;background:${color}"></i></span></div>`,
      )
      .join('')
  }
  const chips = [...sources.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<span class="sigchip">${esc(sourceLabel(k))} · ${n}</span>`)
    .join('')

  return h(`<section>${aggregateLead('global', ctx.state)}
<div class="kpis">${kpis}</div>
<div class="card pad mb16">
<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px"><span style="font-weight:700;font-size:13.5px">Weekly tokens · last 12 weeks</span><span class="mono small muted">${esc(range)}</span></div>
${trend}
</div>
<div class="two-up">
<div class="card pad"><div class="card-title">Tokens by model</div>${rollup(g.byModel, 'var(--accent)')}</div>
<div class="card pad"><div class="card-title">Tokens by project</div>${rollup(g.byProject, 'var(--cat-agent)')}</div>
</div>
<div class="chiprow mb16">${chips}<span class="small muted" style="align-self:center">a session is a session, wherever it ran</span></div>
${aggregateEvidence(g, ctx)}
</section>`)
}
