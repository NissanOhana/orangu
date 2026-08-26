/**
 * The one place `analyze --json` output is produced. Redaction is DEFAULT-ON (policy): secrets/emails in
 * previews and summaries are masked and the home-directory prefix in paths becomes `~` (absolute
 * home paths reveal the username) unless --no-redact; --strip-paths is the stronger opt-in (basenames).
 * --slim emits the SlimAnalysis projection: the shape LLM consumers (skills) read. --quiet: compact JSON.
 */
import type { Analysis } from '../model/analysis.js'
import { redactAnalysis } from '../redact/redact.js'
import { slimAnalysis } from '../suggest/slim.js'
import { flagBool } from './args.js'

export function renderAnalysisJson(a: Analysis, flags: Record<string, string | boolean>): string {
  let out: Analysis = a
  if (!flagBool(flags, 'no-redact')) {
    out = redactAnalysis(a, { scrub: true, stripText: false, stripPaths: flagBool(flags, 'strip-paths') }).analysis
  }
  const body: unknown = flagBool(flags, 'slim') ? slimAnalysis(out) : out
  return JSON.stringify(body, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n'
}

export function emitAnalysisJson(a: Analysis, flags: Record<string, string | boolean>): void {
  process.stdout.write(renderAnalysisJson(a, flags))
}
