/**
 * Overview: what happened (one true sentence from the counted outcomes), what matters (three axes with
 * a verdict word, the top finding as a card with its fix, evidence link and improve command), what next
 * (three text links). Detailed adds the context sparkline and the other top findings; Plain removes
 * panels instead of renaming nouns (A1, A3b). One code path renders the top-finding card for both.
 */
import type { Ctx } from '../app.js'
import type { Analysis, Insight } from '../../../model/analysis.js'
import { esc, ms, num, pct, tok } from '../format.js'
import { h } from '../dom.js'
import { degradedBanner } from '../components/banner.js'
import { signalChips } from '../components/chips.js'
import { findingHtml } from '../components/finding.js'
import { emptyHero } from '../components/empty.js'
import { mascotSvg } from '../mascot.js'
import { lineChart } from '../charts.js'
import { compactionMarkers, endingWord, insightLink, outcomeBits, outcomeHeadline, qualityHeadline, recoverableLine, timeAxis } from '../derive.js'
import { commandForInsight, planRows, recoverableFrom } from '../suggest-rows.js'
import { cleanHash, type RouteState } from '../nav.js'
import { plainSentence } from '../strings.js'

/** A link into this run's own screens: every aggregate/filter key cleared so the target starts clean. */
function href(ctx: Ctx, a: Analysis, next: Partial<RouteState>): string {
  return cleanHash(ctx.state, { s: ctx.state.s ?? a.session.id, ...next })
}

function outcome(a: Analysis, audience: Ctx['audience']): string {
  return `<div class="hero overview-hero"><span class="overview-brand" aria-hidden="true">${mascotSvg(64)}</span><div class="grow overview-copy"><div class="eyebrow">What happened</div><div class="herotitle">${esc(outcomeHeadline(a.summary))}</div><div class="sg-sub">${esc(plainSentence(a.summary.narrative, audience))}</div></div></div>`
}

function triptych(a: Analysis): string {
  const s = a.summary
  const qNote = outcomeBits(s).join(' · ') || 'no commits, PRs or test runs detected'
  const t = timeAxis(s)
  const kNote = s.totalTokens ? `${pct(s.cacheHitRatio)} read from cache · ${tok(a.tokens.byKind.output)} generated` : 'no usage recorded'
  return `<div class="triptych">
    <div class="axis q"><div class="aname">Quality ↑</div><div class="aval">${esc(qualityHeadline(a.quality.signals))}</div><div class="anote">${esc(qNote)}</div>${signalChips(a.quality.signals)}</div>
    <div class="axis t"><div class="aname">Time ↓</div><div class="aval">${esc(t.value)}</div><div class="anote">${esc(t.note)}</div></div>
    <div class="axis c"><div class="aname">Tokens ↓</div><div class="aval">${esc(tok(s.totalTokens))}</div><div class="anote">${esc(kNote)}</div></div>
  </div>`
}

/** The top finding, hoisted: title, fix, savings as a share of the session, the evidence link, the improve command. */
function topFinding(ctx: Ctx, a: Analysis, ins: Insight | undefined): string {
  if (!ins)
    return `<div class="card pad mb16" style="background:var(--bg2);display:flex;align-items:center;gap:10px">${mascotSvg(22)}<span class="muted">Nothing stood out. This session ran clean.</span></div>`
  const at = insightLink(ins)
  const link = at?.tool
    ? { href: href(ctx, a, { screen: 'timeline', tool: at.tool }), label: `See the ${at.tool} calls →` }
    : at
      ? { href: href(ctx, a, { screen: 'timeline', turn: at.turn }), label: `See the ${ins.turnIndexes.length} turn${ins.turnIndexes.length === 1 ? '' : 's'} →` }
      : undefined
  return `<div class="eyebrow mb6">The one thing to improve</div>${findingHtml(ins, ctx.audience, { command: commandForInsight(ins, a.session.id), sessionTotalTokens: a.summary.totalTokens, open: true, ...(link ? { link } : {}) })}`
}

/** 60 px context sparkline (the Context screen's chart, reused); a caption alone when there is no series. */
function contextSpark(a: Analysis): string {
  const c = a.context
  const main = c.series.filter((p) => !p.agentId)
  const peak = c.contextWindow ? `peak ${pct(a.summary.contextPeak / c.contextWindow)} of the window` : `peak ${tok(a.summary.contextPeak)}`
  const caption = `${peak} · ${a.summary.compactions} compaction${a.summary.compactions === 1 ? '' : 's'}`
  const svg = main.length ? `<div class="spark">${lineChart(main.map((p) => p.contextSize), { width: 320, height: 60, markers: compactionMarkers(c.compactions, main), yMax: c.contextWindow })}</div>` : ''
  return `<div class="card pad"><div class="card-title">Context</div>${svg}<div class="small muted">${esc(caption)}</div></div>`
}

function whereNext(ctx: Ctx, a: Analysis): string {
  const s = a.summary
  // the same rows the Suggest screen renders, so the count here equals the rows there
  const n = planRows('session', a, undefined).length
  const links = [
    { screen: 'timeline', label: s.toolErrors ? `Timeline · ${num(s.toolErrors)} error${s.toolErrors === 1 ? '' : 's'} only` : `Timeline · ${num(s.turns)} turns`, state: s.toolErrors ? { errorsOnly: true } : {} },
    { screen: 'tools', label: `Tools · ${num(s.toolCalls)} calls, ${num(s.toolErrors)} errors`, state: {} },
    { screen: 'suggest', label: n ? `Suggestions · ${num(n)} finding${n === 1 ? '' : 's'}` : 'Suggestions · nothing to improve', state: {} },
  ]
  return `<nav class="card pad where-next" aria-label="Where to look next"><div class="card-title">Where to look next</div>${links
    .map((l) => `<a data-screen="${l.screen}" href="${esc(href(ctx, a, { screen: l.screen, ...l.state }))}">${esc(plainSentence(l.label, ctx.audience))} →</a>`)
    .join('')}</nav>`
}

function detailedBody(ctx: Ctx, a: Analysis): string {
  const top = a.summary.topInsightIds.map((id) => a.insights.find((i) => i.id === id)).filter((i): i is Insight => !!i)
  const rest = top.slice(1).map((i) => findingHtml(i, 'dev', { command: commandForInsight(i, a.session.id), sessionTotalTokens: a.summary.totalTokens })).join('')
  const recoverable = recoverableLine(recoverableFrom(planRows('session', a, undefined)), a.insights.length)
  return `${triptych(a)}${topFinding(ctx, a, top[0])}
    <div class="two-up mb16">${contextSpark(a)}${whereNext(ctx, a)}</div>
    ${ctx.harnessCard?.() ?? ''}
    ${rest ? `<h3 style="margin:4px 0 10px">More findings</h3>${recoverable ? `<p class="recoverable"><a href="${esc(href(ctx, a, { screen: 'suggest' }))}">${esc(recoverable)} →</a></p>` : ''}${rest}` : ''}`
}

function plainBody(ctx: Ctx, a: Analysis): string {
  const s = a.summary
  const goal = a.turns.find((t) => t.kind === 'human')?.promptPreview.slice(0, 140)
  const goalText = goal || (a.session.title ? a.session.title : '(prompt text not included in this report)')
  const firstSentence = (s.narrative.split(/(?<=\.)\s/)[0] ?? s.narrative).trim()
  const effort = `${tok(s.totalTokens)} tokens · ${ms(s.wallMs)}, of which ${ms(s.humanWaitMs)} needed your attention`
  const one = a.insights.find((i) => i.id === s.topInsightIds[0]) ?? a.insights[0]
  return `<div class="card mb16" style="overflow:hidden">
      <div class="card-head">${mascotSvg(22)}What happened here</div>
      <div class="plaingrid">
        <div class="k">Goal</div><div>${esc(goalText)}</div>
        <div class="k">What happened</div><div>${esc(plainSentence(firstSentence, 'plain'))}</div>
        <div class="k">What it produced</div><div>${esc(outcomeBits(s).join(' · ') || 'no tracked outputs')}</div>
        <div class="k">How it ended</div><div>${esc(endingWord(s.ending))}</div>
        <div class="k">Tokens &amp; time</div><div>${esc(effort)}</div>
      </div>
    </div>
    ${topFinding(ctx, a, one)}
    ${whereNext(ctx, a)}`
}

export function renderOverview(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a)
    return h(`<section>${emptyHero({ title: 'No session selected.', hint: 'Pick a session from the sidebar.' })}</section>`)
  const body = ctx.audience === 'plain' ? plainBody(ctx, a) : detailedBody(ctx, a)
  return h(`<section>${degradedBanner(a, ctx.audience)}${outcome(a, ctx.audience)}${body}</section>`)
}
