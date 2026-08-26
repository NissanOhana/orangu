/** Agents (Detailed-only panel, policy/policy): swimlane + usage by type + runs table. */
import type { Ctx } from '../app.js'
import { catColor, esc, ms, pct, tok } from '../format.js'
import { h } from '../dom.js'
import { degradedBanner } from '../components/banner.js'
import { emptyHero } from '../components/empty.js'
import { proportionRows } from '../charts.js'
import { laneHtml } from './live.js'

const LANES = 24

export function renderAgents(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a) return h(`<section>${emptyHero({ title: 'No session selected.' })}</section>`)
  const ag = a.agents
  if (!ag.runs.length) return h(`<section>${emptyHero({ title: 'No subagents in this session.', hint: 'This session ran entirely on the main thread.' })}</section>`)
  const min = Math.min(...ag.runs.map((r) => r.startTs ?? Infinity).filter(isFinite))
  const max = Math.max(...ag.runs.map((r) => r.endTs ?? -Infinity).filter(isFinite))
  const swim = ag.runs.slice(0, LANES).map((r) => laneHtml(r, min, max)).join('')
  const typeRows = proportionRows(
    ag.byType.map((t) => ({ label: t.agentType, value: t.tokens, color: catColor('agent'), sub: '×' + t.count })),
    (v) => tok(v),
  )
  const rows = ag.runs
    .map(
      (r) => `<tr data-agent="${esc(r.agentId)}" class="agent-row"${ctx.state.agent === r.agentId ? ' style="background:var(--accent-weak)"' : ''}>
      <td>${'· '.repeat(r.spawnDepth)}${esc(r.agentType || r.name || r.agentId.slice(0, 8))}${!r.hasTranscript ? ' <span class="tag warn" title="only the parent summary was available">summary</span>' : ''}</td>
      <td>${esc(r.model ?? '–')}</td>
      <td class="num">${esc(ms(r.durationMs))}</td>
      <td class="num">${r.toolCallCount}${r.toolErrors ? ` <span class="tag bad">${r.toolErrors}</span>` : ''}</td>
      <td class="num">${esc(tok(r.totalTokens))}</td>
    </tr>`,
    )
    .join('')
  const el = h(`<section>
    ${degradedBanner(a, ctx.audience)}
    <div class="card pad" style="margin-bottom:16px">
      <div class="card-title">${ag.runs.length} subagent runs · ${esc(pct(1 - ag.mainThreadShare.tokens))} of tokens · max depth ${ag.maxDepth} · up to ${ag.maxConcurrency} parallel</div>
      <div class="swimbox">${swim}</div>
      ${ag.runs.length > LANES ? `<div class="pagefoot muted small">showing ${LANES} of ${ag.runs.length} lanes · all runs in the table below</div>` : ''}
    </div>
    <div class="two-up">
      <div class="card pad"><div class="card-title">Tokens by agent type</div>${typeRows}</div>
      <div class="card scroll-x"><table class="grid"><thead><tr><th>Agent</th><th>Model</th><th class="num">Duration</th><th class="num">Tools</th><th class="num">Tokens</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>
  </section>`)
  el.querySelectorAll<HTMLElement>('[data-agent]').forEach((r) =>
    r.addEventListener('click', () => ctx.go({ screen: 'timeline', agent: r.dataset['agent'] }, { push: true })),
  )
  return el
}
