/**
 * The guard of the host port: what 1 host command passes to the engine. The engine adapter (src/god/engine.tsx)
 * runs a command only when its plan is ok, and passes the plan's init as it is:
 * - argv[0] must be 1 of ALLOWED_COMMANDS by its bare name (isAllowedCommand), else the command does not run;
 * - every command gets timeoutMs HOST_TIMEOUT_MS, so no command runs for more than 5 s;
 * - the environment of a command can set only the keys of RUN_ENV_KEYS (TZ, for `ps` in UTC). A command that asks
 *   for any other key does not run, so no caller can change PATH or load a library into a command.
 */
import { HOST_TIMEOUT_MS, isAllowedCommand, type RunOptions } from './host.js'

/** The environment keys that a host command may set. */
export const RUN_ENV_KEYS = ['TZ'] as const

/** What the engine adapter passes to the engine for 1 command. */
export type RunInit = { timeoutMs: number; cwd?: string; env?: Record<string, string> }

/** The plan of 1 host command: run it with this init, or refuse it with a reason. */
export type RunPlan = { ok: true; init: RunInit } | { ok: false; reason: string }

/** The reason when argv[0] is not on the allowlist. */
export const REFUSED_COMMAND = 'The host port runs only the commands of its allowlist.'

/** The reason when a command asks to set an environment key other than TZ. */
export const REFUSED_ENV = 'The host port sets only the TZ variable for a command.'

const isRunEnvKey = (key: string): boolean => (RUN_ENV_KEYS as readonly string[]).includes(key)

/** The plan of 1 host command from its argv and its options. */
export function planRun(argv: readonly string[], options: RunOptions = {}): RunPlan {
  if (!isAllowedCommand(argv)) return { ok: false, reason: REFUSED_COMMAND }
  const env = options.env ?? {}
  const keys = Object.keys(env)
  if (!keys.every(isRunEnvKey)) return { ok: false, reason: REFUSED_ENV }
  return {
    ok: true,
    init: {
      timeoutMs: HOST_TIMEOUT_MS,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(keys.length === 0 ? {} : { env: { ...env } }),
    },
  }
}
