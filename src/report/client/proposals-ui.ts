/**
 * Serve only: the stored proposal on its plan row and in the improvement home, and the inbox seam that draws the home
 * (home-ui.ts). A file report always embeds `suggestions: []` (render.ts), so neither can render from a file.
 * serve-ui.ts injects this module through the optional ServeUi.proposals seam, the way the whole-harness block reaches
 * the screen through Ctx.megaReview, so its bytes stay out of CLIENT_JS and CLIENT_JS_AGG. The screen, the aggregate
 * seam and both file entries never import it (test/lint.test.ts).
 */
import type { ProposalsUi } from './app.js'
import type { SuggestionViewRecord } from '../../model/app-data.js'
import type { SuggestionProposal, SuggestionRecord } from '../../suggest/types.js'
import { esc } from './format.js'
import { commandBlock } from './components/command.js'
import { trustedVerification } from './screens/suggest.js'
import { homeSections } from './home-ui.js'
import { STATUS_LABELS, changeClassLabel } from './status-labels.js'

export const PROPOSAL_LIST_LIMIT = 6

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Runtime guard for append-only records: legacy proposals omit v and structured fields. */
export function hasValidProposal(record: SuggestionRecord): record is SuggestionRecord & { proposal: SuggestionProposal } {
  const p = record.proposal as unknown as Record<string, unknown> | undefined
  return !!p && /^sg_[0-9a-f]{12}$/.test(record.id) && Array.isArray(record.sessionIds) && record.sessionIds.length > 0 && record.sessionIds.every(nonEmptyString) &&
    nonEmptyString(p['title']) && nonEmptyString(p['change']) && /^[SML]$/.test(String(p['effort'])) && nonEmptyString(p['proposalPath']) && (p['v'] ?? 1) === 1
}

/** A stored field, whole: the manifest loader bounds each field (src/suggest/artifacts.ts), so the block cuts none. */
function fieldText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function detail(label: string, value: unknown): string {
  const text = fieldText(value)
  return text ? `<div class="sg-pfield"><b>${label}.</b> ${esc(text)}</div>` : ''
}

const itemList = (items: string[]): string => `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`

/**
 * The first PROPOSAL_LIST_LIMIT items show, and the rest wait in a closed disclosure that says how many: the
 * "more" disclosure of screens/context.ts with the "N of M" line of the Timeline. Its id keys the app's re-render
 * seam (details[id]), so an open list stays open after an SSE tick.
 */
function detailList(prefix: string, label: string, values: unknown, keys?: string[]): string {
  if (!Array.isArray(values)) return ''
  const items = values.map((value) => keys && value && typeof value === 'object'
    ? keys.map((key) => fieldText((value as Record<string, unknown>)[key])).filter(Boolean).join(' · ')
    : fieldText(value)).filter(Boolean)
  if (!items.length) return ''
  const total = items.length
  // after the splice, items holds the first PROPOSAL_LIST_LIMIT and rest holds the others: none is dropped
  const rest = items.splice(PROPOSAL_LIST_LIMIT)
  const name = label.toLowerCase()
  const more = rest.length
    ? `<details class="sg-more" id="more-${esc(prefix)}-${name.replace(/ /g, '-')}"><summary><span class="chev" aria-hidden="true">▸</span>${items.length} of ${total} ${name} show above. Show ${rest.length} more.</summary>${itemList(rest)}</details>`
    : ''
  return `<div class="sg-pfield"><b>${label}.</b>${itemList(items)}${more}</div>`
}

function applyHandoffs(record: SuggestionRecord): string {
  const proposal = record.proposal
  if (
    record.scope === 'global' ||
    record.status !== 'proposed' ||
    proposal?.v !== 1 ||
    !fieldText(proposal.manifestPath) ||
    !fieldText(proposal.workspace?.cwd) ||
    !Array.isArray(proposal.files) ||
    proposal.files.length === 0
  ) return ''
  return `<div class="sg-handoffs" aria-label="Apply handoff"><div class="small muted">Copy only. Nothing runs here.</div><div class="sg-hand"><span>Claude</span>${commandBlock(`claude "/orangu:apply ${record.id}"`)}</div></div>`
}

/**
 * The stored proposal block. A change class is shown only where one exists: on the proposal that carries it, by its
 * label. `key` keys the list disclosures, so the same record in the home and on a Findings row gets 2 sets of ids.
 * `handoffs: false` leaves out the apply handoff, for a home row that shows its own next step.
 */
export function proposalDetails(record: SuggestionViewRecord | undefined, key = record?.id ?? '', handoffs = true): string {
  if (!record || !hasValidProposal(record)) return ''
  const proposal = record.proposal
  const verification = record.verificationReceipt
  const trusted = trustedVerification(record)
  // Trust is computed server-side for either receipt version; both carry a summary and graded checks.
  const lifecycle = trusted && verification
    ? detail('Later evidence', verification.summary) + detailList(key, 'Computed comparisons', verification.checks, ['name', 'evidence'])
    : record.status === 'verified'
      ? detail('Legacy state', 'Not verified under the current deterministic contract.')
    : record.application?.v === 1 ? detail('Applied', record.application.summary) : ''
  return `<div class="sg-proposal"><div class="sg-phead"><span class="eyebrow">Proposal</span>${proposal.changeClass ? `<span class="pill">${esc(changeClassLabel(proposal.changeClass))}</span>` : ''}<span class="pill">effort ${esc(proposal.effort)}</span></div><div class="sg-ptitle">${esc(fieldText(proposal.title))}</div>${detail('Status', STATUS_LABELS[record.status])}${detail('Change', proposal.change)}${detail('Evidence', proposal.evidence)}${detail('Expected effect', proposal.expectedEffect)}${detail('Risk', proposal.risk)}${detail('Verification', proposal.verification)}${detailList(key, 'Reviewed comparisons', proposal.verificationChecks, ['metric', 'comparison'])}${detailList(key, 'Files', proposal.files)}${detailList(key, 'Sources', proposal.sources, ['kind', 'label', 'url', 'verifiedAt'])}${lifecycle}${handoffs ? applyHandoffs(record) : ''}</div>`
}

export const proposalsUi: ProposalsUi = { details: proposalDetails, inbox: homeSections }
