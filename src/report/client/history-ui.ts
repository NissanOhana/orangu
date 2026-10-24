/**
 * Serve only: the History section of the improvement home. Each applied change of this workspace, newest application
 * first, with its tag, its dates and the check means of the history read. Only the home frame (home-ui.ts) and the
 * Lessons section (lessons-ui.ts) import this file, so the file bundles carry none of it.
 *
 * The client computes no verdict. Each tag, count, verdict and check value comes from the history read of the server.
 * The Plain sentence of a check is a lookup by its comparison and its stored check verdict. A row reads the stored
 * receipt lines and the workspace from the stored record with the same id, and shows the receipt lines whole, in
 * Detailed only. The home never rewrites a stored string. Every stored string goes through esc(), because a title can
 * be model text. A row has no copy control and names no command.
 *
 * The history read has no workspace key. In a read of every workspace, a row takes the workspace of its stored
 * record: its proposal workspace, else its bound workspace, the key of the queue read of every workspace. Both come
 * from the store reads of serve, scrubbed, so no raw path reaches the page.
 */
import type { SuggestionViewRecord } from '../../model/app-data.js'
import { REJECT_REASON_LABELS, type RejectReasonCode } from '../../suggest/reason-codes.js'
import { esc, num, plural } from './format.js'
import { headCard } from './components/card.js'
import { emptyHero, emptyNote } from './components/empty.js'
import { trustedVerification } from './screens/suggest.js'
import { changeClassLabel, statusLabel } from './status-labels.js'
import { STORE_ERROR, day, folderOf, readError } from './queue-ui.js'
import type { ChangeCheck, ChangeRow } from './lesson-types.js'

export interface HistoryView {
  /** the read of this workspace, or of every workspace: undefined while the first read runs, null when it failed */
  main: ChangeRow[] | null | undefined
  /** the read of every workspace, for the All workspaces disclosure: undefined until it lands, null when it failed */
  all?: ChangeRow[] | null | undefined
  /** the scrubbed workspace path of the read, `all`, or undefined while no read named it */
  scope: string | undefined
  /** each of the 3 store reads of the home failed */
  storeError: boolean
  /** the Plain language audience */
  plain: boolean
}

export interface StoreContext {
  /** the stored records of the app, by id: the workspace and the receipt lines of a row */
  records: ReadonlyMap<string, SuggestionViewRecord>
}

/** The plain name of each metric of a check. */
export const METRIC_NAMES: Readonly<Record<string, string>> = {
  avgTotalTokens: 'tokens per session',
  avgToolCalls: 'tool calls per session',
  avgToolErrors: 'tool errors per session',
  avgActiveMs: 'active time per session',
  avgContextPeak: 'context peak',
  avgTestRunsFailed: 'failed test runs',
  avgBuildRunsFailed: 'failed builds',
  avgInterruptions: 'interruptions',
}

/** The end of the Plain sentence of a check, by its comparison and its stored check verdict. */
const SENTENCE_ENDS: Readonly<Record<string, string>> = {
  'decreased improved': 'went down beyond chance',
  'decreased within-noise': 'did not go down beyond chance',
  'decreased regressed': 'went up beyond chance',
  'increased improved': 'went up beyond chance',
  'increased within-noise': 'did not go up beyond chance',
  'increased regressed': 'went down beyond chance',
  'not-increased held': 'did not go up beyond chance',
  'not-increased regressed': 'went up beyond chance',
  'not-decreased held': 'did not go down beyond chance',
  'not-decreased regressed': 'went down beyond chance',
  'equal held': 'did not change beyond chance',
  'equal changed': 'changed beyond chance',
}

/** The Plain sentence of a check, as text: the plain name of its metric with a capital letter, then the end from the table. */
export function checkSentence(check: { metric: string; comparison: string; verdict: string }): string {
  const name = METRIC_NAMES[check.metric] ?? check.metric
  const end = SENTENCE_ENDS[`${check.comparison} ${check.verdict}`] ?? `${check.comparison}, ${check.verdict}`
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${end}.`
}

/** The tag of a row by its stored status and the trust of its verdict, its dot, and its word in the summary line. */
interface Kind {
  status: ChangeRow['status']
  trusted?: boolean
  tag: string
  tone: 'good' | 'bad' | 'neutral'
  dot: string
  word: string
}

const KINDS: readonly Kind[] = [
  { status: 'verified', trusted: true, tag: 'verified comparison', tone: 'good', dot: 'g', word: 'verified' },
  { status: 'verified', trusted: false, tag: 'legacy unverified', tone: 'neutral', dot: 'wr', word: 'legacy unverified' },
  { status: 'unproven', tag: 'not shown beyond chance', tone: 'neutral', dot: 'r', word: 'not shown beyond chance' },
  { status: 'regressed', tag: 'regressed', tone: 'bad', dot: 'b', word: 'regressed' },
  { status: 'kept', tag: 'kept after a regression', tone: 'neutral', dot: 'w', word: 'kept after a regression' },
  { status: 'rejected', tag: 'dismissed after apply', tone: 'neutral', dot: 'r', word: 'dismissed after apply' },
  { status: 'applied', tag: 'waiting for sessions', tone: 'neutral', dot: 'r', word: 'waiting' },
]

/** The form of a change that was not shown beyond chance, from its verdict, in Detailed. */
const UNPROVEN_FORMS: Readonly<Record<string, string>> = {
  'within-noise': 'within noise',
  'no-directional-check': 'every guard held',
  'not-enough-sessions': 'not enough sessions',
}

/** The kind of a row by its stored status, or undefined for a status that the history does not name. */
function kindOf(row: ChangeRow): Kind | undefined {
  return KINDS.find((kind) => kind.status === row.status && (kind.trusted === undefined || kind.trusted === row.verdictTrusted))
}

/** The tag of a row: fixed words, else the stored status word, escaped. */
function tagOf(row: ChangeRow, plain: boolean): { html: string; dot: string } {
  const kind = kindOf(row)
  if (!kind) return { html: `<span class="tag neutral">${esc(statusLabel(row.status))}</span>`, dot: 'r' }
  const form = row.status === 'unproven' && !plain && row.verdict !== null ? UNPROVEN_FORMS[row.verdict] : undefined
  return { html: `<span class="tag ${kind.tone}">${form ? `${kind.tag} · ${form}` : kind.tag}</span>`, dot: kind.dot }
}

/** The summary line: the number of rows, then a count for each kind, with each count of 0 left out. No ratio. */
export function summaryLine(rows: readonly ChangeRow[]): string {
  const counts = KINDS.map((kind) => [kind, rows.filter((row) => kindOf(row) === kind).length] as const)
  const parts = counts.filter(([, n]) => n > 0).map(([kind, n]) => `${num(n)} ${kind.word}`)
  return `${plural(rows.length, 'applied change')}.${parts.length ? ` ${parts.join(', ')}.` : ''}`
}

/**
 * The workspace of a stored record, as the queue read of every workspace names it: its proposal workspace, else its
 * bound workspace, else ''. The record of the app is scrubbed as the store reads are.
 */
export function workspaceOf(record: SuggestionViewRecord | undefined): string {
  const proposal: unknown = record?.proposal?.workspace?.cwd
  if (typeof proposal === 'string') return proposal
  const bound: unknown = record?.workspaceCwd
  return typeof bound === 'string' ? bound : ''
}

/**
 * Items of a read of every workspace, by the workspace of each stored record, in the order of the read. The named
 * workspaces come first, then the items with no workspace, then the global items, which belong to no workspace.
 */
export function byWorkspace<T extends { id: string; scope: string }>(items: readonly T[], records: StoreContext['records']): { blocks: Array<[string, T[]]>; global: T[] } {
  const blocks = new Map<string, T[]>()
  const global: T[] = []
  for (const item of items) {
    if (item.scope === 'global') {
      global.push(item)
      continue
    }
    const workspace = workspaceOf(records.get(item.id))
    const into = blocks.get(workspace) ?? blocks.set(workspace, []).get(workspace)!
    into.push(item)
  }
  const named = [...blocks.keys()].filter(Boolean)
  if (blocks.has('')) named.push('')
  return { blocks: named.map((workspace) => [workspace, blocks.get(workspace)!]), global }
}

/** A stored number of a check as the receipt holds it, or a dash when the receipt form has none. */
const value = (n: number | null): string => (n === null ? '–' : esc(String(n)))

/** The checks of a row: 1 Plain sentence each, or in Detailed a table of the means and the 2 p-values. */
function checksPart(checks: readonly ChangeCheck[], plain: boolean): string {
  if (!checks.length) return ''
  if (plain) return `<div class="sg-pfield"><b>Checks.</b><ul>${checks.map((check) => `<li>${esc(checkSentence(check))}</li>`).join('')}</ul></div>`
  const rows = checks.map(
    (check) =>
      `<tr><td class="mono">${esc(check.metric)} ${esc(check.comparison)}</td><td class="num">${value(check.before)}</td><td class="num">${value(check.after)}</td><td class="num">${value(check.pLower)}</td><td class="num">${value(check.pHigher)}</td><td>${esc(check.verdict)}</td></tr>`,
  )
  return `<div class="sg-pfield"><b>Checks.</b></div><div class="scroll-x"><table class="grid"><thead><tr><th scope="col">Check</th><th scope="col" class="num">Before</th><th scope="col" class="num">After</th><th scope="col" class="num">p lower</th><th scope="col" class="num">p higher</th><th scope="col">Verdict</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

/**
 * The stored lines of a verified record, whole, as the stored proposal block shows its later evidence
 * (proposalDetails, proposals-ui.ts): only a receipt that the trust policy accepts.
 */
function storedLines(record: SuggestionViewRecord | undefined): string {
  const receipt = record?.verificationReceipt
  if (record?.status !== 'verified' || !receipt || !trustedVerification(record)) return ''
  const evidence = (Array.isArray(receipt.checks) ? receipt.checks : []).map((check) => check?.evidence).filter((line): line is string => typeof line === 'string')
  return (
    `<div class="sg-pfield"><b>Stored summary.</b> <code>${esc(receipt.summary)}</code></div>` +
    (evidence.length ? `<div class="sg-pfield"><b>Stored evidence.</b><ul>${evidence.map((line) => `<li><code>${esc(line)}</code></li>`).join('')}</ul></div>` : '')
  )
}

/** The other changes of the measured window, with their ids. */
function othersPart(ids: readonly string[]): string {
  if (!ids.length) return ''
  const line = `${plural(ids.length, 'other change')} landed in the same window. ${ids.length === 1 ? 'Its effect is' : 'Their effects are'} measured together.`
  return `<div class="sg-pfield">${line}<ul>${ids.map((id) => `<li class="mono">${esc(id)}</li>`).join('')}</ul></div>`
}

/** 1 row: closed, the title and its line with the tag and the date. Open, the parts of the row, in order. A part with no data does not show. */
function rowHtml(row: ChangeRow, view: HistoryView, context: StoreContext): string {
  const record = context.records.get(row.id)
  const id = esc(row.id)
  const tag = tagOf(row, view.plain)
  const workspace = workspaceOf(record)
  const scope = [row.scope, row.changeClass ? changeClassLabel(row.changeClass) : '', workspace].filter(Boolean).join(' · ')
  const reason = row.reasonCode ? REJECT_REASON_LABELS[row.reasonCode as RejectReasonCode] ?? row.reasonCode : ''
  // The earlier receipt form keeps no earlier sessions and no p-value, so its row shows only the later count.
  const earlier = row.checks.some((check) => check.pLower === null) ? '' : `${num(row.baseline)} earlier and `
  const body = [
    row.decidedAt !== undefined ? `<div class="sg-pfield"><b>Decided.</b> ${day(row.decidedAt)}</div>` : '',
    `<div class="sg-pfield"><b>Id.</b> <span class="mono">${id}</span></div>`,
    `<div class="sg-pfield"><b>Scope.</b> ${esc(scope)}</div>`,
    row.files.length ? `<div class="sg-pfield"><b>Files.</b> ${plural(row.files.length, 'file')} changed<ul>${row.files.map((file) => `<li class="mono">${esc(file)}</li>`).join('')}</ul></div>` : '',
    row.verdict !== null ? `<div class="sg-pfield"><b>Sessions.</b> ${earlier}${plural(row.later, 'later session')}.</div>` : '',
    checksPart(row.checks, view.plain),
    view.plain ? '' : storedLines(record),
    othersPart(row.confoundedBy),
    reason ? `<div class="sg-pfield"><b>Reason.</b> ${esc(reason)}</div>` : '',
    row.status === 'verified' && !row.verdictTrusted ? '<div class="sg-pfield"><b>Legacy state.</b> Not verified under the current deterministic contract.</div>' : '',
  ]
  const applied = row.appliedAt !== undefined ? ` applied ${day(row.appliedAt)}` : ''
  return `<details class="saved-proposal" id="h-${id}"><summary><span class="chev" aria-hidden="true">▸</span><span class="bdot ${tag.dot}" aria-hidden="true"></span><span class="grow"><b>${esc(row.title)}</b><span class="q-meta small muted">${tag.html}${applied}</span></span></summary><div class="saved-proposal-body">${body.join('')}</div></details>`
}

/** The rows, newest application first. */
const newestFirst = (rows: readonly ChangeRow[]): ChangeRow[] => [...rows].sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))

const rowList = (rows: readonly ChangeRow[], view: HistoryView, context: StoreContext, cls = ''): string =>
  `<div class="q-rows${cls}">${rows.map((row) => rowHtml(row, view, context)).join('')}</div>`

/** The rows of a read of every workspace: 1 block for each workspace, its folder and its path, then the global rows. */
function workspaceRows(rows: readonly ChangeRow[], view: HistoryView, context: StoreContext): string {
  const { blocks, global } = byWorkspace(newestFirst(rows), context.records)
  // the head of each workspace, as the queue read of every workspace draws it (queue-ui.ts)
  const html = blocks.map(
    ([workspace, items]) =>
      (workspace ? `<div class="card-title" style="margin:2px 0">${esc(folderOf(workspace))}</div><div class="small muted mb16">${esc(workspace)}</div>` : '<div class="card-title">No workspace</div>') +
      rowList(items, view, context, ' mb16'),
  )
  if (global.length) html.push(headCard('Global proposals and lessons', rowList(global, view, context), 'mb16'))
  return html.join('')
}

const LOADING = emptyNote('orangu reads the applied changes.')
const ERROR = 'orangu could not read the history.'

/** The All workspaces disclosure: closed at first, read on its first open only, with the rows that the section does not show. */
function allWorkspaces(main: readonly ChangeRow[], view: HistoryView, context: StoreContext): string {
  const all = view.all
  const shown = new Set(main.map((row) => row.id))
  const body =
    all === undefined
      ? LOADING
      : all === null
        ? readError(ERROR)
        : workspaceRows(all.filter((row) => !shown.has(row.id)), view, context) || emptyNote('No other workspace has an applied change.')
  return `<details class="sg-note mt8" id="home-all-history"><summary><span class="chev" aria-hidden="true">▸</span>All workspaces</summary><div class="mt8"${all === undefined ? ' aria-busy="true"' : ''}>${body}</div></details>`
}

/** The section body once a read landed. A read of every workspace shows each workspace in turn, with no disclosure. */
function historyBody(rows: readonly ChangeRow[], view: HistoryView, context: StoreContext): string {
  const every = view.scope === 'all'
  const parts = rows.length
    ? [`<p class="sg-sub">${summaryLine(rows)}</p>`, every ? workspaceRows(rows, view, context) : rowList(newestFirst(rows), view, context)]
    : [emptyHero({ title: 'No change was applied yet.', hint: 'When you run the apply skill, the change shows here with its verdict.' })]
  if (!every) parts.push(allWorkspaces(rows, view, context))
  return parts.join('')
}

/** The History section: closed at first, its summary the accessible name of the toggle, with the count of the read. */
export function historySection(view: HistoryView, context: StoreContext): string {
  const rows = view.main
  const count = rows ? (rows.length ? ` · ${plural(rows.length, 'applied change')}` : ' · no applied change yet') : ''
  const body = rows === undefined ? LOADING : rows === null ? readError(view.storeError ? STORE_ERROR : ERROR) : historyBody(rows, view, context)
  return `<details class="card pad mb16 sg-note" id="home-history"><summary><span class="chev" aria-hidden="true">▸</span><b>History</b>${count}</summary><div class="mt8"${rows === undefined ? ' aria-busy="true"' : ''}>${body}</div></details>`
}
