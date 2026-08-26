/**
 * Worker pool for aggregate scans (repo/global): one Worker per CPU (minus one), each
 * parsing + analyzing sessions through the same AnalysisCache code path as the
 * sequential loop. The single-file CLI bundle is its own worker entry: main.ts checks
 * isPoolWorker() at startup and turns into a worker instead of running the CLI.
 *
 * Large scans are adapter-bound because transcripts and sidecars must all be parsed. Parallelism
 * bounds that latency while results remain in reference order, so pooled output is byte-identical
 * to the sequential path.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { cpus } from 'node:os'
import type { SessionRef } from '../discover/discover.js'
import type { Analysis } from '../model/analysis.js'
import { AnalysisCache, analyzeRefCached } from './index.js'

const POOL_FLAG = '__oranguPoolWorker'

interface WorkerInit {
  [POOL_FLAG]: true
  version: string
  cacheEnabled: boolean
}
interface JobMsg {
  idx: number
  ref: SessionRef
  now: number
}
type ResultMsg = { idx: number; ok: true; analysis: Analysis; cacheHit: boolean } | { idx: number; ok: false; error: string }

/** true when this process is a pool worker thread (checked at CLI startup) */
export function isPoolWorker(): boolean {
  if (isMainThread) return false
  const wd = workerData as Record<string, unknown> | null
  return !!wd && wd[POOL_FLAG] === true
}

/** worker side: analyze jobs forever until the parent terminates us */
export function runPoolWorker(): void {
  const init = workerData as WorkerInit
  const cache = init.cacheEnabled ? new AnalysisCache({ version: init.version }) : null
  parentPort!.on('message', (job: JobMsg) => {
    void (async () => {
      const hitsBefore = cache?.stats().hits ?? 0
      try {
        const analysis = await analyzeRefCached(job.ref, { cache, version: init.version, now: job.now })
        const msg: ResultMsg = { idx: job.idx, ok: true, analysis, cacheHit: (cache?.stats().hits ?? 0) > hitsBefore }
        parentPort!.postMessage(msg)
      } catch (e) {
        const msg: ResultMsg = { idx: job.idx, ok: false, error: String(e instanceof Error ? e.message : e) }
        parentPort!.postMessage(msg)
      }
    })()
  })
}

export function defaultJobs(): number {
  return Math.max(1, cpus().length - 1)
}

export interface PoolRunResult {
  analyses: Analysis[]
  failed: number
  hits: number
  misses: number
}

/**
 * Analyze `refs` across `jobs` workers. `entry` is the worker script (the CLI bundle's own
 * import.meta.url). Analyses come back in ref order; a session that fails to analyze is
 * counted, never fatal, exactly like the sequential loop.
 */
export async function analyzeAllPooled(
  refs: SessionRef[],
  o: { entry: string | URL; jobs: number; version: string; now: number; cacheEnabled: boolean },
): Promise<PoolRunResult> {
  const results: Array<Analysis | undefined> = new Array(refs.length)
  let failed = 0
  let hits = 0
  let next = 0
  let done = 0
  const n = Math.max(1, Math.min(o.jobs, refs.length))
  await new Promise<void>((resolveAll, rejectAll) => {
    let alive = 0
    const finishIfDone = (): boolean => {
      if (done >= refs.length) {
        resolveAll()
        return true
      }
      return false
    }
    for (let i = 0; i < n; i++) {
      const w = new Worker(o.entry, { workerData: { [POOL_FLAG]: true, version: o.version, cacheEnabled: o.cacheEnabled } satisfies WorkerInit })
      alive++
      let currentIdx = -1
      const assign = (): void => {
        if (next >= refs.length) {
          currentIdx = -1
          void w.terminate()
          return
        }
        currentIdx = next++
        w.postMessage({ idx: currentIdx, ref: refs[currentIdx] as SessionRef, now: o.now } satisfies JobMsg)
      }
      w.on('message', (msg: ResultMsg) => {
        if (msg.ok) {
          results[msg.idx] = msg.analysis
          if (msg.cacheHit) hits++
        } else failed++
        done++
        if (finishIfDone()) {
          void w.terminate()
          return
        }
        assign()
      })
      w.on('error', (err) => {
        // the worker died mid-job: count that job failed, stop this worker
        if (currentIdx >= 0 && results[currentIdx] === undefined) {
          failed++
          done++
        }
        alive--
        void w.terminate()
        if (finishIfDone()) return
        if (alive === 0) rejectAll(err instanceof Error ? err : new Error(String(err)))
      })
      assign()
    }
    finishIfDone()
  })
  const analyses = results.filter((a): a is Analysis => a !== undefined)
  return { analyses, failed, hits, misses: refs.length - failed - hits }
}
