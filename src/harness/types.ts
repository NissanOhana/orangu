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

/**
 * 2 (2026-09-14): listing rows split main vs subagent and name their population; hook rows may be event-only
 * 3 (2026-10-09): the `enforcement` section (rules in context against the calls that broke them, notes against the
 *   complaints after them, memory indexes against their load limit, recurring complaint words) and
 *   `inventory.memoryIndexes`
 */
export const HARNESS_SCHEMA_VERSION = '3'

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

/**
 * An auto-memory index (`<config>/projects/<slug>/memory/MEMORY.md`). Claude Code loads the first 200 lines or the
 * first 25,000 characters at session start, whichever comes first, and drops the rest: the newest entries, at the end.
 */
export interface HarnessMemoryIndexFile {
  file: string
  bytes: number
  /** the length that the 25,000 load limit counts */
  chars: number
  approxTokens: number
  lines: number
  /** lines that the next session will not load; 0 when the file fits */
  linesPastLimit: number
  /** 1-based line where the cut starts; absent when the file fits */
  firstLinePastLimit?: number
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
  /** the memory indexes in scope: the cwd's project (repo) or every project (global), plus each one a scanned session loaded */
  memoryIndexes: HarnessMemoryIndexFile[]
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

// ---------------------------------------------------------------------------------------------------------
// enforcement: what the instruction files and notes said, against what the sessions did
// ---------------------------------------------------------------------------------------------------------

/** an example the skill can open with `orangu analyze <sessionId>`; `preview` only under --include-text */
export interface HarnessPromptRef {
  sessionId: string
  turnIndex: number
  at?: number
  preview?: string
}

/**
 * A "do not" rule that was in the main context of a session, summed over the sessions that had it there.
 * In context means: in a file Claude Code loaded at start (the transcript records the list), counted from the
 * moment the session saw it, or in a note the session wrote, counted from the write. The rule identity is its
 * text and target, so the same line in a worktree copy of CLAUDE.md is one rule.
 */
export interface HarnessRuleRow {
  /** a file the rule was seen in: one with a known line first, then the shortest path (the main checkout) */
  file: string
  /** how many distinct files carried the same line */
  files: number
  /** 1-based; 0 when only a session's Edit wrote the rule, so no file line is known */
  line: number
  /** the whole instruction line, trimmed and scrubbed; empty without --include-text (read it at `file:line`) */
  text: string
  target: { kind: 'command' | 'flag' | 'tool' | 'mcp-server'; name: string }
  /** sessions that had the rule in context */
  sessionsInContext: number
  /** of those, sessions with at least one matching call */
  sessionsBroken: number
  /** calls that matched the target after the rule entered the context: each one is a try to break the rule */
  calls: number
  /** the part of `calls` that subagents made */
  agentCalls: number
  /** the part of `calls` that a hook or a permission rule stopped: there a check held where the line did not */
  blocked: number
  /** up to 3 matches: a runner and the target, a program and a flag, or a tool name */
  examples: string[]
  /** up to 3 sessions, the most calls first */
  exampleSessionIds: string[]
  /** the start of the latest session that broke the rule */
  lastBrokenAt?: number
}

/**
 * A feedback note that a session wrote, and the complaints after it. A feedback note is a memory note of type
 * `feedback` (or a `feedback_*.md` file), or any note (memory, CLAUDE.md, AGENTS.md, .claude/rules) written within
 * 3 turns after a complaint: "the agent agreed and saved a note".
 */
export interface HarnessNoteRow {
  file: string
  kind: 'memory' | 'memory-index' | 'claude-md' | 'agents-md' | 'rules'
  noteType?: string
  /** the complaint just before the first write, when there was one */
  trigger?: HarnessPromptRef
  /** the first write in the window */
  writtenAt?: number
  writtenBy: string
  writes: number
  /** sessions of the same project that started after the first write, plus the writer's own remaining turns */
  sessionsAfter: number
  /** complaint prompts after the first write, in those sessions */
  complaintsAfter: number
  /** of those, the complaints that share rare content words with the note or its trigger: 1 after a trigger, else 2 */
  matchingComplaints: number
  /** ms from the first write to the first matching complaint */
  firstMatchAfterMs?: number
  /** the shared words, most frequent first; empty without --include-text */
  sharedWords: string[]
  /** up to 3 matching complaints */
  examples: HarnessPromptRef[]
}

/** an auto-memory index against its load limit, now and in the sessions */
export interface HarnessMemoryLoadRow {
  file: string
  /** the file now; absent when it is gone */
  lines?: number
  bytes?: number
  chars?: number
  linesPastLimit?: number
  firstLinePastLimit?: number
  /** sessions whose transcript says they loaded this index */
  sessionsLoaded: number
  /** sessions where Claude Code said it did not load all of it */
  sessionsCut: number
  maxLinesCut: number
  lastCutAt?: number
}

/** a content word that recurs in complaint prompts */
export interface HarnessComplaintRow {
  word: string
  prompts: number
  sessions: number
  firstAt?: number
  lastAt?: number
  /** an instruction file or memory note in scope already uses this word: a note exists and the complaint came back */
  inInstructions: boolean
  examples: HarnessPromptRef[]
}

export interface HarnessEnforcementCounts {
  /** sessions whose transcript lists the instruction files they loaded; older transcripts do not */
  sessionsWithRecord: number
  /** distinct rules with a target that at least one session had in context */
  rulesInContext: number
  /** of those, rules with at least one matching call */
  rulesBroken: number
  /** of the broken rules, the ones where a hook or a permission rule stopped every matching call */
  rulesEnforced: number
  /** distinct note files that the sessions wrote */
  notesWritten: number
  /** of those, the feedback notes (see HarnessNoteRow) */
  feedbackNotes: number
  /** feedback notes with at least one matching complaint after them */
  notesFollowedByComplaint: number
  /** complaint prompts in the scanned sessions */
  complaints: number
  /** words in complaint prompts of 2 or more sessions; their rows are in `complaints` only with --include-text */
  recurringComplaintWords: number
  /** memory indexes cut in a session or past the limit now */
  memoryIndexesCut: number
}

/**
 * Where a rule did not hold. This layer measures and recommends nothing: the harness skill turns a broken rule, a
 * note followed by the same complaint, or a cut memory index into a check (a hook or a permission rule).
 * Arrays are sorted, then capped at `HARNESS_ROW_CAP`; `counts` are taken before the cap.
 */
export interface HarnessEnforcement {
  counts: HarnessEnforcementCounts
  /** rules with at least one matching call, the most calls first */
  broken: HarnessRuleRow[]
  /** the feedback notes written in the window, the most matching complaints first */
  notes: HarnessNoteRow[]
  memory: HarnessMemoryLoadRow[]
  /** words in complaint prompts of 2 or more sessions, the most sessions first; only with --include-text */
  complaints: HarnessComplaintRow[]
}

/** Eight top-level keys. `generator.generatedAt` is the injected `now`, never a clock read. */
export interface HarnessReport {
  schemaVersion: string
  generator: { name: string; version: string; generatedAt: number }
  scope: HarnessScope
  inventory: HarnessInventory
  crosswalk: HarnessCrosswalk
  /** what the configured cleanup window will delete out from under the crosswalk above */
  retention: HarnessRetention
  /** where an instruction or a note did not hold */
  enforcement: HarnessEnforcement
  /** drift and skip notes, human-readable. A note is how this layer reports a miss instead of throwing. */
  notes: string[]
}
