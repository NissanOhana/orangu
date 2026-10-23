/**
 * Bare interactive `orangu`: a local report dashboard over the existing command paths.
 *
 * The dashboard owns no analysis or report logic. It discovers enough metadata to describe the
 * choices, then calls the injected improve/repo/global/session commands. Non-interactive callers never
 * enter this module's discovery path; main.ts keeps the compact latest-session answer for them.
 *
 * The IMPROVE choice counts the queue of this folder from the store and the cohort facts cache only: its read may parse
 * no transcript, so no transcript read comes before the first frame. The printout of the choice runs the full check.
 */
import { basename, resolve } from 'node:path'
import { claudeRoots, listSessions } from '../../discover/discover.js'
import { flagStr } from '../args.js'
import { mascotArt, mascotLines } from '../mascot-ascii.js'
import { machineQueueReads, queueCounts, type QueueCountReads } from '../next-step.js'
import { select, type InputLike, type OutputLike, type SelectView } from '../select.js'
import { fmtAge, layoutWidth, type PickRow } from '../summary.js'
import { displayWidth, glyphs, paint, truncate, type Caps, type ExitHookProcess, type WritableLike } from '../tty.js'
import { gatherPickRows, interactivePrecondition } from './pick.js'

const INDENT = '  '
/** the longest tag (IMPROVE, SESSION) and 1 space */
const TAG_WIDTH = 8
/** frame rows outside the art and the choices: blank, header, counts, blank, "N more", key hint */
const CHROME_ROWS_AROUND_ART = 6
const TARGETED_BARE_FLAGS = ['session', 's', 'global', 'cwd', 'max-tokens', 'fail-on-hook-errors'] as const
/** The transcript bytes that the IMPROVE count may parse on a cache miss: none. An item with no cache entry is not due. */
export const DASHBOARD_QUEUE_BYTES = 0

/** The queue of this folder as the dashboard counts it, or the store that could not be read. */
export type DashboardQueue = { due: number; open: number } | 'store-error'

export interface DashboardData {
  repoName: string
  repoSessions: number
  globalSessions: number
  roots: number
  runningSessions: number
  live: PickRow[]
  queue: DashboardQueue
}

type DashboardChoice =
  | { kind: 'improve' }
  | { kind: 'repo' }
  | { kind: 'global' }
  | { kind: 'browse' }
  | { kind: 'session'; row: PickRow }

/**
 * What a scope choice asks its command for. Choosing REPO or GLOBAL here is an explicit request to
 * see the report, so the dashboard asks for the HTML one; main.ts folds this into the run's flags,
 * where --no-open still wins.
 */
export interface ScopeReportRequest {
  open: true
}

export interface DashboardDeps {
  showRepo: (request: ScopeReportRequest) => Promise<void>
  showGlobal: (request: ScopeReportRequest) => Promise<void>
  showSession: (sessionId: string) => Promise<void>
  browseSessions: () => Promise<void>
  /** prints the queue of this folder with the full check: the run of `orangu suggest --queue` */
  showQueue: () => Promise<void>
  /** the reads of the IMPROVE count; the default is the store, the cache and the discovery of this machine */
  queue?: QueueCountReads
  stdin: InputLike & { isTTY?: boolean }
  stdout: OutputLike & { isTTY?: boolean }
  stderr: WritableLike
  env: NodeJS.ProcessEnv
  out: Caps
  err: Caps
  now?: number
  cwd?: () => string
  isAlive?: (pid: number) => boolean
  proc?: ExitHookProcess
}

/** Explicit selectors and CI/machine modes retain the historical latest-session answer. */
export function dashboardPrecondition(
  stdin: { isTTY?: boolean; setRawMode?: unknown },
  stdout: { isTTY?: boolean },
  env: NodeJS.ProcessEnv,
  flags: Record<string, string | boolean>,
): boolean {
  if (TARGETED_BARE_FLAGS.some((flag) => flags[flag] !== undefined)) return false
  return interactivePrecondition(stdin, stdout, env, flags)
}

/** The queue counts of this folder at a budget of 0 B, or the store error. Any failure of the read is that error. */
async function countQueue(cwd: string, now: number, reads: QueueCountReads): Promise<DashboardQueue> {
  try {
    const { due, open } = await queueCounts(cwd, now, DASHBOARD_QUEUE_BYTES, reads)
    return { due, open }
  } catch {
    return 'store-error'
  }
}

/** Read counts in parallel; reuse the picker as the one source of truth for live-session status. */
export async function gatherDashboardData(
  flags: Record<string, string | boolean>,
  deps: { now?: number; cwd?: () => string; isAlive?: (pid: number) => boolean; queue?: QueueCountReads } = {},
): Promise<DashboardData> {
  const cwd = resolve((deps.cwd ?? (() => process.cwd()))())
  const configArg = flagStr(flags, 'root', 'config', 'r')
  const pickFlags = { ...flags, global: true }
  const reads = deps.queue ?? machineQueueReads({ cache: !(flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1') })
  const [picked, repoRefs, roots, queue] = await Promise.all([
    gatherPickRows(pickFlags, { ...(deps.now !== undefined ? { now: deps.now } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}) }),
    listSessions(configArg ? { configDir: configArg, cwd } : { cwd }),
    claudeRoots(configArg),
    countQueue(cwd, deps.now ?? Date.now(), reads),
  ])
  return {
    repoName: basename(cwd) || cwd,
    repoSessions: repoRefs.length,
    globalSessions: picked.counts.total,
    roots: roots.length,
    runningSessions: picked.counts.running,
    live: picked.rows.filter((row) => row.running),
    queue,
  }
}

/** IMPROVE comes first when this folder has an open item or the store cannot be read. It is absent when nothing is open. */
export function dashboardChoices(data: DashboardData): DashboardChoice[] {
  const choices: DashboardChoice[] = data.queue === 'store-error' || data.queue.open > 0 ? [{ kind: 'improve' }] : []
  choices.push({ kind: 'repo' }, { kind: 'global' })
  if (data.globalSessions) choices.push({ kind: 'browse' })
  choices.push(...data.live.map((row) => ({ kind: 'session' as const, row })))
  return choices
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function choiceText(choice: DashboardChoice, data: DashboardData, now: number, sep: string): { tag: string; text: string; live: boolean } {
  switch (choice.kind) {
    case 'improve': {
      const counts = data.queue === 'store-error' ? 'the store could not be read' : `${data.queue.due} due${sep}${data.queue.open} open`
      return { tag: 'IMPROVE', text: `Improvements${sep}${counts}`, live: false }
    }
    case 'repo':
      return { tag: 'REPO', text: `Repository report${sep}${data.repoName}${sep}${count(data.repoSessions, 'session')}`, live: false }
    case 'global':
      return { tag: 'GLOBAL', text: `Global report${sep}${count(data.globalSessions, 'session')}${sep}${count(data.roots, 'root')}`, live: false }
    case 'browse':
      return { tag: 'SESSION', text: `Browse session reports${sep}${count(data.globalSessions, 'session')}`, live: false }
    case 'session': {
      const title = oneLine(choice.row.title ?? choice.row.sessionId.slice(0, 8))
      return { tag: 'LIVE', text: `${title}${sep}${choice.row.project}${sep}${fmtAge(choice.row.mtimeMs, now)}`, live: true }
    }
  }
}

/**
 * Rows the frame spends on everything that is not a choice. Derived from the art the same caps
 * render, so a taller tier never leaves the window claiming rows the frame has already spent:
 * WIDE 14, STACKED 13, MINI 15.
 */
export function dashboardChromeLines(caps: Caps): number {
  return mascotArt(layoutWidth(caps)).length + CHROME_ROWS_AROUND_ART
}

/** Pure terminal frame: orange mascot, scope summaries, live shortcuts, and one key hint. */
export function dashboardFrame(
  caps: Caps,
  data: DashboardData,
  choices: DashboardChoice[],
  view: Pick<SelectView, 'cursor' | 'start' | 'size'>,
  now: number,
): string[] {
  const width = layoutWidth(caps)
  const g = glyphs(caps)
  const lines = [
    ...mascotLines(caps),
    '',
    paint(caps, 'bold', INDENT + 'Choose a report'),
    paint(caps, 'dim', truncate(`${INDENT}${count(data.runningSessions, 'open Claude session')}${g.sep}local only${g.sep}no network calls`, width, caps)),
    '',
  ]
  const end = Math.min(choices.length, view.start + view.size)
  for (let i = view.start; i < end; i++) {
    const choice = choices[i]!
    const rendered = choiceText(choice, data, now, g.sep)
    const cursor = i === view.cursor
    const prefix = `${INDENT}${cursor ? paint(caps, 'accent', '>') : ' '} `
    const liveMark = rendered.live ? paint(caps, 'good', g.mark) : ' '
    const tag = paint(caps, rendered.live ? 'good' : 'accent', rendered.tag.padEnd(TAG_WIDTH))
    const budget = Math.max(1, width - displayWidth(prefix) - 2 - TAG_WIDTH - 1)
    const text = truncate(rendered.text, budget, caps)
    lines.push(prefix + liveMark + ' ' + tag + (cursor ? paint(caps, 'bold', text) : text))
  }
  const hidden = choices.length - (end - view.start)
  lines.push(hidden > 0 ? paint(caps, 'dim', truncate(`${INDENT}    ${g.up}${g.down} ${count(hidden, 'more choice')}`, width, caps)) : '')
  const keys = caps.unicode ? '↑↓ or j k move · enter selects · q quits' : 'up/down or j k move | enter selects | q quits'
  lines.push(paint(caps, 'dim', truncate(INDENT + keys, width, caps)))
  return lines
}

async function runChoice(choice: DashboardChoice, deps: DashboardDeps): Promise<void> {
  switch (choice.kind) {
    case 'improve':
      return deps.showQueue()
    case 'repo':
      return deps.showRepo({ open: true })
    case 'global':
      return deps.showGlobal({ open: true })
    case 'browse':
      return deps.browseSessions()
    case 'session':
      return deps.showSession(choice.row.sessionId)
  }
}

/** Return false only when main.ts should use the non-interactive latest-session brief. */
export async function cmdDashboard(flags: Record<string, string | boolean>, deps: DashboardDeps): Promise<boolean> {
  if (!dashboardPrecondition(deps.stdin, deps.stdout, deps.env, flags)) return false
  const now = deps.now ?? Date.now()
  const data = await gatherDashboardData(flags, {
    now,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
    ...(deps.queue ? { queue: deps.queue } : {}),
  })
  const choices = dashboardChoices(data)
  const terminalRows = Number.isFinite(deps.stdout.rows) && (deps.stdout.rows ?? 0) > 0 ? (deps.stdout.rows as number) : 24
  const result = await select({
    count: choices.length,
    render: (view) => dashboardFrame({ ...deps.out, columns: view.columns }, data, choices, view, now),
    input: deps.stdin,
    output: deps.stdout,
    caps: deps.out,
    viewRows: Math.max(1, terminalRows - dashboardChromeLines(deps.out)),
    ...(deps.proc ? { proc: deps.proc } : {}),
  })
  if (result.kind === 'cancel') {
    if (result.code) process.exitCode = result.code
    else deps.stderr.write(paint(deps.err, 'dim', '  cancelled') + '\n')
    return true
  }
  await runChoice(choices[result.index]!, deps)
  return true
}
