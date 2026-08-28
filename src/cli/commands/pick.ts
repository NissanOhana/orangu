/**
 * `orangu pick`: every open session, running ones first, choose one, open its report.
 *
 *   orangu pick [--limit <n>] [--global] [--root <dir>] [--cwd <dir>] [--json] [--plain]
 *
 * Behaviour matrix (PLAN-cli-ux §3d):
 *   interactive (stdin + stdout are TTYs, raw mode exists, not CI, TERM != dumb, no --json/--plain/
 *   --quiet, ORANGU_NO_ANIMATION != 1): an inline picker; Enter runs the in-process
 *   `report <id> --open`; q / Esc cancel (exit 0); Ctrl-C cancels with exit 130; a signal from
 *   outside restores the terminal before re-raising.
 *   --json: the list as a JSON array, nothing else.
 *   otherwise (a pipe, CI, --plain): a numbered list plus one hint; never waits for input.
 *   no sessions: an error (exit 1): a chooser that returns nothing did not do its job.
 *
 * "running" = Claude Code records a live pid for the session (src/discover/current.ts), else
 * its transcript changed within the live/idle thresholds (src/serve/badge.ts). Titles come from a
 * bounded head read of the rows actually shown and are scrubbed unless --no-redact.
 */
import { basename } from 'node:path'
import { claudeRoots, listSessions, peekHead, type DiscoverOptions, type SessionRef } from '../../discover/discover.js'
import { runningSessions } from '../../discover/current.js'
import { badgeFor } from '../../serve/badge.js'
import { redactValue } from '../../redact/redact.js'
import { flagBool, flagStr } from '../args.js'
import { select, type InputLike, type OutputLike } from '../select.js'
import { pickFrame, pickList, type PickCounts, type PickRow } from '../summary.js'
import { paint, type Caps, type ExitHookProcess, type WritableLike } from '../tty.js'

export const DEFAULT_PICK_LIMIT = 20

export interface PickDeps {
  /** run the report for the chosen session and open it (main.ts binds cmdReport with --open) */
  openReport: (sessionId: string) => Promise<void>
  stdin: InputLike & { isTTY?: boolean }
  stdout: OutputLike & { isTTY?: boolean }
  stderr: WritableLike
  env: NodeJS.ProcessEnv
  out: Caps
  err: Caps
  now?: number
  isAlive?: (pid: number) => boolean
  proc?: ExitHookProcess
}

/** All of these, or the numbered list: a prompt that waits on a stream nobody types into hangs. */
export function interactivePrecondition(
  stdin: { isTTY?: boolean; setRawMode?: unknown },
  stdout: { isTTY?: boolean },
  env: NodeJS.ProcessEnv,
  flags: Record<string, string | boolean>,
): boolean {
  const ci = env['CI']
  if (ci !== undefined && ci !== '' && ci !== 'false') return false
  if (env['TERM'] === 'dumb' || env['ORANGU_NO_ANIMATION'] === '1') return false
  if (flagBool(flags, 'json') || flagBool(flags, 'plain') || flagBool(flags, 'quiet')) return false
  return Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function')
}

async function discoverOptions(flags: Record<string, string | boolean>): Promise<DiscoverOptions> {
  const configArg = flagStr(flags, 'root', 'config', 'r')
  const opts: DiscoverOptions = flagBool(flags, 'global') ? { roots: await claudeRoots(configArg) } : configArg ? { configDir: configArg } : {}
  if (flags['cwd']) opts.cwd = String(flags['cwd'])
  return opts
}

/** Discover, mark running, order running-first, cut to the limit, then title only the rows shown. */
export async function gatherPickRows(
  flags: Record<string, string | boolean>,
  deps: { now?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<{ rows: PickRow[]; counts: PickCounts }> {
  const now = deps.now ?? Date.now()
  const opts = await discoverOptions(flags)
  const refs = await listSessions(opts)
  let live = new Map<string, unknown>()
  try {
    live = await runningSessions(opts, deps.isAlive ? { isAlive: deps.isAlive } : {})
  } catch {
    /* the pid records are an enrichment; the mtime badge stands on its own */
  }
  const isRunning = (r: SessionRef): boolean => live.has(r.sessionId) || badgeFor(r.mtimeMs, now).badge !== 'ended'
  const ordered = refs
    .map((r) => ({ r, running: isRunning(r) }))
    .sort((a, b) => Number(b.running) - Number(a.running) || b.r.mtimeMs - a.r.mtimeMs)
  const limitStr = flagStr(flags, 'limit', 'l')
  const limit = limitStr !== undefined && Number.isFinite(Number(limitStr)) && Number(limitStr) > 0 ? Math.floor(Number(limitStr)) : DEFAULT_PICK_LIMIT
  const redact = !flagBool(flags, 'no-redact')
  const rows: PickRow[] = []
  for (const { r, running } of ordered.slice(0, limit)) {
    const head = await peekHead(r.path)
    const title = head.title && redact ? redactValue(head.title, { scrub: true, stripPaths: flagBool(flags, 'strip-paths') }) : head.title
    const project = head.cwd ? basename(head.cwd) : basename(r.projectSlug)
    const row: PickRow = { sessionId: r.sessionId, path: r.path, projectSlug: r.projectSlug, project, sizeBytes: r.sizeBytes, mtimeMs: r.mtimeMs, running }
    if (title) row.title = title
    rows.push(row)
  }
  return { rows, counts: { total: refs.length, running: ordered.filter((x) => x.running).length } }
}

export async function cmdPick(flags: Record<string, string | boolean>, deps: PickDeps): Promise<void> {
  const now = deps.now ?? Date.now()
  const { rows, counts } = await gatherPickRows(flags, { now, ...(deps.isAlive ? { isAlive: deps.isAlive } : {}) })
  // --json is a contract: the array is always printed, `[]` included; an empty chooser still exits 1
  if (flagBool(flags, 'json')) deps.stdout.write(JSON.stringify(rows, null, 2) + '\n')
  if (!rows.length) throw new Error('No sessions found. Is Claude Code installed? Try: orangu list')
  if (flagBool(flags, 'json')) return
  if (!interactivePrecondition(deps.stdin, deps.stdout, deps.env, flags)) {
    deps.stdout.write(pickList(deps.out, rows, counts, now).join('\n') + '\n')
    return
  }
  const result = await select({
    count: rows.length,
    render: (view) => pickFrame({ ...deps.out, columns: view.columns }, rows, view, counts, now),
    input: deps.stdin,
    output: deps.stdout,
    caps: deps.out,
    ...(deps.proc ? { proc: deps.proc } : {}),
  })
  if (result.kind === 'cancel') {
    if (result.code) process.exitCode = result.code
    else deps.stderr.write(paint(deps.err, 'dim', '  cancelled') + '\n')
    return
  }
  await deps.openReport(rows[result.index]!.sessionId)
}
