/** Tools & calls (§2.5): category bar + legend, tool table, recurring errors. Across-session patterns live on Repo/Global. */
import type { Ctx } from '../app.js'
import { CAT_LABEL, catColor, esc, ms, num, pct, bytes } from '../format.js'
import { h } from '../dom.js'
import { degradedBanner } from '../components/banner.js'
import { noSession } from '../components/empty.js'
import { hiddenErrorRow } from '../components/errors.js'
import { foldHiddenErrors } from '../derive.js'
import { plainSentence } from '../strings.js'

const SHOW = 12

/** static hint map keyed by signature prefix (§2.5) */
const ERR_HINTS: Array<[RegExp, string]> = [
  [/ENOENT/, 'run the build first, or check the path'],
  [/old_string not found|String to replace not found/i, 'file changed since last read; re-read before editing'],
  [/EACCES|permission/i, 'permission problem: check file modes'],
  [/timed? out/i, 'raise the timeout or split the command'],
]

function errHint(sig: string): string {
  for (const [re, hint] of ERR_HINTS) if (re.test(sig)) return hint
  return ''
}

export function renderTools(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a) return noSession()
  const t = a.tools
  const total = a.summary.toolCalls
  const catBar = t.byCategory
    .map((c) => `<span style="width:${total ? ((c.count / total) * 100).toFixed(1) : 0}%;background:${catColor(c.category)}" title="${esc(CAT_LABEL[c.category] ?? c.category)} · ${c.count}"></span>`)
    .join('')
  const legend = t.byCategory
    .map((c) => `<span><i class="sw" style="background:${catColor(c.category)}"></i>${esc(CAT_LABEL[c.category] ?? c.category)} · ${c.count}</span>`)
    .join('')
  const par = t.parallelism
  const parCaption = par.groups
    ? `${par.parallelGroups} of ${par.groups} batches ran in parallel · max ${par.maxGroupSize} at once`
    : ''
  const maxMs = Math.max(...t.byName.map((s) => s.totalMs), 1)
  // A mean above p95 is honest arithmetic (one 30-minute timeout among 62 quick calls) but reads as a
  // broken statistic next to p95, so the Avg cell says why. Client-only; the Analysis contract is untouched.
  const outlierWhy = ctx.audience === 'plain' ? 'one or more calls far above the rest' : 'one or more calls far above the rest; p95 is the typical worst case'
  const avgCell = (s: typeof t.byName[number]): string =>
    s.avgMs > s.p95Ms ? `<td class="num" title="${outlierWhy}">${esc(ms(s.avgMs))}<span class="outlier">outlier</span></td>` : `<td class="num">${esc(ms(s.avgMs))}</td>`
  const toolRows = (rows: typeof t.byName): string =>
    rows
      .map(
        (s) => `<tr class="tool-row" data-tool="${esc(s.name)}" title="${esc(`${bytes(s.resultBytesTotal)} output · ${s.mainCount} main / ${s.agentCount} agent`)}">
<td><i class="swd" style="background:${catColor(s.category)}"></i><span class="mono125">${esc(s.name)}</span></td>
<td class="num">${num(s.count)}</td>
<td class="num"${s.errors ? ' style="color:var(--bad)"' : ' style="color:var(--ink3)"'}>${s.errors}</td>
${avgCell(s)}
<td class="num p95col">${esc(ms(s.p95Ms))}</td>
<td><span class="trough"><i style="width:${((s.totalMs / maxMs) * 100).toFixed(1)}%;background:${catColor(s.category)}"></i></span></td>
</tr>`,
      )
      .join('')
  const head = `<tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Avg</th><th class="num p95col">${ctx.audience === 'plain' ? '' : 'p95'}</th><th>Share of tool time</th></tr>`
  const more = t.byName.length > SHOW ? `<div class="pagefoot"><button data-more-tools="1">show all ${t.byName.length} tools</button></div>` : ''

  // the default redaction strips the signature with every other transcript-authored string: fold those per tool
  const { kept, hidden } = foldHiddenErrors(t.errorGroups, (g) => ({ tool: g.name, total: g.count }))
  const errCard = t.errorGroups.length
    ? hidden.map((r) => hiddenErrorRow(r, ctx.data.capabilities.includeText)).join('') +
      kept
        .slice(0, 8)
        .map((g) => {
          const hint = g.sampleHint || errHint(g.signature)
          return `<div class="rerow" style="font-size:13px"><div style="display:flex;gap:8px;align-items:center"><span class="sigline">${esc(g.signature)}</span><span class="mono115" style="margin-left:auto">×${g.count}</span></div><div class="small muted" style="margin-top:2px">${esc(g.name)}${hint ? ' · ' + esc(hint) : ''}</div></div>`
        })
        .join('')
    : `<p class="small" style="color:var(--good);margin:0">No tool errors in this session.</p>`

  const el = h(`<section>
${degradedBanner(a, ctx.audience)}
<div class="card pad mb16">
<div class="card-title">${esc(plainSentence(`Calls by category · ${total} total`, ctx.audience))}</div>
<div class="catbar">${catBar}</div>
<div class="legend">${legend}</div>
${parCaption ? `<div class="smt8">${esc(parCaption)} · ${esc(pct(par.parallelCallShare))} of calls in a parallel batch</div>` : ''}
</div>
<div class="card scroll-x mb16">
<table class="grid"><thead>${head}</thead><tbody id="toolbody">${toolRows(t.byName.slice(0, SHOW))}</tbody></table>
${more}
</div>
<div class="card pad"><div class="card-title">Recurring errors in this session</div>${errCard}</div>
</section>`)
  const wire = (root: ParentNode): void => {
    if (ctx.audience === 'plain') root.querySelectorAll('.p95col').forEach((c) => c.remove())
    root.querySelectorAll<HTMLElement>('.tool-row').forEach((r) =>
      r.addEventListener('click', () => ctx.go({ screen: 'timeline', tool: r.dataset['tool'] }, { push: true })),
    )
  }
  wire(el)
  el.querySelector('[data-more-tools]')?.addEventListener('click', (e) => {
    const body = el.querySelector('#toolbody')!
    body.innerHTML = toolRows(t.byName)
    wire(body)
    ;(e.currentTarget as HTMLElement).parentElement?.remove()
  })
  return el
}
