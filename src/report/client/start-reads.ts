/**
 * Serve only: the reads of the start view (#start). start-ui.ts draws the view from the state that this file keeps.
 * Only serve-ui.ts and start-ui.ts import this file, so the file bundles carry none of it (src/report/offline.test.ts
 * holds them to it).
 *
 * The view starts no read that analyzes every session. A repository or machine read analyzes each session of the
 * registry before its first reply and keeps each analysis, so on a large disk it runs for minutes (SPEC risk 13). The
 * machine read starts only from its control (Read this machine, then Read again on a failure), with its progress.
 * Sessions and agents reads only the sessions that it lists, the running ones and the 20 newest, through the session
 * read of each, and fills each row as its read lands.
 *
 * The screen data seam of serve (serve-ui.ts) calls ensureStart on each render of #start: it starts the profile read
 * once and the reads of the listed sessions. Each read keeps its state here and draws the app again when it lands. Live
 * frames draw the view again, as home-ui.ts does for the queue, and a window that gets focus reads the profile again,
 * so an interview that ran in Claude Code shows when the person comes back.
 */
import type { Aggregate } from '../../analyze/aggregate.js'
import type { Insight } from '../../model/analysis.js'
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import type { DataSource, ProfileRead } from './data.js'
import { liveRows, startZoom, type RouteState } from './nav.js'

/** The machine read: asked by its control, busy while it runs, its progress from the 202 bodies, and why it stopped. */
export interface ReadView {
  asked?: boolean
  busy: boolean
  done?: number
  total?: number
  failed?: string
}

/** What a listed session gives once its read lands: the parts that its row and the findings of the list show. */
export interface RowRead {
  title?: string
  tokens: number
  agents: number
  insights: Insight[]
}

/** Sessions and agents lists the running sessions, then this many of the newest. */
export const NEWEST = 20

export const newestFirst = (rows: SessionSummaryRow[]): SessionSummaryRow[] => [...rows].sort((a, b) => b.mtimeMs - a.mtimeMs)

/** The sessions that Sessions and agents lists: the running ones, then the newest of the others. */
export function listedRows(d: AppData): SessionSummaryRow[] {
  const live = newestFirst(liveRows(d))
  const liveIds = new Set(live.map((r) => r.id))
  return [...live, ...newestFirst(d.sessions.filter((r) => !liveIds.has(r.id))).slice(0, NEWEST)]
}

/** The parts of an analysis that a listed row and the findings of the list read. */
export function rowReadOf(a: { session: { title?: string }; summary: { totalTokens: number }; agents: { runs: unknown[] }; insights: Insight[] }): RowRead {
  return { ...(a.session.title ? { title: a.session.title } : {}), tokens: a.summary.totalTokens, agents: a.agents.runs.length, insights: a.insights }
}

// ---------- the reads: module state, as home-ui.ts keeps the queue ----------

let source: DataSource | undefined
let rerender: () => void = () => {}
let profile: ProfileRead | null | undefined
let profileBusy = false
const machine: ReadView = { busy: false }
/** the reads of the listed sessions: absent while each runs, null when it failed */
const rowReads = new Map<string, RowRead | null>()
const rowAsked = new Set<string>()
const rowWaiting: string[] = []
let rowsBusy = 0
/** How many session reads of the list run at once: each one analyzes its session in serve when no cache holds it. */
const ROW_READS = 4

/** Is the start view on the page? app.ts gives each screen the id `screen-<id>`. */
const onStart = (): boolean => typeof document !== 'undefined' && document.getElementById('screen-start') !== null

/**
 * Did the person ask for the machine read, or did another screen read the machine? Only then does the harness read
 * start for This machine (serve-ui.ts): it analyzes every session too.
 */
export function machineRead(d: AppData): boolean {
  return machine.asked === true || !!d.aggregates.global
}

/** The reads that start-ui.ts draws: the interview status, the machine read and the read of each listed session. */
export function startReadState(): { profile: ProfileRead | null | undefined; machine: ReadView; rows: ReadonlyMap<string, RowRead | null> } {
  return { profile, machine, rows: rowReads }
}

/** Draw the app again, by the callback of the last ensureStart: a read control calls it once its read starts. */
export function redraw(): void {
  rerender()
}

/** Read the interview status. A failed read again keeps the last good status. */
async function readProfile(): Promise<void> {
  if (profileBusy || !source?.profile) return
  profileBusy = true
  let read: ProfileRead | null = null
  try {
    read = await source.profile()
  } catch {
    read = null
  }
  profileBusy = false
  profile = read ?? (profile || null)
  if (onStart()) rerender()
}

/** Read the machine with its progress, and store the aggregate where #global and #suggest read it. Only a control calls it. */
export async function readMachine(d: AppData): Promise<void> {
  if (machine.busy || !source) return
  Object.assign(machine, { asked: true, busy: true, done: undefined, total: undefined, failed: undefined })
  let agg: Aggregate | null = null
  try {
    agg = await source.aggregate('global', undefined, {
      progress: (done, total) => {
        machine.done = done
        machine.total = total
        if (onStart()) rerender()
      },
      failed: (reason) => (machine.failed = reason),
    })
  } catch {
    agg = null
  }
  machine.busy = false
  if (agg) d.aggregates.global = agg
  else machine.failed ??= 'The request to localhost failed.'
  if (onStart()) rerender()
}

/** Read each listed session that no read asked for yet, at most ROW_READS at once, in the order of the list. */
function readRows(rows: SessionSummaryRow[]): void {
  for (const r of rows)
    if (!rowAsked.has(r.id)) {
      rowAsked.add(r.id)
      rowWaiting.push(r.id)
    }
  while (rowsBusy < ROW_READS && rowWaiting.length && source) {
    const id = rowWaiting.shift()!
    const ds = source
    rowsBusy++
    void ds
      .session(id)
      .then(
        (a) => rowReads.set(id, a ? rowReadOf(a) : null),
        () => rowReads.set(id, null),
      )
      .finally(() => {
        rowsBusy--
        readRows([])
        if (onStart()) rerender()
      })
  }
}

/** The listeners of the view, once: live frames draw it again, and a window that gets focus reads the profile again. */
function wire(ds: DataSource): void {
  ds.subscribe((ev) => {
    if ((ev.type === 'session-live' || ev.type === 'session-updated') && onStart()) rerender()
  })
  if (typeof window !== 'undefined')
    window.addEventListener('focus', () => {
      if (onStart()) void readProfile()
    })
}

/**
 * The data seam of #start (serve-ui.ts calls it on each render): the profile read once, and the reads of the listed
 * sessions when Sessions and agents is open. It starts no repository or machine read. `loaded` draws the app again.
 */
export function ensureStart(d: AppData, ds: DataSource, state: RouteState, loaded: () => void): void {
  rerender = loaded
  if (!source) {
    source = ds
    wire(ds)
  }
  if (profile === undefined) void readProfile()
  if (startZoom(d, state) === 'sessions') readRows(listedRows(d))
}
