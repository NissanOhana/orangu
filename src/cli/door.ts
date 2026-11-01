/**
 * Door 1: bare `orangu`. On an interactive terminal it prints the mascot and the brief of the latest session, then
 * runs the local app over every root until ctrl-c. In a pipe, in CI, or with a flag that targets 1 session or 1
 * scope, it prints only the brief, as it always did: a machine read never waits and never starts a server.
 *
 * The app is `orangu serve` with its defaults (src/cli/serve-options.ts): 127.0.0.1 only, every route behind the
 * capability path, and transcript text shown on this machine unless --no-include-text. The Export HTML download stays
 * redacted unless --include-text. Only the roots differ: serve reads 1 root unless --global, and this door reads every
 * root. The browser gets a private redirect page, never the capability URL (src/cli/open-app.ts).
 */
import { claudeRoots } from '../discover/discover.js'
import { startServe, type ServeDeps, type ServeHandle } from '../serve/server.js'
import type { ServeOptions } from '../serve/types.js'
import { flagBool, flagStr } from './args.js'
import { gatherPickRows, interactivePrecondition } from './commands/pick.js'
import { mascotLines } from './mascot-ascii.js'
import { openApp } from './open-app.js'
import { serveOptions } from './serve-options.js'
import { appBlock } from './summary.js'
import { oneLine, type Caps, type WritableLike } from './tty.js'

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
  /** the OS opener of the redirect page; the default is openInBrowser */
  openInBrowser?: (page: string) => unknown
  /** calls `stop` on ctrl-c; the default listens once for SIGINT */
  onInterrupt?: (stop: () => void) => void
  /** runs `fn` once at the exit of the process, as the last removal of the redirect page; the default is process.once('exit') */
  onExit?: (fn: () => void) => void
  /** the end of the process; the default is process.exit */
  exit?: (code: number) => void
  /** the clock and the pid check of the running count (tests) */
  now?: number
  isAlive?: (pid: number) => boolean
}

/**
 * Bare `orangu`. The brief alone, or on a terminal: the mascot, the brief, then the app. The app listens for ctrl-c and
 * hands the browser its redirect page before it prints its rows, so a ctrl-c after the URL always stops it with exit 0
 * and removes the page. If the app does not start, the brief stays on stdout and the error names the cause (main.ts
 * prints it on stderr and exits 1), and no page exists.
 */
export async function cmdBare(flags: Record<string, string | boolean>, deps: BareDeps): Promise<void> {
  if (!appPrecondition(deps.stdin, deps.stdout, deps.env, flags)) return deps.brief({ hint: !flagBool(flags, 'quiet') })
  // the options first, so a bad --port is an error before any output
  const roots = await claudeRoots(flagStr(flags, 'root', 'config', 'r'))
  const opts = serveOptions(flags, { roots }, { tty: deps.out.tty, env: deps.env })
  deps.stdout.write('\n' + mascotLines(deps.out).join('\n') + '\n')
  // the app does not need the brief: an input cap, a session that changes while orangu reads it, or a root list that
  // the brief cannot read gives 1 line on stderr, and the app starts
  try {
    await deps.brief({ hint: false })
  } catch (e) {
    deps.stderr.write(`  orangu printed no brief: ${oneLine(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')}.\n`)
  }
  const start = deps.startServe ?? startServe
  const [app, picked] = await Promise.all([
    start(opts, { quiet: !flagBool(flags, 'verbose') }).catch((e: unknown) => {
      throw new Error(`the app did not start: ${e instanceof Error ? e.message : String(e)}`)
    }),
    // the counts of the discovery that `orangu pick` reads, over every root
    gatherPickRows({ ...flags, global: true }, { ...(deps.now !== undefined ? { now: deps.now } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}) }),
  ])
  const stopped = new Promise<void>((resolve) => (deps.onInterrupt ?? ((stop) => process.once('SIGINT', stop)))(resolve))
  const handoff = opts.open
    ? await openApp(app.url, { env: deps.env, ...(deps.openInBrowser ? { open: deps.openInBrowser } : {}), ...(deps.onExit ? { onExit: deps.onExit } : {}) })
    : undefined
  if (handoff?.note) deps.stderr.write(`  ${handoff.note}\n`)
  deps.stdout.write(appBlock(deps.out, { url: app.url, sessions: picked.counts.total, running: picked.counts.running }).join('\n') + '\n')
  try {
    await stopped
    await app.close()
  } finally {
    handoff?.remove()
  }
  deps.stderr.write('\n  The app stopped.\n')
  ;(deps.exit ?? ((code) => process.exit(code)))(0)
}
