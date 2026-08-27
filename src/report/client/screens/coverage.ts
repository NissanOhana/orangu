/** Coverage (Detailed-only panel, policy/policy): reconciliation, unknown types, hooks/skills, raw explorer, about. */
import type { Ctx } from '../app.js'
import { STRIPPED_KEY } from '../../../model/app-data.js'
import { CAT_LABEL, esc, ms, num, ts } from '../format.js'
import { h } from '../dom.js'
import { emptyHero } from '../components/empty.js'
import { banner } from '../components/banner.js'

export function renderCoverage(ctx: Ctx): HTMLElement {
  const a = ctx.a
  if (!a) return h(`<section>${emptyHero({ title: 'No session selected.' })}</section>`)
  const p = a.parse
  const rec = p.reconciliation
  const unknownEntries = Object.entries(p.unknownRecordTypes).filter(([k]) => k !== STRIPPED_KEY)
  const hiddenByRedaction = p.unknownRecordTypes[STRIPPED_KEY] ?? 0
  const unknown = unknownEntries.length
  const hiddenNote = hiddenByRedaction
    ? `<div class="small muted">${hiddenByRedaction} unrecognized record${hiddenByRedaction === 1 ? '' : 's'} were counted; their type names are hidden by redaction. Re-run with --include-text to see them.</div>`
    : ''
  const skillRows = a.skills.byName.length
    ? `<div class="card pad mt16"><div class="card-title">Skills &amp; commands used</div><div class="pill-row">${a.skills.byName
        .map((s) => `<span class="sigchip">${esc(s.name)} <span class="muted">×${s.count} ${esc(s.via.join('/'))}</span></span>`)
        .join('')}</div></div>`
    : ''
  const hooks = a.hooks.runs
    ? `<div class="card pad mt16"><div class="card-title">Hooks</div><p class="small muted" style="margin:0">${a.hooks.runs} hook runs · ${a.hooks.errors} errors · ${esc(ms(a.hooks.totalMs))} total</p></div>`
    : ''
  const el = h(`<section>
    ${banner(rec.ok ? 'info' : 'warn', `<strong>Parse coverage:</strong>&nbsp;${esc(num(p.totalLines))} records, ${p.badLines} unreadable, ${unknown} unrecognized record type${unknown === 1 ? '' : 's'}${hiddenByRedaction ? ` (+${hiddenByRedaction} record${hiddenByRedaction === 1 ? '' : 's'} with redacted type names)` : ''}. Token totals reconcile to within ${esc(rec.matchesWithinPct.toFixed(2))}% ${rec.ok ? '✓' : '(review)'}.`)}
    <div class="two-up">
      <div class="card pad"><div class="card-title">Session</div>
        <table class="grid"><tbody>
          <tr><td>ID</td><td class="mono small">${esc(a.session.id)}</td></tr>
          <tr><td>Source</td><td>${esc(a.session.source)}</td></tr>
          <tr><td>Project</td><td class="mono small">${esc(a.session.cwd ?? a.session.projectSlug ?? '–')}</td></tr>
          <tr><td>Started</td><td>${esc(ts(a.session.startedAt))}</td></tr>
          <tr><td>Client</td><td>${esc(a.session.clientVersions.join(', '))}</td></tr>
          <tr><td>Models</td><td>${a.session.models.map((m) => esc(m.displayName) + (m.estimatedMatch ? ' ~' : '')).join(', ')}</td></tr>
          <tr><td>Branches</td><td class="mono small">${esc(a.session.gitBranches.join(', ') || '–')}</td></tr>
          <tr><td>Generated</td><td>orangu v${esc(a.generator.version)} · model catalog ${esc(a.generator.modelCatalogUpdatedAt)}</td></tr>
        </tbody></table>
      </div>
      <div class="card pad"><div class="card-title">How to read the numbers</div>
        <ul class="small" style="padding-left:18px;line-height:1.7;margin:0">
          <li><strong>Tokens are the only usage metric</strong> orangu reports. They are what the transcript records.</li>
          <li>Token usage is <strong>deduplicated by message id</strong>.</li>
          <li>Context = fresh input + cache read + cache write.</li>
          <li>~ marks a model matched by family fallback: the name is approximate, the token counts are not.</li>
          <li>No LLM produced any number here; zero network calls.</li>
        </ul>
      </div>
    </div>
    ${unknown || hiddenByRedaction ? `<div class="card pad mt16"><div class="card-title">Unrecognized records (counted, not dropped)</div>${unknown ? `<div class="pill-row">${unknownEntries.map(([k, v]) => `<span class="pill">${esc(k)} ×${v}</span>`).join('')}</div>` : ''}${hiddenNote}</div>` : ''}
    ${skillRows}
    ${hooks}
    <div class="card pad mt16">
      <div class="card-title">Raw explorer</div>
      <div class="raw-filter no-print">
        <input type="text" id="raw-q" placeholder="filter by text…" aria-label="filter calls by text" />
        <select id="raw-cat" aria-label="filter by category"><option value="">all categories</option>${Object.keys(CAT_LABEL).map((c) => `<option value="${esc(c)}">${esc(CAT_LABEL[c]!)}</option>`).join('')}</select>
        <label class="small"><input type="checkbox" id="raw-err" /> errors only</label>
        <span class="small muted" id="raw-count"></span>
      </div>
      <div id="raw-list" style="max-height:480px;overflow:auto;border-top:1px solid var(--border)"></div>
    </div>
  </section>`)
  const listEl = el.querySelector('#raw-list') as HTMLElement
  const countEl = el.querySelector('#raw-count') as HTMLElement
  const draw = (): void => {
    const q = (el.querySelector('#raw-q') as HTMLInputElement).value.toLowerCase()
    const cat = (el.querySelector('#raw-cat') as HTMLSelectElement).value
    const errOnly = (el.querySelector('#raw-err') as HTMLInputElement).checked
    const rows = a.tools.calls.filter((c) => (!cat || c.category === cat) && (!errOnly || c.isError) && (!q || c.summary.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)))
    countEl.textContent = rows.length + ' of ' + a.tools.calls.length + ' calls'
    listEl.innerHTML =
      rows
        .slice(0, 2000)
        .map(
          (c) =>
            `<div class="rawrow"><span class="rt">${esc(c.name)}</span><span class="muted">#${c.turnIndex}${c.agentId ? ' agent' : ''}${c.isError ? ' ⚠' : ''}</span><span class="rp">${esc(c.summary)}${c.durationMs !== undefined ? ' · ' + esc(ms(c.durationMs)) : ''}</span></div>`,
        )
        .join('') + (rows.length > 2000 ? `<div class="rawrow muted">…${rows.length - 2000} more (narrow the filter)</div>` : '')
    if (!rows.length) listEl.innerHTML = '<div class="rawrow muted">no calls match</div>'
  }
  el.querySelector('#raw-q')!.addEventListener('input', draw)
  el.querySelector('#raw-cat')!.addEventListener('change', draw)
  el.querySelector('#raw-err')!.addEventListener('change', draw)
  draw()
  return el
}
