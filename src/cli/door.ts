/**
 * Door 1: bare `orangu`. On an interactive terminal it prints the mascot and the brief of the latest session, then
 * runs the local app over every root until ctrl-c. In a pipe, in CI, or with a flag that targets 1 session or 1
 * scope, it prints only the brief, as it always did: a machine read never waits and never starts a server.
 *
 * The app is `orangu serve` with its defaults (main.ts cmdServe): 127.0.0.1 only, every route behind the capability
 * path, and transcript text shown on this machine unless --no-include-text. The Export HTML download stays redacted
 * unless --include-text. Only the roots differ: serve reads 1 root unless --global, and this door reads every root.
 */
import { claudeRoots } from '../discover/discover.js'
import { DEFAULT_MAX_LIVE } from '../serve/registry.js'
import { startServe, type ServeDeps, type ServeHandle } from '../serve/server.js'
import type { ServeOptions } from '../serve/types.js'
import { VERSION } from '../version.js'
import { flagBool, flagStr } from './args.js'
import { gatherPickRows, interactivePrecondition } from './commands/pick.js'
import { mascotLines } from './mascot-ascii.js'
import { openInBrowser } from './open-browser.js'
import { appBlock } from './summary.js'
import type { Caps, WritableLike } from './tty.js'

/** The flags that target 1 session or 1 scope: each keeps bare `orangu` on the brief of its target. */
export const TARGETED_BARE_FLAGS = ['session', 's', 'global', 'cwd', 'max-tokens', 'fail-on-hook-errors'] as const

/** The app starts only for an untargeted interactive terminal. Every other input keeps the latest-session brief. */
export function appPrecondition(
  stdin: { isTTY?: boolean; setRawMode?: unknown },
  stdout: { isTTY?: boolean },
  env: NodeJS.ProcessEnv,
  flags: Record<string, string | boolean>,
): boolean {
  if (TARGETED_BARE_FLAGS.some((flag) => flags[flag] !== undefined)) return false
  return interactivePrecondition(stdin, stdout, env, flags)
}

export interface BareDeps {
  /** prints the brief of the latest session on stdout (main.ts cmdBrief); `hint` adds its closing hint line */
  brief: (o: { hint: boolean }) => Promise<void>
  stdin: { isTTY?: boolean; setRawMode?: unknown }
  stdout: { isTTY?: boolean; write(chunk: string): unknown }
  stderr: WritableLike
  env: NodeJS.ProcessEnv
  out: Caps
  /** the app server; the default is startServe */
  startServe?: (opts: ServeOptions, deps: ServeDeps) => Promise<Pick<ServeHandle, 'url' | 'close'>>
  /** the browser handoff; the default is the OS opener */
  openInBrowser?: (url: string) => unknown
  /** calls `stop` on ctrl-c; the default listens once for SIGINT */
  onInterrupt?: (stop: () => void) => void
  /** the end of the process; the default is process.exit */
  exit?: (code: number) => void
  /** the clock and the pid check of the running count (tests) */
  now?: number
  isAlive?: (pid: number) => boolean
}

/** The options of `orangu serve` (main.ts cmdServe) for the given roots: the same flags and the same defaults. */
function appOptions(flags: Record<string, string | boolean>, roots: string[], deps: Pick<BareDeps, 'env' | 'out'>): ServeOptions {
  const maxLiveStr = flagStr(flags, 'max-live')
  return {
    port: appPort(flags),
    // policy: open by default when TTY; --no-open suppresses
    open: !flagBool(flags, 'no-open') && (flagBool(flags, 'open') || deps.out.tty),
    // loopback + capability URL: the operator sees their own transcript by default; --no-include-text opts out
    includeText: !flagBool(flags, 'no-include-text'),
    // the Export HTML download leaves the machine: redacted like `orangu report` unless --include-text
    exportIncludeText: flagBool(flags, 'include-text'),
    roots,
    noCache: flags['no-cache'] !== undefined || deps.env['ORANGU_NO_CACHE'] === '1',
    version: VERSION,
    maxLive: maxLiveStr !== undefined ? Math.max(1, Math.floor(Number(maxLiveStr)) || DEFAULT_MAX_LIVE) : undefined,
  }
}

/** --port, or none for a random port. A bad value is an error before any output. */
function appPort(flags: Record<string, string | boolean>): number | undefined {
  const portStr = flagStr(flags, 'port', 'p')
  if (portStr === undefined) return undefined
  const port = Number(portStr)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be an integer 0–65535, got "${portStr}"`)
  return port
}

/**
 * Bare `orangu`. The brief alone, or on a terminal: the mascot, the brief, then the app. The app prints its rows only
 * after it listens for ctrl-c, so a ctrl-c after the URL always stops it with exit 0. If the app does not start,
 * the brief stays on stdout and the error names the cause (main.ts prints it on stderr and exits 1).
 */
export async function cmdBare(flags: Record<string, string | boolean>, deps: BareDeps): Promise<void> {
  if (!appPrecondition(deps.stdin, deps.stdout, deps.env, flags)) return deps.brief({ hint: !flagBool(flags, 'quiet') })
  // the options first, so a bad --port is an error before any output
  const opts = appOptions(flags, await claudeRoots(flagStr(flags, 'root', 'config', 'r')), deps)
  deps.stdout.write('\n' + mascotLines(deps.out).join('\n') + '\n')
  await deps.brief({ hint: false })
  const start = deps.startServe ?? startServe
  const [app, picked] = await Promise.all([
    start(opts, { quiet: !flagBool(flags, 'verbose') }).catch((e: unknown) => {
      throw new Error(`the app did not start: ${e instanceof Error ? e.message : String(e)}`)
    }),
    // the counts of the discovery that `orangu pick` reads, over every root
    gatherPickRows({ ...flags, global: true }, { ...(deps.now !== undefined ? { now: deps.now } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}) }),
  ])
  const stopped = new Promise<void>((resolve) => (deps.onInterrupt ?? ((stop) => process.once('SIGINT', stop)))(resolve))
  deps.stdout.write(appBlock(deps.out, { url: app.url, sessions: picked.counts.total, running: picked.counts.running }).join('\n') + '\n')
  if (opts.open) (deps.openInBrowser ?? openInBrowser)(app.url)
  await stopped
  await app.close()
  deps.stderr.write('\n  The app stopped.\n')
  ;(deps.exit ?? ((code) => process.exit(code)))(0)
}
