/** Timeline: every parent and subagent tool call, then filters, compaction dividers, and pagination. */
import type { Ctx } from '../app.js'
import type { Analysis, TurnAnalysis } from '../../../model/analysis.js'
import { catColor, esc, ms, tok, bytes } from '../format.js'
import { h, wireExpandables } from '../dom.js'
import { chip } from '../components/chips.js'
import { degradedBanner } from '../components/banner.js'
import { noSession } from '../components/empty.js'
import { callsForTurn, catMixForTurn, compactionGroups, topTokenThreshold } from '../derive.js'
import { plainSentence } from '../strings.js'

const PAGE = 10

function matches(a: Analysis, t: TurnAnalysis, ctx: Ctx): boolean {
  const st = ctx.state
  if (st.turn !== undefined && t.index !== st.turn) return false
  const turnCalls = callsForTurn(a.tools.calls, t.index, st.agent)
  if (st.filter === 'errors' && !turnCalls.some((c) => c.isError)) return false
  if (st.filter === 'agents' && t.agents.length === 0 && !turnCalls.some((c) => c.agentId)) return false
  if (st.filter === 'human' && t.kind !== 'human') return false
  if (st.agent && !t.agents.includes(st.agent) && !turnCalls.length) return false
  if (st.tool || st.cat || st.errorsOnly) {
    if (st.tool && !turnCalls.some((c) => c.name === st.tool)) return false
    if (st.cat && !turnCalls.some((c) => c.category === st.cat)) return false
    if (st.errorsOnly && !turnCalls.some((c) => c.isError)) return false
  }
  return true
}

function kindTag(t: TurnAnalysis): string {
  const label = t.isCommand ? 'cmd' : t.kind === 'human' ? 'human' : t.autoContinuations > 0 ? 'auto' : t.kind
  const cls = t.isCommand ? 'kcmd' : t.kind === 'human' ? 'khuman' : ''
  return `<span class="kind ${cls}">${esc(label)}</span>`
}

/**
 * The row's text: the prompt, else the command name, else the row's OWN facts (prompt size and the
 * activity string, neither of which the redactor strips) so a default-redacted report never reads as
 * N rows of the same notice; the notice is left for a turn that has no facts at all.
 */
export function promptText(t: TurnAnalysis, includeText: boolean): { text: string; own: boolean } {
  const given = t.promptPreview || t.commandName
  if (given) return { text: given, own: false }
  const facts = [t.promptChars ? `${tok(t.promptChars)}-char prompt` : '', t.activity].filter(Boolean).join(' · ')
  return { text: facts || (includeText ? '(no prompt)' : '(prompt text not included)'), own: true }
}

function turnRow(a: Analysis, t: TurnAnalysis, ctx: Ctx, hotTokens: number, open: boolean): string {
  const segs = catMixForTurn(a.tools.calls, t.index, ctx.state.agent)
  const mix = segs.map((s) => `<i style="width:${s.pct.toFixed(1)}%;background:${catColor(s.cat)}"></i>`).join('')
  const { text: prompt, own } = promptText(t, ctx.data.capabilities.includeText)
  const promptCls = own ? ' style="color:var(--ink3)"' : ''
  const calls = callsForTurn(a.tools.calls, t.index, ctx.state.agent)
  const evs = calls
    .map(
      (c) => {
        const run = c.agentId ? a.agents.runs.find((r) => r.agentId === c.agentId) : undefined
        const actor = c.agentId ? run?.agentType || run?.name || c.agentId.slice(0, 8) : 'main'
        return `<div class="evline"><span class="sw" style="background:${catColor(c.category)}"></span><span class="pill">${esc(actor)}</span><span class="en">${esc(c.name)}</span><span class="ew">${esc(c.summary)}</span><span class="tag ${c.isError ? 'bad' : 'good'}">${c.isError ? 'error' : 'ok'}</span><span class="ex">${[c.durationMs !== undefined ? ms(c.durationMs) : '', c.resultBytes ? bytes(c.resultBytes) : '', c.errorHint ?? ''].filter(Boolean).map(esc).join(' · ')}</span></div>`
      },
    )
    .join('')
  const agents = t.agents
    .map((aid) => {
      const r = a.agents.runs.find((x) => x.agentId === aid)
      if (!r) return ''
      const so = r.hasTranscript ? '' : ' <span class="tag warn" title="only the parent summary was available">summary</span>'
      return `<button class="btn-sm" data-agent-jump="${esc(aid)}">▸ ${esc(r.agentType || r.name || aid.slice(0, 8))} · ${esc(tok(r.totalTokens))} tokens${so}</button>`
    })
    .join(' ')
  const meta = [
    t.firstResponseMs !== undefined ? `first response ${ms(t.firstResponseMs)}` : '',
    t.humanGapMs ? `waited ${ms(t.humanGapMs)}` : '',
    t.autoContinuations ? `${t.autoContinuations} auto-continuations` : '',
    t.models.length ? t.models.join(', ') : '',
    'context end ' + (t.contextEnd ? tok(t.contextEnd) : '–'),
  ]
    .filter(Boolean)
    .join(' · ')
  const dur = ms(t.durationMs ?? t.reportedDurationMs)
  return `<details class="turn${t.interrupted ? ' interrupted' : ''}" id="turn-${t.index}"${open ? ' open' : ''}>
<summary>
<span class="tnum">#${t.index}</span>
<span class="tprompt"${promptCls}>${kindTag(t)}${esc(prompt)}</span>
<span class="mixbar" title="tool mix">${mix}</span>
<span class="tcell">${calls.length}⚙</span>
<span class="tcell">${esc(dur)}</span>
<span class="tcell${t.totalTokens >= hotTokens && t.totalTokens > 0 ? ' hot' : ''}">${esc(tok(t.totalTokens))}</span>
</summary>
<div class="tbody">
<div class="tmeta">${esc(meta)}</div>
${evs || '<p class="small muted" style="margin:0">No tool calls in this turn.</p>'}
${agents ? `<div class="pill-row">${agents}</div>` : ''}
</div>
</details>`
}

function groupsHtml(a: Analysis, list: TurnAnalysis[], ctx: Ctx, hotTokens: number): string {
  return compactionGroups(list, a.context.compactions)
    .map((g) => {
      const inner = g.turns.map((t) => turnRow(a, t, ctx, hotTokens, ctx.state.turn === t.index)).join('')
      const div = g.after
        ? `<div class="divider"><span class="mono">⇅ context compacted at turn ${g.after.turnIndex}${g.after.contextBefore && g.after.contextAfter ? ` · ${tok(g.after.contextBefore)} → ${tok(g.after.contextAfter)}` : ''}</span></div>`
        : ''
      return inner + div
    })
    .join('')
}

export function renderTimeline(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a) return noSession()
  const st = ctx.state
  const all = a.turns
  const counts = {
    all: all.length,
    errors: all.filter((t) => callsForTurn(a.tools.calls, t.index).some((c) => c.isError)).length,
    agents: all.filter((t) => t.agents.length > 0 || callsForTurn(a.tools.calls, t.index).some((c) => c.agentId)).length,
    human: all.filter((t) => t.kind === 'human').length,
  }
  const cur = st.filter ?? 'all'
  const fixed = [
    chip(`All turns · ${counts.all}`, { active: cur === 'all', data: { filter: 'all' } }),
    chip(`Errors only · ${counts.errors}`, { active: cur === 'errors', data: { filter: 'errors' } }),
    chip(`With agents · ${counts.agents}`, { active: cur === 'agents', data: { filter: 'agents' } }),
    chip(`Human turns · ${counts.human}`, { active: cur === 'human', data: { filter: 'human' } }),
  ].join('')
  const cross: string[] = []
  if (st.tool) cross.push(chip('tool: ' + st.tool, { active: true, removable: true, data: { clear: 'tool' } }))
  if (st.cat) cross.push(chip('category: ' + st.cat, { active: true, removable: true, data: { clear: 'cat' } }))
  if (st.agent) cross.push(chip('agent: ' + st.agent.slice(0, 12), { active: true, removable: true, data: { clear: 'agent' } }))
  if (st.turn !== undefined) cross.push(chip('turn ' + st.turn, { active: true, removable: true, data: { clear: 'turn' } }))
  if (st.errorsOnly) cross.push(chip('errors only', { active: true, removable: true, data: { clear: 'err' } }))

  const visible = all.filter((t) => matches(a, t, ctx))
  const hotTokens = topTokenThreshold(all)
  const showAll = visible.length <= PAGE || st.turn !== undefined || !!(st.tool || st.cat || st.agent || st.errorsOnly || (st.filter && st.filter !== 'all'))
  const shown = showAll ? visible : visible.slice(0, PAGE)
  const shownSet = new Set(shown.map((t) => t.index))
  const rows = groupsHtml(a, shown, ctx, hotTokens)
  const emptyState = !visible.length
    ? `<div class="card pad" style="background:var(--bg2);text-align:center"><p class="muted" style="margin:0 0 10px">No turns match · ${esc(cur === 'all' ? 'these filters' : cur)}</p><button class="btn-sm" data-clearall="1">Clear filters</button></div>`
    : ''
  const foot = !showAll ? `<div class="pagefoot">showing ${shown.length} of ${visible.length} turns · <button data-showall="1">show all</button></div>` : ''
  const caption = plainSentence('expand a turn for every parent and subagent call · the URL is the saved view', ctx.audience)

  const el = h(`<section>
${degradedBanner(a, ctx.audience)}
<div class="chiprow">${fixed}${cross.join('')}<span class="small muted" style="margin-left:auto">${esc(caption)}</span></div>
<div id="turnlist">${rows}${emptyState}${foot}</div>
</section>`)

  el.querySelectorAll<HTMLElement>('[data-filter]').forEach((c) =>
    c.addEventListener('click', () => {
      const f = c.dataset['filter'] as 'all' | 'errors' | 'agents' | 'human'
      ctx.go({ filter: f === 'all' ? undefined : f, turn: undefined })
    }),
  )
  el.querySelectorAll<HTMLElement>('[data-clear]').forEach((c) =>
    c.addEventListener('click', () => {
      const k = c.dataset['clear']!
      if (k === 'err') ctx.go({ errorsOnly: undefined })
      else if (k === 'tool') ctx.go({ tool: undefined })
      else if (k === 'cat') ctx.go({ cat: undefined })
      else if (k === 'agent') ctx.go({ agent: undefined })
      else ctx.go({ turn: undefined })
    }),
  )
  el.querySelector('[data-clearall]')?.addEventListener('click', () => ctx.go({ filter: undefined, tool: undefined, cat: undefined, agent: undefined, turn: undefined, errorsOnly: undefined }))
  el.querySelector('[data-showall]')?.addEventListener('click', () => {
    const list = el.querySelector('#turnlist')!
    list.innerHTML = groupsHtml(a, visible, ctx, hotTokens)
    wireExpandables(list)
    wireAgentJumps(list, ctx)
  })
  wireAgentJumps(el, ctx)
  if (st.turn !== undefined && shownSet.has(st.turn)) setTimeout(() => el.querySelector('#turn-' + st.turn)?.scrollIntoView({ block: 'center' }), 0)
  return el
}

function wireAgentJumps(root: ParentNode, ctx: Ctx): void {
  root.querySelectorAll<HTMLElement>('[data-agent-jump]').forEach((b) =>
    b.addEventListener('click', () => ctx.go({ screen: 'agents', agent: b.dataset['agentJump'] }, { push: true })),
  )
}
