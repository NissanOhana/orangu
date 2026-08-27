/** Repo (§2.6): Aggregate scope='repo'. File mode without an aggregate shows the designed empty state (policy). */
import type { Ctx } from '../app.js'
import type { Aggregate } from '../../../analyze/aggregate.js'
import { esc, num, pct, tok } from '../format.js'
import { h } from '../dom.js'
import { kpi } from '../components/kpi.js'
import { emptyHero, emptyNote } from '../components/empty.js'
import { savingsText } from '../components/finding.js'
import { boundedSavings } from '../suggest-rows.js'

export function aggregateEmpty(scope: 'repo' | 'global'): string {
  return emptyHero({
    title: `Across-session views need orangu serve`,
    hint: `This single-file report carries one session. Start the local viewer to analyse ${scope === 'repo' ? 'this repository' : 'everything on this machine'}. Nothing leaves your machine.`,
    command: 'orangu serve',
  })
}

export function aggregateLead(scope: 'repo' | 'global'): string {
  const place = scope === 'repo' ? 'this repository' : 'supported sessions on this machine'
  return `<div class="hero"><div class="grow"><div class="eyebrow">Recurring patterns</div><div class="herotitle">Choose major improvements from repeated evidence.</div><div class="sg-sub">Patterns across ${place} link back to example sessions. Review them before changing instructions, tools, skills, hooks, agents, plugins, or workflow configuration.</div></div><a class="btn" href="#suggest?scope=${scope}">Review ${scope} improvements →</a></div>`
}

export function renderRepo(ctx: Ctx): HTMLElement {
  const g = ctx.data.aggregates.repo
  if (!g) return h(`<section>${aggregateEmpty('repo')}</section>`)
  return h(`<section>${aggregateLead('repo')}${aggregateBody(g, ctx)}</section>`)
}

/** shared by Repo and (partly) Global */
export function aggregateBody(g: Aggregate, ctx: Ctx): string {
  const kpis = [
    kpi('Sessions', String(g.sessionCount)),
    kpi('Total tokens', tok(g.totals.tokens), '', { accent: true }),
    kpi('Per session', tok(g.averages.tokensPerSession)),
    kpi('Per human turn', tok(g.averages.tokensPerHumanTurn)),
    kpi('Cache hits', pct(g.averages.cacheHitRatio)),
    kpi('Tool error rate', pct(g.averages.toolErrorRate, 1), '', { badHint: g.averages.toolErrorRate >= 0.03 }),
  ].join('')
  const findings = g.crossFindings.length
    ? g.crossFindings
        .slice(0, 8)
        .map(
          (f) =>
            `<div class="rrow"><span class="pill">${esc(f.ruleId)}</span><span class="grow">${esc(f.title)}</span><span class="mono small muted">${f.sessions} sessions</span><span class="saveval">${esc(savingsText(boundedSavings(f)))}</span></div>`,
        )
        .join('')
    : emptyNote(g.sessionCount < 2 ? 'Patterns appear from 2 sessions on.' : `No recurring findings across ${g.sessionCount} sessions.`)
  const maxReads = Math.max(...g.topReReadFiles.map((r) => r.totalReads), 1)
  const reReads = g.topReReadFiles.length
    ? g.topReReadFiles
        .slice(0, 8)
        .map(
          (r) =>
            `<div class="rerow"><div class="rehead"><span class="mono grow ellip">${esc(r.path)}</span><span class="mono115">${r.sessions} sess</span><span class="saveval">${r.totalReads} reads</span></div><span class="trough" style="height:6px;margin-top:5px"><i style="width:${((r.totalReads / maxReads) * 100).toFixed(1)}%"></i></span></div>`,
        )
        .join('')
    : emptyNote('No heavily re-read files.')
  const errs = g.recurringErrors.length
    ? `<div class="card mb16" style="overflow:hidden"><div class="card-head">Recurring errors · environment problems to fix once</div>${g.recurringErrors
        .slice(0, 8)
        .map(
          (e) =>
            `<div class="rrow" style="padding:10px 18px"><span class="sigline">${esc(e.signature)}</span><span class="kind">${esc(e.tool)}</span><span class="mono small muted">${e.sessions} sessions</span><span class="mono125">×${e.total}</span></div>`,
        )
        .join('')}</div>`
    : ''
  const sessions = g.topSessions
    .slice(0, 10)
    .map((s) => {
      const outcome = [s.prs ? `${s.prs} PR` : '', s.commits ? `${s.commits} commits` : '', s.interruptions ? `interrupted ×${s.interruptions}` : ''].filter(Boolean).join(' · ') || '–'
      const open = ctx.data.mode === 'serve' ? `href="#overview?s=${esc(s.id)}"` : `href="#" title="open with: orangu report ${esc(s.id.slice(0, 8))}" aria-disabled="true" onclick="return false"`
      return `<tr>
        <td><a class="mono" style="font-size:12px" ${open}>${esc(s.id.slice(0, 8))}</a></td>
        <td class="ellip" style="max-width:280px;color:var(--ink2)">${esc(s.title ?? '')}</td>
        <td class="num">${s.turns}</td>
        <td class="num">${s.toolCalls}</td>
        <td class="num"${s.toolErrors ? ' style="color:var(--bad)"' : ''}>${s.toolErrors}</td>
        <td class="num" style="font-weight:700">${esc(tok(s.tokens))}</td>
        <td class="small muted">${esc(outcome)}</td>
      </tr>`
    })
    .join('')
  return `
    <div class="kpis">${kpis}</div>
    <div class="two-up">
      <div class="card pad"><div class="card-title">Recurring findings · ranked by evidence</div><div class="cardsub">patterns one session cannot establish</div>${findings}</div>
      <div class="card pad"><div class="card-title">Most re-read files</div><div class="cardsub">context carried again and again · trim or index these</div>${reReads}</div>
    </div>
    ${errs}
    <div class="card scroll-x">
      <div class="card-head"><span>Heaviest sessions</span><span style="margin-left:auto;font-weight:400;font-size:12px;color:var(--ink3)">sorted by tokens</span></div>
      <table class="grid"><thead><tr><th>Session</th><th>Title</th><th class="num">Turns</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Tokens</th><th>Outcome</th></tr></thead><tbody>${sessions}</tbody></table>
    </div>
    ${g.sessionCount ? '' : `<div style="margin-top:16px">${emptyNote('Analysing sessions…')}</div>`}
    <p class="small muted" style="margin-top:12px">${num(g.sessionCount)} sessions · every figure is a token count reported by the API.</p>`
}
