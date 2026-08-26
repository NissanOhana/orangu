/**
 * The harness report contract.
 *
 * `orangu harness --json` emits exactly this object: what the user's Claude Code configuration DECLARES
 * (the `inventory`), crossed against what their sessions actually DID (the `crosswalk`).
 *
 * Discipline, mirroring `src/suggest/types.ts`: platform-neutral, **no `node:` imports**, so the shape can be
 * imported from any bundle. Deterministic by construction: the builder takes an injected `now`, every array is
 * explicitly sorted then capped, and nothing here is a judgement: a row carries a `status` and the measured
 * counts, never a recommendation. Recommendation text belongs to the optional plugin skills, not this layer.
 *
 * Units: `bytes` = bytes, `approxTokens` = bytes / 4, `*Ms` = milliseconds, `*At` = epoch ms, everything else
 * is a count. **There is no money field anywhere in this shape, by rule.** This layer speaks tokens and effort.
 *
 * Versioned independently of `ANALYSIS_SCHEMA_VERSION`: this is its own contract, and `Analysis` is untouched.
 */

export const HARNESS_SCHEMA_VERSION = '1'

/** every `crosswalk` array is bounded to this many rows, after an explicit sort */
export const HARNESS_ROW_CAP = 50

/**
 * The only classification this layer emits.
 * - `used`       : declared in a config we read AND observed in the scanned sessions
 * - `idle`       : declared, zero observations in the scanned window
 * - `undeclared` : observed in sessions but absent from every config we could read. That means
 *                  "not found in the config I read" (a source outside scope, or drift), never "a rogue tool".
 */
export type HarnessStatus = 'used' | 'idle' | 'undeclared'

/** which config file a declaration came from */
export type HarnessConfigScope = 'repo' | 'global' | 'repo-local' | 'global-local'

/** where a skill or agent definition lives */
export type HarnessOrigin = 'repo' | 'global' | 'plugin'

/** why a path the collector probed did not make it into the report. A miss is never an error. */
export type HarnessUnreadableReason = 'enoent' | 'eacces' | 'bad-json' | 'too-large' | 'other'

// ---------------------------------------------------------------------------------------------------------
// inventory: the declared side, read from the filesystem
// ---------------------------------------------------------------------------------------------------------

/** a memory file: CLAUDE.md, AGENTS.md, .claude/CLAUDE.md */
export interface HarnessMemoryFile {
  scope: 'repo' | 'global'
  file: string
  bytes: number
  approxTokens: number
  lines: number
  headings: number
}

export interface HarnessHookConfig {
  event: string
  matchers: number
  commands: number
  /** `basename(argv0)` ONLY: a hook command line carries arguments, and arguments carry secrets */
  commandBasenames: string[]
}

export interface HarnessSettingsFile {
  scope: HarnessConfigScope
  file: string
  /** TOP-LEVEL KEY NAMES ONLY, never a value */
  keys: string[]
  model?: string
  effortLevel?: string
  permissions: { allow: number; deny: number; ask: number; defaultMode?: string }
  hooks: HarnessHookConfig[]
  /** NAMES ONLY, never values */
  env: { count: number; names: string[] }
  statusLine: boolean
  cleanupPeriodDays?: number
  enabledPlugins: string[]
}

export interface HarnessSkillEntry {
  name: string
  origin: HarnessOrigin
  plugin?: string
  file: string
  bytes: number
  approxTokens: number
  descriptionChars: number
  allowedTools: string[] | null
  bodyLines: number
  hasReferences: boolean
}

export interface HarnessAgentEntry {
  name: string
  origin: HarnessOrigin
  plugin?: string
  file: string
  bytes: number
  approxTokens: number
  descriptionChars: number
  model?: string
  effort?: string
  tools: string[] | null
  disallowedTools: string[] | null
}

export interface HarnessPluginEntry {
  key: string
  name: string
  marketplace: string
  scope: string
  version?: string
  enabled: boolean
  skills: number
  agents: number
  commands: number
  hooks: number
  mcpServers: number
}

export type HarnessMcpScope = 'global' | 'project' | 'repo-file' | 'plugin'

export interface HarnessMcpServerEntry {
  name: string
  scope: HarnessMcpScope
  transport: string
  /** `basename(argv0)` ONLY, for the same reason as a hook command */
  commandBasename?: string
  enabled: boolean
}

/**
 * Optional client-maintained counters from `~/.claude.json`. Absent when that file is missing or unreadable,
 * a `notes[]` entry records the miss and this stays `undefined`.
 */
export interface HarnessUsageCounters {
  skills: Array<{ name: string; usageCount: number; lastUsedAt: number }>
  plugins: Array<{ key: string; usageCount: number; lastUsedAt: number }>
}

export interface HarnessInventoryTotals {
  filesRead: number
  bytesRead: number
  claudeMdBytes: number
  claudeMdApproxTokens: number
  skills: number
  agents: number
  plugins: number
  mcpServers: number
  hookCommands: number
}

export interface HarnessUnreadableEntry {
  path: string
  reason: HarnessUnreadableReason
}

/** Stable inventory contract. Add fields deliberately because consumers serialize this shape. */
export interface HarnessInventory {
  claudeMd: HarnessMemoryFile[]
  settings: HarnessSettingsFile[]
  skills: HarnessSkillEntry[]
  agents: HarnessAgentEntry[]
  plugins: HarnessPluginEntry[]
  mcpServers: HarnessMcpServerEntry[]
  usageCounters?: HarnessUsageCounters
  totals: HarnessInventoryTotals
  unreadable: HarnessUnreadableEntry[]
}

// ---------------------------------------------------------------------------------------------------------
// crosswalk: the declared side joined against the observed side (Analysis / Aggregate)
// ---------------------------------------------------------------------------------------------------------

/** derived from session `startedAt` values, NEVER from the clock */
export interface HarnessWindow {
  firstStartedAt?: number
  lastStartedAt?: number
}

export interface HarnessSkillRow {
  name: string
  origin?: string
  installed: boolean
  invocations: number
  sessions: number
  viaTool: number
  viaCommand: number
  status: HarnessStatus
}

export interface HarnessMcpRow {
  name: string
  configured: boolean
  toolCalls: number
  distinctTools: number
  sessions: number
  status: HarnessStatus
}

export interface HarnessAgentRow {
  name: string
  origin?: string
  defined: boolean
  dispatches: number
  sessions: number
  models: string[]
  status: HarnessStatus
}

export interface HarnessHookRow {
  event?: string
  commandBasename: string
  configured: boolean
  runs: number
  errors: number
  totalMs: number
  /**
   * Σ `totalMs` ÷ Σ `runs` across the scanned sessions, exact from what `HooksAnalysis.byCommand`
   * (`src/model/analysis.ts`) exposes. That field carries `count` and `totalMs`, never per-run durations, so a
   * percentile is not computable here and is deliberately not claimed: an approximation dressed up as a
   * percentile would be an invented figure. 0 when the command never ran.
   */
  meanMs: number
  status: HarnessStatus
}

export interface HarnessModelsCrosswalk {
  configured?: string
  seen: Array<{ model: string; requests: number; sessions: number }>
  matchesConfigured: boolean
}

export interface HarnessEffortCrosswalk {
  configured?: string
  seen: Array<{ effort: string; sessions: number }>
  slashEffortCommands: number
  matchesConfigured: boolean
}

export interface HarnessPermissionsCrosswalk {
  allowRules: number
  denyRules: number
  askRules: number
  defaultMode?: string
  promptEvents: number
  promptSessions: number
}

export interface HarnessMemoryRow {
  file: string
  bytes: number
  approxTokens: number
  reads: number
  sessions: number
  /** bytes / 4 × reads: the recurring weight this file puts into context across the window */
  approxTokensCarried: number
}

export interface HarnessListingRow {
  type: string
  sessions: number
  bytes: number
  approxTokens: number
  approxTokensPerSession: number
}

/**
 * Stable crosswalk contract. `status` is the only classification this shape carries: no `severity`,
 * `recommendation`, `title`, `detail`, or `findings`.
 */
export interface HarnessCrosswalk {
  window: HarnessWindow
  skills: HarnessSkillRow[]
  mcpServers: HarnessMcpRow[]
  agents: HarnessAgentRow[]
  hooks: HarnessHookRow[]
  models: HarnessModelsCrosswalk
  effort: HarnessEffortCrosswalk
  permissions: HarnessPermissionsCrosswalk
  claudeMd: HarnessMemoryRow[]
  injectedListings: HarnessListingRow[]
}

// ---------------------------------------------------------------------------------------------------------

export interface HarnessScope {
  /** ~-relativized */
  cwd: string
  /** ~-relativized */
  roots: string[]
  global: boolean
  /** the sessions cap that was applied */
  limit: number
  sessionsScanned: number
  /** sessions that could not be analyzed: counted, never an error */
  sessionsUnreadable: number
}

/** Six top-level keys. `generator.generatedAt` is the injected `now`, never a clock read. */
export interface HarnessReport {
  schemaVersion: string
  generator: { name: string; version: string; generatedAt: number }
  scope: HarnessScope
  inventory: HarnessInventory
  crosswalk: HarnessCrosswalk
  /** drift and skip notes, human-readable. A note is how this layer reports a miss instead of throwing. */
  notes: string[]
}
