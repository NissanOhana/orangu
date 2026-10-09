/**
 * The cmux tab map of orangu god: `cmux capabilities` once at start, `cmux tree --all --json`, and
 * `ps -o pid=,tty=,lstart=` in UTC. A session shows in cmux through its PID, then its TTY, then the 1 cmux surface
 * that has that TTY.
 *
 * Each read returns plain data or a source failure and never throws. Only the start check can find cmux missing
 * (the command did not start). After that, a failed read is off, and the collector keeps the last good map.
 * The map fails closed: a TTY that 2 surfaces or 2 PIDs share gives no tab, because a jump or a key on that tab
 * could reach the wrong session.
 */
import type { Host } from '../host.js'
import type { TabRef } from '../types.js'
import {
  exitReason,
  formReason,
  isObject,
  isPid,
  notRunReason,
  off,
  parseJson,
  textOf,
  tryRun,
  type CleanText,
  type ProcStart,
  type SourceResult,
} from './agents.js'

const CMUX_MISSING = 'The cmux command did not start.'

/** What the cmux server says it can do: the names of its methods, and its protocol version when it gives one. */
export type CmuxCapabilities = { methods: readonly string[]; version?: number }

/** Runs `cmux capabilities` once at start. A cmux that does not start is missing. */
export async function readCmuxCapabilities(host: Host): Promise<SourceResult<CmuxCapabilities>> {
  const result = await tryRun(host, ['cmux', 'capabilities'])
  if (!result) return { ok: false, status: 'missing', reason: CMUX_MISSING }
  if (result.exitCode !== 0) return off(exitReason('cmux capabilities', result.exitCode))
  const value = parseJson(result.stdout)
  const methods = isObject(value) && Array.isArray(value.methods) ? (value.methods as unknown[]) : undefined
  if (!isObject(value) || !methods || !methods.every((method) => typeof method === 'string')) return off(formReason('cmux capabilities'))
  const capabilities: CmuxCapabilities = { methods: methods as string[] }
  if (typeof value.version === 'number') capabilities.version = value.version
  return { ok: true, value: capabilities }
}

/** 1 cmux surface that has a TTY, with the workspace that holds it. */
export type CmuxSurface = {
  /** the TTY name as cmux writes it */
  tty: string
  workspaceRef: string
  surfaceRef: string
  /** cleaned */
  workspaceTitle: string
  /** cleaned; absent when the surface has no title */
  surfaceTitle?: string
}

/** The surfaces of 1 tree read, and the nodes that did not parse. */
export type CmuxTree = { surfaces: readonly CmuxSurface[]; parseErrors: number }

const listOf = (value: unknown): readonly unknown[] | undefined => (Array.isArray(value) ? value : undefined)

/** Collects the surfaces of 1 tree and counts each window, workspace, pane or surface node that has the wrong form. */
class TreeWalk {
  readonly surfaces: CmuxSurface[] = []
  parseErrors = 0

  constructor(private readonly clean: CleanText) {}

  window(value: unknown): void {
    const workspaces = isObject(value) ? listOf(value.workspaces) : undefined
    if (!workspaces) this.parseErrors += 1
    else for (const workspace of workspaces) this.workspace(workspace)
  }

  private workspace(value: unknown): void {
    const panes = isObject(value) ? listOf(value.panes) : undefined
    if (!isObject(value) || typeof value.ref !== 'string' || !panes) {
      this.parseErrors += 1
      return
    }
    const title = textOf(value.title)
    const workspace = { workspaceRef: value.ref, workspaceTitle: title ? this.clean(title) : '' }
    for (const pane of panes) {
      const surfaces = isObject(pane) ? listOf(pane.surfaces) : undefined
      if (!surfaces) this.parseErrors += 1
      else for (const surface of surfaces) this.surface(surface, workspace)
    }
  }

  private surface(value: unknown, workspace: Pick<CmuxSurface, 'workspaceRef' | 'workspaceTitle'>): void {
    if (!isObject(value) || typeof value.ref !== 'string') {
      this.parseErrors += 1
      return
    }
    const tty = textOf(value.tty)
    if (!tty) return // a browser surface has no TTY
    const surface: CmuxSurface = { tty, workspaceRef: workspace.workspaceRef, surfaceRef: value.ref, workspaceTitle: workspace.workspaceTitle }
    const title = textOf(value.title)
    if (title) surface.surfaceTitle = this.clean(title)
    this.surfaces.push(surface)
  }
}

/** The surfaces of `cmux tree --all --json` that have a TTY, or nothing when the output has no windows list. */
export function parseCmuxTree(stdout: string, clean: CleanText): CmuxTree | undefined {
  const tree = parseJson(stdout)
  const windows = isObject(tree) ? listOf(tree.windows) : undefined
  if (!windows) return undefined
  const walk = new TreeWalk(clean)
  for (const window of windows) walk.window(window)
  return { surfaces: walk.surfaces, parseErrors: walk.parseErrors }
}

/** Runs `cmux tree --all --json`. */
export async function readCmuxTree(host: Host, clean: CleanText): Promise<SourceResult<CmuxTree>> {
  try {
    const result = await tryRun(host, ['cmux', 'tree', '--all', '--json'])
    if (!result) return off(notRunReason('cmux tree'))
    if (result.exitCode !== 0) return off(exitReason('cmux tree', result.exitCode))
    const tree = parseCmuxTree(result.stdout, clean)
    return tree ? { ok: true, value: tree } : off(formReason('cmux tree'))
  } catch {
    return off(formReason('cmux tree'))
  }
}

/** 1 line of `ps -o pid=,tty=,lstart=` in UTC: the TTY is absent when ps writes `??` (no terminal). */
export type PsRow = ProcStart & { tty?: string }

/** The rows of 1 ps read, and the lines that did not parse. */
export type PsRead = { rows: readonly PsRow[]; parseErrors: number }

/** The PID, the TTY, then the start time; the start time keeps its inner spaces (2 before a 1-digit day). */
const PS_LINE = /^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/
const NO_TTY = new Set(['??', '-'])

/** Parses the output of `ps -o pid=,tty=,lstart=`. A line that does not parse counts and gives no row. */
export function parsePs(stdout: string): PsRead {
  const rows: PsRow[] = []
  let parseErrors = 0
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const match = PS_LINE.exec(line)
    const pid = Number(match?.[1])
    const [tty, lstart] = [match?.[2], match?.[3]]
    if (!isPid(pid) || tty === undefined || lstart === undefined) {
      parseErrors += 1
      continue
    }
    rows.push(NO_TTY.has(tty) ? { pid, lstart } : { pid, tty, lstart })
  }
  return { rows, parseErrors }
}

/**
 * Runs ps once for the PIDs, in UTC: the registry writes procStart in UTC, so the start time compares as text.
 * ps exits 1 when no PID of the list runs, so exit 1 is an empty read, not a failure.
 */
export async function readPs(host: Host, pids: readonly number[]): Promise<SourceResult<PsRead>> {
  const wanted = [...new Set(pids.filter(isPid))]
  if (wanted.length === 0) return { ok: true, value: { rows: [], parseErrors: 0 } }
  const result = await tryRun(host, ['ps', '-o', 'pid=,tty=,lstart=', '-p', wanted.join(',')], { env: { TZ: 'UTC' } })
  if (!result) return off(notRunReason('ps'))
  if (result.exitCode !== 0 && result.exitCode !== 1) return off(exitReason('ps', result.exitCode))
  return { ok: true, value: parsePs(result.stdout) }
}

/** The TTY name with no `/dev/` folder: ps writes `ttys003`, and a surface with no shell integration can write `/dev/ttys003`. */
const ttyName = (tty: string): string => (tty.startsWith('/dev/') ? tty.slice('/dev/'.length) : tty)

/** Counts each TTY name, so a TTY that 2 surfaces or 2 PIDs share gives no tab. */
function countTtys(ttys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const tty of ttys) counts.set(ttyName(tty), (counts.get(ttyName(tty)) ?? 0) + 1)
  return counts
}

/** The cmux tab of each PID that has a TTY that exactly 1 PID and exactly 1 surface show, by PID. */
export function mapTabs(ps: readonly PsRow[], surfaces: readonly CmuxSurface[]): TabRef[] {
  const surfaceCounts = countTtys(surfaces.map((surface) => surface.tty))
  const pidCounts = countTtys(ps.flatMap((row) => (row.tty === undefined ? [] : [row.tty])))
  const byTty = new Map(surfaces.map((surface) => [ttyName(surface.tty), surface]))
  const tabs: TabRef[] = []
  for (const row of ps) {
    if (row.tty === undefined) continue
    const name = ttyName(row.tty)
    const surface = byTty.get(name)
    if (!surface || surfaceCounts.get(name) !== 1 || pidCounts.get(name) !== 1) continue
    const tab: TabRef = { pid: row.pid, tty: row.tty, workspaceRef: surface.workspaceRef, surfaceRef: surface.surfaceRef, workspaceTitle: surface.workspaceTitle }
    if (surface.surfaceTitle !== undefined) tab.surfaceTitle = surface.surfaceTitle
    tabs.push(tab)
  }
  return tabs.sort((a, b) => a.pid - b.pid)
}
