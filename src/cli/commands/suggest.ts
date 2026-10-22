/**
 * `orangu suggest`: the CLI face of the suggestion store (~/.orangu/suggestions.jsonl, XDG honoured).
 * Deterministic bookkeeping only: creating, listing, showing and transitioning records. It never calls a
 * model. Skills write bounded proposal/application/verification artifacts under ~/.orangu/proposals/;
 * this command validates them before recording each lifecycle transition. Nothing is auto-applied.
 *
 *   orangu suggest [<sg_id>] --finding <v2-token> [--json]
 *   orangu suggest [<sg_id>] --rule <r> --scope session|repo|global --session <a,b> [--cohort <16hex>] [--insight <id>] [--title <t>] [--json]
 *     (repo/global derive the cohort from the complete session list when --cohort is omitted)
 *     (the optional positional id must match the encoded/canonical or legacy report identity)
 *   orangu suggest --show <id> [--for-proposal|--for-apply] [--json]
 *                                                record + bounded evidence, with an optional lifecycle preflight
 *   orangu suggest --set <id> proposed --proposal <id>.md [--manifest <id>.json] [--json]
 *   orangu suggest --set <id> applied --application <id>.applied.json [--json]
 *     (freezes the baseline sessions first. A failed freeze writes the move without one. The --json output says
 *      so in baselineFreeze, and 1 stderr line says so unless --quiet silences it)
 *   orangu suggest --effect <id> [--json]      read-only: later sessions vs baseline, beyond chance
 *   orangu suggest --set <id> verified [--verification <id>.verified.json] [--json]
 *     (Orangu picks both cohorts; an optional intent may only name sessions inside the later cohort)
 *   orangu suggest --record <id> [--json]      measures again and stores a final verdict that is not verified
 *   orangu suggest --set <id> kept [--json]     keeps a regressed change, and measures nothing
 *   orangu suggest --set <id> rejected [--reason <code>] [--json]
 *   orangu suggest --list [--scope <s>] [--status <s>[,<s>]] [--json]
 *   orangu suggest --queue [--cwd <dir> | --all] [--json]       the open records, in 6 groups
 *   orangu suggest --todo [--cwd <dir>] [--json]                 the open items that need a step, 8,192 B at most
 *   orangu suggest --lessons [--cwd <dir> | --all | --scope global] [--rule <id>[,<id>]] [--json]   16,384 B at most
 *   orangu suggest --history [--cwd <dir> | --all | --scope global] [--rule <id>[,<id>]] [--json]
 *     (the 4 reads write no record and no proposal file. Only the queue check may write cohort facts cache entries.
 *      Their text output is in ./suggest-reads.ts)
 *
 * Each call runs 1 step: 2 step flags together exit 1 before any read or write.
 */
import { matchRule, type CatalogMatch } from '../../suggest/catalog.js'
import { realpath } from 'node:fs/promises'
import { loadApplicationReceipt, loadProposalArtifacts, loadVerificationIntent } from '../../suggest/artifacts.js'
import {
  effectFinality,
  freezeBaseline,
  measureCohortEffect,
  nextStep,
  outcomePatch,
  verificationPatch,
  type CohortEffect,
  type FreezeDeps,
} from '../../suggest/cohort.js'
import { createCohortDeps } from '../../suggest/cohort-deps.js'
import { REJECT_REASON_CODES, type RejectReasonCode } from '../../suggest/reason-codes.js'
import { rejectWorkspaceCwd, type RejectWorkspaceDeps } from '../../suggest/reject-workspace.js'
import { SESSION_ID_RE } from '../../discover/discover.js'
import { decodeFinding, kickoffCommand, sessionCohortFingerprint, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import { redactAnalysis, redactValue } from '../../redact/redact.js'
import { slimAnalysis, type SlimAnalysis } from '../../suggest/slim.js'
import { SuggestionStore } from '../../suggest/store.js'
import { liveWorkspaceIdentity, sameWorkspace, storedWorkspaceIdentity } from '../../suggest/workspace-identity.js'
import { isTrustedComputedVerification } from '../../suggest/verification-policy.js'
import { MAX_EVIDENCE_LIMIT, projectEvidence } from '../../suggest/evidence.js'
import {
  TRANSITIONS,
  type Finding,
  type SuggestionApplicationReceipt,
  type SuggestionFrozenBaseline,
  type SuggestionProposal,
  type SuggestionRecord,
  type SuggestionScope,
  type SuggestionStatus,
  type SuggestionWorkspaceIdentity,
} from '../../suggest/types.js'
import { createDiscoveredClaudeAnalysisLoader } from '../../adapters/claude-code/discovered-analysis.js'
import { CohortFactsCache } from '../../suggest/cohort-cache.js'
import type { LessonRead } from '../../suggest/lessons.js'
import type { TodoRead } from '../../suggest/queue.js'
import {
  createQueueReadDeps,
  readHistory,
  readLessons,
  readQueue,
  readTodo,
  type LessonTarget,
  type QueueReadDeps,
  type QueueTarget,
} from '../../suggest/queue-read.js'
import { flagBool, flagStr } from '../args.js'
import { layoutWidth } from '../summary.js'
import { detectCaps, displayWidth, wrapWords } from '../tty.js'
import { loadAnalysisBySelector } from './estimate.js'
import { historyLines, lessonLines, queueLines, todoLines, transitionLines, transitionsOf } from './suggest-reads.js'
import { VERSION } from '../../version.js'

async function currentWorkspaceIdentity(): Promise<SuggestionWorkspaceIdentity> {
  // Only the stored fields: this value is persisted with the reviewed proposal.
  return storedWorkspaceIdentity(await liveWorkspaceIdentity(process.cwd()))
}

async function assertEvidenceWorkspace(
  rec: SuggestionRecord,
  workspace: SuggestionWorkspaceIdentity,
): Promise<void> {
  if (rec.scope === 'global') return
  const load = createDiscoveredClaudeAnalysisLoader()
  for (const selector of rec.sessionIds) {
    const analysis = await load(selector)
    if (!analysis) {
      throw new Error(`suggestion ${rec.id} evidence session ${selector} could not be resolved from supported Claude roots`)
    }
    const cwd = analysis.session.cwd
    if (!cwd) throw new Error(`suggestion ${rec.id} evidence session ${selector} has no workspace identity`)
    let canonical: string
    try {
      canonical = await realpath(cwd)
    } catch {
      throw new Error(`suggestion ${rec.id} evidence workspace no longer exists: ${cwd}`)
    }
    if (canonical !== workspace.cwd) {
      throw new Error(`suggestion ${rec.id} evidence belongs to workspace ${canonical}. Create the proposal from that exact workspace.`)
    }
    if (rec.source === 'report' && rec.scope === 'session') {
      const rebound = projectEvidence(analysis, { limit: MAX_EVIDENCE_LIMIT }).findings.find((finding) => finding.suggestionId === rec.id)
      const sameSnapshot = rebound && canonicalJson(rebound.finding) === canonicalJson({
        ruleId: rec.ruleId,
        title: rec.title,
        scope: rec.scope,
        sessionIds: rec.sessionIds,
        ...(rec.insightId ? { insightId: rec.insightId } : {}),
        evidence: rec.evidence,
      })
      if (!sameSnapshot) {
        throw new Error(`suggestion ${rec.id} does not match the canonical finding recomputed from its discovered session`)
      }
    } else if (rec.source === 'report' && rec.scope === 'repo' && !analysis.insights.some((insight) => insight.ruleId === rec.ruleId)) {
      throw new Error(`suggestion ${rec.id} example session does not contain the claimed recurring rule ${rec.ruleId}`)
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : item,
  )
}

type ApplyReadyProposal = SuggestionProposal & {
  v: 1
  files: string[]
  manifestPath: string
  workspace: SuggestionWorkspaceIdentity
}

async function assertWorkspaceMatch(rec: SuggestionRecord): Promise<ApplyReadyProposal> {
  if (rec.scope === 'global') {
    throw new Error(`suggestion ${rec.id} is global and proposal-only. Global apply is not supported.`)
  }
  if (rec.status !== 'proposed' || rec.proposal?.v !== 1 || !rec.proposal.manifestPath || !rec.proposal.files?.length) {
    throw new Error(`suggestion ${rec.id} is not an apply-ready structured proposal`)
  }
  if (!rec.proposal.workspace) throw new Error(`suggestion ${rec.id} is a legacy unbound proposal and cannot be applied`)
  if (!sameWorkspace(rec.proposal.workspace, await liveWorkspaceIdentity(process.cwd()))) {
    throw new Error(`suggestion ${rec.id} belongs to workspace ${rec.proposal.workspace.cwd}. Run apply from that exact workspace.`)
  }
  return rec.proposal as ApplyReadyProposal
}

const SCOPES: SuggestionScope[] = ['session', 'repo', 'global']
/** The statuses that `--set` writes. */
const STATUSES: SuggestionStatus[] = ['new', 'kicked-off', 'proposed', 'applied', 'verified', 'rejected', 'failed', 'kept']
/** The statuses that only `--record` writes: orangu measures the verdict, so no caller names it. */
const RECORDED_STATUSES: SuggestionStatus[] = ['regressed', 'unproven']
/** The flags that name a skill-written file. */
const ARTIFACT_FLAGS = ['proposal', 'manifest', 'application', 'verification'] as const
/** The store refuses the frozen baseline of an apply move with this phrase (src/suggest/store.ts, validateTransitionPatch and transitionLocked). */
const FROZEN_BASELINE_REFUSAL_RE = /invalid frozen baseline/
/** Every status of a record: the ones that `--set` writes and the ones that only `--record` writes. */
const ALL_STATUSES: SuggestionStatus[] = [...STATUSES, ...RECORDED_STATUSES]
/** The steps of `orangu suggest`. A call runs 1 of them, or none to create a record. */
const STEP_FLAGS = ['list', 'show', 'effect', 'record', 'set', 'queue', 'todo', 'lessons', 'history'] as const
/** The 4 reads, the read options that each one takes, and its usage. A read refuses the option of another read. */
const READS = {
  queue: { takes: ['cwd', 'all'], usage: '--queue [--cwd <dir> | --all] [--json]' },
  todo: { takes: ['cwd'], usage: '--todo [--cwd <dir>] [--json]' },
  lessons: { takes: ['cwd', 'all', 'scope', 'rule'], usage: '--lessons [--cwd <dir> | --all | --scope global] [--rule <id>[,<id>]] [--json]' },
  history: { takes: ['cwd', 'all', 'scope', 'rule'], usage: '--history [--cwd <dir> | --all | --scope global] [--rule <id>[,<id>]] [--json]' },
} as const
type ReadStep = keyof typeof READS
const READ_OPTIONS = ['cwd', 'all', 'scope', 'rule'] as const

/** What the store steps read outside the store. The CLI uses the trusted loaders, and a test injects fakes. */
export interface SuggestDeps {
  /** the cohort loaders of `--effect`, `--record`, `--set verified` and the freeze at `--set applied` */
  cohort?: FreezeDeps
  /** the discovery reads that bind the workspace of a rejection */
  rejectWorkspace?: RejectWorkspaceDeps
  /** the clock, the queue check loaders and the discovery of the 4 reads. The CLI makes them for each read */
  read?: QueueReadDeps
}

const emit = (v: unknown, flags: Record<string, string | boolean>) =>
  process.stdout.write(JSON.stringify(v, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')

function visible<T>(value: T, flags: Record<string, string | boolean>): T {
  return flagBool(flags, 'no-redact') ? value : redactValue(value, { scrub: true })
}

/**
 * The exact stdout of a read, past the output boundary (`visible`): the JSON that `emit` writes (2-space, or 1 line
 * with `--quiet`), or the text lines, each with its newline. A capped read measures this string, so the cap holds on
 * the bytes that a person or a skill reads.
 */
function readOutput<T>(read: T, flags: Record<string, string | boolean>, text: (shown: T) => string[]): string {
  const shown = visible(read, flags)
  if (flagBool(flags, 'json')) return JSON.stringify(shown, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n'
  return text(shown).map((line) => line + '\n').join('')
}

const outputBytes = (output: string): number => Buffer.byteLength(output, 'utf8')

function terminal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

/** The narrowest title column: below it, the line runs past the measure rather than print a word per line. */
const MIN_TITLE_COLUMNS = 20

/**
 * One record as terminal lines. The title wraps under itself at whole words inside `width` and is never
 * cut; wrapWords strips escapes and control bytes, because a stored title can carry transcript text.
 */
export function recordLines(rec: SuggestionRecord, width: number): string[] {
  const status = rec.status === 'verified' && !isTrustedComputedVerification(rec) ? 'legacy-unverified' : rec.status
  const head = `  ${terminal(rec.id)}  [${terminal(status)}]  `
  const column = displayWidth(head)
  const [first = '', ...rest] = wrapWords(rec.title, Math.max(MIN_TITLE_COLUMNS, width - column))
  const lines = [head + first, ...rest.map((t) => ' '.repeat(column) + t)]
  lines.push(`    rule ${terminal(rec.ruleId)} · scope ${terminal(rec.scope)} · sessions ${rec.sessionIds.map((s) => terminal(s.slice(0, 8))).join(', ')}`)
  if (rec.proposal) lines.push(`    proposal: ${terminal(rec.proposal.proposalPath)}`)
  return lines
}

function printRecord(rec: SuggestionRecord): void {
  const width = layoutWidth(detectCaps(process.stdout, process.env))
  for (const l of recordLines(rec, width)) process.stdout.write(l + '\n')
}

// Curated deterministic, offline catalog: known tool, skill, and feature entries for this finding.
function printCatalog(matches: CatalogMatch[]): void {
  const w = (s: string) => process.stdout.write(s + '\n')
  for (const m of matches) {
    const what = m.entry.tool ? `tool ${m.entry.tool}` : m.entry.skill ? `skill ${m.entry.skill}` : `feature ${m.entry.feature}`
    w(`    catalog ${m.entry.id}: ${what}${m.entry.url ? ` · ${m.entry.url}` : ''}${m.entry.verifiedAt ? ` · verified ${m.entry.verifiedAt}` : ' · candidate (unverified)'}`)
  }
}

/** The statuses of `--status <s>[,<s>]`: each one a status of a record, or exit 1 with the allowed list before any read. */
function statusFilter(flags: Record<string, string | boolean>): Set<SuggestionStatus> | undefined {
  const value = flags['status']
  if (value === undefined) return undefined
  const names = typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : []
  const unknown = names.filter((name) => !ALL_STATUSES.includes(name as SuggestionStatus))
  if (!names.length || unknown.length) {
    throw new Error(`--status takes 1 or more of ${ALL_STATUSES.join(', ')}${unknown.length ? `, not ${unknown.map((name) => JSON.stringify(name)).join(', ')}` : ''}`)
  }
  return new Set(names as SuggestionStatus[])
}

async function cmdList(store: SuggestionStore, flags: Record<string, string | boolean>): Promise<void> {
  const scope = flagStr(flags, 'scope')
  const statuses = statusFilter(flags)
  let all = await store.all()
  if (scope) all = all.filter((r) => r.scope === scope)
  if (statuses) all = all.filter((r) => statuses.has(r.status))
  if (flagBool(flags, 'json')) return emit(visible(all, flags), flags) as unknown as void
  if (!all.length && statuses) {
    process.stdout.write(`no suggestion has the status ${[...statuses].join(' or ')}.\n`)
    return
  }
  if (!all.length) {
    process.stdout.write('no suggestions yet. Create one from a report finding, or run: orangu suggest --rule <r> --scope session --session <id>\n')
    return
  }
  for (const rec of all) printRecord(visible(rec, flags))
}

async function cmdShow(store: SuggestionStore, id: string, flags: Record<string, string | boolean>): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`)
  const forApply = flagBool(flags, 'for-apply')
  const forProposal = flagBool(flags, 'for-proposal')
  if (forApply && forProposal) throw new Error('--for-proposal and --for-apply are mutually exclusive')
  if (forApply) await assertWorkspaceMatch(rec)
  if (forProposal && rec.scope !== 'global') await assertEvidenceWorkspace(rec, await currentWorkspaceIdentity())
  const sessions: SlimAnalysis[] = []
  const missing: string[] = []
  for (const sel of rec.sessionIds) {
    const a = await loadAnalysisBySelector(sel, { version: VERSION, now: Date.now() })
    if (!a) {
      missing.push(sel)
      continue
    }
    const body = flagBool(flags, 'no-redact') ? a : redactAnalysis(a, { scrub: true }).analysis
    sessions.push(slimAnalysis(body))
  }
  const catalog = matchRule(rec.ruleId, sessions)
  // Every move of the record in file order, from its store lines: the 1 key that --show --json adds to 0.11.0.
  const transitions = transitionsOf(await store.lines(rec.id))
  if (flagBool(flags, 'json')) {
    return emit(visible({
      record: rec,
      sessions,
      catalog,
      missingSessionIds: missing,
      ...(rec.status === 'verified' ? { verificationTrusted: isTrustedComputedVerification(rec) } : {}),
      ...(forApply ? { workspaceMatchesCurrent: true } : {}),
      ...(forProposal ? { proposalEligibility: rec.scope === 'global' ? 'global-proposal-only' : 'workspace-bound' } : {}),
      transitions,
    }, flags), flags) as unknown as void
  }
  printRecord(visible(rec, flags))
  for (const line of transitionLines(transitions)) process.stdout.write(line + '\n')
  printCatalog(catalog)
  process.stdout.write(`  evidence: ${sessions.length} session(s) loaded${missing.length ? `, ${missing.length} unresolvable` : ''}. Add --json for the slim data\n`)
}

/** The `--reason` code of a rejection: 1 of the 5 codes exactly, or none. No free text reaches the store. */
function rejectReason(flags: Record<string, string | boolean>): RejectReasonCode | undefined {
  const value = flags['reason']
  if (value === undefined) return undefined
  const code = REJECT_REASON_CODES.find((known) => known === value)
  if (!code) throw new Error(`--reason must be 1 of ${REJECT_REASON_CODES.join(', ')}`)
  return code
}

async function cmdSet(store: SuggestionStore, id: string, positionals: string[], flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  const status = positionals[0] as SuggestionStatus | undefined
  if (status && RECORDED_STATUSES.includes(status)) {
    throw new Error(`--set cannot write ${status}, because orangu measures that verdict itself. Run: orangu suggest --record ${id}`)
  }
  if (!status || !STATUSES.includes(status)) throw new Error(`usage: orangu suggest --set <id> <${STATUSES.join('|')}>`)
  const reasonCode = rejectReason(flags)
  const proposalPath = flagStr(flags, 'proposal')
  const manifestPath = flagStr(flags, 'manifest')
  const applicationPath = flagStr(flags, 'application')
  const verificationPath = flagStr(flags, 'verification')
  for (const name of ARTIFACT_FLAGS) {
    if (flags[name] !== undefined && typeof flags[name] !== 'string') throw new Error(`--${name} requires a file path`)
  }
  const rec = await store.get(id)
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`)
  // Only the moves that --set writes: the 2 measured outcomes of an applied record are --record moves.
  const settable = (TRANSITIONS[rec.status] ?? []).filter((next) => STATUSES.includes(next))
  if (!settable.includes(status)) {
    throw new Error(`illegal transition ${rec.status} → ${status} for ${id} (allowed: ${settable.join(', ') || 'none'})`)
  }
  const allowedArtifacts =
    status === 'proposed' ? new Set(['proposal', 'manifest']) : status === 'applied' ? new Set(['application']) : status === 'verified' ? new Set(['verification']) : new Set<string>()
  const unexpectedArtifact = ARTIFACT_FLAGS.find((name) => flags[name] !== undefined && !allowedArtifacts.has(name))
  if (unexpectedArtifact) throw new Error(`--${unexpectedArtifact} is not valid when setting ${status}`)
  let patch: Parameters<SuggestionStore['transition']>[2]
  if (status === 'proposed') {
    if (!proposalPath) throw new Error('--proposal <id>.md is required when setting proposed')
    const workspace = await currentWorkspaceIdentity()
    if (manifestPath) await assertEvidenceWorkspace(rec, workspace)
    const proposal = await loadProposalArtifacts(store.proposalsDir, rec.id, proposalPath, manifestPath, workspace)
    patch = {
      proposal: manifestPath ? proposal : { ...proposal, title: rec.title, change: `see ${proposal.proposalPath}` },
    }
  } else if (status === 'applied') {
    if (!applicationPath) throw new Error('--application <id>.applied.json is required when setting applied')
    const proposal = await assertWorkspaceMatch(rec)
    const application = await loadApplicationReceipt(store.proposalsDir, rec.id, applicationPath, proposal.files)
    const { next, baselineFreeze } = await transitionApplied(store, rec, application, deps.cohort ?? createCohortDeps(), flags)
    // baselineFreeze is a key of this output only: the store line has no such field.
    if (flagBool(flags, 'json')) return emit(visible({ ...next, baselineFreeze }, flags), flags) as unknown as void
    return printRecord(visible(next, flags))
  } else if (status === 'verified') {
    if (rec.scope === 'global') throw new Error(`suggestion ${id}: global suggestions are review-only and cannot be verified`)
    if (!rec.application) throw new Error(`suggestion ${id} has no validated application receipt to verify`)
    if (!rec.proposal?.verificationChecks?.length) {
      throw new Error(`suggestion ${id} has no reviewed structured verification checks`)
    }
    if (!rec.proposal.workspace) throw new Error(`suggestion ${id} has no canonical proposal workspace`)
    const effect = await measureCohortEffect(rec, await store.all(), deps.cohort ?? createCohortDeps())
    if (verificationPath) {
      const { selectors } = await loadVerificationIntent(store.proposalsDir, rec.id, verificationPath, rec.proposal.verificationChecks)
      for (const selector of selectors) {
        if (!(await inLaterCohort(selector, effect))) {
          throw new Error(`verification intent names ${selector}, which is not in the later cohort orangu measured`)
        }
      }
    }
    patch = verificationPatch(effect)
  } else if (status === 'rejected') {
    // A record with no proposal workspace keeps the folder of its evidence sessions, when they all agree on 1.
    const workspaceCwd = await rejectWorkspaceCwd(rec, deps.rejectWorkspace)
    patch = { ...(reasonCode ? { reasonCode } : {}), ...(workspaceCwd ? { workspaceCwd } : {}) }
  }
  const next = await store.transition(id, status, patch)
  if (flagBool(flags, 'json')) return emit(visible(next, flags), flags) as unknown as void
  printRecord(visible(next, flags))
}

/** Whether the apply step froze the baseline, and why not when it did not. A key of the `--set applied --json` output. */
type BaselineFreeze = { frozen: true } | { frozen: false; reason: string }

/**
 * The apply move, with the baseline frozen just before it. The freeze never fails the apply step. When the baseline
 * read fails, or the store refuses the frozen baseline, the move goes ahead without one. The result says so, and 1
 * stderr line says so unless `--quiet` silences it. The record then reads its baseline sessions live at each check,
 * as a record of an older orangu does.
 */
async function transitionApplied(
  store: SuggestionStore,
  rec: SuggestionRecord,
  application: SuggestionApplicationReceipt,
  cohort: FreezeDeps,
  flags: Record<string, string | boolean>,
): Promise<{ next: SuggestionRecord; baselineFreeze: BaselineFreeze }> {
  let frozenBaseline: SuggestionFrozenBaseline | undefined
  let notFrozen: unknown
  try {
    frozenBaseline = await freezeBaseline(rec, await store.all(), cohort)
  } catch (error) {
    notFrozen = error
  }
  let next: SuggestionRecord
  try {
    next = await store.transition(rec.id, 'applied', { application, ...(frozenBaseline ? { frozenBaseline } : {}) })
  } catch (error) {
    // The store checks the frozen baseline again, and its cut against the application time that the store stamps. A
    // wall clock that steps back between the 2 calls can fail that check. Any other refusal is not about the freeze.
    if (!frozenBaseline || !(error instanceof Error) || !FROZEN_BASELINE_REFUSAL_RE.test(error.message)) throw error
    notFrozen = error
    next = await store.transition(rec.id, 'applied', { application })
  }
  if (notFrozen === undefined) return { next, baselineFreeze: { frozen: true } }
  const reason = terminal(notFrozen instanceof Error ? notFrozen.message : String(notFrozen))
  if (!flagBool(flags, 'quiet')) {
    // The same scrub as the JSON value: an error can name a directory under the home folder.
    process.stderr.write(`  orangu did not freeze the baseline (${visible(reason, flags)}). The change is applied, and each check reads the baseline sessions again.\n`)
  }
  return { next, baselineFreeze: { frozen: false, reason } }
}

/**
 * `--record <id>`: the record step. Orangu measures both cohorts again with the trusted loaders and stores a final
 * verdict that is not `verified`: `regressed` for a `regressed` verdict, else `unproven`. It takes no artifact, no
 * verdict and no text. A verdict that is not final, or a win, exits 1 with the step to take instead.
 */
async function cmdRecord(store: SuggestionStore, id: string, positionals: string[], flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  if (positionals.length) throw new Error('--record takes no status. Orangu measures the verdict itself')
  const artifact = ARTIFACT_FLAGS.find((name) => flags[name] !== undefined)
  if (artifact) throw new Error(`--${artifact} is not valid with --record`)
  const rec = await store.get(id)
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`)
  // Before any read, as --set verified refuses it: a global record is review-only.
  if (rec.scope === 'global') throw new Error(`suggestion ${id}: global suggestions are review-only and cannot be verified`)
  if (rec.status !== 'applied') throw new Error(`suggestion ${id} is not applied (status ${rec.status})`)
  const effect = await measureCohortEffect(rec, await store.all(), deps.cohort ?? createCohortDeps())
  const patch = outcomePatch(effect)
  const next = await store.transition(id, effect.verdict === 'regressed' ? 'regressed' : 'unproven', patch)
  if (flagBool(flags, 'json')) return emit(visible(next, flags), flags) as unknown as void
  printRecord(visible(next, flags))
}

async function cmdCreate(store: SuggestionStore, positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  // A file-mode kickoff command is `/orangu:improve <sg_id> --rule … --scope … --session …`.
  // The store accepts that report id only when it hashes to this exact finding.
  const explicitId = positionals[0]
  if (explicitId !== undefined && !/^sg_[0-9a-f]{12}$/.test(explicitId)) {
    throw new Error(`"${explicitId}" is not a suggestion id (sg_ + 12 hex chars). See: orangu suggest --list`)
  }
  const token = flagStr(flags, 'finding')
  let finding: Finding
  let source: 'report' | 'skill'
  if (token) {
    const decoded = decodeFinding(token)
    finding = decoded.finding
    source = decoded.source
    const canonicalId = suggestionIdV2(suggestionKey(finding, source))
    if (explicitId && explicitId !== canonicalId) {
      throw new Error(`suggestion id mismatch: encoded finding hashes to ${canonicalId}`)
    }
  } else {
    // Legacy file-command flags remain accepted. Their explicit v1 report id is hash-checked;
    // an id-less manual create mints a canonical v2 skill suggestion.
    const ruleId = flagStr(flags, 'rule')
    const scope = (flagStr(flags, 'scope') ?? 'session') as SuggestionScope
    const sessions = (flagStr(flags, 'session', 's') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (!ruleId || !sessions.length) {
      throw new Error('usage: orangu suggest [<sg_id>] --finding <token> OR --rule <ruleId> --scope session|repo|global --session <a,b> [--cohort <16hex>]')
    }
    if (!SCOPES.includes(scope)) throw new Error(`--scope must be ${SCOPES.join('|')}, got "${scope}"`)
    const cohort = flags['cohort']
    if (cohort !== undefined && (typeof cohort !== 'string' || !/^[0-9a-f]{16}$/.test(cohort))) {
      throw new Error('--cohort must be exactly 16 lowercase hexadecimal characters')
    }
    if (scope === 'session' && cohort !== undefined) throw new Error('--cohort is valid only with --scope repo|global')
    const cohortFingerprint = scope === 'session' ? undefined : cohort ?? sessionCohortFingerprint(sessions)
    finding = {
      ruleId,
      title: flagStr(flags, 'title') ?? ruleId,
      scope,
      sessionIds: sessions,
      ...(flagStr(flags, 'insight') ? { insightId: flagStr(flags, 'insight') } : {}),
      ...(cohortFingerprint ? { cohortFingerprint } : {}),
      evidence: { estimated: true },
    }
    source = explicitId ? 'report' : 'skill'
  }
  const { record, created } = await store.upsertNew(finding, source, explicitId)
  const command = kickoffCommand(record, 'serve')
  const catalog = matchRule(record.ruleId)
  if (flagBool(flags, 'json')) return emit(visible({ record, created, command, catalog }, flags), flags) as unknown as void
  printRecord(visible(record, flags))
  printCatalog(catalog)
  process.stdout.write(`  ${created ? 'created' : 'already existed'}. Continue with:\n    ${command}\n`)
}

/** A compatibility intent may name a later session by full id or by transcript path; either must be in the cohort. */
async function inLaterCohort(selector: string, effect: CohortEffect): Promise<boolean> {
  const value = selector.trim()
  if (SESSION_ID_RE.test(value)) return effect.later.some((session) => session.id === value.toLowerCase())
  let canonical: string
  try {
    canonical = await realpath(value)
  } catch {
    return false
  }
  for (const session of effect.later) {
    try {
      if ((await realpath(session.path)) === canonical) return true
    } catch {
      // a session that vanished after it was measured cannot be named
    }
  }
  return false
}

function effectView(effect: CohortEffect) {
  // The checkpoint of the verdict, whether a step can record it now, and a hint that orangu computes on each read and
  // never stores.
  const { checkpoint, final, leaning } = effectFinality(effect)
  return {
    id: effect.id,
    scope: effect.scope,
    verdict: effect.verdict,
    checkpoint,
    final,
    ...(leaning ? { leaning } : {}),
    appliedAt: effect.appliedAt,
    baseline: { n: effect.baseline.length, ids: effect.baseline.map((session) => session.id) },
    // n and ids are the graded later sessions, and count is every later session so far.
    later: { n: effect.later.length, ids: effect.later.map((session) => session.id), complete: effect.laterComplete, count: effect.laterCount },
    checks: effect.checks,
    confoundedBy: effect.confoundedBy,
    skipped: effect.skipped,
    next: nextStep(effect),
  }
}

async function cmdEffect(store: SuggestionStore, id: string, flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`)
  const effect = await measureCohortEffect(rec, await store.all(), deps.cohort ?? createCohortDeps())
  const view = visible(effectView(effect), flags)
  if (flagBool(flags, 'json')) return emit(view, flags) as unknown as void
  const w = (s: string) => process.stdout.write(s + '\n')
  // later.n is the graded later sessions, and later.count is every later session so far.
  w(`  ${terminal(view.id)}  later sessions vs baseline · ${view.baseline.n} before, ${view.later.n} after the change, of ${view.later.count} later sessions so far`)
  for (const check of view.checks) w(`    ${terminal(check.evidence)}`)
  if (view.confoundedBy.length) w(`    measured together with: ${view.confoundedBy.map(terminal).join(', ')} (not attributable to this change alone)`)
  const skipped = Object.entries(view.skipped).filter(([, count]) => count > 0)
  if (skipped.length) w(`    skipped: ${skipped.map(([reason, count]) => `${reason} ${count}`).join(', ')}`)
  w(`  verdict: ${view.verdict}`)
  w(`  next: ${terminal(view.next)}`)
}

/** The workspace folder of a read: `--cwd <dir>`, or the current folder. */
function workspaceDir(flags: Record<string, string | boolean>): string {
  const value = flags['cwd']
  if (value === undefined) return process.cwd()
  if (typeof value !== 'string' || !value) throw new Error('--cwd requires a folder')
  return value
}

/** Refuse, before any read, a read option that this read does not take, so no option goes unread. */
function assertReadOptions(step: ReadStep, flags: Record<string, string | boolean>): void {
  if (step === 'todo' && flags['all'] !== undefined) {
    throw new Error('--todo reads 1 workspace, so it takes no --all. Name the workspace with --cwd <dir>. The default is the current folder.')
  }
  const takes: readonly string[] = READS[step].takes
  const other = READ_OPTIONS.find((name) => flags[name] !== undefined && !takes.includes(name))
  if (other) throw new Error(`--${other} is not valid with --${step}. usage: orangu suggest ${READS[step].usage}`)
}

/** The scope of `--queue`: 1 workspace (`--cwd <dir>`, the default) or every workspace (`--all`). */
function queueTarget(flags: Record<string, string | boolean>): QueueTarget {
  if (flags['all'] === undefined) return { cwd: workspaceDir(flags) }
  if (flags['cwd'] !== undefined) throw new Error('--cwd and --all name 2 different scopes. Give 1 of them.')
  return 'all'
}

/** The scope of `--lessons` and `--history`: the scope of `--queue`, or only the global records (`--scope global`). */
function lessonTarget(flags: Record<string, string | boolean>): LessonTarget {
  const scope = flags['scope']
  if (scope === undefined) return queueTarget(flags)
  if (scope !== 'global') throw new Error('--scope takes only global here. It reads the global records, which belong to no workspace.')
  if (flags['cwd'] !== undefined || flags['all'] !== undefined) throw new Error('--scope global reads only the global records, so it takes no --cwd and no --all.')
  return 'global'
}

/** The rule ids of `--rule <id>[,<id>]`, or undefined for every rule. */
function ruleFilter(flags: Record<string, string | boolean>): string[] | undefined {
  const value = flags['rule']
  if (value === undefined) return undefined
  const rules = typeof value === 'string' ? value.split(',').map((rule) => rule.trim()).filter(Boolean) : []
  if (!rules.length) throw new Error('--rule requires 1 or more rule ids')
  return rules
}

/**
 * The deps of 1 read: the clock of this read, the queue check loaders behind the cohort facts cache (none with
 * `--no-cache` or `ORANGU_NO_CACHE=1`), and the discovery of every Claude root.
 */
function readDeps(flags: Record<string, string | boolean>, deps: SuggestDeps): QueueReadDeps {
  if (deps.read) return deps.read
  const cacheOn = !(flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1')
  return createQueueReadDeps({ now: Date.now(), cache: cacheOn ? new CohortFactsCache({ version: VERSION }) : null })
}

const textWidth = (): number => layoutWidth(detectCaps(process.stdout, process.env))

/** `--queue`: the open records of 1 workspace or of every workspace, in 6 groups. No cap: a person reads it. */
async function cmdQueue(store: SuggestionStore, flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  assertReadOptions('queue', flags)
  const target = queueTarget(flags)
  const queue = await readQueue(store, target, readDeps(flags, deps))
  const width = textWidth()
  process.stdout.write(readOutput(queue, flags, (shown) => queueLines(shown, width)))
}

/** `--todo`: the open items of 1 workspace that need a step, for a skill. `TODO_MAX_BYTES` of the exact output. */
async function cmdTodo(store: SuggestionStore, flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  assertReadOptions('todo', flags)
  const cwd = workspaceDir(flags)
  const output = (read: TodoRead): string => readOutput(read, flags, todoLines)
  const todo = await readTodo(store, cwd, readDeps(flags, deps), { measure: (read) => outputBytes(output(read)) })
  process.stdout.write(output(todo))
}

/** `--lessons`: the lesson read, the newest lessons that fit `LESSONS_MAX_BYTES` of the exact output. */
async function cmdLessons(store: SuggestionStore, flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  assertReadOptions('lessons', flags)
  const target = lessonTarget(flags)
  const rules = ruleFilter(flags)
  const width = textWidth()
  const output = (read: LessonRead): string => readOutput(read, flags, (shown) => lessonLines(shown, width))
  const read = await readLessons(store, target, readDeps(flags, deps), { ...(rules ? { rules } : {}), measure: (lessons) => outputBytes(output(lessons)) })
  process.stdout.write(output(read))
}

/** `--history`: 1 change row for each applied record of the scope, oldest first. */
async function cmdHistory(store: SuggestionStore, flags: Record<string, string | boolean>, deps: SuggestDeps): Promise<void> {
  assertReadOptions('history', flags)
  const target = lessonTarget(flags)
  const rules = ruleFilter(flags)
  const rows = await readHistory(store, target, readDeps(flags, deps), rules ? { rules } : {})
  const width = textWidth()
  process.stdout.write(readOutput(rows, flags, (shown) => historyLines(shown, width)))
}

export async function cmdSuggest(positionals: string[], flags: Record<string, string | boolean>, deps: SuggestDeps = {}): Promise<void> {
  // A reason code belongs to a rejection only. Refuse it, before any read or write, on every other step and with each
  // step flag that the dispatch below runs before --set, so no step ignores it.
  if (flags['reason'] !== undefined) {
    const runsBeforeSet = flagBool(flags, 'list') || flagStr(flags, 'show') || flagStr(flags, 'effect') || flags['record'] !== undefined
    if (runsBeforeSet || !(flagStr(flags, 'set') && positionals[0] === 'rejected')) {
      throw new Error('--reason is valid only with --set <id> rejected, and with no other step. usage: orangu suggest --set <id> rejected --reason <code>')
    }
  }
  // 1 step for each call, before any read or write: the dispatch below runs only the first step, so a second one would
  // go unread. A status filter belongs to --list only, for the same reason.
  const steps = STEP_FLAGS.filter((name) => flags[name] !== undefined)
  if (steps.length > 1) {
    throw new Error(`orangu suggest runs 1 step at a time, and this call has ${steps.length}: ${steps.map((name) => `--${name}`).join(', ')}. usage: orangu suggest <step> [<options>] (orangu help all lists each step)`)
  }
  if (flags['status'] !== undefined && flags['list'] === undefined) {
    throw new Error('--status is valid only with --list. usage: orangu suggest --list --status <s>[,<s>]')
  }
  const store = new SuggestionStore()
  if (flags['queue'] !== undefined) return cmdQueue(store, flags, deps)
  if (flags['todo'] !== undefined) return cmdTodo(store, flags, deps)
  if (flags['lessons'] !== undefined) return cmdLessons(store, flags, deps)
  if (flags['history'] !== undefined) return cmdHistory(store, flags, deps)
  if (flagBool(flags, 'list')) return cmdList(store, flags)
  const show = flagStr(flags, 'show')
  if (show) return cmdShow(store, show, flags)
  const effect = flagStr(flags, 'effect')
  if (effect) return cmdEffect(store, effect, flags, deps)
  if (flags['record'] !== undefined) {
    const record = flagStr(flags, 'record')
    if (!record) throw new Error('--record requires a suggestion id')
    return cmdRecord(store, record, positionals, flags, deps)
  }
  const set = flagStr(flags, 'set')
  if (set) return cmdSet(store, set, positionals, flags, deps)
  return cmdCreate(store, positionals, flags)
}
