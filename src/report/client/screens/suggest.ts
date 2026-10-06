/**
 * Improvements (§5): hero + scope chips + one explainer + plan items. Each card is one finding with its
 * severity dot, its savings as a share of the session and its improvement in the summary, so a reader
 * sees the change while the card is closed; the body holds the evidence, the examples and the copy
 * button. The explainer above the cards says once how to get an AI proposal: copy the command, paste it
 * in a terminal (it is a shell command that starts Claude Code), read the proposal where it lands. The
 * report never launches a model process; copying a string queues nothing.
 * Rows per scope come from suggest-rows.ts (pure): session = this session's insights; repo/global =
 * the aggregate's crossFindings. Status chips prefer canonical v2 identity and retain v1 fallback.
 */
import type { Ctx } from '../app.js'
import type { SuggestionViewRecord } from '../../../model/app-data.js'
import type { SuggestionStatus } from '../../../suggest/types.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../../../suggest/id.js'
import { CHANGE_CLASS_LABELS } from '../../../suggest/change-class-labels.js'
import { esc } from '../format.js'
import { h, wireCopyButtons } from '../dom.js'
import { chip } from '../components/chips.js'
import { cleanHash, fileScope } from '../nav.js'
import { commandBlock, installLines, pasteLine } from '../components/command.js'
import { emptyHero } from '../components/empty.js'
import { improvementLead } from '../components/finding.js'
import { mascotBox } from '../components/mascot-box.js'
import { savingsShare } from '../derive.js'
import {
  findingForRow,
  kickoffFailureMessage,
  planRows,
  recordForRow,
  type PlanRow,
} from '../suggest-rows.js'
import { plainSentence } from '../strings.js'

type ChipState = Exclude<SuggestionStatus, 'kicked-off' | 'rejected'> | 'running' | 'dismissed'

export const trustedVerification = (record: SuggestionViewRecord | undefined): boolean => record?.verificationTrusted === true

export function chipState(s: SuggestionStatus | undefined): ChipState {
  return s === 'kicked-off' ? 'running' : s === 'rejected' ? 'dismissed' : s ?? 'new'
}

export function statusChip(state: ChipState, title = '', trustedVerification = false): string {
  const trusted = state !== 'verified' || trustedVerification
  const label = trusted ? (state === 'verified' ? 'verified comparison' : state) : 'legacy unverified'
  return `<span class="status-chip" data-status="${trusted ? state : 'legacy'}" aria-live="polite"${title ? ` title="${esc(title)}"` : ''}>${label}${state === 'verified' && trusted ? ' ✓' : ''}</span>`
}

function improveHandoffs(commands: { claude: string }): string {
  return `<div class="sg-handoffs"><div class="sg-hand"><span>Claude</span>${commandBlock(commands.claude)}</div></div>`
}

/**
 * How to get an AI proposal, said once above the cards: each card keeps only its button, its status
 * and its message. Step 3 names where the proposal lands: the list below (serve) or the store (file).
 */
function explainer(paste: string, mode: Ctx['data']['mode']): string {
  return `<div class="card pad mb16"><div class="eyebrow">Get an AI proposal</div><ol class="steps">
<li><span>Open an improvement. Click <b>Copy the Claude Code command</b>.</span></li>
<li><div><span>${esc(paste)}</span>${installLines()}</div></li>
<li><span>Claude writes one proposal: the change, its effect, its risk and how to check it. It changes no file in your repository. ${mode === 'serve' ? 'The proposal shows below, in Saved proposals.' : 'The proposal is in ~/.orangu/proposals. Run orangu serve to see it here.'}</span></li>
</ol></div>`
}

function planItem(ctx: Ctx, row: PlanRow, rank: number, sid: string, rec: SuggestionViewRecord | undefined): string {
  const aud = ctx.audience
  const share = savingsShare(row.savings, ctx.state.scope === undefined || ctx.state.scope === 'session' ? ctx.a?.summary.totalTokens : undefined, row.ruleId)
  const effort = rec?.proposal?.effort
  const state = chipState(rec?.status)
  const failure = kickoffFailureMessage(rec)
  const examples = row.sessionIds
    .map((id) => (ctx.data.mode === 'serve' ? `<a class="exch" href="${esc(cleanHash(ctx.state, { screen: 'overview', s: id }))}">${esc(id.slice(0, 8))}</a>` : `<span class="exch">${esc(id.slice(0, 8))}</span>`))
    .join('')
  return `<details class="finding" data-sid="${esc(sid)}" data-rule="${esc(row.ruleId)}">
<summary><span class="chev" aria-hidden="true">▸</span><span class="rank">${rank}</span>${row.severity ? `<span class="sev ${esc(row.severity)}" title="${esc(row.severity)}"></span>` : ''}<b class="sg-t">${esc(plainSentence(row.title, aud))}</b>${share ? `<span class="fsave sg-save" title="${esc(share.title)}">${esc(share.text)}</span>` : ''}${effort ? `<span class="pill">effort ${esc(effort)}</span>` : ''}${improvementLead(row.recommendation, aud)}</summary>
<div class="fbody sg-body">
<div class="sg-ev"><b>Evidence:</b> ${esc(plainSentence(row.detail, aud))} ${aud === 'plain' ? '' : `<span class="pill">${esc(row.ruleId)}</span>`}</div>
<div class="sg-ex"><span class="small muted">Example sessions:</span>${examples}</div>
${ctx.proposals?.details(rec) ?? ''}
<div class="kickrow">
<button type="button" class="btn-primary" data-kick-copy="${esc(sid)}">Copy the Claude Code command</button>
${statusChip(state, failure, trustedVerification(rec))}
</div>
<div class="kick-cmd sg-cmd">${ctx.data.mode === 'serve' && rec && !rec.proposal && state !== 'dismissed' ? improveHandoffs(kickoffCommands(rec, 'serve')) : ''}</div>
<div class="kick-msg small muted" aria-live="polite">${esc(failure)}</div>
</div>
</details>`
}

export function renderSuggest(ctx: Ctx): HTMLElement {
  const a = ctx.a
  // No scope= in the hash: a file about a scope answers about that scope, not about a session it has
  // no record of. The session chip is then a dead end, so it says so rather than ignoring the click.
  const scope = ctx.state.scope ?? fileScope(ctx.data) ?? 'session'
  const repoN = ctx.data.aggregates.repo?.sessionCount
  const globalN = ctx.data.aggregates.global?.sessionCount
  const scopeChips = [
    chip('This session', { active: scope === 'session', disabled: !a, title: a ? '' : 'no session is selected', data: { scope: 'session' } }),
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
  const heroSub = plainSentence(
    scope === 'session'
      ? 'Each improvement below comes from the evidence in this session.'
      : scope === 'repo'
        ? 'These patterns recur across this repository. Review each proposal before you apply it.'
        : 'These patterns recur across this machine. Global proposals are for review only.',
    ctx.audience,
  )
  // the command is a shell command that starts Claude Code; the explainer and the copy message share the line
  const paste = pasteLine(a?.session.cwd, scope === 'repo')

  const items = boundRows.length
    ? explainer(paste, ctx.data.mode) + boundRows.map((r, i) => planItem(ctx, r.row, i + 1, r.sid, r.record)).join('')
    : emptyHero({ title: 'No improvements found', hint: 'The rules found nothing to change. Look again after your next session.' })

  // The taxonomy is explanatory copy under a collapsed note, never a status chip and never a header
  // before a proposal exists; the class a proposal actually got shows on the proposal itself. It stays
  // in the app (test/plugin.test.ts pins one taxonomy shared by catalog, plugin and app). The one-time
  // plugin install lives in step 2 of the explainer above the cards, where the CLI prints it too.
  const types = CHANGE_CLASS_LABELS.map((label) => `<span class="sigchip">${esc(label)}</span>`).join('')
  const install = boundRows.length
    ? `<details class="card pad mb16 sg-note"><summary><span class="chev" aria-hidden="true">▸</span>What a proposal can change</summary><div class="chiprow mt8">${types}</div></details>`
    : ''
  const mega = scope === 'session' || !agg ? '' : (ctx.megaReview?.(scope) ?? '')

  // User-facing nouns only (session · finding · evidence · proposal · apply · verify); no internal vocabulary.
  const foot = 'orangu measures the evidence. Claude writes the proposal only when you run the command. ' + (scope === 'session'
    ? 'Only later sessions in the same workspace can verify it.'
    : scope === 'repo'
      ? 'Applied means that the reviewed files changed. Only later sessions can verify it.'
      : 'Global proposals stay proposals. Claude applies nothing from here.')

  const el = h(`<section>
<div class="hero">
${mascotBox(48)}
<div class="grow sg-hero herotitle">${esc(heroSub)}</div>
</div>
<div class="chiprow">${scopeChips}</div>
${mega}
${scope !== 'session' && !agg ? emptyHero({ title: 'This scope needs orangu serve', command: 'orangu serve' }) : items + install}
${ctx.proposals?.inbox(ctx, scope, activeSessionIds, mapped) ?? ''}
<p class="small muted sg-foot">${foot}</p>
</section>`)

  el.querySelectorAll<HTMLElement>('[data-scope]').forEach((c) =>
    c.addEventListener('click', () => {
      if (c.getAttribute('aria-disabled') === 'true') return
      const s = c.dataset['scope'] as 'session' | 'repo' | 'global'
      ctx.go({ scope: s === 'session' ? undefined : s })
    }),
  )
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
            ? { kind: 'copied' as const, message: `The command is on your clipboard. ${paste}`, response: result.response }
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
