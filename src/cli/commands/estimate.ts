/**
 * `orangu estimate`: the gate that runs BEFORE any LLM-facing read.
 * Prints how many bytes / ≈tokens the target sessions would put into a model's context. Never reads
 * a transcript into anything; it only sizes. Tokens are the whole answer: the gate exists so nobody
 * feeds a multi-MB analysis to a model by accident, and a token count is what that decision turns on.
 *
 * One canonical projection: the evidence bundle, byte-identical to `orangu evidence <session> --estimate`
 * (same analysis inputs, clock-free). `--slim` sizes the one other read that still exists,
 * `orangu analyze --json --slim`. `--depth` was retired.
 *
 *   orangu estimate [<session>] [--slim] [--json]
 *   orangu estimate --suggestion <id> [--json]
 *   orangu estimate --rule <r> --session <a,b> [--json]
 *   orangu estimate harness [--cwd <dir>] [--root <dir>] [--global] [--limit <n>] [--json]
 *
 * The `harness` scope sizes the `orangu harness` report instead of a session projection.
 */
import { claudeRoots, resolveSession, findLatestSession, listSessions } from '../../discover/discover.js'
import { parseClaudeCodeSession , readStableEvidenceSession } from '../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../analyze/analyze.js'
import { estimateFor, type AnalysisLoad, type SizeProjection } from '../../suggest/estimate.js'
import { CONFIRMATION_PUBLIC_KEY_ENV, verifyConfirmationReceipt } from '../../suggest/receipt.js'
import { slimAnalysis } from '../../suggest/slim.js'
import { SuggestionStore } from '../../suggest/store.js'
import { ESTIMATE_TOKEN_THRESHOLD, type ConfirmationReceiptResult, type Estimate, type SuggestionRecord } from '../../suggest/types.js'
import { flagBool, flagStr } from '../args.js'
import { runHarness } from './harness.js'
import type { Analysis } from '../../model/analysis.js'

const SLIM_HARNESS = '--slim sizes a session projection; orangu estimate harness sizes the harness report'
const DEPTH_RETIRED = 'orangu estimate has one canonical projection (the evidence bundle); --depth was retired. Use --slim to size an `analyze --json --slim` read.'

/** the `analyze --json --slim` read; the default projection is the evidence bundle (see suggest/estimate.ts) */
const slimBytes: SizeProjection = (a) => Buffer.byteLength(JSON.stringify(slimAnalysis(a)))

/**
 * `analyzeOptions` defaults to the clock-free values `orangu evidence` uses (evidence.ts
 * bundleFromSession), so an estimate is byte-identical to `evidence --estimate`. `suggest --show`
 * passes the real version and clock because its output is shown, not sized.
 */
export async function loadAnalysisResult(
  sel: string,
  analyzeOptions: { version: string; now: number } = { version: 'evidence', now: 0 },
): Promise<AnalysisLoad> {
  const value = sel.trim()
  const pathSelector = value.endsWith('.jsonl') || value.includes('/') || value.includes('\\')
  let ref
  try {
    ref = await resolveSession(value, pathSelector ? {} : { roots: await claudeRoots() })
  } catch (err) {
    return { ok: false, reason: `session lookup failed: ${(err as Error).message}` }
  }
  if (!ref) return { ok: false, reason: 'no such session' }
  try {
    const loaded = await readStableEvidenceSession(ref.path)
    const session = await parseClaudeCodeSession(loaded.parseInput)
    return { ok: true, analysis: analyzeSession(session, analyzeOptions) }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/** `loadAnalysisResult` collapsed to the analysis; callers that only need presence (suggest --show). */
export async function loadAnalysisBySelector(
  sel: string,
  analyzeOptions?: { version: string; now: number },
): Promise<Analysis | undefined> {
  const loaded = await loadAnalysisResult(sel, analyzeOptions)
  return loaded.ok ? loaded.analysis : undefined
}

async function targetSessionIds(positionals: string[], flags: Record<string, string | boolean>): Promise<string[]> {
  const suggestionId = flagStr(flags, 'suggestion')
  if (suggestionId) {
    const rec = await new SuggestionStore().get(suggestionId)
    if (!rec) throw new Error(`suggestion ${suggestionId} not found (see: orangu suggest --list)`)
    return rec.sessionIds
  }
  const sessionsFlag = flagStr(flags, 'session', 's')
  if (sessionsFlag) return sessionsFlag.split(',').map((s) => s.trim()).filter(Boolean)
  // scope keywords, matching the other verbs: `estimate global` / `estimate repo` size every matching session
  if (positionals[0] === 'global' || positionals[0] === 'all') {
    return (await listSessions({})).map((r) => r.path)
  }
  if (positionals[0] === 'repo') {
    return (await listSessions({ cwd: flagStr(flags, 'cwd') ?? process.cwd() })).map((r) => r.path)
  }
  // `latest` is the documented default selector; resolve it like an absent selector does
  if (positionals.length > 0) {
    const sel = (positionals[0] ?? '').trim()
    // an empty selector must not fall through to `latest`: that is a silent answer about the wrong session
    if (!sel) throw new Error('session selector is empty')
    if (sel !== 'latest') return [sel]
  }
  const latest = await findLatestSession({})
  if (!latest) throw new Error('No sessions found. Try: orangu list')
  return [latest.path]
}

const fmtKb = (bytes: number) => (bytes / 1024).toFixed(1) + ' KB'

export async function cmdEstimate(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (flags['depth'] !== undefined) throw new Error(DEPTH_RETIRED)
  const slim = flagBool(flags, 'slim')

  // `estimate harness` sizes the harness report itself rather than a session projection.
  if (positionals[0] === 'harness') {
    if (slim) throw new Error(SLIM_HARNESS)
    const report = await runHarness({ ...flags, quiet: true })
    const bytes = Buffer.byteLength(JSON.stringify(report))
    const approxTokens = Math.ceil(bytes / 4)
    const est: Estimate = {
      sessions: report.scope.sessionsScanned,
      files: report.inventory.totals.filesRead,
      bytes,
      approxTokens,
      overThreshold: approxTokens > ESTIMATE_TOKEN_THRESHOLD,
    }
    if (flagBool(flags, 'json')) {
      process.stdout.write(JSON.stringify(est, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')
      return
    }
    printEstimate(est, 'harness')
    return
  }

  const receiptToken = flagStr(flags, 'receipt')
  const suggestionSelector = flagStr(flags, 'suggestion')
  if (receiptToken && !suggestionSelector) throw new Error('--receipt requires --suggestion <id>')
  let receiptRecord: SuggestionRecord | undefined
  if (receiptToken && suggestionSelector) {
    receiptRecord = await new SuggestionStore().get(suggestionSelector)
    if (!receiptRecord) throw new Error(`suggestion ${suggestionSelector} not found (see: orangu suggest --list)`)
  }

  const ids = await targetSessionIds(positionals, flags)
  const est: Estimate = await estimateFor(ids, (id) => loadAnalysisResult(id), slim ? slimBytes : undefined)
  // Nothing sized means the gate has no answer. Fail the way `orangu evidence --estimate` fails on the
  // same input, so the two gates never disagree; a clean 0 would read as "small enough".
  if (est.sessions === 0 && est.skipped && est.skipped.length > 0) {
    throw new Error(`no session could be projected:\n${est.skipped.map((s) => `  ${s.selector}: ${s.reason}`).join('\n')}`)
  }

  const confirmationReceipt: ConfirmationReceiptResult | undefined =
    receiptToken && receiptRecord
      ? verifyConfirmationReceipt({
          token: receiptToken,
          record: receiptRecord,
          estimate: est,
          publicKey: process.env[CONFIRMATION_PUBLIC_KEY_ENV],
          now: Date.now(),
        })
      : undefined
  const result = confirmationReceipt ? { ...est, confirmationReceipt } : est

  if (flagBool(flags, 'json')) {
    process.stdout.write(JSON.stringify(result, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')
    return
  }

  printEstimate(est, slim ? 'slim' : 'evidence')
  if (confirmationReceipt) {
    process.stdout.write(
      confirmationReceipt.valid
        ? `  confirmation receipt valid until ${new Date(confirmationReceipt.expiresAt!).toISOString()}\n\n`
        : `  confirmation receipt not accepted: ${confirmationReceipt.reason ?? 'unknown reason'}\n\n`,
    )
  }
}

/** The shared estimate block: bytes in, tokens out, and the ask-first gate. */
function printEstimate(est: Estimate, label: string): void {
  const w = (s: string) => process.stdout.write(s + '\n')
  w('')
  w(`estimate (${label})  ${est.sessions} session${est.sessions === 1 ? '' : 's'} · ${est.files} file${est.files === 1 ? '' : 's'}`)
  w(`  read size     ${fmtKb(est.bytes)}`)
  w(`  ≈ tokens      ${est.approxTokens.toLocaleString('en-US')}  (4 bytes/token)`)
  if (est.overThreshold) {
    w(`  ⚠ over the ~${ESTIMATE_TOKEN_THRESHOLD.toLocaleString('en-US')}-token gate. Ask the user before reading this into an LLM`)
  } else {
    w(`  under the ~${ESTIMATE_TOKEN_THRESHOLD.toLocaleString('en-US')}-token gate, small enough to read`)
  }
  if (est.skipped && est.skipped.length > 0) {
    w(`  ⚠ ${est.skipped.length} session${est.skipped.length === 1 ? '' : 's'} could not be projected and ${est.skipped.length === 1 ? 'is' : 'are'} not counted above:`)
    for (const s of est.skipped) w(`      ${s.selector}: ${s.reason}`)
  }
  w('')
}
