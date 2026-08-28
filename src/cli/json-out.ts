/**
 * The one place `analyze --json` output is produced. Redaction is DEFAULT-ON (policy): secrets/emails
 * are masked, the home-directory prefix in paths becomes `~` (absolute home paths reveal the
 * username), and transcript text (prompt/result previews, Insight.detail) is stripped exactly as the
 * HTML report strips it, unless --include-text; --no-redact keeps everything; --strip-paths is the
 * stronger path opt-in (basenames). --slim emits the SlimAnalysis projection: the shape LLM consumers
 * (skills) read. --quiet: compact JSON.
 */
import type { Analysis } from '../model/analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'
import { redactAnalysis, redactValue } from '../redact/redact.js'
import { slimAnalysis } from '../suggest/slim.js'
import { flagBool } from './args.js'

export function renderAnalysisJson(a: Analysis, flags: Record<string, string | boolean>): string {
  let out: Analysis = a
  if (!flagBool(flags, 'no-redact')) {
    out = redactAnalysis(a, { scrub: true, stripText: !flagBool(flags, 'include-text'), stripPaths: flagBool(flags, 'strip-paths') }).analysis
  }
  const body: unknown = flagBool(flags, 'slim') ? slimAnalysis(out) : out
  return JSON.stringify(body, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n'
}

export function emitAnalysisJson(a: Analysis, flags: Record<string, string | boolean>): void {
  process.stdout.write(renderAnalysisJson(a, flags))
}

declare const PREPARED_AGGREGATE: unique symbol
export type PreparedAggregate = Aggregate & { readonly [PREPARED_AGGREGATE]: true }

/** One default-on confidentiality boundary shared by human, JSON, and file aggregate output. */
export function prepareAggregateForOutput(a: Aggregate, flags: Record<string, string | boolean>): PreparedAggregate {
  if (flagBool(flags, 'no-redact')) return a as PreparedAggregate
  // Project identities (byProject keys, sessions[].project) are Claude's encoded absolute-path slugs;
  // redactValue drops them to their leaf (src/redact/redact.ts projectIdentity) on every scrubbed output.
  // Transcript-derived text (sessions[].title = the first prompt, recurringErrors[].signature = raw error
  // output) leaves only with --include-text, exactly like `analyze --json`; rule-generated cross-finding
  // titles are kept by the per-record strip rule.
  return redactValue(a, {
    scrub: true,
    stripText: !flagBool(flags, 'include-text'),
    stripPaths: flagBool(flags, 'strip-paths'),
  }) as PreparedAggregate
}

/** Serialize an aggregate that has already crossed prepareAggregateForOutput. */
export function renderPreparedAggregateJson(
  a: PreparedAggregate,
  flags: Record<string, string | boolean>,
  options: { pretty?: boolean; trailingNewline?: boolean } = {},
): string {
  const body = JSON.stringify(a, null, (options.pretty ?? !flagBool(flags, 'quiet')) ? 2 : 0)
  return body + ((options.trailingNewline ?? true) ? '\n' : '')
}

/** Safe convenience boundary for callers that only need aggregate JSON. */
export function renderAggregateJson(
  a: Aggregate,
  flags: Record<string, string | boolean>,
  options: { pretty?: boolean; trailingNewline?: boolean } = {},
): string {
  return renderPreparedAggregateJson(prepareAggregateForOutput(a, flags), flags, options)
}
