/**
 * The contract of orangu god: the facts that the sources read, the row of 1 session on the board, the board
 * snapshot, the settings and the stored choices, the key-path intents and outcomes, and the alert kinds.
 *
 * Every unit under src/god reads this file, and no unit changes it after it lands: a change to a shape here is a
 * change of its own, made before the units that need it. The file has types and 1 constant only, and no import,
 * so the pure core and the engine shell type-check against the same shapes.
 *
 * Rules for every shape here:
 * - Plain JSON data only: no Map, no Set, no function, no class instance. The pane keeps these values in the
 *   engine state and the engine store, which take JSON. An absent optional field is left out, never set to
 *   undefined. src/god/host.test.ts holds this at compile time.
 * - Time is milliseconds since the epoch, as the engine clock gives it. A duration says its unit in its name.
 * - Text from outside (transcript text, a registry name, a cmux title, a screen) goes through src/god/sanitize.ts
 *   and then the redaction before it enters a shape here. A path that a later host command takes (a cwd, a repo
 *   path) keeps its form on disk. Each view and each tool text redacts such a path before it shows it.
 */

// ---------- levels and flags ----------

/** The attention level of 1 session. The board shows the levels in LEVEL_ORDER. */
export type Level = 'needs-you' | 'your-turn' | 'stuck' | 'working' | 'idle' | 'stale'

/**
 * The board order of the levels, first the level that needs the person most:
 * - needs-you: the session waits for the person (its status is waiting);
 * - your-turn: the session is idle, and its last turn ended after the person last saw it;
 * - stuck: the session is busy, and its transcript has no write for a time, or it ends with an API error or retry;
 * - working: the session is busy;
 * - idle: the session is idle, the person saw its last turn, and it is idle for less than the stale limit;
 * - stale: the session is idle for the stale limit or more.
 */
export const LEVEL_ORDER: readonly Level[] = ['needs-you', 'your-turn', 'stuck', 'working', 'idle', 'stale']

/** An overlap of 2 live sessions. */
export type FlagKind = 'same-tree' | 'same-files' | 'same-repo'

/**
 * 1 overlap flag on the row of 1 session. The model puts each flag on both rows, each row naming the other.
 * - same-tree: the same worktree path on the same branch;
 * - same-files: both sessions wrote the same file in the last 2 h of the transcript part that the mod read;
 * - same-repo: the same git common dir in different worktrees.
 */
export type Flag = {
  kind: FlagKind
  /** the session id of the other session */
  otherId: string
  /** the name of the other session, as its row shows it */
  otherName: string
  /** same-files only: the file that both sessions wrote (the newest such write when there are more) */
  file?: string
}

// ---------- the live session list ----------

/** The status of a session, as `claude agents --json` and the registry file write it. */
export type SessionStatus = 'busy' | 'idle' | 'waiting'

/**
 * 1 row of `claude agents --json`. A row whose status is not a SessionStatus counts as a parse error of its
 * source and gives no row.
 */
export type AgentRow = {
  pid: number
  sessionId: string
  /** the working directory of the session, as on disk */
  cwd: string
  /** the session name (sanitized and redacted) */
  name: string
  /** the session kind, for example `interactive` */
  kind: string
  status: SessionStatus
  /**
   * Why the session waits, only while its status is waiting. Values seen: `permission prompt`, `input needed`,
   * `sandbox request`, `worker request`, `dialog open`.
   */
  waitingFor?: string
  /** when the session process started */
  startedAt?: number
}

/**
 * 1 registry file `<home>/.claude/sessions/<pid>.json`: the fields of an agents row, plus the ones only the
 * file has. The registry is not a documented interface: a missing field is left out, never guessed.
 */
export type RegistryRow = AgentRow & {
  /** when the status last changed (the file writes no heartbeat, so this is also its last write) */
  statusUpdatedAt?: number
  /**
   * The process start time in UTC, in the format of `ps -o lstart=` (for example `Thu Oct  8 21:26:02 2026`).
   * Plain `ps -o lstart=` writes local time, so the check against a reused PID runs
   * `ps -o pid=,tty=,lstart= -p <pids>` with the env `{ TZ: 'UTC' }`. It compares the lstart field of `ps`, with
   * its padding trimmed, to this string as it is, with no change to epoch.
   */
  procStart?: string
  /** the Claude Code version of the session */
  version?: string
  /** the mtime of the registry file */
  fileMtimeMs: number
}

/**
 * 1 live session after the collector merged the agents list and the registry: 1 per session id. A session is
 * live when its PID is in the last agents list, or when its registry file is newer than that list. When the
 * agents list fails, a PID counts only when `ps` in UTC shows the start time of its procStart (RegistryRow).
 */
export type LiveSession = AgentRow & {
  /** when the status last changed: the registry statusUpdatedAt; absent when no registry file has the session */
  statusSince?: number
  /** the Claude Code version of the session, from the registry file */
  version?: string
}

/** The git identity of a working directory: `git rev-parse --git-common-dir --show-toplevel`. */
export type RepoRef = {
  /** the absolute git common dir: the same for a repo and each of its worktrees */
  commonDir: string
  /** the absolute top level of the worktree that holds the cwd */
  topLevel: string
  /** the repo name that `/god repos <name>` matches: the folder name of the main worktree */
  name: string
  /** true when the top level is a linked worktree, not the main worktree */
  isWorktree: boolean
}

/** Where a session shows in cmux: its PID, then its TTY (`ps`), then the cmux surface with that TTY. */
export type TabRef = {
  pid: number
  /** the TTY name as `ps -o tty=` writes it */
  tty: string
  /** the cmux workspace ref, for `--workspace` */
  workspaceRef: string
  /** the cmux surface ref, for `--surface` and `--panel` */
  surfaceRef: string
  /** the workspace title (sanitized and redacted) */
  workspaceTitle: string
  /** the surface title (sanitized and redacted) */
  surfaceTitle?: string
}

// ---------- transcript facts ----------

/** 1 option of a question. */
export type QuestionOption = {
  label: string
  description?: string
}

/** 1 question of an AskUserQuestion call. */
export type Question = {
  /** the question text */
  text: string
  /** the short header that the dialog shows in its chip (`☐ <header>` on the screen) */
  header: string
  multiSelect: boolean
  /** the options in dialog order: option n has the digit n */
  options: readonly QuestionOption[]
}

/** The last AskUserQuestion call with no result: the dialog that the session shows now. */
export type OpenQuestion = {
  /** the tool use id of the call: the question closes when a result with this id comes */
  toolUseId: string
  /** when the call was written */
  askedAt?: number
  questions: readonly Question[]
}

/** The last tool call of a session: the open one, else the last one. */
export type ToolActivity = {
  toolUseId: string
  /** the tool name as the transcript writes it (`Edit`, `Bash`, `mcp__<server>__<tool>`) */
  tool: string
  /** 1 line, as summarizeToolInput writes it (`Edit parse.ts`) */
  text: string
  /** the whole input as JSON text, for an open call: the confirm bar shows it before a permission answer */
  input?: string
  /** true while the call has no result */
  isOpen: boolean
  /** when the call was written */
  at?: number
}

/** The context fill of the last reply: input plus cache read plus cache write tokens, and the model window. */
export type ContextFacts = {
  tokens: number
  /** the context window of the model, from the model catalog */
  window: number
  /** the model id of the last reply */
  model: string
  /** true when the catalog matched the model id only by an estimate, so the window is an estimate too */
  isEstimated: boolean
}

/** 1 file that an Edit, Write, MultiEdit or NotebookEdit call named. */
export type FileTouch = {
  path: string
  tool: string
  at: number
}

/** An API error or retry system record at the end of the transcript. */
export type ErrorTail = {
  kind: 'api-error' | 'api-retry'
  text: string
  at?: number
}

/** 1 pull request link record. */
export type PrLink = {
  url: string
  /** the pull request number, when the link names one */
  number?: number
}

/** 1 turn of the History tab: the person's prompt, then the last reply of the turn. */
export type HistoryTurn = {
  prompt?: string
  promptAt?: number
  reply?: string
  replyAt?: number
  /** when the turn ended (a turn duration record) */
  endedAt?: number
}

/** 1 subagent or background task of a session: an Agent call (or a background task) and its state. */
export type AgentTask = {
  /** the tool use id of the call that started it */
  toolUseId: string
  kind: 'subagent' | 'background'
  /** 1 line, as summarizeToolInput writes it */
  text: string
  /** the subagent type, when the call names one */
  agentType?: string
  /** true while the call has no result */
  isRunning: boolean
  startedAt?: number
  endedAt?: number
}

/** 1 subagent transcript file `<sessionId>/subagents/agent-<id>.jsonl`, with its `.meta.json` when it parses. */
export type SubagentFile = {
  agentId: string
  size: number
  mtimeMs: number
  /** the Agent call that started it (meta `toolUseId`) */
  toolUseId?: string
  /** meta `agentType` */
  agentType?: string
  /** meta `description` (sanitized and redacted) */
  description?: string
}

/**
 * What the record reducer reads from the transcript part that the mod read. Each text field is sanitized and
 * redacted. A field the part does not hold is left out.
 */
export type TranscriptFacts = {
  /** the orangu title order: the custom title, then the AI title, then the first human prompt */
  title?: string
  /** the last user record that classifyPrompt calls human */
  lastPrompt?: string
  /** the last text block of the last assistant record */
  lastReply?: string
  openQuestion?: OpenQuestion
  activity?: ToolActivity
  context?: ContextFacts
  /** the last permission-mode record */
  permissionMode?: string
  /** gitBranch of the last record that has one */
  branch?: string
  prLinks: readonly PrLink[]
  /** oldest first */
  filesTouched: readonly FileTouch[]
  errorTail?: ErrorTail
  /** when the last turn ended: the last system record with subtype turn_duration */
  lastTurnEndedAt?: number
  /** the last turns, oldest first */
  history: readonly HistoryTurn[]
  /** the subagents and background tasks, oldest first */
  agents: readonly AgentTask[]
  /** the lines that did not parse: each counts, and none stops the refresh */
  parseErrors: number
}

// ---------- sources and facts ----------

/** A source of facts. Each one fails alone, and the board keeps its last good facts. */
export type SourceName = 'agents' | 'registry' | 'cmux' | 'git'

/** The state of 1 source after the last refresh. */
export type SourceState = {
  /**
   * unread: not tried yet; ok: the last read worked; off: the last read failed; missing: its command is not on
   * the machine (no cmux turns jump and answer off, with its own line in the key row)
   */
  status: 'unread' | 'ok' | 'off' | 'missing'
  /** when the last good read ended */
  lastOkAt?: number
  /** off and missing only: a short reason with no session text, for /god stats */
  reason?: string
}

/** The facts of 1 live session. A session with no transcript has only the registry facts. */
export type SessionFacts = LiveSession & {
  repo?: RepoRef
  tab?: TabRef
  /** absent when the session has no transcript file yet */
  transcript?: TranscriptFacts
  /** the mtime of the transcript file */
  lastWriteAt?: number
  subagents: readonly SubagentFile[]
}

/** The time of 1 refresh: the engine work apart from the wait on host commands. */
export type RefreshStats = {
  /** when the refresh ended */
  at: number
  /** time in pure code in the engine */
  computeMs: number
  /** time spent on host commands and file reads */
  waitMs: number
  /** the live sessions the refresh read */
  sessions: number
}

/** What 1 refresh of the collector gives. */
export type Facts = {
  /** 1 per session id, the god session included */
  sessions: readonly SessionFacts[]
  sources: Readonly<Record<SourceName, SourceState>>
  stats: RefreshStats
}

// ---------- settings and stored choices ----------

/** The userConfig values of the plugin. */
export type Settings = {
  /** a busy session with no transcript write for this many minutes is stuck (default 10) */
  stuckAfterMin: number
  /** an idle session is stale after this many hours (default 24) */
  staleAfterH: number
  /** off stops every spinner, pulse and sparkline */
  motion: 'on' | 'off'
}

/** all: every live session. repos: only the sessions in the selected repos, a worktree with its repo. */
export type BoardMode = 'all' | 'repos'

/** The board groups its rows by attention level or by repo. */
export type GroupBy = 'level' | 'repo'

/** The choices that the engine store keeps across sessions. */
export type StoreState = {
  mode: BoardMode
  /** the repo names of the repos mode (RepoRef name) */
  repos: readonly string[]
  groupBy: GroupBy
  /** session id to the last time the person opened or jumped to it */
  seenAt: Readonly<Record<string, number>>
  /** the session ids that make no alert */
  muted: readonly string[]
  /** false turns every tone off */
  sound: boolean
}

// ---------- the board ----------

/** 1 row of the board: the facts of 1 session and what the model made of them. */
export type GodSession = SessionFacts & {
  /** the last time the person opened or jumped to the session; at first sight, the start time of the pane */
  seenAt: number
  level: Level
  /** since when the session is at its level */
  levelSince: number
  /** the 1-line summary, from rules only */
  summary: string
  flags: readonly Flag[]
  /** true when the session is in StoreState muted */
  muted: boolean
}

/** 1 group of the board, in board order. */
export type BoardGroup = {
  /** the level when the board groups by level, else the repo common dir ('' for the sessions with no repo) */
  key: string
  /** set when the board groups by level */
  level?: Level
  /** set when the board groups by repo and the sessions have a repo */
  repo?: RepoRef
  /** the sessions of the group, in board order */
  sessionIds: readonly string[]
  /** true for the stale group: it shows only its count until the person opens it */
  startsClosed: boolean
}

/** 1 board, as the pane draws it and the tools read it. The engine state holds the last one. */
export type BoardSnapshot = {
  /** when the snapshot was made */
  at: number
  /** the session id of the god session itself: the board leaves it out */
  selfId: string
  /** false until the first refresh ends: the pane shows that it reads the sessions */
  firstRefreshDone: boolean
  /**
   * every live session but the god session, whatever the mode, in board order: the level order, then the longest
   * time in the level first. The header live count is its length, and the tools read it.
   */
  sessions: readonly GodSession[]
  /** what the pane shows: the groups in board order, each with the ids of the sessions that the mode keeps */
  groups: readonly BoardGroup[]
  /** the stored choices that this snapshot was made with */
  mode: BoardMode
  repos: readonly string[]
  groupBy: GroupBy
  sources: Readonly<Record<SourceName, SourceState>>
  /** when the newest facts were read: the facts are old when this is more than 10 s ago */
  factsAt?: number
  stats: RefreshStats
}

// ---------- the detail ----------

/** The tabs of the detail, in the order that `t` walks them. */
export type DetailTab = 'now' | 'history' | 'agents' | 'screen' | 'recap'

/** 1 read of the screen of a cmux tab (sanitized and redacted). */
export type ScreenRead = {
  sessionId: string
  workspaceRef: string
  surfaceRef: string
  text: string
  /** when the read ended: a key plan refuses a screen older than 1 s */
  readAt: number
}

/** Why a Recap has no text: the 3 reasons of the model call, or the engine refused to send it. */
export type RecapFailure = 'api-error' | 'empty-reply' | 'aborted' | 'refused'

/** The Recap of 1 session: model text, made only when the person presses x. tokens is the sum of the 4 usage counts. */
export type RecapState =
  | { status: 'running'; sessionId: string; startedAt: number }
  | { status: 'answered'; sessionId: string; text: string; tokens: number; at: number }
  | { status: 'failed'; sessionId: string; reason: RecapFailure; tokens: number; at: number }

// ---------- the key path ----------

/** The session that an intent goes to: its id, and its name for the confirm bar. */
export type DeliverTarget = {
  sessionId: string
  name: string
}

/**
 * What the person asked the pane to send, before the confirm bar. Nothing goes out until the person presses y.
 * - answer: the digit of 1 option of a single-select question with 1 question;
 * - permission: Yes or No on a permission dialog, never an option that starts with "Yes, and";
 * - prompt: a text for the prompt of the session, 1 or more lines;
 * - peer: a peer message through the engine, with no screen check.
 */
export type DeliverIntent =
  | {
      kind: 'answer'
      target: DeliverTarget
      /** the AskUserQuestion call that the answer closes */
      toolUseId: string
      /** the header that the fresh screen must still show */
      header: string
      question: string
      /** the option digit, 1 to 9 */
      option: number
      /** the label that the fresh screen must still show at that digit */
      label: string
    }
  | {
      kind: 'permission'
      target: DeliverTarget
      choice: 'yes' | 'no'
      /** the tool that asks, and its whole input, for the confirm bar */
      tool: string
      input?: string
    }
  | { kind: 'prompt'; target: DeliverTarget; text: string }
  | { kind: 'peer'; target: DeliverTarget; text: string }

/**
 * Why the key path sent nothing:
 * - no-cmux: cmux is not on the machine;
 * - no-tab: the session has no mapped cmux tab;
 * - stale-screen: the screen read is more than 1 s old;
 * - screen-changed: the fresh screen does not show the same header and label, or the empty prompt line;
 * - label-not-found: no option on the screen has the exact label Yes or No;
 * - multi-question: the dialog has more than 1 question or takes more than 1 selection;
 * - empty: the text is empty;
 * - control-char: the text holds a control character other than a newline;
 * - backslash-escape: the text holds the 2 characters of a backslash escape that cmux types as a key.
 */
export type DeliverRefusal =
  | 'no-cmux'
  | 'no-tab'
  | 'stale-screen'
  | 'screen-changed'
  | 'label-not-found'
  | 'multi-question'
  | 'empty'
  | 'control-char'
  | 'backslash-escape'

/** The plan of 1 delivery from an intent and a fresh screen: the argv lists to run in order, or 1 refusal. */
export type DeliverPlan =
  | { kind: 'send'; steps: readonly (readonly string[])[] }
  | { kind: 'refuse'; refusal: DeliverRefusal }

/**
 * What became of 1 intent after y:
 * - sent: every step ran; the next refresh checks that the question closed or the prompt shows as human;
 * - delivered: that check passed (a peer message is delivered when the engine says so);
 * - not-delivered: that check failed;
 * - refused: the plan refused, and nothing went out;
 * - failed: a step failed, and the steps after it did not run.
 */
export type DeliverOutcome =
  | { status: 'sent'; intent: DeliverIntent; at: number }
  | { status: 'delivered'; intent: DeliverIntent; at: number }
  | { status: 'not-delivered'; intent: DeliverIntent; at: number }
  | { status: 'refused'; intent: DeliverIntent; at: number; refusal: DeliverRefusal; screen?: ScreenRead }
  | { status: 'failed'; intent: DeliverIntent; at: number; /** a short reason with no session text */ reason: string; screen?: ScreenRead }

// ---------- alerts ----------

/** What starts an alert: a change into needs-you or stuck, and a done tone. */
export type AlertKind = 'needs-you' | 'stuck' | 'done'

/** The alerts that this pane made since it started, for /god stats. */
export type AlertCounts = {
  tones: number
  notifications: number
}
