/**
 * Serve only: the stored proposal on its plan row and the Saved proposals inbox. A file report always
 * embeds `suggestions: []` (render.ts), so neither can render from a file. serve-ui.ts injects this
 * module through the optional ServeUi.proposals seam, the way the whole-harness block reaches the
 * screen through Ctx.megaReview, so its bytes stay out of CLIENT_JS and CLIENT_JS_AGG. The screen, the
 * aggregate seam and both file entries never import it (test/lint.test.ts).
 */
import type { Ctx, ProposalsUi } from './app.js'
import type { SuggestionViewRecord } from '../../model/app-data.js'
import type { SuggestionProposal, SuggestionRecord, SuggestionScope } from '../../suggest/types.js'
import { esc } from './format.js'
import { commandBlock } from './components/command.js'
import { chipState, statusChip, trustedVerification } from './screens/suggest.js'

export const SAVED_PROPOSAL_LIMIT = 12
export const PROPOSAL_LIST_LIMIT = 6

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Runtime guard for append-only records: legacy proposals omit v and structured fields. */
export function hasValidProposal(record: SuggestionRecord): record is SuggestionRecord & { proposal: SuggestionProposal } {
  const p = record.proposal as unknown as Record<string, unknown> | undefined
  return !!p && /^sg_[0-9a-f]{12}$/.test(record.id) && Array.isArray(record.sessionIds) && record.sessionIds.length > 0 && record.sessionIds.every(nonEmptyString) &&
    nonEmptyString(p['title']) && nonEmptyString(p['change']) && /^[SML]$/.test(String(p['effort'])) && nonEmptyString(p['proposalPath']) && (p['v'] ?? 1) === 1
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

/** A change class is shown only where one exists: on the proposal that carries it. */
function proposalDetails(record: SuggestionViewRecord | undefined): string {
  if (!record || !hasValidProposal(record)) return ''
  const proposal = record.proposal
  const verification = record.verificationReceipt
  const trusted = trustedVerification(record)
  // Trust is computed server-side for either receipt version; both carry a summary and graded checks.
  const lifecycle = trusted && verification
    ? detail('Later evidence', verification.summary) + detailList('Computed comparisons', verification.checks, ['name', 'evidence'])
    : record.status === 'verified'
      ? detail('Legacy state', 'Not verified under the current deterministic contract.')
    : record.application?.v === 1 ? detail('Applied', record.application.summary) : ''
  return `<div class="sg-proposal"><div class="sg-phead"><span class="eyebrow">Proposal</span>${proposal.changeClass ? `<span class="pill">${esc(proposal.changeClass)}</span>` : ''}<span class="pill">effort ${esc(proposal.effort)}</span></div><div class="sg-ptitle">${esc(boundedText(proposal.title))}</div>${detail('Change', proposal.change)}${detail('Evidence', proposal.evidence)}${detail('Expected effect', proposal.expectedEffect)}${detail('Risk', proposal.risk)}${detail('Verification', proposal.verification)}${detailList('Reviewed comparisons', proposal.verificationChecks, ['metric', 'comparison'])}${detailList('Files', proposal.files)}${detailList('Sources', proposal.sources, ['kind', 'label', 'url', 'verifiedAt'])}${lifecycle}${applyHandoffs(record)}</div>`
}

function savedProposalItem(record: SuggestionViewRecord): string {
  return `<details class="saved-proposal" id="saved-${esc(record.id)}"><summary><span class="chev" aria-hidden="true">▸</span><b>${esc(boundedText(record.proposal?.title))}</b>${statusChip(chipState(record.status), '', trustedVerification(record))}</summary><div class="saved-proposal-body">${proposalDetails(record)}</div></details>`
}

function identityKeys(record: SuggestionRecord): string[] {
  return [record.id, ...(Array.isArray(record.legacyIds) ? record.legacyIds : []), record.proposal?.proposalPath].filter(nonEmptyString)
}

/**
 * Serve-only inbox selection. Session scope is exact; aggregate scopes require evidence overlap.
 * Mapped rows and migrated/path duplicates are removed before the hard display cap.
 */
export function savedProposalRecords<T extends SuggestionRecord>(
  records: T[],
  scope: SuggestionScope,
  selectedSessionId: string | undefined,
  aggregateSessionIds: string[],
  mappedRecords: T[],
): T[] {
  const activeIds = new Set(scope === 'session' ? (selectedSessionId ? [selectedSessionId] : []) : aggregateSessionIds)
  if (!activeIds.size) return []
  const seen = new Set(mappedRecords.flatMap(identityKeys))
  const result: T[] = []
  const newest = [...records].sort((a, b) => b.statusAt - a.statusAt)
  for (const record of newest) {
    if (record.scope !== scope || !hasValidProposal(record) || !record.sessionIds.some((id) => activeIds.has(id))) continue
    const keys = identityKeys(record)
    if (keys.some((key) => seen.has(key))) continue
    keys.forEach((key) => seen.add(key))
    result.push(record)
    if (result.length === SAVED_PROPOSAL_LIMIT) break
  }
  return result
}

/** Serve only: the inbox is the persisted store, so a file report never renders it, not even empty. */
function savedProposalInbox(records: SuggestionViewRecord[], mode: Ctx['data']['mode']): string {
  if (mode !== 'serve') return ''
  const body = records.length
    ? records.map(savedProposalItem).join('')
    : '<p class="small muted" style="margin:0">Nothing yet. A proposal drafted by /orangu:improve for this scope lands here.</p>'
  return `<section class="sg-inbox card pad mb16" aria-label="Saved proposals"><div class="sg-inbox-head"><div class="card-title">Saved proposals · ${records.length}</div><span class="eyebrow">Localhost only</span></div>${body}</section>`
}

function inbox(ctx: Ctx, scope: SuggestionScope, aggregateSessionIds: string[], mapped: SuggestionViewRecord[]): string {
  const saved = ctx.data.mode === 'serve'
    ? savedProposalRecords(ctx.data.suggestions, scope, ctx.a?.session.id ?? ctx.state.s ?? ctx.data.selectedId, aggregateSessionIds, mapped)
    : []
  return savedProposalInbox(saved, ctx.data.mode)
}

export const proposalsUi: ProposalsUi = { details: proposalDetails, inbox }
