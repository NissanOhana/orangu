/**
 * Suggest (§5): hero + scope chips + plan items. Each row is one finding with its severity dot, its
 * savings as a share of the session, the evidence, the fix, and the handoff explained as three steps:
 * copy the improve command → paste it in Claude Code in this workspace → the proposal appears under
 * Saved proposals. The report never launches a model process; copying a string queues nothing.
 * Rows per scope come from suggest-rows.ts (pure): session = this session's insights; repo/global =
 * the aggregate's crossFindings. Status chips prefer canonical v2 identity and retain v1 fallback.
 */
import type { Ctx } from '../app.js'
import type { SuggestionViewRecord } from '../../../model/app-data.js'
import type { SuggestionRecord, SuggestionStatus } from '../../../suggest/types.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../../../suggest/id.js'
import { CHANGE_CLASS_LABELS } from '../../../suggest/change-class-labels.js'
import { esc } from '../format.js'
import { h, wireCopyButtons } from '../dom.js'
import { chip } from '../components/chips.js'
import { commandBlock } from '../components/command.js'
import { emptyHero } from '../components/empty.js'
import { mascotBox } from '../components/mascot-box.js'
import { savingsShare } from '../derive.js'
import {
  PLUGIN_INSTALL,
  PROPOSAL_LIST_LIMIT,
  findingForRow,
  hasValidProposal,
  kickoffFailureMessage,
  planRows,
  recordForRow,
  savedProposalRecords,
  type PlanRow,
} from '../suggest-rows.js'
import { plainSentence } from '../strings.js'

type ChipState = Exclude<SuggestionStatus, 'kicked-off' | 'rejected'> | 'running' | 'dismissed'

const trustedVerification = (record: SuggestionViewRecord | undefined): boolean => record?.verificationTrusted === true

function chipState(s: SuggestionStatus | undefined): ChipState {
  return s === 'kicked-off' ? 'running' : s === 'rejected' ? 'dismissed' : s ?? 'new'
}

function statusChip(state: ChipState, title = '', trustedVerification = false): string {
  const trusted = state !== 'verified' || trustedVerification
  const label = trusted ? (state === 'verified' ? 'verified comparison' : state) : 'legacy unverified'
  return `<span class="status-chip" data-status="${trusted ? state : 'legacy'}" aria-live="polite"${title ? ` title="${esc(title)}"` : ''}>${label}${state === 'verified' && trusted ? ' ✓' : ''}</span>`
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 600)
}

function detail(label: string, value: unknown): string {
  const text = boundedText(value)
  return text ? `<div class="sg-pfield"><b>${label}.</b> ${esc(text)}</div>` : ''
}

function detailList(label: string, values: unknown, keys?: string[]): string {
  if (!Array.isArray(values)) return ''
  const shown = values.slice(0, PROPOSAL_LIST_LIMIT).map((value) => keys && value && typeof value === 'object'
    ? keys.map((key) => boundedText((value as Record<string, unknown>)[key])).filter(Boolean).join(' · ')
    : boundedText(value)).filter(Boolean)
  return shown.length ? `<div class="sg-pfield"><b>${label}.</b><ul>${shown.map((value) => `<li>${esc(value)}</li>`).join('')}${values.length > PROPOSAL_LIST_LIMIT ? `<li class="muted">+${values.length - PROPOSAL_LIST_LIMIT} more</li>` : ''}</ul></div>` : ''
}

function applyHandoffs(record: SuggestionRecord): string {
  const proposal = record.proposal
  if (
    record.scope === 'global' ||
    record.status !== 'proposed' ||
    proposal?.v !== 1 ||
    !boundedText(proposal.manifestPath) ||
    !boundedText(proposal.workspace?.cwd) ||
    !Array.isArray(proposal.files) ||
    proposal.files.length === 0
  ) return ''
  return `<div class="sg-handoffs" aria-label="Apply handoff"><div class="small muted">Copy only. Nothing runs here.</div><div class="sg-hand"><span>Claude</span>${commandBlock(`claude "/orangu:apply ${record.id}"`)}</div></div>`
}

function improveHandoffs(commands: { claude: string }): string {
  return `<div class="sg-handoffs"><div class="sg-hand"><span>Claude</span>${commandBlock(commands.claude)}</div></div>`
}

/** A change class is shown only where one exists: on the proposal that carries it. */
function proposalDetails(record: SuggestionViewRecord | undefined): string {
  if (!record || !hasValidProposal(record)) return ''
  const proposal = record.proposal
  const verification = record.verificationReceipt
  const trusted = trustedVerification(record)
  const lifecycle = verification?.v === 1 && trusted
    ? detail('Later evidence', verification.summary) + detailList('Computed comparisons', verification.checks, ['name', 'evidence'])
    : record.status === 'verified'
      ? detail('Legacy state', 'Not verified under the current deterministic contract.')
    : record.application?.v === 1 ? detail('Applied', record.application.summary) : ''
  return `<div class="sg-proposal"><div class="sg-phead"><span class="eyebrow">Proposal</span>${proposal.changeClass ? `<span class="pill">${esc(proposal.changeClass)}</span>` : ''}<span class="pill">effort ${esc(proposal.effort)}</span></div><div class="sg-ptitle">${esc(boundedText(proposal.title))}</div>${detail('Change', proposal.change)}${detail('Evidence', proposal.evidence)}${detail('Expected effect', proposal.expectedEffect)}${detail('Risk', proposal.risk)}${detail('Verification', proposal.verification)}${detailList('Reviewed comparisons', proposal.verificationChecks, ['metric', 'comparison'])}${detailList('Files', proposal.files)}${detailList('Sources', proposal.sources, ['kind', 'label', 'url', 'verifiedAt'])}${lifecycle}${applyHandoffs(record)}</div>`
}

function savedProposalItem(record: SuggestionViewRecord): string {
  return `<details class="saved-proposal" id="saved-${esc(record.id)}"><summary><span class="chev" aria-hidden="true">▸</span><b>${esc(boundedText(record.proposal?.title))}</b>${statusChip(chipState(record.status), '', trustedVerification(record))}</summary><div class="saved-proposal-body">${proposalDetails(record)}</div></details>`
}

/** Serve only: the inbox is the persisted store, so a file report never renders it, not even empty. */
function savedProposalInbox(records: SuggestionViewRecord[], mode: Ctx['data']['mode']): string {
  if (mode !== 'serve') return ''
  const body = records.length
    ? records.map(savedProposalItem).join('')
    : '<p class="small muted" style="margin:0">Nothing yet. A proposal drafted by /orangu:improve for this scope lands here.</p>'
  return `<section class="sg-inbox card pad mb16" aria-label="Saved proposals"><div class="sg-inbox-head"><div class="card-title">Saved proposals · ${records.length}</div><span class="eyebrow">Localhost only</span></div>${body}</section>`
}

/** Where the proposal shows up after step 2: in the inbox below (serve) or in orangu serve (file). */
function stepThree(mode: Ctx['data']['mode']): string {
  return mode === 'serve' ? 'The proposal appears below under Saved proposals.' : 'The proposal is saved under ~/.orangu; open orangu serve to review it.'
}

function planItem(ctx: Ctx, row: PlanRow, rank: number, sid: string, rec: SuggestionViewRecord | undefined): string {
  const aud = ctx.audience
  const share = savingsShare(row.savings, ctx.state.scope === undefined || ctx.state.scope === 'session' ? ctx.a?.summary.totalTokens : undefined, row.ruleId)
  const effort = rec?.proposal?.effort
  const state = chipState(rec?.status)
  const failure = kickoffFailureMessage(rec)
  const cwd = ctx.a?.session.cwd
  const examples = row.sessionIds
    .map((id) => (ctx.data.mode === 'serve' ? `<a class="exch" href="#overview?s=${esc(id)}">${esc(id.slice(0, 8))}</a>` : `<span class="exch">${esc(id.slice(0, 8))}</span>`))
    .join('')
  return `<details class="finding" data-sid="${esc(sid)}" data-rule="${esc(row.ruleId)}">
    <summary><span class="chev" aria-hidden="true">▸</span><span class="rank">${rank}</span>${row.severity ? `<span class="sev ${esc(row.severity)}" title="${esc(row.severity)}"></span>` : ''}<b class="sg-t">${esc(plainSentence(row.title, aud))}</b>${share ? `<span class="fsave sg-save" title="${esc(share.title)}">${esc(share.text)}</span>` : ''}${effort ? `<span class="pill">effort ${esc(effort)}</span>` : ''}</summary>
    <div class="fbody sg-body">
      <div class="sg-ev"><b>Evidence.</b> ${esc(plainSentence(row.detail, aud))} ${aud === 'plain' ? '' : `<span class="pill">${esc(row.ruleId)}</span>`}</div>
      ${row.recommendation ? `<div class="rec sg-fix"><b>Fix.</b> ${esc(plainSentence(row.recommendation, aud))}</div>` : ''}
      <div class="sg-ex"><span class="small muted">example sessions:</span>${examples}</div>
      ${proposalDetails(rec)}
      <div class="kickrow">
        <span class="mono115">handled by</span>
        <span class="pill">orangu:improve</span>
        ${statusChip(state, failure, trustedVerification(rec))}
      </div>
      <ol class="steps" aria-label="Hand off to Claude Code">
        <li><button type="button" class="btn-sm" data-kick-copy="${esc(sid)}">Copy improve command</button></li>
        <li>Paste it in Claude Code${cwd ? ` in <span class="mono">${esc(cwd)}</span>` : ''}.</li>
        <li>${stepThree(ctx.data.mode)}</li>
      </ol>
      <div class="kick-cmd sg-cmd">${ctx.data.mode === 'serve' && rec && !rec.proposal && state !== 'dismissed' ? improveHandoffs(kickoffCommands(rec, 'serve')) : ''}</div>
      <div class="kick-msg small muted" aria-live="polite">${esc(failure)}</div>
    </div>
  </details>`
}

export function renderSuggest(ctx: Ctx): HTMLElement {
  const a = ctx.a
  const scope = ctx.state.scope ?? 'session'
  const repoN = ctx.data.aggregates.repo?.sessionCount
  const globalN = ctx.data.aggregates.global?.sessionCount
  const scopeChips = [
    chip('This session', { active: scope === 'session', data: { scope: 'session' } }),
    chip(repoN !== undefined ? `Repo · ${repoN}` : 'Repo', { active: scope === 'repo', disabled: repoN === undefined, title: repoN === undefined ? 'run orangu serve' : '', data: { scope: 'repo' } }),
    chip(globalN !== undefined ? `Global · ${globalN}` : 'Global', { active: scope === 'global', disabled: globalN === undefined, title: globalN === undefined ? 'run orangu serve' : '', data: { scope: 'global' } }),
  ].join('')

  const agg = scope === 'session' ? undefined : ctx.data.aggregates[scope]
  const rows = planRows(scope, a, agg).map((row) => {
    const finding = findingForRow(row, scope)
    return { row, finding, sid: suggestionIdV2(suggestionKey(finding, 'report')) }
  })
  const bySid = new Map(rows.map((r) => [r.sid, r]))
  const boundRows = rows.map((row) => ({ ...row, record: recordForRow(ctx.data.suggestions, row.row, scope, row.sid) }))
  const mapped = boundRows.flatMap(({ record }) => record ? [record] : [])
  const activeSessionIds = agg?.sessions.map((session) => session.id) ?? []
  const saved = ctx.data.mode === 'serve'
    ? savedProposalRecords(ctx.data.suggestions, scope, a?.session.id ?? ctx.state.s ?? ctx.data.selectedId, activeSessionIds, mapped)
    : []
  const heroSub = plainSentence(
    scope === 'session'
      ? 'Diagnose one finding and draft one bounded proposal. Verify its evidence in a later run before calling it an improvement.'
      : scope === 'repo'
        ? 'Use recurring repo patterns for larger harness changes. Apply only after review; a fresh cohort comparison remains separate.'
        : 'Use recurring global patterns to draft larger harness proposals. Global suggestions are proposal-only.',
    ctx.audience,
  )

  const items = boundRows.length
    ? boundRows.map((r, i) => planItem(ctx, r.row, i + 1, r.sid, r.record)).join('')
    : emptyHero({ title: 'Nothing to improve was found', hint: 'Ran clean. Re-run after your next session.' })

  // the taxonomy is shown on demand, under the first-time note, never as a header before any proposal exists
  const types = CHANGE_CLASS_LABELS.map((label) => `<span class="sigchip">${esc(label)}</span>`).join('')
  const install = boundRows.length
    ? `<details class="card pad mb16 sg-install"><summary><span class="chev" aria-hidden="true">▸</span>First time? Install the orangu plugin in Claude Code</summary><div class="mt8">${commandBlock(PLUGIN_INSTALL, '>')}<p class="small muted" style="margin:8px 0 0">Two commands typed inside Claude Code, once. After that every improve command above works. A proposal changes exactly one of:</p><div class="chiprow mt8">${types}</div></div></details>`
    : ''
  const mega = scope === 'session' || !agg ? '' : (ctx.megaReview?.(scope) ?? '')

  const foot = scope === 'session'
    ? 'Local evidence and catalog matches stay deterministic. Optional AI drafts one bounded proposal. Only a later same-workspace session can verify its reviewed checks.'
    : scope === 'repo'
      ? 'Repo evidence and catalog matches stay deterministic. Applied means the reviewed files changed; it is not a cohort-wide verification.'
      : 'Global evidence and catalog matches stay deterministic. Global suggestions remain proposals and never receive an apply handoff.'

  const el = h(`<section>
    <div class="hero">
      ${mascotBox(48)}
      <div class="grow sg-hero"><div class="herotitle">Improvement plan</div><div class="sg-sub">${esc(heroSub)}</div></div>
    </div>
    <div class="chiprow">${scopeChips}</div>
    ${scope !== 'session' && !agg ? emptyHero({ title: 'This scope needs orangu serve', command: 'orangu serve' }) : items + install}
    ${savedProposalInbox(saved, ctx.data.mode)}
    ${mega}
    <p class="small muted sg-foot">${foot}</p>
  </section>`)

  el.querySelectorAll<HTMLElement>('[data-scope]').forEach((c) =>
    c.addEventListener('click', () => {
      if (c.getAttribute('aria-disabled') === 'true') return
      const s = c.dataset['scope'] as 'session' | 'repo' | 'global'
      ctx.go({ scope: s === 'session' ? undefined : s })
    }),
  )
  const cwd = a?.session.cwd
  const wireAction = (selector: string): void => {
    el.querySelectorAll<HTMLButtonElement>(selector).forEach((button) =>
      button.addEventListener('click', () => {
        const item = button.closest('details')!
        const message = item.querySelector<HTMLElement>('.kick-msg')!
        const sid = button.dataset['kickCopy']
        const row = sid ? bySid.get(sid) : undefined
        if (!row) return
        button.setAttribute('aria-busy', 'true')
        const request = { mode: 'copy' as const, suggestionId: sid, finding: row.finding }
        const action = ctx.ds.kickoff(request).then((result) =>
          result.ok
            ? { kind: 'copied' as const, message: `Claude command copied. Paste it in Claude Code${cwd ? ` in ${cwd}` : ''}.`, response: result.response }
            : { kind: 'error' as const, message: result.message, ...(result.response ? { response: result.response } : {}) },
        )
        void action.then((result) => {
          button.removeAttribute('aria-busy')
          // the aria-live line is the only confirmation: copying a string queues nothing, so no chip changes
          message.textContent = result.message
          if ('response' in result && result.response?.commands) {
            const box = item.querySelector<HTMLElement>('.kick-cmd')!
            box.innerHTML = improveHandoffs(result.response.commands)
            wireCopyButtons(box)
            if (result.kind === 'copied') box.querySelector<HTMLButtonElement>('[data-copy]')?.click()
          }
        })
      }),
    )
  }
  wireAction('[data-kick-copy]')
  return el
}
