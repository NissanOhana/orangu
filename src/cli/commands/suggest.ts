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
 *   orangu suggest --set <id> verified --verification <id>.verified.json [--json]
 *   orangu suggest --list [--scope <s>] [--json]
 */
import { matchRule, type CatalogMatch } from '../../suggest/catalog.js'
import { realpath, stat } from 'node:fs/promises'
import { loadApplicationReceipt, loadProposalArtifacts, loadVerificationReceipt } from '../../suggest/artifacts.js'
import { decodeFinding, kickoffCommand, sessionCohortFingerprint, suggestionIdV2, suggestionKey } from '../../suggest/id.js'
import { redactAnalysis, redactValue } from '../../redact/redact.js'
import { slimAnalysis, type SlimAnalysis } from '../../suggest/slim.js'
import { SuggestionStore } from '../../suggest/store.js'
import { isTrustedComputedVerification } from '../../suggest/verification-policy.js'
import { MAX_EVIDENCE_LIMIT, projectEvidence } from '../../suggest/evidence.js'
import {
  TRANSITIONS,
  type Finding,
  type SuggestionProposal,
  type SuggestionRecord,
  type SuggestionScope,
  type SuggestionStatus,
  type SuggestionWorkspaceIdentity,
} from '../../suggest/types.js'
import { createDiscoveredClaudeAnalysisLoader } from '../../adapters/claude-code/discovered-analysis.js'
import { flagBool, flagStr } from '../args.js'
import { loadAnalysisBySelector } from './estimate.js'

async function currentWorkspaceIdentity(): Promise<{ cwd: string; device: string; inode: string }> {
  const cwd = await realpath(process.cwd())
  const info = await stat(cwd, { bigint: true })
  if (!info.isDirectory()) throw new Error(`current workspace is not a directory: ${cwd}`)
  return { cwd, device: String(info.dev), inode: String(info.ino) }
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
      throw new Error(`suggestion ${rec.id} evidence belongs to workspace ${canonical}; create the proposal from that exact workspace`)
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
    throw new Error(`suggestion ${rec.id} is global and proposal-only; global apply is not supported`)
  }
  if (rec.status !== 'proposed' || rec.proposal?.v !== 1 || !rec.proposal.manifestPath || !rec.proposal.files?.length) {
    throw new Error(`suggestion ${rec.id} is not an apply-ready structured proposal`)
  }
  if (!rec.proposal.workspace) throw new Error(`suggestion ${rec.id} is a legacy unbound proposal and cannot be applied`)
  const workspace = await currentWorkspaceIdentity()
  if (
    workspace.cwd !== rec.proposal.workspace.cwd ||
    workspace.device !== rec.proposal.workspace.device ||
    workspace.inode !== rec.proposal.workspace.inode
  ) {
    throw new Error(`suggestion ${rec.id} belongs to workspace ${rec.proposal.workspace.cwd}; run apply from that exact workspace`)
  }
  return rec.proposal as ApplyReadyProposal
}

const SCOPES: SuggestionScope[] = ['session', 'repo', 'global']
const STATUSES: SuggestionStatus[] = ['new', 'kicked-off', 'proposed', 'applied', 'verified', 'rejected', 'failed']

const emit = (v: unknown, flags: Record<string, string | boolean>) =>
  process.stdout.write(JSON.stringify(v, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')

function visible<T>(value: T, flags: Record<string, string | boolean>): T {
  return flagBool(flags, 'no-redact') ? value : redactValue(value, { scrub: true })
}

function terminal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

function printRecord(rec: SuggestionRecord): void {
  const w = (s: string) => process.stdout.write(s + '\n')
  const status = rec.status === 'verified' && !isTrustedComputedVerification(rec) ? 'legacy-unverified' : rec.status
  w(`  ${terminal(rec.id)}  [${terminal(status)}]  ${terminal(rec.title)}`)
  w(`    rule ${terminal(rec.ruleId)} · scope ${terminal(rec.scope)} · sessions ${rec.sessionIds.map((s) => terminal(s.slice(0, 8))).join(', ')}`)
  if (rec.proposal) w(`    proposal: ${terminal(rec.proposal.proposalPath)}`)
}

// Curated deterministic, offline catalog: known tool, skill, and feature entries for this finding.
function printCatalog(matches: CatalogMatch[]): void {
  const w = (s: string) => process.stdout.write(s + '\n')
  for (const m of matches) {
    const what = m.entry.tool ? `tool ${m.entry.tool}` : m.entry.skill ? `skill ${m.entry.skill}` : `feature ${m.entry.feature}`
    w(`    catalog ${m.entry.id}: ${what}${m.entry.url ? ` · ${m.entry.url}` : ''}${m.entry.verifiedAt ? ` · verified ${m.entry.verifiedAt}` : ' · candidate (unverified)'}`)
  }
}

async function cmdList(store: SuggestionStore, flags: Record<string, string | boolean>): Promise<void> {
  const scope = flagStr(flags, 'scope')
  let all = await store.all()
  if (scope) all = all.filter((r) => r.scope === scope)
  if (flagBool(flags, 'json')) return emit(visible(all, flags), flags) as unknown as void
  if (!all.length) {
    process.stdout.write('no suggestions yet. Create one from a report finding or: orangu suggest --rule <r> --scope session --session <id>\n')
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
    const a = await loadAnalysisBySelector(sel)
    if (!a) {
      missing.push(sel)
      continue
    }
    const body = flagBool(flags, 'no-redact') ? a : redactAnalysis(a, { scrub: true }).analysis
    sessions.push(slimAnalysis(body))
  }
  const catalog = matchRule(rec.ruleId, sessions)
  if (flagBool(flags, 'json')) {
    return emit(visible({
      record: rec,
      sessions,
      catalog,
      missingSessionIds: missing,
      ...(rec.status === 'verified' ? { verificationTrusted: isTrustedComputedVerification(rec) } : {}),
      ...(forApply ? { workspaceMatchesCurrent: true } : {}),
      ...(forProposal ? { proposalEligibility: rec.scope === 'global' ? 'global-proposal-only' : 'workspace-bound' } : {}),
    }, flags), flags) as unknown as void
  }
  printRecord(visible(rec, flags))
  printCatalog(catalog)
  process.stdout.write(`  evidence: ${sessions.length} session(s) loaded${missing.length ? `, ${missing.length} unresolvable` : ''}. Add --json for the slim data\n`)
}

async function cmdSet(store: SuggestionStore, id: string, positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const status = positionals[0] as SuggestionStatus | undefined
  if (!status || !STATUSES.includes(status)) throw new Error(`usage: orangu suggest --set <id> <${STATUSES.join('|')}>`)
  const proposalPath = flagStr(flags, 'proposal')
  const manifestPath = flagStr(flags, 'manifest')
  const applicationPath = flagStr(flags, 'application')
  const verificationPath = flagStr(flags, 'verification')
  const artifactNames = ['proposal', 'manifest', 'application', 'verification'] as const
  for (const name of artifactNames) {
    if (flags[name] !== undefined && typeof flags[name] !== 'string') throw new Error(`--${name} requires a file path`)
  }
  const rec = await store.get(id)
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`)
  if (!(TRANSITIONS[rec.status] ?? []).includes(status)) {
    throw new Error(`illegal transition ${rec.status} → ${status} for ${id} (allowed: ${(TRANSITIONS[rec.status] ?? []).join(', ') || 'none'})`)
  }
  const allowedArtifacts =
    status === 'proposed' ? new Set(['proposal', 'manifest']) : status === 'applied' ? new Set(['application']) : status === 'verified' ? new Set(['verification']) : new Set<string>()
  const unexpectedArtifact = artifactNames.find((name) => flags[name] !== undefined && !allowedArtifacts.has(name))
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
    patch = { application: await loadApplicationReceipt(store.proposalsDir, rec.id, applicationPath, proposal.files) }
  } else if (status === 'verified') {
    if (!verificationPath) throw new Error('--verification <id>.verified.json is required when setting verified')
    if (rec.scope !== 'session') {
      throw new Error(`suggestion ${id} has ${rec.scope} scope; later verification is currently supported only for one-session suggestions`)
    }
    if (!rec.application) throw new Error(`suggestion ${id} has no validated application receipt to verify`)
    if (!rec.proposal?.verificationChecks?.length) {
      throw new Error(`suggestion ${id} has no reviewed structured verification checks`)
    }
    if (!rec.proposal.workspace) throw new Error(`suggestion ${id} has no canonical proposal workspace`)
    const verified = await loadVerificationReceipt(store.proposalsDir, rec.id, verificationPath, {
      baselineSessionIds: rec.sessionIds,
      applicationStatusAt: rec.statusAt,
      expectedChecks: rec.proposal.verificationChecks,
      workspace: rec.proposal.workspace,
      loadAnalysis: createDiscoveredClaudeAnalysisLoader(undefined, { requireQuiet: true }),
    })
    patch = { verificationReceipt: verified.receipt, effect: verified.effect }
  }
  const next = await store.transition(id, status, patch)
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

export async function cmdSuggest(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const store = new SuggestionStore()
  if (flagBool(flags, 'list')) return cmdList(store, flags)
  const show = flagStr(flags, 'show')
  if (show) return cmdShow(store, show, flags)
  const set = flagStr(flags, 'set')
  if (set) return cmdSet(store, set, positionals, flags)
  return cmdCreate(store, positionals, flags)
}
