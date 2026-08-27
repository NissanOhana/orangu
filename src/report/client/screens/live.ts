/**
 * Live (§2.1, §4): session view (banner → KPIs → context → agents swimlane → feed) and the fleet
 * (N live sessions). In file mode the page is a static snapshot: "Watching via orangu watch" only when
 * `capabilities.watch` says a running watch rewrites the file, otherwise a plain snapshot banner; the
 * serve states (connecting/reconnecting) arrive with the remote source in Wave C via the same states.
 */
import type { Ctx } from '../app.js'
import type { Analysis, AgentStat } from '../../../model/analysis.js'
import type { SessionSummaryRow } from '../../../model/app-data.js'
import { catColor, esc, ms, pct, timeOnly, tok } from '../format.js'
import { h } from '../dom.js'
import { kpi } from '../components/kpi.js'
import { emptyHero } from '../components/empty.js'
import { mascotBox } from '../components/mascot-box.js'
import { ganttRow } from '../charts.js'
import { badgeCopy, liveFeed } from '../derive.js'
import { liveRows, shortId } from '../nav.js'
import type { FeedbackBootstrap } from '../../../feedback/diagnostics.js'

const FEED_MAX = 50
const LANES = 12

declare global {
  interface Window {
    /** serve shell bootstrap (renderShell): fleet header facts */
    __ORANGU_SERVE__?: { maxLive: number; version?: string; feedback?: FeedbackBootstrap }
    /**
     * Fleet screen renderer (serve-ui.ts): the fleet exists only in serve mode (file mode
     * always has exactly one session), so its bytes live in the serve bundle (policy ratchet).
     */
    __ORANGU_FLEET__?: (ctx: Ctx, live: SessionSummaryRow[]) => HTMLElement
  }
}

export type LiveState = 'connecting' | 'live' | 'stalled' | 'ended' | 'reconnecting' | 'file' | 'snapshot' | 'empty'

export function liveStateFor(ctx: Ctx, row: SessionSummaryRow | undefined, a: Analysis | undefined): LiveState {
  if (!row) return 'connecting'
  if (ctx.conn === 'reconnecting') return 'reconnecting'
  if (row.badge === 'ended') return 'ended'
  if (a && a.summary.toolCalls === 0) return 'empty'
  if (ctx.data.mode === 'file') return ctx.data.capabilities.watch ? 'file' : 'snapshot'
  if (row.badge === 'idle') return 'stalled'
  return 'live'
}

function bdot(cls: string, vh?: string): string {
  return `<span class="bdot ${cls}"${cls === 'p' ? ' data-pulse="1"' : ''} aria-hidden="true"></span>${vh ? `<span class="vh">${vh}</span>` : ''}`
}
const DOTS = {
  pulse: bdot('p', 'live'),
  hollow: bdot('h', 'quiet'),
  good: bdot('g', 'ended'),
  static: bdot('s'),
}

/** static banner copy per state: [dot, title, sub]; live/stalled titles and the ended sub are dynamic */
const LIVE_ROW: [string, string, string] = [DOTS.pulse, '', 'Refreshes as the transcript grows. Nothing leaves this machine.']
const BANNER: Record<LiveState, [string, string, string]> = {
  connecting: [DOTS.static, 'Connecting to orangu serve…', 'Waiting for the first event.'],
  live: LIVE_ROW,
  empty: LIVE_ROW,
  stalled: [DOTS.hollow, '', 'No transcript growth lately; it may be waiting on you.'],
  ended: [DOTS.good, 'Session ended · final numbers', ''],
  reconnecting: [DOTS.hollow, 'Connection lost · retrying', 'The page reconnects on its own.'],
  file: [DOTS.static, 'Watching via orangu watch', 'Rewritten on every change; reload to refresh.'],
  snapshot: [DOTS.static, 'Static snapshot', 'This file does not update; orangu watch follows the session live.'],
}

export function bannerFor(state: LiveState, row: SessionSummaryRow | undefined, a: Analysis | undefined): string {
  const turnRight = a ? `turn <b style="color:var(--ink1)">${a.summary.turns}</b>${state === 'ended' || state === 'snapshot' ? '' : ' in progress'}` : ''
  const [d, t, s] = BANNER[state]
  let title = t
  let sub = s
  if (state === 'live' || state === 'empty') title = row?.possiblyLive ? 'Watching · possibly live' : 'Watching a running session'
  else if (state === 'stalled') title = `Watching · quiet for ${Math.max(1, Math.round((row?.ageMs ?? 0) / 60000))}m`
  else if (state === 'ended') sub = row ? badgeCopy(row) : ''
  return `<div class="livebanner">${mascotBox(44)}<div class="grow"><div class="lt">${d}<span aria-live="polite">${esc(title)}</span></div><div class="ls">${esc(sub)}</div></div><div class="lr">${turnRight}</div></div>`
}

export function laneHtml(r: AgentStat, min: number, max: number): string {
  const bar =
    r.startTs !== undefined && isFinite(min)
      ? ganttRow(r.startTs, r.endTs ?? max, min, max || min + 1, catColor('agent'), `${r.agentType ?? r.name ?? r.agentId} · ${ms(r.durationMs)} · ${tok(r.totalTokens)} tokens`)
      : '<div class="small muted">no timing</div>'
  return `<div class="swimrow"><div class="alabel">${'· '.repeat(r.spawnDepth)}${esc(r.agentType || r.name || r.agentId.slice(0, 10))} <small>${esc(r.model ?? '')}</small></div><div${r.status === 'running' ? '' : ' class="dim"'}>${bar}</div></div>`
}

function agentsCard(a: Analysis): string {
  const runs = a.agents.runs
  if (!runs.length) return ''
  const running = runs.filter((r) => r.status === 'running')
  const min = Math.min(...runs.map((r) => r.startTs ?? Infinity).filter(isFinite))
  const max = Math.max(...runs.map((r) => r.endTs ?? -Infinity).filter(isFinite))
  const ordered = [...running, ...runs.filter((r) => r.status !== 'running')].slice(0, LANES)
  const more = runs.length > LANES ? `<div class="pagefoot"><button data-all-lanes="1">show all ${runs.length} agents</button></div>` : ''
  return `<div class="card pad mb18"><div class="card-title">Agents · ${running.length} running · ${runs.length - running.length} done</div><div class="agent-lanes">${ordered.map((r) => laneHtml(r, min, max)).join('')}</div>${more}</div>`
}

function sessionView(ctx: Ctx, row: SessionSummaryRow | undefined, a: Analysis | undefined): HTMLElement {
  const state = liveStateFor(ctx, row, a)
  const s = a?.summary
  const skel = !a
  const kpis = [
    kpi('Elapsed', s?.wallMs !== undefined ? ms(s.wallMs) : '–', '', { big: true, skeleton: skel }),
    kpi('Tokens so far', s ? tok(s.totalTokens) : '–', '', { big: true, accent: true, skeleton: skel }),
    kpi('Tool calls', s ? String(s.toolCalls) : '–', '', { big: true, skeleton: skel }),
    kpi('Cache hits', s ? pct(s.cacheHitRatio) : '–', '', { big: true, skeleton: skel }),
  ].join('')
  const c = a?.context
  const ctxPct = c?.contextWindow ? c.final / c.contextWindow : undefined
  const ctxCaption =
    state === 'ended' ? '–' : `${s?.compactions ?? 0} compaction${(s?.compactions ?? 0) === 1 ? '' : 's'} so far${ctxPct !== undefined && ctxPct >= 0.75 ? ' · compaction likely near 90%' : ''}`
  const ctxCard = `<div class="card pad mb18">
    <div class="ctxhead"><span>Context window</span><span class="mono">${ctxPct !== undefined ? esc(pct(ctxPct)) + ' of ' + esc(tok(c!.contextWindow!)) : c ? esc(tok(c.final)) : '–'}</span></div>
    <div class="ctxbar"><i style="width:${ctxPct !== undefined ? (ctxPct * 100).toFixed(1) : 0}%"></i></div>
    <div class="smt8">${esc(ctxCaption)}</div>
  </div>`
  const feedAll = a ? liveFeed(a, FEED_MAX + 1) : []
  const truncated = feedAll.length > FEED_MAX
  const rows = feedAll
    .slice(-FEED_MAX)
    .map(
      (f) =>
        `<div class="feedrow">${f.agentType ? '<span style="width:2px;align-self:stretch;background:var(--cat-agent);flex:none"></span>' : ''}<span class="ft">${esc(timeOnly(f.ts))}</span><span class="sw" style="background:${catColor(f.category)}"></span><span class="fn">${esc(f.name)}</span><span class="fw">${esc(f.summary)}</span><span class="fd">${f.durationMs !== undefined ? esc(ms(f.durationMs)) : ''}${f.isError ? ' · error' : ''}</span></div>`,
    )
    .join('')
  const emptyFeed =
    state === 'connecting' ? '<div class="feedrow muted">Waiting for the first event…</div>' : '<div class="feedrow muted">No tool calls yet.</div>'
  const footBits: string[] = []
  if (row) footBits.push(`streaming from …/${shortId(row.id)}.jsonl`)
  if (state === 'ended') footBits.push('transcript closed')
  if (truncated && a) footBits.push(`showing last ${FEED_MAX} of ${a.tools.calls.length + a.events.length + a.agents.runs.length} · full list in Timeline`)
  const endedBtn = state === 'ended' ? `<a class="btn-sm" href="#overview${row ? '?s=' + esc(row.id) : ''}" style="display:inline-block;margin-left:10px">Open Overview →</a>` : ''
  const feed = `<div class="feed" aria-live="off"><div class="card-head">Live feed</div>${rows || emptyFeed}<div class="feedfoot">${esc(footBits.join(' · '))}${endedBtn}</div></div>`
  const el = h(`<section>${bannerFor(state, row, a)}<div class="kpis k4">${kpis}</div>${ctxCard}${a ? agentsCard(a) : ''}${feed}</section>`)
  el.querySelector('[data-all-lanes]')?.addEventListener('click', (e) => {
    if (!a) return
    const lanes = el.querySelector('.agent-lanes')!
    lanes.classList.add('swimbox')
    const min = Math.min(...a.agents.runs.map((r) => r.startTs ?? Infinity).filter(isFinite))
    const max = Math.max(...a.agents.runs.map((r) => r.endTs ?? -Infinity).filter(isFinite))
    lanes.innerHTML = a.agents.runs.map((r) => laneHtml(r, min, max)).join('')
    ;(e.currentTarget as HTMLElement).parentElement?.remove()
  })
  return el
}

export function renderLive(ctx: Ctx): HTMLElement {
  const live = liveRows(ctx.data)
  const explicitS = /[?&]s=/.test(location.hash)
  // the fleet is serve-only: file mode carries one session, so the renderer lives in
  // serve-ui.ts (serve bundle) and reaches this shared screen through the window seam
  const fleet = typeof window !== 'undefined' ? window.__ORANGU_FLEET__ : undefined
  if (live.length > 1 && !explicitS && fleet) return fleet(ctx, live)
  const row = ctx.data.sessions.find((r) => r.id === (ctx.state.s ?? ctx.data.selectedId)) ?? ctx.data.sessions[0]
  if (!row) return h(`<section>${emptyHero({ title: 'No sessions discovered.', command: 'orangu serve' })}</section>`)
  return sessionView(ctx, row, ctx.a)
}
