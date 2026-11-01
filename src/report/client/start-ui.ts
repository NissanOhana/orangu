/**
 * Serve only: the start view (#start), the first screen of the local app. 3 zoom tabs show 1 session, the sessions and
 * their agents, or the whole machine, in 1 panel. Under the panel, "What to improve first" shows the first findings of
 * the zoom, and "Next: improve with Claude" names the improve command and the interview status. Only serve-ui.ts
 * imports this file, so the file bundles carry none of it (src/report/offline.test.ts holds them to it).
 *
 * This file draws, and start-reads.ts reads. The view starts no read that analyzes every session (SPEC risk 13), and
 * Sessions and agents reads only the sessions that it lists. Its findings come from those reads, and its caption says so.
 *
 * No count shows where a read did not land: a running read shows its progress and skeleton tiles, a failed read says
 * so, and a row that no read filled shows no tokens and no agents.
 */
import type { HarnessReport } from '../../harness/types.js'
import type { Insight } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import type { SuggestionScope } from '../../suggest/types.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import type { Ctx } from './app.js'
import type { ProfileRead } from './data.js'
import type { QueueRead } from './queue-types.js'
import { cleanHash, liveRows, shortId, startZoom, type RouteState, type StartZoom } from './nav.js'
import { esc, ms, num, pct, plural, tok } from './format.js'
import { h } from './dom.js'
import { banner } from './components/banner.js'
import { commandBlock } from './components/command.js'
import { emptyHero } from './components/empty.js'
import { improvementLead } from './components/finding.js'
import { kpi } from './components/kpi.js'
import { outcomeHeadline, savingsText } from './derive.js'
import { plainSentence } from './strings.js'
import { EXAMPLE_TITLE_CAPTION, findingForRow, planRowForInsight, planRows, type PlanRow } from './suggest-rows.js'
import { queueRead } from './home-ui.js'
import { harnessLead } from './screens/harness.js'
import { listedRows, NEWEST, newestFirst, readMachine, redraw, startReadState, type ReadView, type RowRead } from './start-reads.js'

/** What the view draws from, beside the app state: the reads of start-reads.ts, of home-ui.ts and of serve-ui.ts. */
export interface StartReads {
  /** the harness report of serve-ui.ts: undefined while its first read runs or before the machine read, null when it failed */
  harness: HarnessReport | null | undefined
  /** the interview status: undefined while its first read runs, null when it failed */
  profile: ProfileRead | null | undefined
  machine: ReadView
  /** the read of each listed session, by id: absent while it runs, null when it failed */
  rows: ReadonlyMap<string, RowRead | null>
  /** the queue read of home-ui.ts: undefined while it runs, null when it failed */
  queue: QueueRead | null | undefined
}

const ZOOMS: ReadonlyArray<[StartZoom, string]> = [
  ['session', 'One session'],
  ['sessions', 'Sessions and agents'],
  ['machine', 'This machine'],
]
/** What to improve first shows this many findings, and a link to all of them when there are more. */
const FIRST = 3
/** The injected listings that a session loads at its start: skills, agents and MCP tools (src/harness/crosswalk.ts). */
const LOAD_TYPES = ['skill_listing', 'agent_listing_delta', 'deferred_tools_delta', 'mcp_instructions_delta']
/** The severity order of compareCrossFindings (src/analyze/aggregate.ts:41). */
const SEVERITY: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }
const DAY = /^\d{4}-\d{2}-\d{2}$/
const LIVE_DOT = '<span class="ldot" data-pulse="1" aria-hidden="true"></span>'

/** A link into another screen, built by the hash writer, so the theme and the audience go with it. */
const link = (ctx: Ctx, next: Partial<RouteState>, cls: string, label: string): string => `<a${cls ? ` class="${cls}"` : ''} href="${esc(cleanHash(ctx.state, next))}">${label}</a>`

/** The age that the server measured at its read: "40m ago", "3h ago", "5d ago". */
function ago(ageMs: number): string {
  const m = Math.max(1, Math.floor(ageMs / 60_000))
  if (m < 60) return `${m}m ago`
  const hours = Math.floor(m / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** "orangu · 11 sessions · 2 running · 1 root · local only". With no session it counts nothing. */
export function headLineHtml(d: AppData): string {
  const parts = ['<b>orangu</b>']
  if (d.sessions.length) {
    parts.push(esc(plural(d.sessions.length, 'session')), `${num(liveRows(d).length)} running`)
    if (d.roots) parts.push(esc(plural(d.roots.length, 'root')))
  }
  parts.push('local only')
  return `<p class="start-line">${parts.map((p) => `<span>${p}</span>`).join('<span aria-hidden="true">·</span>')}</p>`
}

/** The tablist: 1 tab stop on the selected tab, and each tab controls the 1 panel that shows the selected zoom. */
function tabsHtml(zoom: StartZoom): string {
  const tabs = ZOOMS.map(([id, label]) => `<button class="ztab" role="tab" type="button" id="zt-${id}" aria-controls="start-panel" aria-selected="${id === zoom}" tabindex="${id === zoom ? 0 : -1}" data-zoom="${id}">${label}</button>`)
  return `<div class="ztabs" role="tablist" aria-label="Zoom">${tabs.join('')}</div>`
}

/** One session: the session of the hash, running now or the latest, with its outcome, 4 tiles and its 2 links. */
function sessionPanel(ctx: Ctx): string {
  const row = ctx.data.sessions.find((r) => r.id === ctx.state.s)
  const a = ctx.a
  const live = row?.badge === 'live'
  const latest = !live && !!row && row.id === newestFirst(ctx.data.sessions)[0]?.id
  const quiet = latest && !liveRows(ctx.data).length ? '<span class="zp-meta">No session runs now. This shows the latest session.</span>' : ''
  const id = a?.session.id ?? row?.id ?? ''
  // the project as the picker and the live items name it
  const project = row?.projectSlug ?? a?.session.projectSlug ?? ''
  const head = `<div class="zp-head"><span class="zp-live">${live ? LIVE_DOT : '<span class="ldot hollow" aria-hidden="true"></span>'}${live ? 'Running now' : latest ? 'Latest session' : 'Selected session'}</span>${quiet}<span class="zp-meta">${esc(project)} · ${esc(shortId(id))}</span></div>`
  if (!a) return `${head}<p class="zp-out">orangu could not read this session.</p>`
  const runs = a.agents.runs.length
  const running = live && row?.agentsRunning ? `${num(row.agentsRunning)} running` : ''
  const tiles = kpi('Turns', num(a.summary.turns)) + kpi('Tokens', tok(a.summary.totalTokens)) + kpi('Active time', ms(a.summary.activeMs)) + kpi('Agents', num(runs), running)
  const agents = runs ? link(ctx, { screen: 'agents', s: a.session.id }, 'btn-sm', 'Open its agents') : ''
  return `${head}<h2 class="zp-title">${esc(a.session.title || `Session ${shortId(a.session.id)}`)}</h2><p class="zp-out">${esc(outcomeHeadline(a.summary))}</p><div class="kpis k4">${tiles}</div><div class="zp-foot">${link(ctx, { screen: 'overview', s: a.session.id }, 'btn-primary', 'Open the session')}${agents}</div>`
}

/**
 * 1 session row, 1 link: the agents of an orchestrator, else the Overview. A row that serve did not analyze takes its
 * title, tokens and agents from its read once the read lands. No token or agent count before that.
 */
function sessionRow(ctx: Ctx, r: SessionSummaryRow, read: RowRead | null | undefined): string {
  const live = r.badge === 'live'
  const total = r.agentsTotal ?? read?.agents
  const tokenCount = r.tokens ?? read?.tokens
  const agents = total ? `orchestrator · ${plural(total, 'agent')}${live && r.agentsRunning ? `, ${num(r.agentsRunning)} running` : ''}` : ''
  const dot = live ? LIVE_DOT : `<span class="ldot ${r.badge === 'idle' ? 'hollow' : 'done'}" aria-hidden="true"></span>`
  const tokens = tokenCount !== undefined ? `${esc(tok(tokenCount))}<span class="vh"> tokens</span>` : ''
  const href = cleanHash(ctx.state, { screen: total ? 'agents' : 'overview', s: r.id })
  return `<a class="srow" href="${esc(href)}">${dot}<span class="st">${esc(r.title || read?.title || shortId(r.id))}</span><span class="sk">${tokens}</span><span class="sm"><span class="sp">${esc(r.projectSlug)}</span><span class="sa${live ? ' run' : ''}">${live ? 'running' : ago(r.ageMs)}</span><span class="sg">${esc(agents)}</span></span></a>`
}

/** Sessions and agents: the running sessions, then the newest, and the links to the fleet and to this repository. */
function sessionsPanel(ctx: Ctx, reads: StartReads): string {
  const d = ctx.data
  const live = liveRows(d).length
  const shown = listedRows(d)
  const head = live ? `${plural(d.sessions.length, 'session')}. Running sessions come first, then the newest.` : 'No session runs now. The newest session comes first.'
  // no `s` in the hash: #live shows the fleet only when the hash names no session (screens/live.ts)
  const fleet = live ? link(ctx, { screen: 'live', s: undefined }, 'btn-sm', 'All live sessions') : ''
  const cut = shown.length < d.sessions.length ? `<p class="zp-why">This list shows ${num(shown.length)} of ${plural(d.sessions.length, 'session')}. They are the running sessions and the ${NEWEST} newest.</p>` : ''
  return `<div class="zp-head"><span class="zp-k">${esc(head)}</span><span class="zp-actions">${fleet}${link(ctx, { screen: 'repo' }, 'btn-sm', 'This repository')}</span></div><ol class="srows">${shown.map((r) => `<li>${sessionRow(ctx, r, reads.rows.get(r.id))}</li>`).join('')}</ol>${cut}`
}

/**
 * The tokens of the skill, agent and MCP tool listings that a session loads at its start: the per-session weight of
 * each of the 4 listing types, summed and rounded to 2 significant digits. Undefined when the report has none.
 */
export function loadTokens(r: HarnessReport): number | undefined {
  const sum = r.crosswalk.injectedListings.filter((l) => LOAD_TYPES.includes(l.type)).reduce((n, l) => n + l.approxTokensPerMainSession, 0)
  if (!sum) return undefined
  const step = 10 ** Math.max(0, Math.floor(Math.log10(sum)) - 1)
  return Math.round(sum / step) * step
}

/** The 2 wells: what the sessions load, and the harness line. No harness number before the report is here. */
function wellsHtml(r: HarnessReport | null | undefined): string {
  const none = r === null ? 'orangu has no harness data for this machine yet.' : r === undefined ? 'orangu reads the harness of this machine.' : ''
  const load = r ? loadTokens(r) : undefined
  const loads = none || (load ? `About ${num(load)} tokens of skill, agent and MCP tool listings in each session.` : 'orangu measured no skill or tool listings in these sessions.')
  // a rule is checked only in a session that recorded the files it loaded, so with no such session no rule is named
  const broken = r && r.enforcement.counts.sessionsWithRecord && r.enforcement.counts.rulesBroken ? ` · ${plural(r.enforcement.counts.rulesBroken, 'rule')} did not hold` : ''
  const harness = none || (r ? harnessLead(r).title + broken : '')
  return `<div class="wells"${r === undefined ? ' aria-busy="true"' : ''}><div class="well"><p class="eyebrow">What your sessions load</p><p>${esc(loads)}</p></div><div class="well"><p class="eyebrow">Harness</p><p>${esc(harness)}</p></div></div>`
}

/** This machine: no read until the person asks, then the read with its progress or its failure, then its totals and wells. */
function machinePanel(ctx: Ctx, reads: StartReads): string {
  const d = ctx.data
  const g = d.aggregates.global
  const read = reads.machine
  const report = link(ctx, { screen: 'global' }, 'btn-sm', 'Open the machine report')
  const harness = link(ctx, { screen: 'harness' }, 'btn-sm', 'Open the harness')
  if (!g && read.failed !== undefined)
    return `<div role="alert">${banner('warn', 'The read failed. orangu shows no totals for this machine.')}</div><p class="zp-why"><code>${esc(read.failed)}</code></p><div class="zp-foot"><button class="btn-sm" type="button" data-start-read>Read again</button>${report}</div>`
  if (!g && !read.asked && !read.busy)
    return `<div class="zp-head"><span class="zp-k">${esc(`This machine has ${plural(d.sessions.length, 'session')}.`)}</span></div><p class="zp-why">orangu reads them all only when you ask, and a first read can take some minutes.</p><div class="zp-foot"><button class="btn-primary" type="button" data-start-read>Read this machine</button>${report}${harness}</div>`
  if (!g) {
    const { done, total } = read
    const counted = done !== undefined && !!total
    const bar = counted ? `<div class="zp-bar" role="progressbar" aria-label="Sessions read" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${Math.min(100, (done / total) * 100).toFixed(1)}%"></i></div>` : '<div class="zp-bar" role="progressbar" aria-label="Sessions read"><i></i></div>'
    const skeleton = ['Sessions', 'Tokens', 'Read from cache', 'Active time'].map((label) => kpi(label, '', '', { skeleton: true })).join('')
    return `<div class="zp-head"><span class="zp-k">${esc(counted ? `Reading ${num(done)} of ${plural(total, 'session')}.` : 'orangu reads the sessions of this machine.')}</span></div>${bar}<div class="kpis k4">${skeleton}</div><p class="zp-why">orangu shows the totals when the read ends.</p>`
  }
  const n = g.sessionCount
  const all = d.sessions.length
  const head = n < all ? `orangu read ${num(n)} of ${plural(all, 'session')} on this machine.` : n === 1 ? 'The 1 session on this machine.' : `All ${num(n)} sessions on this machine.`
  const tiles = kpi('Sessions', num(n)) + kpi('Tokens', tok(g.totals.tokens)) + kpi('Read from cache', pct(g.averages.cacheHitRatio), 'average per session') + kpi('Active time', ms(g.totals.activeMs))
  return `<div class="zp-head"><span class="zp-k">${esc(head)}</span><span class="zp-actions">${report}${harness}</span></div><div class="kpis k4">${tiles}</div>${wellsHtml(reads.harness)}`
}

/** The panel of the selected zoom, labelled by its tab. It is busy while the machine read runs. */
export function panelHtml(ctx: Ctx, reads: StartReads): string {
  const zoom = startZoom(ctx.data, ctx.state)
  const body = zoom === 'session' ? sessionPanel(ctx) : zoom === 'sessions' ? sessionsPanel(ctx, reads) : machinePanel(ctx, reads)
  const busy = zoom === 'machine' && !ctx.data.aggregates.global && reads.machine.failed === undefined && (reads.machine.asked || reads.machine.busy)
  return `<section class="card zpanel" id="start-panel" role="tabpanel" aria-labelledby="zt-${zoom}" tabindex="0"${busy ? ' aria-busy="true"' : ''}>${body}</section>`
}

/** The improve command of a finding: the self-contained form that needs no stored record (handoffForInsight, suggest-rows.ts). */
export function handoffFor(row: PlanRow, scope: SuggestionScope): string {
  const finding = findingForRow(row, scope)
  const key = suggestionKey(finding, 'report')
  return kickoffCommands({ id: suggestionIdV2(key), ...finding, sessionIds: key.sessionIds, source: 'report' }, 'file').claude
}

/** 1 finding with each part in view: its title and saving, where it shows, the improvement and the improve command. */
function findingRow(ctx: Ctx, row: PlanRow, scope: SuggestionScope, where: string, top: boolean): string {
  const aud = ctx.audience
  const saving = savingsText(row.savings)
  const sev = row.severity ? `<span class="sev ${esc(row.severity)}" title="${esc(row.severity)}" aria-hidden="true"></span><span class="vh">${esc(row.severity)} severity.</span>` : ''
  return `<article class="frow${top ? ' top' : ''}"><div class="frow-h">${sev}<b class="frow-t">${esc(plainSentence(row.displayTitle || row.title, aud))}</b>${saving ? `<span class="fsave">${esc(saving)}</span>` : ''}</div><p class="fwhere">${esc(aud === 'plain' ? where : `${where} · ${row.ruleId}`)}</p>${improvementLead(row.improvement, aud)}${commandBlock(handoffFor(row, scope), '$', 'the Claude Code command')}</article>`
}

/** 1 rule of the listed sessions: the first listed session that shows it is its example, and how many listed sessions show it. */
interface ListFinding {
  insight: Insight
  sessionId: string
  sessions: number
  tokens: number
}

/**
 * The findings of the listed sessions whose read landed, 1 for each rule, ranked with the keys of compareCrossFindings
 * (src/analyze/aggregate.ts:51): severity, then tokens, then sessions, then the rule id. `read` is how many reads landed.
 */
function listFindings(rows: SessionSummaryRow[], reads: ReadonlyMap<string, RowRead | null>): { read: number; failed: number; findings: ListFinding[] } {
  const byRule = new Map<string, ListFinding>()
  let read = 0
  let failed = 0
  for (const r of rows) {
    const got = reads.get(r.id)
    if (got === null) failed++
    if (!got) continue
    read++
    // a rule counts once in each session
    const seen = new Set<string>()
    for (const insight of got.insights) {
      if (seen.has(insight.ruleId)) continue
      seen.add(insight.ruleId)
      const known = byRule.get(insight.ruleId)
      if (known) {
        known.sessions++
        known.tokens += insight.savings?.tokens ?? 0
      } else byRule.set(insight.ruleId, { insight, sessionId: r.id, sessions: 1, tokens: insight.savings?.tokens ?? 0 })
    }
  }
  const findings = [...byRule.values()].sort(
    (a, b) => (SEVERITY[b.insight.severity] ?? 0) - (SEVERITY[a.insight.severity] ?? 0) || b.tokens - a.tokens || b.sessions - a.sessions || a.insight.ruleId.localeCompare(b.insight.ruleId),
  )
  return { read, failed, findings }
}

/** The link to every improvement of a scope, when the view shows only the first ones. */
function moreLink(ctx: Ctx, count: number, scope: SuggestionScope): string {
  return count > FIRST ? `<p class="fmore">${link(ctx, { screen: 'suggest', scope: scope === 'session' ? undefined : scope }, '', `Open all ${num(count)} improvements`)}</p>` : ''
}

/** The findings of the sessions on the list, from their reads, with the caption that says where they come from. */
function listFirst(ctx: Ctx, reads: StartReads): string {
  const rows = listedRows(ctx.data)
  const { read, failed, findings } = listFindings(rows, reads.rows)
  if (!read) return `<p class="cap">${failed === rows.length && rows.length ? 'orangu could not read the sessions on this list.' : 'orangu reads the sessions on this list.'}</p>`
  if (!findings.length) return '<p class="cap">orangu found nothing to improve in the sessions on this list.</p>'
  const shown = findings.slice(0, FIRST).map((f, i) => findingRow(ctx, planRowForInsight(f.insight, f.sessionId), 'session', `In ${num(f.sessions)} of ${plural(read, 'session')} on this list`, i === 0))
  return `<p class="cap">They come from the sessions on this list. Each title and each command use one example session.</p>${shown.join('')}`
}

/** The queue line: only when the queue has items that are due for a check, with the items that are ready to apply. */
function queueBanner(ctx: Ctx, q: QueueRead | null | undefined): string {
  const due = q?.counts.due ?? 0
  if (!due) return ''
  const apply = q?.counts.apply ?? 0
  const line = `${due === 1 ? '1 change is' : `${num(due)} changes are`} due for a check.${apply ? ` ${apply === 1 ? '1 is' : `${num(apply)} are`} ready to apply.` : ''}`
  return banner('info', `<span>${esc(line)}</span>${link(ctx, { screen: 'suggest' }, 'banner-link', 'Open Improvements')}`)
}

/** What to improve first: the first findings of the zoom, from a read that is already cheap, or the state of the read. */
export function firstHtml(ctx: Ctx, reads: StartReads): string {
  const d = ctx.data
  const zoom = startZoom(d, ctx.state)
  let body: string
  if (zoom === 'sessions') body = listFirst(ctx, reads)
  else if (zoom === 'session') {
    const rows = ctx.a ? planRows('session', ctx.a, undefined) : []
    body = !ctx.a
      ? '<p class="cap">orangu could not read this session.</p>'
      : rows.length
        ? rows.slice(0, FIRST).map((row, i) => findingRow(ctx, row, 'session', 'In this session', i === 0)).join('') + moreLink(ctx, rows.length, 'session')
        : '<p class="cap">orangu found nothing to improve in this session.</p>'
  } else {
    const g = d.aggregates.global
    const rows = g ? planRows('global', undefined, g) : []
    body = !g
      ? `<p class="cap">${reads.machine.failed !== undefined ? 'The read failed, so orangu shows no findings.' : reads.machine.asked || reads.machine.busy ? 'orangu shows the findings when the read ends.' : 'Read this machine to see the findings of all its sessions.'}</p>`
      : rows.length
        ? `<p class="cap">${EXAMPLE_TITLE_CAPTION}</p>${rows.slice(0, FIRST).map((row, i) => findingRow(ctx, row, 'global', `In ${plural(row.sessions ?? 1, 'session')} on this machine`, i === 0)).join('')}${moreLink(ctx, rows.length, 'global')}`
        : '<p class="cap">orangu found nothing to improve on this machine.</p>'
  }
  return `<section class="start-first" aria-labelledby="first-h"><h2 class="h-sec" id="first-h">What to improve first</h2><p class="cap">orangu found these with no model. Each line shows the change to make.</p>${body}${queueBanner(ctx, reads.queue)}</section>`
}

/** The interview status: done on its day, not yet, a file that does not read, or a status read that failed. None while it runs. */
function interviewTag(p: ProfileRead | null | undefined): string {
  if (p === undefined) return ''
  const [cls, words] =
    p === null
      ? ['neutral', 'Interview: orangu could not read the status.']
      : !p.exists
        ? ['neutral', 'Interview: not yet.']
        : typeof p.updatedAt === 'string' && DAY.test(p.updatedAt)
          ? ['good', `Interview: done on ${p.updatedAt}.`]
          : ['warn', 'Interview: orangu cannot read your answers.']
  return `<p><span class="tag ${cls}">${esc(words)}</span></p>`
}

/** Next: improve with Claude. The improve command with a copy control, what it does, and the interview status. */
export function nextHtml(profile: ProfileRead | null | undefined): string {
  return `<aside class="card pad start-next" aria-labelledby="next-h"><h2 class="h-sec" id="next-h">Next: improve with Claude</h2><p>In Claude Code, run <code>/orangu:improve</code>.</p>${commandBlock('/orangu:improve', '>', 'the command /orangu:improve')}<ul><li>It reads this evidence, finds patterns and proposes changes.</li><li>You approve each change by its id.</li><li>Run <code>/orangu:interview</code> to change your answers.</li></ul>${interviewTag(profile)}</aside>`
}

/** No session at all: the folders that orangu read, as code, and how to make a first session. */
function emptyHtml(d: AppData): string {
  const roots = d.roots ?? []
  const looked = roots.length
    ? `<div class="s">${roots.length === 1 ? 'orangu looked in this folder.' : `orangu looked in these ${num(roots.length)} folders.`}</div><ul class="roots">${roots.map((root) => `<li><code>${esc(root)}</code></li>`).join('')}</ul>`
    : ''
  // the shared empty state, with the folders and the next step added inside its card
  const hero = emptyHero({ title: 'orangu found no sessions on this machine.', mascotSize: 72 })
  return `<div class="start-empty">${hero.replace(/<\/div><\/div>$/, `${looked}<div class="s">Start a session in Claude Code, Cowork or Claude Desktop. Then load this page again.</div></div></div>`)}</div>`
}

/** The whole view as a string, with no DOM: renderStart wraps and wires it, and a node test reads it. */
export function startHtml(ctx: Ctx, reads: StartReads): string {
  const d = ctx.data
  const head = `${headLineHtml(d)}<h1 class="start-h1">See what your agents do.</h1>`
  if (!d.sessions.length) return `<section class="start">${head}${emptyHtml(d)}</section>`
  return `<section class="start">${head}<p class="start-sub">orangu read these sessions with no model and no network.</p>${tabsHtml(startZoom(d, ctx.state))}${panelHtml(ctx, reads)}<div class="start-below">${firstHtml(ctx, reads)}${nextHtml(reads.profile)}</div></section>`
}

// ---------- the focus across renders: the reads that the view draws are in start-reads.ts ----------

/** the tab that a click or a key selected, or the panel after a read control: the next render puts focus on it */
let focusId: string | undefined

/**
 * The control that has the focus in the start view, as a selector that finds the same control in the next render: by
 * its id (a tab, the panel), its link target, or the text that it copies. Undefined outside the view.
 */
function focusSelector(el: Element | null): string | undefined {
  if (!el?.closest('#screen-start')) return undefined
  if (el.id) return '#' + CSS.escape(el.id)
  const href = el.getAttribute('href')
  if (href) return `#screen-start a[href="${CSS.escape(href)}"]`
  const copy = el.getAttribute('data-copy')
  return copy === null ? undefined : `#screen-start [data-copy="${CSS.escape(copy)}"]`
}

/**
 * The view, wired: the zoom tabs by click and by key, and the machine read control. `harness` is the report of
 * serve-ui.ts. Each render replaces the whole view, and a live frame or the progress of a read renders it again, so the
 * focus goes back to the same control after each render: the tab or the panel that a click or a key chose, else the
 * control that had it.
 */
export function renderStart(ctx: Ctx, harness: HarnessReport | null | undefined): HTMLElement {
  // the app builds this element before it removes the old view, so the old focus is still on the page here
  const keep = focusId ? '#' + focusId : focusSelector(document.activeElement)
  focusId = undefined
  const { profile, machine, rows } = startReadState()
  const el = h(startHtml(ctx, { harness, profile, machine, rows, queue: queueRead() }))
  const tabs = Array.prototype.slice.call(el.querySelectorAll<HTMLButtonElement>('[role="tab"]')) as HTMLButtonElement[]
  const pick = (zoom: string | undefined): void => {
    if (zoom !== 'session' && zoom !== 'sessions' && zoom !== 'machine') return
    focusId = 'zt-' + zoom
    ctx.go({ zoom })
  }
  for (const tab of tabs) tab.addEventListener('click', () => pick(tab.dataset['zoom']))
  // the arrows move the selection and the focus together, and Home and End go to the first and the last tab
  el.querySelector('[role="tablist"]')?.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    const at = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
    const to = key === 'ArrowRight' ? at + 1 : key === 'ArrowLeft' ? at - 1 : key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : undefined
    if (to === undefined) return
    event.preventDefault()
    pick(tabs[(to + tabs.length) % tabs.length]?.dataset['zoom'])
  })
  // Read this machine, and Read again after a failure: the only start of the machine read
  el.querySelector('[data-start-read]')?.addEventListener('click', () => {
    focusId = 'start-panel'
    void readMachine(ctx.data)
    redraw()
  })
  // the app attaches this element after the render returns it
  if (keep)
    setTimeout(() => {
      const target = document.querySelector<HTMLElement>(keep)
      if (target && document.activeElement !== target) target.focus({ preventScroll: true })
    })
  return el
}
