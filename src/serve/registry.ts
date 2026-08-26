/**
 * Session registry: watches ~/.claude/projects for the fleet.
 *
 * - candidates = every session whose badge ≠ ended (mtime, policy) ∪ pinned; capped at maxLive
 *   (default 8, policy) keeping the most recently active (LRU by mtime). Memory is the record arrays.
 * - change detection: fs.watch (recursive) on each root's projects dir + a 1.5 s size poll over the
 *   tailed sessions (fs.watch on macOS misses some sidecar events) + a 10 s full rescan for newcomers.
 * - per session: coalesced ticks (min 500 ms apart), ≤ 1 in flight; across sessions: a FIFO queue
 *   drained by `concurrency` workers. One `session-updated` per completed tick, never per fs event.
 * - a session crossing into `ended` gets exactly one final (forced) tick, then is untailed.
 * - clock: `now()` is data for badges/generatedAt only; the analyzer itself stays clock-free.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listSessions, type DiscoverOptions, type SessionRef } from '../discover/discover.js'
import { discoverSubagentFiles } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import type { Analysis } from '../model/analysis.js'
import type { Session } from '../model/session.js'
import { AnalysisCache, analyzeRefCached } from '../cache/index.js'
import { badgeFor } from './badge.js'
import type { LiveBadge, SessionSummaryRow } from '../model/app-data.js'
import type { RegistryLike, ServeEvent, ServeOptions } from './types.js'
import { newTailState, tailOnce, sessionFromTail, type ReadFn, type TailState } from './tail.js'
import { rowFromAnalysis } from '../report/render.js'
import { redactValue } from '../redact/redact.js'
import type { RowEventView } from '../model/app-data.js'

export const DEFAULT_MAX_LIVE = 8
/** ring size of SessionSummaryRow.lastEvents  */
export const LAST_EVENTS_MAX = 5

export interface RegistryOptions {
  opts: ServeOptions
  cache: AnalysisCache | null
  /** parallel analyses across sessions (max(1, cpus-1) in serve) */
  concurrency: number
  /** min ms between tick starts per session (default 500) */
  minTickMs?: number
  rescanMs?: number
  pollMs?: number
  /** data clock (badges, generatedAt), injectable for tests */
  now?: () => number
  analyze?: (s: Session, o: { version: string; now: number }) => Analysis
  read?: ReadFn
}

interface Watched {
  ref: SessionRef
  badge: LiveBadge
  tail?: TailState
  analysis?: Analysis
  dirty: boolean
  queued: boolean
  inFlight: boolean
  /** real-clock ms of the last tick start (pacing, not data) */
  lastTickMs: number
  pinned: boolean
  /** force re-analysis on the next tick (the final tick of an ending session) */
  force: boolean
  seq: number
}

export class Registry implements RegistryLike {
  private readonly o: Required<Pick<RegistryOptions, 'concurrency'>> & RegistryOptions
  private readonly emitFn: (ev: ServeEvent) => void
  private readonly nowFn: () => number
  private readonly analyzeFn: (s: Session, o: { version: string; now: number }) => Analysis
  private readonly readFn: ReadFn | undefined
  private readonly minTickMs: number
  private readonly maxLive: number
  private watched = new Map<string, Watched>()
  private queue: string[] = []
  private running = 0
  private timers: Array<ReturnType<typeof setInterval>> = []
  private watchers: FSWatcher[] = []
  private stopped = false
  private rescanSoon: ReturnType<typeof setTimeout> | undefined

  constructor(o: RegistryOptions, emit: (ev: ServeEvent) => void) {
    this.o = o
    this.emitFn = emit
    this.nowFn = o.now ?? Date.now
    this.analyzeFn = o.analyze ?? analyzeSession
    this.readFn = o.read
    this.minTickMs = o.minTickMs ?? 500
    this.maxLive = Math.max(1, o.opts.maxLive ?? DEFAULT_MAX_LIVE)
  }

  private discoverOpts(): DiscoverOptions {
    const s = this.o.opts
    const d: DiscoverOptions = {}
    if (s.roots && s.roots.length) d.roots = s.roots
    else if (s.configDir) d.configDir = s.configDir
    if (s.cwd) d.cwd = s.cwd
    return d
  }

  /** Start timers + fs watchers. Tests drive rescanOnce/pollOnce/markDirty directly instead. */
  async start(): Promise<void> {
    await this.rescanOnce()
    const rescanMs = this.o.rescanMs ?? 10_000
    const pollMs = this.o.pollMs ?? 1_500
    const t1 = setInterval(() => void this.rescanOnce().catch(() => {}), rescanMs)
    const t2 = setInterval(() => void this.pollOnce().catch(() => {}), pollMs)
    t1.unref?.()
    t2.unref?.()
    this.timers.push(t1, t2)
    const roots = this.o.opts.roots?.length ? this.o.opts.roots : this.o.opts.configDir ? [this.o.opts.configDir] : []
    for (const root of roots) {
      try {
        const w = fsWatch(join(root, 'projects'), { recursive: true }, (_ev, filename) => this.onFsEvent(String(filename ?? '')))
        this.watchers.push(w)
      } catch {
        /* recursive watch unavailable; the poll + rescan cover it */
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    if (this.rescanSoon) clearTimeout(this.rescanSoon)
    for (const w of this.watchers) w.close()
    this.timers = []
    this.watchers = []
    this.queue = []
    for (const w of this.watched.values()) w.queued = false
    await this.settle()
  }

  private onFsEvent(filename: string): void {
    // map the changed path to a watched session: its own .jsonl, or anything under <id>/ (sidecars)
    for (const [id, w] of this.watched) {
      if (!w.tail) continue
      if (filename.endsWith(`${id}.jsonl`) || filename.includes(`${id}/`) || filename.includes(`${id}\\`)) {
        this.markDirty(id)
        return
      }
    }
    // an unknown .jsonl appeared → a new session; debounce a rescan
    if (filename.endsWith('.jsonl') && !this.rescanSoon) {
      this.rescanSoon = setTimeout(() => {
        this.rescanSoon = undefined
        void this.rescanOnce().catch(() => {})
      }, 500)
      this.rescanSoon.unref?.()
    }
  }

  /** Full discovery pass: newcomers, refreshed refs, badge changes, tailing set. */
  async rescanOnce(): Promise<void> {
    const refs = await listSessions(this.discoverOpts())
    for (const ref of refs) {
      const existing = this.watched.get(ref.sessionId)
      if (!existing) {
        const { badge } = badgeFor(ref.mtimeMs, this.nowFn())
        const w: Watched = { ref, badge, dirty: false, queued: false, inFlight: false, lastTickMs: 0, pinned: false, force: false, seq: 0 }
        this.watched.set(ref.sessionId, w)
        this.emitFn({ type: 'session-added', row: this.rowFor(w) })
      } else {
        const grown = ref.mtimeMs !== existing.ref.mtimeMs || ref.sizeBytes !== existing.ref.sizeBytes || ref.subagentFiles.length !== existing.ref.subagentFiles.length
        existing.ref = ref
        if (grown && existing.tail) this.markDirty(ref.sessionId)
      }
    }
    this.checkBadges()
    this.ensureTailing()
  }

  /** Cheap per-tailed-session stat poll (fallback for missed fs events) + badge recompute. */
  async pollOnce(): Promise<void> {
    for (const [id, w] of this.watched) {
      if (!w.tail) continue
      try {
        const st = await stat(w.ref.path)
        if (st.size !== w.ref.sizeBytes || st.mtimeMs !== w.ref.mtimeMs) {
          w.ref.sizeBytes = st.size
          w.ref.mtimeMs = st.mtimeMs
          this.markDirty(id)
        }
      } catch {
        /* transcript vanished; rescan will drop it */
      }
    }
    this.checkBadges()
    this.ensureTailing()
  }

  /** Recompute badges from mtime; emit session-live on change; queue the final tick on → ended. */
  private checkBadges(): void {
    const now = this.nowFn()
    for (const [id, w] of this.watched) {
      const { badge, ageMs } = badgeFor(w.ref.mtimeMs, now)
      if (badge !== w.badge) {
        w.badge = badge
        this.emitFn({ type: 'session-live', id, badge, ageMs })
        if (badge === 'ended' && w.tail) {
          w.force = true // one final (forced) tick, then untailed by runTick
          this.markDirty(id)
        }
      }
    }
  }

  /** Keep the tailed set = top-maxLive candidates (badge ≠ ended ∪ pinned) by most-recent mtime. */
  private ensureTailing(): void {
    const candidates = [...this.watched.values()].filter((w) => w.badge !== 'ended' || w.pinned).sort((a, b) => b.ref.mtimeMs - a.ref.mtimeMs)
    const keep = new Set(candidates.slice(0, this.maxLive).map((w) => w.ref.sessionId))
    for (const [id, w] of this.watched) {
      if (keep.has(id) && !w.tail) {
        w.tail = newTailState(w.ref.path)
        this.markDirty(id)
      } else if (!keep.has(id) && w.tail && !w.force && !w.inFlight && !w.queued) {
        w.tail = undefined // evicted (LRU): analysis kept, record arrays freed
      }
    }
  }

  /** counts for the fleet header ("watching X of N") and tests */
  tailedIds(): string[] {
    return [...this.watched.entries()].filter(([, w]) => w.tail).map(([id]) => id)
  }

  markDirty(id: string): void {
    const w = this.watched.get(id)
    if (!w || !w.tail) return
    w.dirty = true
    this.enqueue(id)
  }

  private enqueue(id: string): void {
    const w = this.watched.get(id)
    if (!w || w.queued || w.inFlight) return
    w.queued = true
    this.queue.push(id)
    this.pump()
  }

  private pump(): void {
    while (!this.stopped && this.running < this.o.concurrency && this.queue.length) {
      const id = this.queue.shift()!
      void this.runTick(id)
    }
  }

  private async runTick(id: string): Promise<void> {
    const w = this.watched.get(id)
    if (!w || !w.tail) {
      if (w) w.queued = false
      return
    }
    w.queued = false
    w.inFlight = true
    this.running++
    try {
      const wait = w.lastTickMs + this.minTickMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      w.lastTickMs = Date.now()
      w.dirty = false
      await this.tickInner(w)
    } catch {
      /* a mid-write file or vanished sidecar: the next tick retries */
    } finally {
      w.inFlight = false
      this.running--
      if (w.badge === 'ended' && !w.pinned) {
        w.force = false
        w.tail = undefined // final tick done → untailed
        w.dirty = false
      } else if (w.dirty && !this.stopped) this.enqueue(id)
      this.pump()
    }
  }

  /** public single-tick entry (PLAN): mark dirty and wait for the queue to drain this session */
  async tick(id: string): Promise<void> {
    this.markDirty(id)
    await this.settle()
  }

  /** wait until no tick is queued, scheduled or in flight (tests + shutdown) */
  async settle(timeoutMs = 5_000): Promise<void> {
    const t0 = Date.now()
    for (;;) {
      const busy =
        this.running > 0 || (!this.stopped && (this.queue.length > 0 || [...this.watched.values()].some((w) => w.tail && (w.dirty || w.queued || w.inFlight))))
      if (!busy || Date.now() - t0 > timeoutMs) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  private async tickInner(w: Watched): Promise<void> {
    if (!w.tail) return
    // refresh file facts + sidecar list before reading
    try {
      const st = await stat(w.ref.path)
      w.ref.sizeBytes = st.size
      w.ref.mtimeMs = st.mtimeMs
    } catch {
      return
    }
    try {
      const subs = await discoverSubagentFiles(w.ref.path)
      w.ref.subagentFiles = subs.map((s) => s.path)
    } catch (error) {
      w.ref.subagentFiles = []
      throw error
    }
    const { changed } = await tailOnce(w.tail, w.ref, this.readFn)
    if (!changed && w.analysis && !w.force) return
    const session = await sessionFromTail(w.tail)
    w.analysis = this.analyzeFn(session, { version: this.o.opts.version, now: this.nowFn() })
    w.seq++
    this.emitFn({ type: 'session-updated', id: w.ref.sessionId, seq: w.seq, row: this.rowFor(w) })
  }

  /**
   * Rows are built from the raw analysis, and every consumer (list() → /api/sessions and
   * /api/app, plus the session-added/session-updated SSE frames) sends them off-process, so the
   * row is redacted HERE, at its single construction point, with the /api/session/:id policy
   * (scrub on; text stripped unless --include-text).
   */
  private rowFor(w: Watched): SessionSummaryRow {
    const now = this.nowFn()
    const { badge, ageMs } = badgeFor(w.ref.mtimeMs, now)
    if (w.analysis) {
      const row = rowFromAnalysis(w.analysis, now)
      row.badge = badge
      row.ageMs = ageMs
      row.mtimeMs = w.ref.mtimeMs
      row.sizeBytes = w.ref.sizeBytes
      row.possiblyLive = badge !== 'ended' && w.analysis.session.live
      row.agentsRunning = badge === 'ended' ? 0 : w.analysis.agents.runs.filter((r) => r.status === 'running').length
      // Small recent-events ring for the fleet's merged feed, using the same source as
      // lastEvent, ≤ 5 entries, additive on the row, redacted below with everything else.
      row.lastEvents = w.analysis.tools.calls
        .slice(-LAST_EVENTS_MAX)
        .map((c) => ({ ts: c.startTs, name: c.name, category: c.category, summary: c.summary }))
      // Tool names remain structural and visible; transcript-derived title and
      // event summaries follow the same default stripText policy as Analysis.
      return redactValue(row, { scrub: true, stripText: !this.o.opts.includeText })
    }
    return redactValue(
      {
        id: w.ref.sessionId,
        projectSlug: w.ref.projectSlug,
        path: w.ref.path,
        source: 'claude-code',
        sizeBytes: w.ref.sizeBytes,
        mtimeMs: w.ref.mtimeMs,
        badge,
        ageMs,
        possiblyLive: false,
      },
      { scrub: true, stripText: !this.o.opts.includeText },
    )
  }

  list(): SessionSummaryRow[] {
    return [...this.watched.values()].sort((a, b) => b.ref.mtimeMs - a.ref.mtimeMs).map((w) => this.rowFor(w))
  }

  /** tailed → the live analysis; otherwise analyze on demand through the cache (ended sessions). */
  async analysis(id: string): Promise<Analysis | undefined> {
    const w = this.watched.get(id)
    if (!w) return undefined
    if (w.analysis) return w.analysis
    try {
      w.analysis = await analyzeRefCached(w.ref, { cache: this.o.cache, version: this.o.opts.version, now: this.nowFn() })
      return w.analysis
    } catch {
      return undefined
    }
  }

  pin(id: string): void {
    const w = this.watched.get(id)
    if (!w) return
    w.pinned = true
    this.ensureTailing()
  }
}
