/**
 * Assembles the `HarnessReport` from an already-collected inventory and already-computed analyses.
 *
 * The only thing this module adds on top of `collect` + `crosswalk` is the envelope and the `notes[]`:
 * every miss the collector swallowed, and every drift the crosswalk measured, surfaces here as a
 * human-readable line instead of an exception. That is the "never crashes on schema drift" promise, applied
 * to configuration rather than to transcripts.
 *
 * `now` is INJECTED, never read: no clock call appears in this module or anywhere under `src/harness/`, which
 * `test/lint.test.ts` ratchets, so the same inputs always produce the same bytes.
 */
import { redactValue } from '../redact/redact.js'
import type { Analysis } from '../model/analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'
import { crosswalk } from './crosswalk.js'
import { HARNESS_SCHEMA_VERSION } from './types.js'
import type { HarnessCrosswalk, HarnessInventory, HarnessReport } from './types.js'

export interface HarnessReportScope {
  /** the repo whose `.claude/` was read */
  cwd: string
  /** the Claude config roots that were scanned */
  roots: string[]
  global: boolean
  /** the sessions cap that was applied */
  limit: number
  /** sessions that could not be analyzed. Counted and noted, never an error. */
  sessionsUnreadable?: number
  /** rewritten to `~` wherever it prefixes `cwd` or a root; not emitted */
  home?: string
}

export interface BuildHarnessReportOptions {
  version: string
  /** epoch ms, injected by the caller; this module never reads a clock */
  now: number
  scope: HarnessReportScope
}

/** `1 session` / `2 sessions`: the one plural helper the harness surfaces share (src/cli/commands/harness.ts too) */
export function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** deterministic: same inventory + same crosswalk always yields the same lines in the same order */
function buildNotes(inv: HarnessInventory, x: HarnessCrosswalk, sessionsScanned: number, sessionsUnreadable: number): string[] {
  const notes: string[] = []

  const declaredNothing =
    inv.settings.length === 0 && inv.skills.length === 0 && inv.agents.length === 0 && inv.plugins.length === 0 && inv.mcpServers.length === 0 && inv.claudeMd.length === 0
  if (declaredNothing) notes.push('no harness config found under the scanned roots. Nothing to cross-reference')

  if (!inv.usageCounters) {
    notes.push('~/.claude.json was not read, so client-side usage counters are omitted; declared vs used is classified from session evidence only')
  }
  if (inv.unreadable.length > 0) {
    notes.push(`${plural(inv.unreadable.length, 'configured path')} could not be read. See inventory.unreadable for the reason of each`)
  }
  if (sessionsScanned === 0) {
    notes.push('no sessions in scope, so every crosswalk row is config-only and nothing can be classified used')
  }
  if (sessionsUnreadable > 0) {
    notes.push(`${plural(sessionsUnreadable, 'session')} could not be analyzed and ${sessionsUnreadable === 1 ? 'is' : 'are'} not reflected in the crosswalk`)
  }
  if (x.models.configured && !x.models.matchesConfigured) {
    notes.push(`configured model "${x.models.configured}" does not appear among the models these sessions used`)
  }
  if (x.effort.configured && !x.effort.matchesConfigured) {
    notes.push(`configured effort "${x.effort.configured}" does not appear among the effort levels these sessions used`)
  }
  const undeclared =
    x.skills.filter((s) => s.status === 'undeclared').length +
    x.mcpServers.filter((m) => m.status === 'undeclared').length +
    x.agents.filter((a) => a.status === 'undeclared').length +
    x.hooks.filter((h) => h.status === 'undeclared').length
  if (undeclared > 0) {
    notes.push(`${plural(undeclared, 'row')} marked undeclared: observed in sessions but not found in the config that was read (a source outside this scope, or drift)`)
  }
  return notes
}

export function buildHarnessReport(inv: HarnessInventory, analyses: Analysis[], agg: Aggregate, o: BuildHarnessReportOptions): HarnessReport {
  // NOT `?? ''`: an empty string is not nullish, so it would defeat redactValue's own $HOME fallback AND
  // make homeRegExp() return null: a caller that omitted scope.home would emit absolute private paths in a
  // payload designed to be written to a file and handed to plugin agents.
  const home = o.scope.home || process.env['HOME'] || process.env['USERPROFILE'] || undefined
  const rel = (p: string): string => redactValue(p, home ? { home } : {})
  const sessionsUnreadable = o.scope.sessionsUnreadable ?? 0
  // the same home the inventory paths were written with, so `~/…` rows can be joined against session reads
  const x = crosswalk(inv, analyses, agg, home ? { home } : {})

  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    generator: { name: 'orangu', version: o.version, generatedAt: o.now },
    scope: {
      cwd: rel(o.scope.cwd),
      roots: o.scope.roots.map(rel),
      global: o.scope.global,
      limit: o.scope.limit,
      sessionsScanned: analyses.length,
      sessionsUnreadable,
    },
    inventory: inv,
    crosswalk: x,
    notes: buildNotes(inv, x, analyses.length, sessionsUnreadable),
  }
}
