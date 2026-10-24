/**
 * Serve only: the Queue section of the improvement home. Every open record of this workspace, in the 6 groups of the
 * queue read, each row with its next step to copy, or with no step when nothing can run yet. Only the home frame
 * (home-ui.ts) imports this file, so the file bundles carry none of it.
 *
 * The client computes no group, no verdict and no "due". Each of them, each count and each next step comes from the
 * queue read of the server. The row reads only the effort and the proposal block from the stored record with the same
 * id. Every stored string goes through esc(), because a title can be model text. The numbers 3 and 10 in the copy are
 * the 2 checkpoints of a measured change (queue-ui.test.ts holds them to the server constants).
 *
 * Each disclosure has a stable id, so the re-render seam of the app keeps an open one open. One that starts open
 * (the section and each group) renders open only until the person closes it once (`closed`).
 */
import type { SuggestionViewRecord } from '../../model/app-data.js'
import type { SuggestionRecord } from '../../suggest/types.js'
import { REJECT_REASON_LABELS, type RejectReasonCode } from '../../suggest/reason-codes.js'
import { esc, num, plural, ts } from './format.js'
import { banner } from './components/banner.js'
import { headCard } from './components/card.js'
import { commandBlock } from './components/command.js'
import { emptyHero, emptyNote } from './components/empty.js'
import { kickoffFailureMessage } from './suggest-rows.js'
import { changeClassLabel, statusLabel } from './status-labels.js'
import { confirmOf, dismissPart, type DismissState } from './dismiss-ui.js'
import type { QueueGroupKey, QueueRead, QueueRow } from './queue-types.js'

export interface QueueView {
  /** the read of this workspace, or of every workspace: undefined while the first read runs, null when it failed */
  main: QueueRead | null | undefined
  /** the read of every workspace, for the All workspaces disclosure: undefined until it lands, null when it failed */
  all?: QueueRead | null | undefined
  /** a session ended after the read, so the counts can be old */
  stale: boolean
  /** the last read again failed, so the list on screen is the last good one */
  refreshFailed: boolean
  /** the ids of the disclosures that start open and that the person closed once */
  closed: ReadonlySet<string>
  /** the open Dismiss confirm: its row renders open, with the confirm in it */
  confirm?: DismissState
}

export interface QueueContext {
  /** the stored records of the app, by id: the effort and the proposal block of a row */
  records: ReadonlyMap<string, SuggestionViewRecord>
  /** the store holds no record at all */
  storeEmpty: boolean
  /** the whole-harness card is on the page, so the section offers a way to it */
  megaButton: boolean
  /** the stored proposal block of the serve seam, keyed apart from the Findings rows, with no apply handoff */
  details?: (record: SuggestionViewRecord | undefined, key: string, handoffs: boolean) => string
}

/** The 6 groups in the order of the read, with the label and the dot of each. Only the first one is due. */
export const QUEUE_GROUP_VIEWS: ReadonlyArray<{ key: QueueGroupKey; label: string; dot: string }> = [
  { key: 'verdict', label: 'Ready to verify', dot: 'g' },
  { key: 'regressed', label: 'Regressed: keep it or dismiss it', dot: 'b' },
  { key: 'apply', label: 'Ready to apply', dot: 'p' },
  { key: 'review', label: 'To review', dot: 'h' },
  { key: 'running', label: 'Running', dot: 'w' },
  { key: 'wait', label: 'Waiting for sessions', dot: 'r' },
]

/** A group with more rows than this starts closed. Its summary still shows the count, and no row is left out. */
const OPEN_GROUP_MAX = 50

/** The verdict words of a complete checkpoint. */
const VERDICT_WORDS: Readonly<Record<string, string>> = {
  verified: 'verified',
  'within-noise': 'within noise',
  regressed: 'regressed',
  'not-enough-sessions': 'not enough sessions',
  'no-directional-check': 'no check names a direction',
}

const RECORDS_VERDICT = 'Copy the command. Claude checks the change and records the verdict.'

/** The one date form of the home: YYYY-MM-DD, in UTC. */
export function day(at: number): string {
  return ts(at).split(' ')[0]!
}

/** The last folder of a workspace path. */
function folderOf(workspace: string): string {
  return workspace.split('/').filter(Boolean).pop() ?? workspace
}

/** The Count again control: it reads the queue again. The home frame wires it by its data attribute. */
export const COUNT_AGAIN = '<button type="button" class="btn-sm" data-q-count>Count again</button>'

/** The sentences of a row, from the tables of its group and its case. Each value from the read is escaped here. */
export function rowCopy(item: QueueRow, record: SuggestionRecord | undefined): string {
  const later = item.candidates ? ` Up to ${esc(plural(item.candidates.later, 'later session'))} so far.` : ''
  switch (item.group) {
    case 'verdict':
      if (item.cannotVerify === 'few-baseline-sessions')
        return 'Ready to close. This change cannot be verified, because fewer than 3 sessions ran before it. Copy the command. Claude records it as not shown beyond chance.'
      if (item.checkpoint === 'complete')
        return `Ready to close. The later sessions are complete, so the verdict is final. The verdict: ${esc(VERDICT_WORDS[item.verdict ?? ''] ?? item.verdict)}. ${RECORDS_VERDICT}`
      return `Ready to verify. At the first check, on 3 later sessions, the comparison passes. ${RECORDS_VERDICT}`
    case 'wait':
      if (item.check === 'deferred') return 'orangu did not check this change in this read, because the read reached its byte budget. Count again to check it.'
      if (item.leaning === 'worse')
        return '<span class="bdot wr" aria-hidden="true"></span>Leaning worse. At the first check, a check moved beyond chance in a direction that it should not. This is not a final verdict. orangu grades again at 10 later sessions.'
      if (item.cannotVerify === 'no-directional-check')
        return 'No check of this change names a direction to improve, so orangu cannot verify it. When the later sessions are complete, this item moves to Ready to verify.'
      if (item.checkpoint === 'first')
        return `Waiting for the later sessions to complete. At the first check, the verdict was not final. orangu grades again at 10 later sessions, and never between them.${later}`
      return `Waiting for sessions.${later} orangu needs 3 on each side.`
    case 'regressed':
      return 'Regressed. On the complete later sessions, a check moved beyond chance in a direction that it should not. Copy the command. Claude asks you to keep the change or to undo it.'
    case 'apply':
      return 'Review the proposal. Then copy the apply command.'
    case 'review':
      if (item.status === 'proposed') return 'Global proposals are for review only. Claude applies nothing from here.'
      if (item.cannotVerify === 'baseline-gone')
        return 'Claude Code deleted the sessions that ran before this change, so orangu cannot verify it. Copy the command, or dismiss the item.'
      if (item.cannotVerify === 'legacy-record')
        return 'An older orangu applied this change and kept no checks, so orangu cannot verify it. Copy the command, or dismiss the item.'
      if (item.status === 'applied') return 'orangu cannot verify this change.'
      if (item.status === 'failed') {
        const failed = kickoffFailureMessage(record?.status === 'failed' ? record : ({ status: 'failed' } as SuggestionRecord))
        return esc(failed) + (record?.kickoff?.error?.trim() ? '<br>Copy the command to run it again.' : '')
      }
      return 'Copy the command to get one proposal from Claude.'
    case 'running':
      return `Started on ${day(item.lastMoveAt)}. No proposal came back yet. Copy the command again, or dismiss the item.`
  }
}

/** The closed row line under the title: the id, the folded count, the scope, the folder, the class, the effort, the date. */
function metaLine(item: QueueRow, record: SuggestionViewRecord | undefined): string {
  const effort = record?.proposal?.effort
  return [
    item.id,
    item.ids.length > 1 ? `${item.ids.length} records` : '',
    item.scope,
    item.workspace ? folderOf(item.workspace) : '',
    item.changeClass ? changeClassLabel(item.changeClass) : 'no class yet',
    effort ? `effort ${effort}` : '',
    day(item.lastMoveAt),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The earlier records of the same workspace and rule: each with its status word and its reason, and how many show. */
function triedBefore(item: QueueRow): string {
  if (!item.earlier.length) return ''
  const items = item.earlier.map((earlier) => {
    const reason = earlier.reasonCode ? (REJECT_REASON_LABELS[earlier.reasonCode as RejectReasonCode] ?? earlier.reasonCode) : ''
    return `<li>${esc([earlier.id, statusLabel(earlier.status), reason].filter(Boolean).join(' · '))}</li>`
  })
  const shown = item.earlierCount > item.earlier.length ? `<div>${item.earlier.length} of ${num(item.earlierCount)} earlier records show here.</div>` : ''
  return `<div class="sg-pfield"><b>Tried before.</b><ul>${items.join('')}</ul>${shown}</div>`
}

/** 1 render of the section: the view, and the open confirm until a row draws it. */
type Render = QueueView & { pending: { confirm?: DismissState | undefined } }

/** 1 row: closed, the title and its line. Open, the parts of the row, in order. A part with no data does not show. */
function rowHtml(item: QueueRow, dot: string, context: QueueContext, pending: Render['pending']): string {
  // 1 confirm on the page: the first row that holds its ids draws it, and the render has no confirm after that
  const confirm = confirmOf(item, pending.confirm)
  if (confirm) pending.confirm = undefined
  const record = context.records.get(item.id)
  const id = esc(item.id)
  const sessions =
    (item.group === 'verdict' || item.group === 'wait') && item.candidates
      ? `<div class="sg-pfield">Up to ${num(item.candidates.baseline)} earlier and up to ${esc(plural(item.candidates.later, 'later session'))} so far.</div>`
      : ''
  const proposal = context.details?.(record, `q-${item.id}`, false) ?? ''
  const handoff =
    item.next === null
      ? ''
      : `<div class="sg-handoffs"><div class="small muted">Copy only. Nothing runs here.</div><button type="button" class="btn-primary mt8" data-copy="${esc(item.next)}">Copy the command</button><div class="sg-cmd">${commandBlock(item.next, '$', 'the next command')}</div></div>`
  const body = [
    `<div class="sg-pfield"><b>Id.</b> <span class="mono">${id}</span> <button type="button" class="btn-sm" data-copy="${id}" aria-label="copy the id ${id}">copy id</button></div>`,
    item.ids.length > 1 ? `<div class="sg-pfield">${item.ids.length} records of this finding:<ul>${item.ids.map((folded) => `<li class="mono">${esc(folded)}</li>`).join('')}</ul></div>` : '',
    sessions,
    item.workspace ? `<div class="sg-pfield"><b>Workspace.</b> ${esc(item.workspace)}</div>` : '',
    triedBefore(item),
    proposal ? `<details class="why" id="qp-${id}"><summary><span class="chev" aria-hidden="true">▸</span>Proposal</summary>${proposal}</details>` : '',
    `<p class="rec">${rowCopy(item, record)}</p>`,
    item.check === 'deferred' ? COUNT_AGAIN : '',
    handoff,
    item.group === 'verdict'
      ? '<p class="small muted sg-foot">orangu grades at 3 and at 10 later sessions, and never between them. More looks raise the chance of a false win.</p>'
      : '',
    dismissPart(item, confirm),
  ]
  return `<details class="saved-proposal" id="q-${id}"${confirm ? ' open' : ''}><summary><span class="chev" aria-hidden="true">▸</span><span class="bdot ${dot}" aria-hidden="true"></span><span class="grow"><b>${esc(item.title)}</b><span class="q-meta small muted">${esc(metaLine(item, record))}</span></span></summary><div class="saved-proposal-body">${body.join('')}</div></details>`
}

/** The group cards of 1 workspace: 1 card for each group with rows, in order. `n` is the order of the workspace on the page. */
function groupCards(n: number, groups: Partial<Record<QueueGroupKey, QueueRow[]>>, counts: Partial<Record<QueueGroupKey, number>>, view: Render, context: QueueContext): string {
  return QUEUE_GROUP_VIEWS.map(({ key, label, dot }) => {
    const rows = groups[key] ?? []
    if (!rows.length) return ''
    const id = `q-${n}-${key}`
    const open = rows.length <= OPEN_GROUP_MAX && !view.closed.has(id)
    return `<details class="card mb16" id="${id}"${open ? ' open' : ''}><summary class="card-head"><span class="chev" aria-hidden="true">▸</span><span class="bdot ${dot}" aria-hidden="true"></span>${label}<span class="pill">${num(counts[key] ?? rows.length)}</span>${key === 'verdict' ? '<span class="tag good">Due</span>' : ''}</summary><div class="q-rows">${rows.map((row) => rowHtml(row, dot, context, view.pending)).join('')}</div></details>`
  }).join('')
}

/**
 * A read of every workspace, 1 block for each workspace in the order of the read, then the global records. `skip`
 * leaves out the workspace and the ids that the section already shows. The group counts of a block are the lengths of
 * the lists that the read sent.
 */
function workspaceBlocks(read: QueueRead, from: number, view: Render, context: QueueContext, skip?: { scope: string; ids: ReadonlySet<string> }): string {
  const blocks = new Map<string, Partial<Record<QueueGroupKey, QueueRow[]>>>()
  const global: Partial<Record<QueueGroupKey, QueueRow[]>> = {}
  for (const { key } of QUEUE_GROUP_VIEWS) {
    for (const item of read.groups[key] ?? []) {
      if (item.ids.some((id) => skip?.ids.has(id))) continue
      const workspace = item.workspace ?? ''
      if (item.scope !== 'global' && skip && workspace === skip.scope) continue
      const into = item.scope === 'global' ? global : blocks.get(workspace) ?? blocks.set(workspace, {}).get(workspace)!
      ;(into[key] ??= []).push(item)
    }
  }
  // the records with no workspace come after the named workspaces
  const named = [...blocks.keys()].filter(Boolean)
  if (blocks.has('')) named.push('')
  let n = from
  const html = named.map((workspace) => {
    const head = workspace
      ? `<div class="card-title" style="margin:2px 0">${esc(folderOf(workspace))}</div><div class="small muted mb16">${esc(workspace)}</div>`
      : '<div class="card-title">No workspace</div>'
    return head + groupCards(n++, blocks.get(workspace)!, {}, view, context)
  })
  if (Object.keys(global).length) html.push(headCard('Global proposals and lessons', `<div class="pad">${groupCards(n, global, {}, view, context)}</div>`, 'mb16'))
  return html.join('')
}

const LOADING = emptyNote('orangu counts the sessions of each applied change.')
const ERROR_HINT = 'Run orangu in a terminal and choose Improvements to see the reason.'
const queueError = (): string => emptyHero({ title: 'orangu could not compute the queue.', hint: ERROR_HINT, command: 'npx orangu' })

/** The All workspaces disclosure: closed at first, and read on its first open only. */
function allWorkspaces(main: QueueRead, view: Render, context: QueueContext): string {
  const all = view.all
  // every record that the section shows, folded ones too: a record with no workspace of its own is not folded in a
  // read of every workspace, so it comes back there as its own row
  const ids = new Set(Object.values(main.groups).flatMap((rows) => rows.flatMap((row) => row.ids)))
  const body =
    all === undefined
      ? LOADING
      : all === null
        ? queueError()
        : workspaceBlocks(all, 1, view, context, { scope: main.scope, ids }) || emptyNote('No other workspace has an open item.')
  return `<details class="sg-note mt8" id="home-all-queue"><summary><span class="chev" aria-hidden="true">▸</span>All workspaces${all ? ` · ${num(all.counts.open)} open` : ''}</summary><div class="mt8"${all === undefined ? ' aria-busy="true"' : ''}>${body}</div></details>`
}

/** The section body once a read landed. */
function queueBody(q: QueueRead, view: Render, context: QueueContext): string {
  const parts = [
    context.megaButton ? '<div class="right"><button type="button" class="btn-sm" data-q-mega>Review the whole harness ↓</button></div>' : '',
    view.stale ? banner('warn', `New sessions ended after this count. Count again to update the queue. ${COUNT_AGAIN}`) : '',
    view.refreshFailed ? '<p class="small">orangu could not count the queue again. This list is from the last count.</p>' : '',
  ]
  if (!q.counts.open)
    parts.push(
      context.storeEmpty
        ? emptyHero({ title: 'Your queue is empty.', hint: 'Copy a command under Findings in this scope to get a first proposal.' })
        : emptyHero({ title: 'Nothing waits for you.', hint: 'Each applied change has a verdict. Open History to see them.' }),
    )
  else if (q.scope === 'all') parts.push(workspaceBlocks(q, 0, view, context))
  else parts.push(groupCards(0, q.groups, q.counts, view, context))
  if (q.scope !== 'all') parts.push(allWorkspaces(q, view, context))
  return parts.join('')
}

/** The Queue section: open at first, its summary the accessible name of the toggle, with the counts of the read. */
export function queueSection(view: QueueView, context: QueueContext): string {
  const q = view.main
  const counts = q ? (q.counts.open ? `${q.counts.due ? ` · ${num(q.counts.due)} due` : ''} · ${num(q.counts.open)} open` : ' · nothing open') : ''
  const body = q === undefined ? LOADING : q === null ? queueError() : queueBody(q, { ...view, pending: { confirm: view.confirm } }, context)
  return `<details class="card pad mb16 sg-note" id="home-queue"${view.closed.has('home-queue') ? '' : ' open'}><summary><span class="chev" aria-hidden="true">▸</span><b>Queue</b>${counts}</summary><div class="mt8"${q === undefined ? ' aria-busy="true"' : ''}>${body}</div></details>`
}
