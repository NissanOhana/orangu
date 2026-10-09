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
import { crosswalk, hasPrimaryView } from './crosswalk.js'
import { computeRetention, type RetentionSessionRef } from './retention.js'
import { buildEnforcement } from './enforcement.js'
import { HARNESS_SCHEMA_VERSION } from './types.js'
import type { HarnessCrosswalk, HarnessInventory, HarnessReport, HarnessRetention } from './types.js'

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
  /**
   * Every session discovered under the scanned roots, for the retention block. Deliberately the full
   * discovery and not the `--limit` slice the crosswalk was built from: what the cleanup sweep will delete
   * is a fact about the disk, not about how many sessions this run chose to analyze.
   */
  sessions: RetentionSessionRef[]
  /** the content words of the instruction files and memory notes in scope (CollectOptions.instructionWords) */
  instructionWords?: ReadonlySet<string>
  /** keep the prompt text of each enforcement example (`--include-text`) */
  includeText?: boolean
}

/** `1 session` / `2 sessions`: the one plural helper the harness surfaces share (src/cli/commands/harness.ts too) */
export function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/**
 * The one byte formatter the harness surfaces share, so a note and the printed line never disagree.
 * Scales to MB above a megabyte: a whole corpus of transcripts runs to hundreds of thousands of KB.
 */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/** deterministic: same inventory + same crosswalk always yields the same lines in the same order */
function buildNotes(inv: HarnessInventory, x: HarnessCrosswalk, r: HarnessRetention, sessionsScanned: number, sessionsUnreadable: number, unsplitAnalyses: number): string[] {
  const notes: string[] = []

  const declaredNothing =
    inv.settings.length === 0 && inv.skills.length === 0 && inv.agents.length === 0 && inv.plugins.length === 0 && inv.mcpServers.length === 0 && inv.claudeMd.length === 0
  if (declaredNothing) notes.push('orangu found no harness config under the scanned roots. It found nothing to compare')

  if (!inv.usageCounters) {
    notes.push('orangu did not read ~/.claude.json, so the report omits the client-side usage counters. orangu classifies declared vs used from session evidence only')
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
  if (unsplitAnalyses > 0) {
    const one = unsplitAnalyses === 1
    notes.push(
      `${unsplitAnalyses} ${one ? 'session was' : 'sessions were'} read from a cache written by an older orangu. That version did not separate the primary transcript from its subagent files, so the injected listings leave ${one ? 'it' : 'them'} out. Re-run with --no-cache to rebuild ${one ? 'it' : 'them'}`,
    )
  }
  // drift is a statement about what the sessions used; over zero sessions there is nothing to disagree with
  if (sessionsScanned > 0 && x.models.configured && !x.models.matchesConfigured) {
    notes.push(`configured model "${x.models.configured}" does not appear among the models these sessions used`)
  }
  if (sessionsScanned > 0 && x.effort.configured && !x.effort.matchesConfigured) {
    notes.push(`configured effort "${x.effort.configured}" does not appear among the effort levels these sessions used`)
  }
  const managedRead = inv.settings.some((s) => s.scope === 'managed')
  if (inv.settings.some((s) => s.scope === 'managed' && s.allowManagedHooksOnly)) {
    notes.push('managed settings set allowManagedHooksOnly, so hook commands from user, project, local and plugin settings do not run. Only managed hooks, and hooks from plugins that managed enabledPlugins force-enables, can be used')
  }
  // counted over the full population (`counts`), never over the capped row arrays
  const undeclared = x.counts.skills.undeclared + x.counts.mcpServers.undeclared + x.counts.agents.undeclared + x.counts.hooks.undeclared
  if (undeclared > 0) {
    notes.push(`${undeclared === 1 ? '1 row is' : `${undeclared} rows are`} marked undeclared. The sessions used ${undeclared === 1 ? 'it' : 'them'}, but the config that orangu read does not declare ${undeclared === 1 ? 'it' : 'them'}. The cause is a source outside this scope, or drift`)
    // the files on disk are the third of four managed sources Claude Code consults; say so where an operator is already looking at an unexplained row
    if (!managedRead) notes.push('managed settings can also arrive by MDM, a macOS configuration profile, or the claude.ai console. This inventory does not include a policy that arrives that way, because orangu reads only the managed files on disk')
  }
  if (r.expiringSoon.sessions > 0) {
    const one = r.expiringSoon.sessions === 1
    notes.push(
      `${plural(r.expiringSoon.sessions, 'session')} (${sizeLabel(r.expiringSoon.bytes)}) ${one ? 'is' : 'are'} within ${plural(r.expiringSoon.windowDays, 'day')} of the cleanupPeriodDays cutoff at ${plural(r.effectiveDays, 'day')}, after which Claude Code deletes the transcript`,
    )
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
  const retention = computeRetention(inv.settings, o.sessions, o.now)
  const unsplitAnalyses = analyses.filter((a) => !hasPrimaryView(a)).length

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
    retention,
    enforcement: buildEnforcement(analyses, {
      memoryIndexes: inv.memoryIndexes,
      ...(o.instructionWords ? { instructionWords: o.instructionWords } : {}),
      ...(o.includeText ? { includeText: true } : {}),
      norm: rel,
    }),
    notes: buildNotes(inv, x, retention, analyses.length, sessionsUnreadable, unsplitAnalyses),
  }
}
