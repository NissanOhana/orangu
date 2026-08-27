/** Overview: outcome and quality evidence first, with time and tokens as supporting constraints. */
import type { Ctx } from '../app.js'
import type { Analysis } from '../../../model/analysis.js'
import { esc, ms, num, pct, tok } from '../format.js'
import { h } from '../dom.js'
import { kpi } from '../components/kpi.js'
import { degradedBanner } from '../components/banner.js'
import { signalChips } from '../components/chips.js'
import { findingHtml, savingsText } from '../components/finding.js'
import { emptyHero } from '../components/empty.js'
import { mascotSvg } from '../mascot.js'
import { endingWord, outcomeHeadline, qualityHeadline } from '../derive.js'
import { writeHash } from '../nav.js'
import { plainSentence } from '../strings.js'

type CapabilityScreen = 'timeline' | 'tools' | 'agents' | 'context' | 'suggest'

interface Capability {
  screen: CapabilityScreen
  mode: string
  title: string
  metric: string
  detail: string
}

function triptych(a: Analysis): string {
  const s = a.summary
  const q = qualityHeadline(a.quality.signals)
  const bits: string[] = []
  if (s.outcomes.prLinks.length) bits.push(`${s.outcomes.prLinks.length} PR`)
  if (s.outcomes.gitCommits) bits.push(`${s.outcomes.gitCommits} commits`)
  if (s.outcomes.testRuns) bits.push(`${s.outcomes.testRuns - s.outcomes.testRunsFailed} tests green`)
  const qNote = bits.join(' · ') || 'no commits, PRs or test runs detected'
  const tVal = s.wallMs !== undefined ? ms(s.wallMs) : '–'
  const tNote = s.wallMs !== undefined ? `${ms(s.activeMs)} active · ${ms(s.humanWaitMs)} waiting on you` : 'single-message session'
  const kNote = s.totalTokens ? `${pct(s.cacheHitRatio)} read from cache · ${tok(a.tokens.byKind.output)} generated` : 'no usage recorded'
  return `<div class="triptych">
    <div class="axis q"><div class="aname">Quality ↑</div><div class="aval">${esc(q)}</div><div class="anote">${esc(qNote)}</div></div>
    <div class="axis t"><div class="aname">Time ↓</div><div class="aval">${esc(tVal)}</div><div class="anote">${esc(tNote)}</div></div>
    <div class="axis c"><div class="aname">Tokens ↓</div><div class="aval">${esc(tok(s.totalTokens))}</div><div class="anote">${esc(kNote)}</div></div>
  </div>`
}

function outcome(a: Analysis, audience: Ctx['audience']): string {
  return `<div class="hero overview-hero"><span class="overview-brand" aria-hidden="true">${mascotSvg(96)}</span><div class="grow overview-copy"><div class="eyebrow">Observed outcome</div><div class="herotitle">${esc(outcomeHeadline(a.summary))}</div><div class="sg-sub">${esc(plainSentence(a.summary.narrative, audience))}</div><div class="overview-loop"><span>Observe</span><i aria-hidden="true">→</i><span>inspect evidence</span><i aria-hidden="true">→</i><span>improve the next run</span></div></div></div>${signalChips(a.quality.signals)}`
}

function capabilityHref(ctx: Ctx, a: Analysis, screen: CapabilityScreen): string {
  return writeHash({
    ...ctx.state,
    screen,
    s: ctx.state.s ?? a.session.id,
    // These cards explicitly explore the selected run, even when Overview was
    // reached from a repo/global aggregate route.
    scope: undefined,
    tool: undefined,
    cat: undefined,
    agent: undefined,
    turn: undefined,
    errorsOnly: undefined,
    filter: undefined,
  })
}

function capabilityNav(ctx: Ctx, a: Analysis): string {
  const s = a.summary
  // Session-scope Suggestions renders one row per Analysis insight.
  const suggestionCount = a.insights.length
  const contextMetric = a.context.contextWindow
    ? `${pct(s.contextPeak / a.context.contextWindow)} peak`
    : `${tok(s.contextPeak)} peak`
  const capabilities: Capability[] = [
    {
      screen: 'timeline',
      mode: 'Observe',
      title: 'Timeline',
      metric: `${num(s.turns)} turns`,
      detail: plainSentence('Follow every turn, tool call, result, and error in sequence.', ctx.audience),
    },
    {
      screen: 'tools',
      mode: 'Inspect',
      title: 'Tools & calls',
      metric: `${num(s.toolCalls)} calls · ${num(a.tools.byName.length)} tools`,
      detail: plainSentence(`See which tools ran, how long they took, and where ${s.toolErrors} errors occurred.`, ctx.audience),
    },
  ]
  if (ctx.audience === 'dev' && a.agents.runs.length)
    capabilities.push({
      screen: 'agents',
      mode: 'Trace',
      title: 'Agents',
      metric: `${num(a.agents.runs.length)} runs · ${num(a.agents.maxConcurrency)} max parallel`,
      detail: 'Follow delegated work and connect each agent run to its parent turn.',
    })
  if (ctx.audience === 'dev')
    capabilities.push({
      screen: 'context',
      mode: 'Understand',
      title: 'Context & tokens',
      metric: contextMetric,
      detail: `Inspect context growth, ${num(s.compactions)} compactions, cache use, and token flow.`,
    })
  capabilities.push({
    screen: 'suggest',
    mode: 'Improve',
    title: 'Suggestions',
    metric: suggestionCount ? `${num(suggestionCount)} finding${suggestionCount === 1 ? '' : 's'}` : 'No findings',
    detail: suggestionCount
      ? 'Review deterministic evidence and bounded proposals for the next run.'
      : 'This session ran clean; review the evidence or return after the next run.',
  })
  const cards = capabilities
    .map(
      (capability) => `<a class="cap-card" data-capability="${capability.screen}" href="${esc(capabilityHref(ctx, a, capability.screen))}">
        <span class="cap-top"><span class="cap-mark" aria-hidden="true"></span><span class="cap-mode">${esc(capability.mode)}</span><span class="cap-arrow" aria-hidden="true">↗</span></span>
        <span class="cap-title">${esc(capability.title)}</span><span class="cap-metric">${esc(plainSentence(capability.metric, ctx.audience))}</span>
        <span class="cap-copy">${esc(plainSentence(capability.detail, ctx.audience))}</span>
      </a>`,
    )
    .join('')
  return `<div class="cap-section"><div class="cap-head"><div><div class="eyebrow">Explore this run</div><h2>Follow the evidence</h2></div><p>The report stays local. Evidence is traceable; optional proposals stay reviewable.</p></div><nav class="cap-grid" aria-label="Explore this run">${cards}</nav></div>`
}

function detailedBody(a: Analysis): string {
  const s = a.summary
  const errRate = s.toolCalls ? s.toolErrors / s.toolCalls : 0
  const skills = a.skills.byName
  const viaTool = skills.filter((x) => x.via.includes('tool')).length
  const viaCmd = skills.filter((x) => x.via.includes('command')).length
  const comp0 = a.context.compactions[0]
  const kpis = [
    kpi('Turns', String(s.turns), s.humanTurns + ' human'),
    kpi('Tool calls', num(s.toolCalls), s.toolErrors ? `${s.toolErrors} errors · ${pct(errRate, 1)}` : 'no errors', { badHint: s.toolErrors > 0 }),
    kpi('Subagents', String(s.agents), a.agents.maxConcurrency > 1 ? `up to ${a.agents.maxConcurrency} parallel` : a.agents.runs.some((r) => !r.hasTranscript) ? `${a.agents.runs.filter((r) => !r.hasTranscript).length} summary-only` : ''),
    kpi('Skills / commands', String(s.skills), s.skills ? `${viaTool} skills · ${viaCmd} commands` : ''),
    kpi('Context peak', tok(s.contextPeak), a.context.contextWindow ? `${pct(s.contextPeak / a.context.contextWindow)} of ${tok(a.context.contextWindow)} window` : ''),
    kpi('Compactions', String(s.compactions), comp0 ? `at turn ${comp0.turnIndex}${comp0.contextBefore && comp0.contextAfter ? ` · ${tok(comp0.contextBefore)} → ${tok(comp0.contextAfter)}` : ''}` : 'none'),
  ].join('')
  const top = a.summary.topInsightIds.map((id) => a.insights.find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => !!i)
  const findings = top.length
    ? top.map((i) => findingHtml(i, 'dev')).join('')
    : `<div class="card pad" style="background:var(--bg2);display:flex;align-items:center;gap:10px">${mascotSvg(22)}<span class="muted">No findings. This session ran clean.</span></div>`
  return `<div class="kpis">${kpis}</div>
    <h3 style="margin:4px 0 10px">Top findings</h3>
    ${findings}`
}

function plainBody(a: Analysis): string {
  const s = a.summary
  const o = s.outcomes
  const produced: string[] = []
  if (o.prLinks.length) produced.push(`${o.prLinks.length} pull request${o.prLinks.length > 1 ? 's' : ''}`)
  if (o.gitCommits) produced.push(`${o.gitCommits} commits`)
  if (o.filesEdited + o.filesWritten) produced.push(`${o.filesEdited + o.filesWritten} files changed`)
  if (o.testRuns) produced.push(`${o.testRuns - o.testRunsFailed} test runs passing`)
  const goal = a.turns.find((t) => t.kind === 'human')?.promptPreview.slice(0, 140)
  const goalText = goal || (a.session.title ? a.session.title : '(prompt text not included in this report)')
  const firstSentence = (s.narrative.split(/(?<=\.)\s/)[0] ?? s.narrative).trim()
  const effort = `${tok(s.totalTokens)} tokens · ${ms(s.wallMs)}, of which ${ms(s.humanWaitMs)} needed your attention`
  const one = a.insights[0]
  const oneBody = one
    ? `<p style="margin:0;font-size:14px;color:var(--ink2)">${esc(plainSentence(one.recommendation, 'plain'))}${one.savings ? ` <b>Would ${esc(savingsText(one.savings))} on a session like this.</b>` : ''}</p>`
    : '<p style="margin:0;font-size:14px;color:var(--ink2)">Nothing stood out. This session ran cleanly.</p>'
  return `<div class="card mb16" style="overflow:hidden">
      <div class="card-head">${mascotSvg(22)}What happened here</div>
      <div class="plaingrid">
        <div class="k">Goal</div><div>${esc(goalText)}</div>
        <div class="k">What happened</div><div>${esc(plainSentence(firstSentence, 'plain'))}</div>
        <div class="k">What it produced</div><div>${esc(produced.join(' · ') || 'no tracked outputs')}</div>
        <div class="k">How it ended</div><div>${esc(endingWord(s.ending))}</div>
        <div class="k">Tokens &amp; time</div><div>${esc(effort)}</div>
      </div>
    </div>
    <div class="card pad mb16">
      <div class="card-title">The one thing to improve</div>
      ${oneBody}
    </div>`
}

export function renderOverview(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a)
    return h(`<section>${emptyHero({ title: 'No session selected.', hint: 'Pick a session from the sidebar.' })}</section>`)
  const body = ctx.audience === 'plain' ? plainBody(a) : detailedBody(a)
  return h(`<section>${degradedBanner(a, ctx.audience)}${outcome(a, ctx.audience)}${triptych(a)}${capabilityNav(ctx, a)}${body}</section>`)
}
