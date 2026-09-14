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

/** 2 (2026-09-14): listing rows split main vs subagent and name their population; hook rows may be event-only */
export const HARNESS_SCHEMA_VERSION = '2'

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

/** which config file a declaration came from; `managed` is organization policy, above every other scope */
export type HarnessConfigScope = 'managed' | 'repo' | 'global' | 'repo-local' | 'global-local'

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
  /** the sweep window Claude Code applies to `projects/`; present only when this file sets a numeric value */
  cleanupPeriodDays?: number
  /** the sweep window for Claude Desktop / Cowork transcripts, which carry no limit unless this is set */
  desktopSessionCleanupPeriodDays?: number
  /** managed policy only: when true, hook commands declared in user, project and plugin settings do not run */
  allowManagedHooksOnly?: boolean
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
  /** the plugin's `hooks/hooks.json`, basenames only, so a plugin hook joins like a settings one; absent when it declares none */
  hookConfigs?: HarnessHookConfig[]
}

export type HarnessMcpScope = 'managed' | 'global' | 'project' | 'repo-file' | 'plugin'

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
  /** `~/.claude.json` project entries that were read, whether or not they declared anything: the cwd's, or every entry under a global scan */
  projectEntries?: number
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
  /**
   * absent on an event-only row: the transcript recorded the run by name or event, so it can be joined to
   * the event a settings file declares but not to a command
   */
  commandBasename?: string
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

/** one side of an injected listing: the primary transcripts, or the subagent sidecars beneath them */
export interface HarnessListingShare {
  /** main sessions in scope whose transcripts on THIS side carried at least one injection */
  sessions: number
  injections: number
  bytes: number
  approxTokens: number
}

/**
 * What Claude Code injects at session start (skill and tool listings) and on the way (truncation notices),
 * counted over the population each field names. A ratio here always divides a numerator and a denominator
 * from the SAME side: the whole-tree bytes over the main-session count printed a figure larger than any
 * context window, which is the defect this shape replaced.
 */
export interface HarnessListingRow {
  type: string
  /** the primary transcript of each session: what the main context carries */
  main: HarnessListingShare
  /** the subagent sidecars folded under those sessions: what the agent tree carries */
  subagent: HarnessListingShare
  /** (main + subagent) bytes/4 ÷ (main + subagent) injections: the weight of ONE injection */
  approxTokensPerInjection: number
  /** main.approxTokens ÷ main.sessions: what the primary context of a session that carried it paid, per session */
  approxTokensPerMainSession: number
}

/** used / idle / undeclared over the FULL population of one axis, counted before `HARNESS_ROW_CAP` cuts its rows */
export interface HarnessStatusCounts {
  used: number
  idle: number
  undeclared: number
}

/**
 * Stable crosswalk contract. `status` is the only classification this shape carries: no `severity`,
 * `recommendation`, `title`, `detail`, or `findings`.
 */
export interface HarnessCrosswalk {
  window: HarnessWindow
  /**
   * The status counts of every axis over its whole population. The row arrays below are capped at
   * `HARNESS_ROW_CAP` after a sort that puts idle rows last, so a count taken from the rows under-reports idle
   * and can claim "every skill fired" on a machine where most never did. A surface reads these counts and uses
   * the rows for names only.
   */
  counts: { skills: HarnessStatusCounts; mcpServers: HarnessStatusCounts; agents: HarnessStatusCounts; hooks: HarnessStatusCounts }
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

/**
 * How much of the evidence orangu reads Claude Code is going to delete, and when.
 *
 * Every field is measured. `effectiveDays` is the window Claude Code applies to `projects/` (the transcripts,
 * their `subagents/` and their `tool-results/`, which is exactly orangu's evidence base); the auto-memory
 * directory beside them is not swept. Claude Desktop and Cowork transcripts are kept at any age unless a settings file gives them
 * their own limit, so they are counted apart instead of being folded into the at-risk number.
 *
 * There is no recommendation here and none is implied: a longer window keeps more history to measure, and
 * leaves plaintext transcripts on disk for longer. Both are true at once.
 */
export interface HarnessRetention {
  /** whole days; never below `RETENTION_MIN_DAYS`, because Claude Code rejects a smaller value */
  effectiveDays: number
  /** true when no settings file set a usable value, so the window is Claude Code's built-in default */
  isDefault: boolean
  /** which file the effective value came from; absent when `isDefault` */
  source?: { scope: HarnessConfigScope; file: string }
  /** settings files that carried a value too small or not whole to be a window. Counted, never an error. */
  invalidConfigured?: number
  /**
   * Sessions the sweep can reach. `bytes` is the primary transcript on disk: each session's `subagents/`
   * and `tool-results/` are swept with it and are NOT counted here, so the size is a floor, not a total.
   * The basis is every session the caller discovered under the scanned roots, which is not the same set as
   * `scope.sessionsScanned`: the CLI passes the full discovery while the `--limit` slice bounds the
   * crosswalk, so this count can legitimately exceed it.
   */
  sweepable: { sessions: number; bytes: number }
  /** Desktop/Cowork sessions, kept at any age unless `configuredDays` gives them a window */
  exempt: { sessions: number; bytes: number; configuredDays?: number }
  /** age of the oldest sweepable session, whole days; absent when nothing is sweepable */
  oldestSweepableDays?: number
  /** sweepable sessions inside the band `[effectiveDays - windowDays, effectiveDays)`: close, not yet past */
  expiringSoon: { sessions: number; bytes: number; windowDays: number }
  /**
   * Sweepable sessions already older than `effectiveDays`. The sweep should have taken them; a paused
   * sweep or a window that was just lowered is why they are still on disk. Measured, not an alarm.
   */
  pastCutoff: { sessions: number; bytes: number }
}

/** Seven top-level keys. `generator.generatedAt` is the injected `now`, never a clock read. */
export interface HarnessReport {
  schemaVersion: string
  generator: { name: string; version: string; generatedAt: number }
  scope: HarnessScope
  inventory: HarnessInventory
  crosswalk: HarnessCrosswalk
  /** what the configured cleanup window will delete out from under the crosswalk above */
  retention: HarnessRetention
  /** drift and skip notes, human-readable. A note is how this layer reports a miss instead of throwing. */
  notes: string[]
}
