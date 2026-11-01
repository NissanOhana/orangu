/**
 * Serve only: the start view (#start), the first screen of the local app. 3 zoom tabs show 1 session, the sessions and
 * their agents, or the whole machine, in 1 panel. Under the panel, "What to improve first" shows the first findings of
 * the zoom, and "Next: improve with Claude" names the improve command and the interview status. Only serve-ui.ts
 * imports this file, so the file bundles carry none of it (src/report/offline.test.ts holds them to it).
 *
 * The reads fill on demand, as the aggregates and the queue do. The screen data seam of serve (serve-ui.ts) calls
 * ensureStart on each render of #start: it starts the profile read and the machine read of This machine. renderStart
 * starts the repository read of Sessions and agents, because only the render has the analysis that names the folder
 * of the selected session. Each read stores its result where the other screens read it (`AppData.aggregates`), keeps
 * its progress and its failure here, and draws the app again when it lands. A failed read waits for Read again. Live
 * frames draw the view again, as home-ui.ts does for the queue, and a window that gets focus reads the profile again,
 * so an interview that ran in Claude Code shows when the person comes back.
 *
 * No count shows where a read did not land: a running read shows its progress and skeleton tiles, a failed read says
 * so, and a row that the server did not analyze shows no tokens and no agents.
 */
import type { Aggregate } from '../../analyze/aggregate.js'
import type { HarnessReport } from '../../harness/types.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import type { SuggestionScope } from '../../suggest/types.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import type { Ctx } from './app.js'
import type { DataSource, ProfileRead } from './data.js'
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
import { EXAMPLE_TITLE_CAPTION, findingForRow, planRows, type PlanRow } from './suggest-rows.js'
import { queueRead } from './home-ui.js'
import { harnessLead } from './screens/harness.js'

/** A read of this view: busy while it runs, its progress from the 202 bodies, and why it stopped when it failed. */
export interface ReadView {
  busy: boolean
  done?: number
  total?: number
  failed?: string
  /** the repository read: the folder it read */
  cwd?: string
}

/** What the view draws from, beside the app state: the reads of this module, of home-ui.ts and of serve-ui.ts. */
export interface StartReads {
  /** the harness report of serve-ui.ts: undefined while its first read runs, null when it failed */
  harness: HarnessReport | null | undefined
  /** the interview status: undefined while its first read runs, null when it failed */
  profile: ProfileRead | null | undefined
  machine: ReadView
  repo: ReadView
  /** the queue read of home-ui.ts: undefined while it runs, null when it failed */
  queue: QueueRead | null | undefined
}

const ZOOMS: ReadonlyArray<[StartZoom, string]> = [
  ['session', 'One session'],
  ['sessions', 'Sessions and agents'],
  ['machine', 'This machine'],
]
/** Sessions and agents lists the running sessions, then this many of the newest. */
const NEWEST = 20
/** What to improve first shows this many findings, and a link to all of them when there are more. */
const FIRST = 3
/** The injected listings that a session loads at its start: skills, agents and MCP tools (src/harness/crosswalk.ts). */
const LOAD_TYPES = ['skill_listing', 'agent_listing_delta', 'deferred_tools_delta', 'mcp_instructions_delta']
const DAY = /^\d{4}-\d{2}-\d{2}$/
const LIVE_DOT = '<span class="ldot" data-pulse="1" aria-hidden="true"></span>'

const newestFirst = (rows: SessionSummaryRow[]): SessionSummaryRow[] => [...rows].sort((a, b) => b.mtimeMs - a.mtimeMs)
/** A link into another screen, built by the hash writer, so the theme and the audience go with it. */
const link = (ctx: Ctx, next: Partial<RouteState>, cls: string, label: string): string => `<a${cls ? ` class="${cls}"` : ''} href="${esc(cleanHash(ctx.state, next))}">${label}</a>`

/** The age that the server measured at its read: "40m ago", "3h ago", "5d ago". */
function ago(ageMs: number): string {
  const m = Math.max(1, Math.floor(ageMs / 60_000))
  if (m < 60) return `${m}m ago`
  const hours = Math.floor(m / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** The folder of the selected session: its row, else its analysis. */
function selectedCwd(ctx: Ctx): string | undefined {
  return ctx.data.sessions.find((r) => r.id === ctx.state.s)?.cwd ?? ctx.a?.session.cwd
}

/** The repository aggregate of `cwd`, or nothing when the aggregate in the app was read for another folder. */
function repoOf(d: AppData, cwd: string | undefined): Aggregate | undefined {
  const agg = d.aggregates.repo
  return cwd && agg?.scope === `repo ${cwd}` ? agg : undefined
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

/** 1 session row, 1 link: the agents of an orchestrator, else the Overview. No token or agent count that the row lacks. */
function sessionRow(ctx: Ctx, r: SessionSummaryRow): string {
  const live = r.badge === 'live'
  const agents = r.agentsTotal ? `orchestrator · ${plural(r.agentsTotal, 'agent')}${live && r.agentsRunning ? `, ${num(r.agentsRunning)} running` : ''}` : ''
  const dot = live ? LIVE_DOT : `<span class="ldot ${r.badge === 'idle' ? 'hollow' : 'done'}" aria-hidden="true"></span>`
  const tokens = r.tokens !== undefined ? `${esc(tok(r.tokens))}<span class="vh"> tokens</span>` : ''
  const href = cleanHash(ctx.state, { screen: r.agentsTotal ? 'agents' : 'overview', s: r.id })
  return `<a class="srow" href="${esc(href)}">${dot}<span class="st">${esc(r.title || shortId(r.id))}</span><span class="sk">${tokens}</span><span class="sm"><span class="sp">${esc(r.projectSlug)}</span><span class="sa${live ? ' run' : ''}">${live ? 'running' : ago(r.ageMs)}</span><span class="sg">${esc(agents)}</span></span></a>`
}

/** Sessions and agents: the running sessions, then the newest, and the links to the fleet and to this repository. */
function sessionsPanel(ctx: Ctx): string {
  const d = ctx.data
  const live = newestFirst(liveRows(d))
  const liveIds = new Set(live.map((r) => r.id))
  const shown = [...live, ...newestFirst(d.sessions.filter((r) => !liveIds.has(r.id))).slice(0, NEWEST)]
  const head = live.length ? `${plural(d.sessions.length, 'session')}. Running sessions come first, then the newest.` : 'No session runs now. The newest session comes first.'
  // no `s` in the hash: #live shows the fleet only when the hash names no session (screens/live.ts)
  const fleet = live.length ? link(ctx, { screen: 'live', s: undefined }, 'btn-sm', 'All live sessions') : ''
  const cut = shown.length < d.sessions.length ? `<p class="zp-why">This list shows ${num(shown.length)} of ${plural(d.sessions.length, 'session')}. They are the running sessions and the ${NEWEST} newest.</p>` : ''
  return `<div class="zp-head"><span class="zp-k">${esc(head)}</span><span class="zp-actions">${fleet}${link(ctx, { screen: 'repo' }, 'btn-sm', 'This repository')}</span></div><ol class="srows">${shown.map((r) => `<li>${sessionRow(ctx, r)}</li>`).join('')}</ol>${cut}`
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

/** This machine: the global read with its progress or its failure, then its 4 totals and the 2 wells. */
function machinePanel(ctx: Ctx, reads: StartReads): string {
  const d = ctx.data
  const g = d.aggregates.global
  const report = link(ctx, { screen: 'global' }, 'btn-sm', 'Open the machine report')
  if (!g && reads.machine.failed !== undefined)
    return `<div role="alert">${banner('warn', 'The read failed. orangu shows no totals for this machine.')}</div><p class="zp-why"><code>${esc(reads.machine.failed)}</code></p><div class="zp-foot"><button class="btn-sm" type="button" data-start-read>Read again</button>${report}</div>`
  if (!g) {
    const { done, total } = reads.machine
    const counted = done !== undefined && !!total
    const bar = counted ? `<div class="zp-bar" role="progressbar" aria-label="Sessions read" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${Math.min(100, (done / total) * 100).toFixed(1)}%"></i></div>` : '<div class="zp-bar" role="progressbar" aria-label="Sessions read"><i></i></div>'
    const skeleton = ['Sessions', 'Tokens', 'Read from cache', 'Active time'].map((label) => kpi(label, '', '', { skeleton: true })).join('')
    return `<div class="zp-head"><span class="zp-k">${esc(counted ? `Reading ${num(done)} of ${plural(total, 'session')}.` : 'orangu reads the sessions of this machine.')}</span></div>${bar}<div class="kpis k4">${skeleton}</div><p class="zp-why">orangu shows the totals when the read ends.</p>`
  }
  const n = g.sessionCount
  const all = d.sessions.length
  const head = n < all ? `orangu read ${num(n)} of ${plural(all, 'session')} on this machine.` : n === 1 ? 'The 1 session on this machine.' : `All ${num(n)} sessions on this machine.`
  const tiles = kpi('Sessions', num(n)) + kpi('Tokens', tok(g.totals.tokens)) + kpi('Read from cache', pct(g.averages.cacheHitRatio), 'average per session') + kpi('Active time', ms(g.totals.activeMs))
  return `<div class="zp-head"><span class="zp-k">${esc(head)}</span><span class="zp-actions">${report}${link(ctx, { screen: 'harness' }, 'btn-sm', 'Open the harness')}</span></div><div class="kpis k4">${tiles}</div>${wellsHtml(reads.harness)}`
}

/** The panel of the selected zoom, labelled by its tab. It is busy while the machine read runs. */
export function panelHtml(ctx: Ctx, reads: StartReads): string {
  const zoom = startZoom(ctx.data, ctx.state)
  const body = zoom === 'session' ? sessionPanel(ctx) : zoom === 'sessions' ? sessionsPanel(ctx) : machinePanel(ctx, reads)
  const busy = zoom === 'machine' && !ctx.data.aggregates.global && reads.machine.failed === undefined
  return `<section class="card zpanel" id="start-panel" role="tabpanel" aria-labelledby="zt-${zoom}" tabindex="0"${busy ? ' aria-busy="true"' : ''}>${body}</section>`
}

/** The improve command of a finding: the self-contained form that needs no stored record (handoffForInsight, suggest-rows.ts). */
export function handoffFor(row: PlanRow, scope: SuggestionScope): string {
  const finding = findingForRow(row, scope)
  const key = suggestionKey(finding, 'report')
  return kickoffCommands({ id: suggestionIdV2(key), ...finding, sessionIds: key.sessionIds, source: 'report' }, 'file').claude
}

/** 1 finding with each part in view: its title and saving, where it shows, the improvement and the improve command. */
function findingRow(ctx: Ctx, row: PlanRow, scope: SuggestionScope, top: boolean): string {
  const aud = ctx.audience
  const where = scope === 'session' ? 'In this session' : `In ${plural(row.sessions ?? 1, 'session')} ${scope === 'repo' ? 'in this repository' : 'on this machine'}`
  const saving = savingsText(row.savings)
  const sev = row.severity ? `<span class="sev ${esc(row.severity)}" title="${esc(row.severity)}" aria-hidden="true"></span><span class="vh">${esc(row.severity)} severity.</span>` : ''
  return `<article class="frow${top ? ' top' : ''}"><div class="frow-h">${sev}<b class="frow-t">${esc(plainSentence(row.displayTitle || row.title, aud))}</b>${saving ? `<span class="fsave">${esc(saving)}</span>` : ''}</div><p class="fwhere">${esc(aud === 'plain' ? where : `${where} · ${row.ruleId}`)}</p>${improvementLead(row.improvement, aud)}${commandBlock(handoffFor(row, scope), '$', 'the Claude Code command')}</article>`
}

/** The queue line: only when the queue has items that are due for a check, with the items that are ready to apply. */
function queueBanner(ctx: Ctx, q: QueueRead | null | undefined): string {
  const due = q?.counts.due ?? 0
  if (!due) return ''
  const apply = q?.counts.apply ?? 0
  const line = `${due === 1 ? '1 change is' : `${num(due)} changes are`} due for a check.${apply ? ` ${apply === 1 ? '1 is' : `${num(apply)} are`} ready to apply.` : ''}`
  return banner('info', `<span>${esc(line)}</span>${link(ctx, { screen: 'suggest' }, 'banner-link', 'Open Improvements')}`)
}

/** What to improve first: the first findings of the zoom, or the state of the read that brings them. */
export function firstHtml(ctx: Ctx, reads: StartReads): string {
  const d = ctx.data
  const zoom = startZoom(d, ctx.state)
  const scope: SuggestionScope = zoom === 'session' ? 'session' : zoom === 'sessions' ? 'repo' : 'global'
  const cwd = selectedCwd(ctx)
  const agg = scope === 'repo' ? repoOf(d, cwd) : scope === 'global' ? d.aggregates.global : undefined
  const read = scope === 'repo' ? reads.repo : reads.machine
  const failed = read.failed !== undefined && (scope === 'global' || read.cwd === cwd)
  let body: string
  if (scope === 'session' && !ctx.a) body = '<p class="cap">orangu could not read this session.</p>'
  else if (scope === 'repo' && !cwd) body = '<p class="cap">orangu does not know the folder of this session.</p>'
  else if (scope !== 'session' && !agg) body = `<p class="cap">${failed ? 'The read failed, so orangu shows no findings.' : 'orangu shows the findings when the read ends.'}</p>`
  else {
    const rows = planRows(scope, ctx.a, agg)
    const place = scope === 'session' ? 'in this session' : scope === 'repo' ? 'in this repository' : 'on this machine'
    const more = rows.length > FIRST ? `<p class="fmore">${link(ctx, { screen: 'suggest', scope: scope === 'session' ? undefined : scope }, '', `Open all ${num(rows.length)} improvements`)}</p>` : ''
    body = rows.length
      ? `${scope === 'session' ? '' : `<p class="cap">${EXAMPLE_TITLE_CAPTION}</p>`}${rows.slice(0, FIRST).map((row, i) => findingRow(ctx, row, scope, i === 0)).join('')}${more}`
      : `<p class="cap">orangu found nothing to improve ${place}.</p>`
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

// ---------- the reads: module state, as home-ui.ts keeps the queue ----------

let source: DataSource | undefined
let rerender: () => void = () => {}
let profile: ProfileRead | null | undefined
let profileBusy = false
const machine: ReadView = { busy: false }
const repo: ReadView = { busy: false }
/** the tab that a click or a key selected, or the panel after Read again: the next render puts focus on it */
let focusId: string | undefined

/** Is the start view on the page? app.ts gives each screen the id `screen-<id>`. */
const onStart = (): boolean => typeof document !== 'undefined' && document.getElementById('screen-start') !== null

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

/** Read the interview status. A failed read again keeps the last good status. */
async function readProfile(): Promise<void> {
  if (profileBusy || !source?.profile) return
  profileBusy = true
  let read: ProfileRead | null = null
  try {
    read = await source.profile()
  } catch {
    read = null
  }
  profileBusy = false
  profile = read ?? (profile || null)
  if (onStart()) rerender()
}

/** Read the aggregate of a scope with its progress, and store it where #repo, #global and #suggest read it. */
async function readAggregate(d: AppData, scope: 'repo' | 'global', cwd: string | undefined): Promise<void> {
  const read = scope === 'global' ? machine : repo
  if (read.busy || !source) return
  Object.assign(read, { busy: true, done: undefined, total: undefined, failed: undefined, cwd })
  let agg: Aggregate | null = null
  try {
    agg = await source.aggregate(scope, cwd, {
      progress: (done, total) => {
        read.done = done
        read.total = total
        if (onStart()) rerender()
      },
      failed: (reason) => (read.failed = reason),
    })
  } catch {
    agg = null
  }
  read.busy = false
  if (agg) d.aggregates[scope] = agg
  else read.failed ??= 'The request to localhost failed.'
  if (onStart()) rerender()
}

/** The listeners of the view, once: live frames draw it again, and a window that gets focus reads the profile again. */
function wire(ds: DataSource): void {
  ds.subscribe((ev) => {
    if ((ev.type === 'session-live' || ev.type === 'session-updated') && onStart()) rerender()
  })
  if (typeof window !== 'undefined')
    window.addEventListener('focus', () => {
      if (onStart()) void readProfile()
    })
}

/**
 * The data seam of #start (serve-ui.ts calls it on each render): the profile read once, and the machine read when This
 * machine is open and no read ran or failed. `loaded` draws the app again when a read lands.
 */
export function ensureStart(d: AppData, ds: DataSource, state: RouteState, loaded: () => void): void {
  rerender = loaded
  if (!source) {
    source = ds
    wire(ds)
  }
  if (profile === undefined) void readProfile()
  if (startZoom(d, state) === 'machine' && !d.aggregates.global && machine.failed === undefined) void readAggregate(d, 'global', undefined)
}

/**
 * The view, wired: the zoom tabs by click and by key, and Read again. `harness` is the report of serve-ui.ts. Each
 * render replaces the whole view, and a live frame or the progress of a read renders it again, so the focus goes back
 * to the same control after each render: the tab or the panel that a click or a key chose, else the control that had it.
 */
export function renderStart(ctx: Ctx, harness: HarnessReport | null | undefined): HTMLElement {
  const cwd = selectedCwd(ctx)
  if (startZoom(ctx.data, ctx.state) === 'sessions' && cwd && !repoOf(ctx.data, cwd) && !(repo.failed !== undefined && repo.cwd === cwd)) void readAggregate(ctx.data, 'repo', cwd)
  // the app builds this element before it removes the old view, so the old focus is still on the page here
  const keep = focusId ? '#' + focusId : focusSelector(document.activeElement)
  focusId = undefined
  const el = h(startHtml(ctx, { harness, profile, machine, repo, queue: queueRead() }))
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
  el.querySelector('[data-start-read]')?.addEventListener('click', () => {
    machine.failed = undefined
    focusId = 'start-panel'
    void readAggregate(ctx.data, 'global', undefined)
    rerender()
  })
  // the app attaches this element after the render returns it
  if (keep)
    setTimeout(() => {
      const target = document.querySelector<HTMLElement>(keep)
      if (target && document.activeElement !== target) target.focus({ preventScroll: true })
    })
  return el
}
