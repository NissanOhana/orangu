/**
 * The host port of orangu god: the only way the pure units reach the machine. src/god/engine.tsx builds a Host
 * and the Effects from the engine `$`. A test builds them from a fake. The units under source/, act/ and the
 * collector take them as arguments, so they stay pure .ts files that never name `$`.
 *
 * The port is narrow on purpose:
 * - Host runs only the commands of ALLOWED_COMMANDS, by argv and with no shell, and stops each one after
 *   HOST_TIMEOUT_MS. It reads files and the clock. It writes nothing.
 * - Effects are the 4 things the pane does to the world outside the host commands: a native notification, a
 *   tone, a peer message and a model call. Only the person's key starts each of them, or an alert rule.
 * Every shape here is a subset of the engine's own, so the adapter passes values through with no reshaping.
 */

// ---------- host commands ----------

/**
 * The commands that the host port may run, by their bare name. The engine adapter refuses any other argv[0]:
 * a path, another case and a padded name too. Each command reads, but cmux also focuses a tab, types the keys
 * of a confirmed answer and rings a tab.
 */
export const ALLOWED_COMMANDS = ['claude', 'cmux', 'ps', 'git', 'tail', 'head', 'stat'] as const

/** 1 of ALLOWED_COMMANDS. */
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number]

/** Each host command stops after this many milliseconds, and its call rejects. */
export const HOST_TIMEOUT_MS = 5000

/** True when argv[0] is exactly 1 of ALLOWED_COMMANDS. */
export function isAllowedCommand(argv: readonly string[]): boolean {
  const name = argv[0]
  return name !== undefined && (ALLOWED_COMMANDS as readonly string[]).includes(name)
}

/** What 1 host command gives once it exits, any exit code. */
export type RunResult = {
  exitCode: number
  /** the first 4 MiB of standard output, as text */
  stdout: string
  stderr: string
  /** true when standard output had more than 4 MiB: a reader then takes only the whole lines */
  isStdoutTruncated: boolean
  isStderrTruncated: boolean
}

/** The options of 1 host command. */
export type RunOptions = {
  /** the working directory of the command, absolute; absent, the session's own */
  cwd?: string
  /**
   * Variables set over the environment of the host for this command only. The registry writes procStart in UTC,
   * so the reused-PID check runs `ps -o pid=,tty=,lstart= -p <pids>` with `{ TZ: 'UTC' }`.
   */
  env?: Readonly<Record<string, string>>
}

/** 1 entry of a folder listing. A link is not followed. */
export type DirEntry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  /** bytes, for a file */
  size: number
  /** the last change of a file; 0 for any other kind */
  mtimeMs: number
  isLink: boolean
}

/** What a path leads to. The engine gives no inode: a reader that needs one runs `stat -f %i`. */
export type FileStat = {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
}

/** The machine as the pure units see it. Each call rejects on a failure, and the caller counts it. */
export type Host = {
  /**
   * Runs 1 command by its argv with no shell, and resolves when it exits, any exit code. Rejects when argv[0]
   * is not in ALLOWED_COMMANDS, when the command cannot start, and when it runs for more than HOST_TIMEOUT_MS.
   */
  run: (argv: readonly string[], options?: RunOptions) => Promise<RunResult>
  /** Lists 1 folder. Rejects when it is missing. */
  list: (path: string) => Promise<readonly DirEntry[]>
  /** Reads 1 file as UTF-8 text. Rejects when it is missing or larger than 4 MiB: a larger file goes through `tail` or `head`. */
  read: (path: string) => Promise<string>
  /** Reads what 1 path leads to. Rejects when it is missing. */
  stat: (path: string) => Promise<FileStat>
  /** The time now, from the engine clock. */
  now: () => Promise<number>
}

// ---------- effects ----------

/** 1 tone, made from code: WAV bytes as base64. No audio file ships. */
export type ToneClip = {
  base64: string
  mime: 'audio/wav'
}

/** What a native notification gave: sent, or the reason that no channel sent it. */
export type NotifyOutcome = { isSent: true } | { isSent: false; reason: string }

/** What a peer message gave: delivered to the queue of the session, or the reason that it was not. */
export type PeerOutcome = { isDelivered: true } | { isDelivered: false; reason: string }

/** The 4 token counts of 1 model call, as the engine spells them. */
export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** 1 model call with no history: the Recap. */
export type ModelRequest = {
  model: string
  prompt: string
  system?: string
  maxTokens?: number
  timeoutMs?: number
}

/**
 * What 1 model call gave: the text, or the reason that it has none. The usage comes on each arm. A request
 * that the engine refuses to send rejects instead.
 */
export type ModelReply =
  | { isAnswered: true; text: string; usage: TokenUsage }
  | { isAnswered: false; reason: 'api-error' | 'empty-reply' | 'aborted'; usage: TokenUsage }

/** The world outside the host commands, as the pure units see it. */
export type Effects = {
  /** Sends 1 native notification on the person's own channel. */
  notify: (text: string, title: string) => Promise<NotifyOutcome>
  /** Plays 1 tone. Resolves once it played or the engine skipped it. */
  play: (clip: ToneClip) => Promise<void>
  /** Sends 1 peer message to a session. The target Claude reads it as a message from a peer, not as a prompt of the person. */
  peer: (sessionId: string, text: string) => Promise<PeerOutcome>
  /** Runs 1 model call. Only the Recap key starts it. */
  complete: (request: ModelRequest) => Promise<ModelReply>
}
