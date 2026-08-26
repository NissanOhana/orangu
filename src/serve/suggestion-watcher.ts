/**
 * Cross-process suggestion observation.
 *
 * The serve process and an explicitly invoked Claude/Codex workflow intentionally
 * use separate SuggestionStore instances over the same append-only JSONL file. A
 * short poll is the portable fallback that turns the CLI's append into an
 * SSE event; `observe()` records in-process writes first so the poll cannot emit
 * a duplicate for the same version.
 */
import type { SuggestionRecord, SuggestionStoreLike } from '../suggest/types.js'
import type { ServeEvent } from './types.js'

const DEFAULT_POLL_MS = 250

function versionOf(rec: SuggestionRecord): string {
  return JSON.stringify({
    id: rec.id,
    status: rec.status,
    statusAt: rec.statusAt,
    proposalPath: rec.proposal?.proposalPath ?? null,
    kickoffExit: rec.kickoff?.exitCode ?? null,
    kickoffError: rec.kickoff?.error ?? null,
  })
}

export class SuggestionWatcher {
  private readonly seen = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  private observedGeneration = 0

  constructor(
    private readonly store: SuggestionStoreLike,
    private readonly emit: (event: ServeEvent) => void,
    private readonly pollMs = DEFAULT_POLL_MS,
  ) {}

  /** Seed current state without replaying it as new SSE traffic, then poll. */
  async start(): Promise<void> {
    this.stopped = false
    await this.pollOnce(false)
    if (this.pollMs <= 0) return
    this.timer = setInterval(() => void this.pollOnce().catch(() => {}), this.pollMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.pending
  }

  /** Record and broadcast an in-process mutation without waiting for the poll. */
  observe(rec: SuggestionRecord): void {
    this.observedGeneration++
    this.seen.set(rec.id, versionOf(rec))
    this.emit({ type: 'suggestion-updated', id: rec.id, status: rec.status })
  }

  /** Public seam for deterministic unit/E2E tests and an optional explicit refresh. */
  async pollOnce(emitChanges = true): Promise<void> {
    if (this.pending) return this.pending
    const run = async () => {
      const generation = this.observedGeneration
      const records = await this.store.all()
      // An in-process notification won a race with this read. Discard the stale
      // snapshot; the next poll will reconcile any unrelated external change.
      if (generation !== this.observedGeneration) return
      const next = new Map<string, string>()
      for (const rec of records) {
        const version = versionOf(rec)
        next.set(rec.id, version)
        if (emitChanges && this.seen.get(rec.id) !== version && !this.stopped) {
          this.emit({ type: 'suggestion-updated', id: rec.id, status: rec.status })
        }
      }
      // Suggestions are append-only, but replacing the snapshot also behaves
      // correctly for injected test stores that remove a record.
      this.seen.clear()
      for (const [id, version] of next) this.seen.set(id, version)
    }
    this.pending = run().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
}
