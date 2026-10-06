/**
 * Harness (serve-only, A8): what the Claude Code configuration DECLARES against what the sessions
 * on this machine actually DID, from the HarnessReport the server computes (src/harness). Tokens
 * only, by rule. Lives in the SERVE bundle: imported from serve-ui.ts, never from app.ts, so its
 * bytes do not count against the file-mode ratchet. The report carries counts and a status per
 * row, never a recommendation; the recommendation is the `/orangu:harness` skill's job.
 */
import type { Ctx } from '../app.js'
import type { HarnessReport } from '../../../harness/types.js'
import { esc, num, tok } from '../format.js'
import { h } from '../dom.js'
import { commandBlock } from '../components/command.js'
import { emptyHero } from '../components/empty.js'
import { mascotBox } from '../components/mascot-box.js'
import { harnessCommand } from '../suggest-rows.js'

const NAMES = 12

const nothingDeclared = (r: HarnessReport): boolean => {
  const i = r.inventory
  return !i.settings.length && !i.skills.length && !i.agents.length && !i.plugins.length && !i.mcpServers.length && !i.claudeMd.length
}

/** The single most actionable line: idle skills (a count, not an estimate), then the injected-listing weight. */
export function harnessLead(r: HarnessReport): { title: string; sub: string } {
  const x = r.crosswalk
  // the full-population count, not the rows: the 50-row cap cuts idle rows first
  const idle = x.counts.skills.idle
  const skills = r.inventory.totals.skills
  const title = skills ? (idle ? `${idle} of ${skills} skills never fired` : `every one of ${skills} skills fired`) : 'no skills installed'
  const listing = [...x.injectedListings].sort((a, b) => b.approxTokensPerMainSession - a.approxTokensPerMainSession)[0]
  const sub = listing ? `${listing.type} ≈${num(listing.approxTokensPerMainSession)} tokens per session in the main context` : `${num(r.scope.sessionsScanned)} sessions scanned`
  return { title, sub }
}

function names(list: string[]): string {
  if (!list.length) return ''
  const shown = list.slice(0, NAMES).map((n) => `<span class="pill">${esc(n)}</span>`).join('')
  return `<div class="pill-row">${shown}${list.length > NAMES ? `<span class="small muted">+${list.length - NAMES} more</span>` : ''}</div>`
}

/** `never` is the idle phrase ("skills never fired"); `did` the positive one ("skills fired"). `count` is the full-population idle count; `idle` the names the capped rows carry. */
function idleCard(title: string, idle: string[], count: number, total: number, never: string, did: string): string {
  const body = total
    ? count
      ? `<div class="aval">${count}<span class="anote"> of ${total} ${never}</span></div>${names(idle)}`
      : `<p class="small" style="color:var(--good);margin:0">Every one of ${total} ${did}.</p>`
    : `<p class="small muted" style="margin:0">The config that orangu read declares none.</p>`
  return `<div class="card pad"><div class="card-title">${title}</div>${body}</div>`
}

/**
 * The Overview card (serve): one line, linking to #harness. `href` carries the current route (the ?s= key).
 * `undefined` = the report is still computing (designed loading state, never a blank slot); `null` = it
 * could not be computed (the degraded state the #harness screen shows, one line).
 */
export function harnessCardHtml(r: HarnessReport | null | undefined, href: string): string {
  const lead =
    r === undefined
      ? { title: 'Comparing what your config declares with what these sessions used…', sub: 'a cold cache takes a moment' }
      : r === null
        ? { title: 'orangu could not compute the harness report.', sub: 'orangu harness prints the reason' }
        : nothingDeclared(r)
          ? { title: 'orangu found no harness config under the scanned roots', sub: 'settings.json · skills/ · agents/ · plugins/ · .mcp.json · CLAUDE.md' }
          : harnessLead(r)
  return `<a class="card pad mb16 harness-card" href="${esc(href)}"${r === undefined ? ' aria-busy="true"' : ''}><div class="eyebrow">Harness</div><div class="card-title" style="margin:2px 0">${esc(lead.title)}</div><div class="small muted">${esc(lead.sub)} · open the harness view →</div></a>`
}

export function renderHarness(ctx: Ctx, r: HarnessReport | null): HTMLElement {
  if (!r) return h(`<section>${emptyHero({ title: 'orangu could not compute the harness report.', hint: 'Run the command directly to see the reason.', command: 'orangu harness' })}</section>`)
  if (nothingDeclared(r))
    return h(`<section>${emptyHero({ title: 'orangu found no harness config under the scanned roots.', hint: `orangu looked for settings.json · skills/ · agents/ · plugins/ · .mcp.json · CLAUDE.md under ${r.scope.roots.join(', ')}. It found nothing to compare.`, command: 'orangu harness' })}</section>`)
  const x = r.crosswalk
  const inv = r.inventory
  const lead = harnessLead(r)
  const idleSkills = x.skills.filter((s) => s.status === 'idle').map((s) => s.name)
  const idleMcp = x.mcpServers.filter((m) => m.status === 'idle').map((m) => m.name)
  const idleAgents = x.agents.filter((a) => a.status === 'idle').map((a) => a.name)
  // the same four row kinds the notes count, and the count from the full population
  const undeclared = [
    ...x.skills.filter((s) => s.status === 'undeclared').map((s) => 'skill ' + s.name),
    ...x.mcpServers.filter((m) => m.status === 'undeclared').map((m) => 'mcp ' + m.name),
    ...x.agents.filter((a) => a.status === 'undeclared').map((a) => 'agent ' + a.name),
    ...x.hooks.filter((h) => h.status === 'undeclared').map((h) => 'hook ' + (h.commandBasename ?? h.event)),
  ]
  const undeclaredCount = x.counts.skills.undeclared + x.counts.mcpServers.undeclared + x.counts.agents.undeclared + x.counts.hooks.undeclared
  const listings = x.injectedListings.length
    ? `<div class="scroll-x"><table class="grid"><thead><tr><th>Listing</th><th class="num">≈ tokens / session</th><th class="num">Sessions</th><th class="num">≈ tokens / injection<br><span class="small muted">anywhere in the tree</span></th><th class="num">Subagents ≈ tokens</th><th class="num">Subagent sessions</th></tr></thead><tbody>${[...x.injectedListings]
        .sort((a, b) => b.approxTokensPerMainSession - a.approxTokensPerMainSession)
        .map((l) => `<tr><td class="mono">${esc(l.type)}</td><td class="num">${esc(num(l.approxTokensPerMainSession))}</td><td class="num">${l.main.sessions}</td><td class="num">${esc(num(l.approxTokensPerInjection))}</td><td class="num">${esc(num(l.subagent.approxTokens))}</td><td class="num">${l.subagent.sessions}</td></tr>`)
        .join('')}</tbody></table></div><div class="smt8">Each ≈ tokens figure is the recurring context weight, in bytes ÷ 4. The per-session column counts the primary transcript of each session that carried the listing. The subagent columns show what the agent tree carried, over the sessions that had subagents.</div>`
    : `<p class="small muted" style="margin:0">orangu measured no injected listings in these sessions.</p>`
  const carried = x.claudeMd.reduce((s, c) => s + c.approxTokensCarried, 0)
  const memory = inv.claudeMd.length
    ? `<div class="aval">≈${esc(tok(inv.totals.claudeMdApproxTokens))}<span class="anote"> tokens in ${inv.claudeMd.length} file${inv.claudeMd.length === 1 ? '' : 's'} · ≈${esc(tok(carried))} carried across the window</span></div>${names(inv.claudeMd.map((f) => f.file))}`
    : `<p class="small muted" style="margin:0">The scanned roots hold no CLAUDE.md.</p>`
  const notes = r.notes.length ? `<div class="card pad mb16" style="background:var(--bg2)"><div class="card-title">Notes</div><ul class="small muted" style="margin:0;padding-left:18px">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''
  const scope = r.scope.global ? `global · ${r.scope.roots.length} root${r.scope.roots.length === 1 ? '' : 's'}` : `repo ${r.scope.cwd}`
  return h(`<section>
<div class="hero">
${mascotBox(48)}
<div class="grow"><div class="eyebrow">Declared vs used</div><div class="herotitle">${esc(lead.title)}</div><div class="sg-sub">${esc(lead.sub)} · ${esc(scope)} · ${num(r.scope.sessionsScanned)} sessions scanned</div></div>
</div>
<div class="kpis">
${idleCard('Idle skills', idleSkills, x.counts.skills.idle, inv.totals.skills, 'skills never fired', 'skills fired')}
${idleCard('Idle MCP servers', idleMcp, x.counts.mcpServers.idle, inv.totals.mcpServers, 'servers never called', 'servers was called')}
${idleCard('Agents never dispatched', idleAgents, x.counts.agents.idle, inv.totals.agents, 'agents never dispatched', 'agents was dispatched')}
</div>
<div class="card pad mb16"><div class="card-title">Injected listings · per session</div>${listings}</div>
<div class="two-up">
<div class="card pad"><div class="card-title">CLAUDE.md</div>${memory}</div>
<div class="card pad"><div class="card-title">Undeclared · ${undeclaredCount}</div>${undeclaredCount ? `<p class="small muted" style="margin:0 0 8px">The sessions used these, but the config that orangu read does not declare them. They come from a source outside this scope, or the config drifted.</p>${names(undeclared)}` : '<p class="small muted" style="margin:0">The config that orangu read declares everything that the sessions used.</p>'}</div>
</div>
<div class="card pad mb16"><div class="eyebrow">Whole-harness review</div><div class="card-title">Turn this into proposals in Claude Code.</div>${commandBlock(harnessCommand(r.scope.global ? 'global' : 'repo'))}<div class="smt8">This button only copies text. Nothing runs here. <span class="mono">orangu harness --json</span> prints this report.</div></div>
${notes}
</section>`)
}
