/**
 * The one place `analyze --json` output is produced. Redaction is DEFAULT-ON (policy): secrets/emails in
 * previews and summaries are masked and the home-directory prefix in paths becomes `~` (absolute
 * home paths reveal the username) unless --no-redact; --strip-paths is the stronger opt-in (basenames).
 * --slim emits the SlimAnalysis projection: the shape LLM consumers (skills) read. --quiet: compact JSON.
 */
import type { Analysis } from '../model/analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'
import { redactAnalysis, redactValue } from '../redact/redact.js'
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

function encodedProjectLeaf(value: string): string {
  // Claude project directories encode every path separator as "-". Walk from
  // the end so redaction markers such as ‹anthropic-key› remain one safe unit.
  let inMarker = false
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] === '›') inMarker = true
    else if (value[i] === '‹') inMarker = false
    else if (value[i] === '-' && !inMarker) return value.slice(i + 1) || 'project'
  }
  return value
}

/** Project fields include Claude's lossy encoded absolute-path slugs, which defeat normal $HOME rewriting. */
function sanitizeAggregateProjectIdentities(a: Aggregate, stripPaths: boolean): Aggregate {
  const shorten = (value: string): string => {
    if (value.startsWith('-') || /^[A-Za-z]--/.test(value)) return encodedProjectLeaf(value)
    if (stripPaths && (value.includes('/') || value.includes('\\'))) return value.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project'
    return value
  }
  const row = (value: Aggregate['sessions'][number]): Aggregate['sessions'][number] =>
    value.project === undefined ? value : { ...value, project: shorten(value.project) }
  return {
    ...a,
    byProject: a.byProject.map((value) => ({ ...value, key: shorten(value.key) })),
    sessions: a.sessions.map(row),
    topSessions: a.topSessions.map(row),
  }
}

declare const PREPARED_AGGREGATE: unique symbol
export type PreparedAggregate = Aggregate & { readonly [PREPARED_AGGREGATE]: true }

/** One default-on confidentiality boundary shared by human, JSON, and file aggregate output. */
export function prepareAggregateForOutput(a: Aggregate, flags: Record<string, string | boolean>): PreparedAggregate {
  if (flagBool(flags, 'no-redact')) return a as PreparedAggregate
  const stripPaths = flagBool(flags, 'strip-paths')
  const redacted = redactValue(a, { scrub: true, stripPaths })
  return sanitizeAggregateProjectIdentities(redacted, stripPaths) as PreparedAggregate
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
