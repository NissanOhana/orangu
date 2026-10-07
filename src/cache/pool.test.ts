import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cpus } from 'node:os'
import type { SessionRef } from '../discover/discover.js'

// A fake Worker that counts each start and answers each job at once, so the test counts the threads that the pool
// starts without starting one. The factory runs before the imports above, so it loads EventEmitter itself.
const started = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWorker extends EventEmitter {
    constructor() {
      super()
      started.count++
    }
    postMessage(job: { idx: number }): void {
      setImmediate(() => this.emit('message', { idx: job.idx, ok: false, error: 'fake worker' }))
    }
    terminate(): Promise<number> {
      return Promise.resolve(0)
    }
  }
  return { Worker: FakeWorker, isMainThread: true, parentPort: null, workerData: null }
})

const { analyzeAllPooled } = await import('./pool.js')

const refs = (n: number): SessionRef[] => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}` }) as unknown as SessionRef)
const run = (n: number, jobs: number) => analyzeAllPooled(refs(n), { entry: 'fake-entry.js', jobs, version: 'test', now: 0, cacheEnabled: false })

describe('analyzeAllPooled', () => {
  beforeEach(() => {
    started.count = 0
  })

  // A steered model can run a pre-approved `orangu global --jobs 5000`. A larger --jobs value than the machine has
  // CPUs does no harm: the pool starts at most one worker for each CPU.
  it('a huge --jobs value starts at most one worker for each CPU', async () => {
    const limit = Math.max(1, cpus().length)
    const r = await run(limit * 3 + 2, 5000)
    expect(started.count).toBe(limit)
    expect(r.workers, 'the result names the count that the pool used').toBe(limit)
    expect(r.failed, 'each session still runs once').toBe(limit * 3 + 2)
  })

  it('a smaller --jobs value, or a smaller scan, still sets the count', async () => {
    await run(10, 2)
    expect(started.count).toBe(2)
    started.count = 0
    await run(1, 5000)
    expect(started.count).toBe(1)
  })
})
