/**
 * `orangu estimate`: the gate that runs BEFORE any LLM-facing read.
 * Prints how many bytes / ≈tokens the slim projection of the target sessions would put into a model's
 * context. Never reads a transcript into anything; it only sizes. Tokens are the whole answer: the
 * gate exists so nobody feeds a multi-MB analysis to a model by accident, and a token count is what
 * that decision turns on.
 *
 *   orangu estimate [<session>] [--depth quick|standard|deep] [--json]
 *   orangu estimate --suggestion <id> [--json]
 *   orangu estimate --rule <r> --session <a,b> [--json]
 *   orangu estimate harness [--cwd <dir>] [--root <dir>] [--global] [--limit <n>] [--json]
 *
 * The `harness` scope sizes the `orangu harness` report instead of a session projection.
 */
import { claudeRoots, resolveSession, findLatestSession, listSessions } from '../../discover/discover.js'
import { prevalidateEvidenceSession, readEvidenceSessionManifest } from '../../adapters/claude-code/evidence-input.js'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../analyze/analyze.js'
import { estimateFor } from '../../suggest/estimate.js'
import { CONFIRMATION_PUBLIC_KEY_ENV, verifyConfirmationReceipt } from '../../suggest/receipt.js'
import { slimAnalysis } from '../../suggest/slim.js'
import { SuggestionStore } from '../../suggest/store.js'
import { ESTIMATE_TOKEN_THRESHOLD, type ConfirmationReceiptResult, type Estimate, type SuggestionRecord } from '../../suggest/types.js'
import { flagBool, flagStr } from '../args.js'
import { runHarness } from './harness.js'
import type { Analysis } from '../../model/analysis.js'

declare const __ORANGU_VERSION__: string
const VERSION = typeof __ORANGU_VERSION__ !== 'undefined' ? __ORANGU_VERSION__ : '0.0.0-dev'

export type Depth = 'quick' | 'standard' | 'deep'

/** what each depth would feed the model: summary+insights only / the slim projection / the full Analysis */
export function depthBytes(a: Analysis, depth: Depth): number {
  if (depth === 'quick') return Buffer.byteLength(JSON.stringify({ session: a.session, summary: a.summary, insights: a.insights }))
  if (depth === 'deep') return Buffer.byteLength(JSON.stringify(a))
  return Buffer.byteLength(JSON.stringify(slimAnalysis(a)))
}

export async function loadAnalysisBySelector(sel: string): Promise<Analysis | undefined> {
  try {
    const value = sel.trim()
    const pathSelector = value.endsWith('.jsonl') || value.includes('/') || value.includes('\\')
    const ref = await resolveSession(value, pathSelector ? {} : { roots: await claudeRoots() })
    if (!ref) return undefined
    const manifest = await prevalidateEvidenceSession(ref.path)
    const loaded = await readEvidenceSessionManifest(manifest)
    const session = await parseClaudeCodeSession(loaded.parseInput)
    return analyzeSession(session, { version: VERSION, now: Date.now() })
  } catch {
    return undefined
  }
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
  if (positionals[0]) return [positionals[0]]
  const latest = await findLatestSession({})
  if (!latest) throw new Error('No sessions found. Try: orangu list')
  return [latest.path]
}

const fmtKb = (bytes: number) => (bytes / 1024).toFixed(1) + ' KB'

export async function cmdEstimate(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const depthRaw = flagStr(flags, 'depth') ?? 'standard'
  if (!['quick', 'standard', 'deep'].includes(depthRaw)) throw new Error(`--depth must be quick|standard|deep, got "${depthRaw}"`)
  const depth = depthRaw as Depth

  // `estimate harness` sizes the harness report itself rather than a session projection.
  if (positionals[0] === 'harness') {
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
  const loaded: Analysis[] = []
  const load = async (id: string) => {
    const a = await loadAnalysisBySelector(id)
    if (a) loaded.push(a)
    return a
  }
  let est: Estimate = await estimateFor(ids, load)
  if (depth !== 'standard') {
    // same sessions, different projection size; sessions/files counts stay
    const bytes = loaded.reduce((sum, a) => sum + depthBytes(a, depth), 0)
    const approxTokens = Math.ceil(bytes / 4)
    est = { ...est, bytes, approxTokens, overThreshold: approxTokens > ESTIMATE_TOKEN_THRESHOLD }
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

  printEstimate(est, depth)
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
  w('')
}
