/**
 * The options of the local app that `orangu serve` (src/cli/main.ts cmdServe) and bare `orangu` on a terminal
 * (src/cli/door.ts) start: 1 builder, so both keep the same flags and the same defaults. Only the sessions that they
 * read differ, and each caller gives those.
 */
import { DEFAULT_MAX_LIVE } from '../serve/registry.js'
import type { ServeOptions } from '../serve/types.js'
import { VERSION } from '../version.js'
import { flagBool, flagStr } from './args.js'

/** The sessions that the app reads: every root, 1 config dir, and a cwd filter. */
export type AppSessions = Pick<ServeOptions, 'roots' | 'configDir' | 'cwd'>

/** The app options from the flags. A bad --port value is an error here, before the app starts. */
export function serveOptions(flags: Record<string, string | boolean>, sessions: AppSessions, o: { tty: boolean; env: NodeJS.ProcessEnv }): ServeOptions {
  const portStr = flagStr(flags, 'port', 'p')
  const port = portStr !== undefined ? Number(portStr) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error(`--port must be an integer 0–65535, got "${portStr}"`)
  const maxLiveStr = flagStr(flags, 'max-live')
  return {
    port,
    // policy: open by default when TTY; --no-open suppresses
    open: !flagBool(flags, 'no-open') && (flagBool(flags, 'open') || o.tty),
    // loopback + capability URL: the operator sees their own transcript by default; --no-include-text opts out
    includeText: !flagBool(flags, 'no-include-text'),
    // the Export HTML download leaves the machine: redacted like `orangu report` unless --include-text
    exportIncludeText: flagBool(flags, 'include-text'),
    ...sessions,
    noCache: flags['no-cache'] !== undefined || o.env['ORANGU_NO_CACHE'] === '1',
    version: VERSION,
    maxLive: maxLiveStr !== undefined ? Math.max(1, Math.floor(Number(maxLiveStr)) || DEFAULT_MAX_LIVE) : undefined,
  }
}
