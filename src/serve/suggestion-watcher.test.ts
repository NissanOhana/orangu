import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SuggestionStore } from '../suggest/store.js'
import type { Finding } from '../suggest/types.js'
import type { ServeEvent } from './types.js'
import { SuggestionWatcher } from './suggestion-watcher.js'

const finding: Finding = {
  ruleId: 'reread-files',
  title: 'Repeated reads',
  scope: 'session',
  sessionIds: ['session-a'],
  evidence: { estimated: true },
}

describe('SuggestionWatcher', () => {
  it('observes a proposal written through a separate store process exactly once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-suggestion-watch-'))
    const serverStore = new SuggestionStore({ home, now: () => 10 })
    const cliStore = new SuggestionStore({ home, now: () => 20 })
    const { record } = await serverStore.upsertNew(finding, 'report')
    await serverStore.transition(record.id, 'kicked-off')
    const events: ServeEvent[] = []
    const watcher = new SuggestionWatcher(serverStore, (event) => events.push(event), 0)
    await watcher.start()

    await cliStore.transition(record.id, 'proposed', {
      proposal: { title: 'Proposal', change: 'Change', effort: 'S', proposalPath: join(home, 'proposals', `${record.id}.md`) },
    })
    await watcher.pollOnce()
    expect(events).toEqual([{ type: 'suggestion-updated', id: record.id, status: 'proposed' }])
    await watcher.pollOnce()
    expect(events).toHaveLength(1)
    await watcher.stop()
  })

  it('records an in-process notification before polling so it is not duplicated', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-suggestion-watch-'))
    const store = new SuggestionStore({ home, now: () => 10 })
    const { record } = await store.upsertNew(finding, 'report')
    const events: ServeEvent[] = []
    const watcher = new SuggestionWatcher(store, (event) => events.push(event), 0)
    await watcher.start()
    const kicked = await store.transition(record.id, 'kicked-off')
    watcher.observe(kicked)
    await watcher.pollOnce()
    expect(events).toEqual([{ type: 'suggestion-updated', id: record.id, status: 'kicked-off' }])
    await watcher.stop()
  })

  it('does not let a stale in-flight poll overwrite a newer in-process observation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-suggestion-watch-'))
    const store = new SuggestionStore({ home, now: () => 10 })
    const { record } = await store.upsertNew(finding, 'report')
    const events: ServeEvent[] = []
    let release!: () => void
    let entered!: () => void
    const pollEntered = new Promise<void>((resolve) => (entered = resolve))
    let block = false
    const delayedStore = {
      ...store,
      all: async () => {
        const snapshot = await store.all()
        if (block) {
          entered()
          await new Promise<void>((resolve) => (release = resolve))
        }
        return snapshot
      },
    } as unknown as SuggestionStore
    const watcher = new SuggestionWatcher(delayedStore, (event) => events.push(event), 0)
    await watcher.start()
    block = true
    const stalePoll = watcher.pollOnce()
    await pollEntered
    const kicked = await store.transition(record.id, 'kicked-off')
    watcher.observe(kicked)
    release()
    await stalePoll
    block = false
    await watcher.pollOnce()
    expect(events).toEqual([{ type: 'suggestion-updated', id: record.id, status: 'kicked-off' }])
    await watcher.stop()
  })
})
