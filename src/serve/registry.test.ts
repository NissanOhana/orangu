import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, appendFile, utimes, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from './registry.js'
import type { ServeEvent, ServeOptions } from './types.js'
import { readJsonlFile } from '../adapters/claude-code/jsonl.js'
import { analyzeSession } from '../analyze/analyze.js'
import { makeFixtureHome, appendTurn } from '../../test/fixtures/home.js'
import { SessionBuilder, resetIds } from '../../test/fixtures/session-builder.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function opts(configDir: string): ServeOptions {
  return { open: false, includeText: false, configDir, noCache: true, version: 'test' }
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orangu-reg-'))
}

describe('Registry', () => {
  it('discovers the fixture sessions with badges live/idle/ended and tails only the non-ended', async () => {
    const home = await makeFixtureHome(await tmp())
    const events: ServeEvent[] = []
    const reg = new Registry({ opts: opts(home.configDir), cache: null, concurrency: 1, minTickMs: 10 }, (ev) => events.push(ev))
    await reg.rescanOnce()
    await reg.settle()
    const rows = reg.list()
    expect(rows.length).toBe(3)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(home.liveId)?.badge).toBe('live')
    expect(byId.get(home.idleId)?.badge).toBe('idle')
    expect(byId.get(home.endedId)?.badge).toBe('ended')
    expect(reg.tailedIds().sort()).toEqual([home.liveId, home.idleId].sort())
    // live session's trailing partial is honest copy material
    expect(byId.get(home.liveId)?.possiblyLive).toBe(true)
    // ticks produced analyses → numeric fields exist on tailed rows
    expect(byId.get(home.liveId)?.turns).toBeGreaterThan(0)
    await reg.stop()
  })

  it('coalesces a burst of 50 dirty events into at most 2 analyses', async () => {
    const home = await makeFixtureHome(await tmp())
    const analyze = vi.fn(analyzeSession)
    const reg = new Registry(
      { opts: opts(home.configDir), cache: null, concurrency: 1, minTickMs: 150, analyze },
      () => {},
    )
    await reg.rescanOnce()
    await reg.settle()
    analyze.mockClear()
    const livePath = home.sessions[0]!.path
    // Grow the file once, then deliver the event burst synchronously. Testing the
    // scheduler against wall-clock sleeps made this assertion depend on host load.
    await appendFile(livePath, Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'progress', i })).join('\n') + '\n')
    for (let i = 0; i < 50; i++) reg.markDirty(home.liveId)
    await sleep(400)
    await reg.settle()
    expect(analyze.mock.calls.length).toBeLessThanOrEqual(2)
    expect(analyze.mock.calls.length).toBeGreaterThan(0)
    await reg.stop()
  })

  it('two dirty sessions with concurrency 1 tick sequentially (never overlapping)', async () => {
    const home = await makeFixtureHome(await tmp())
    let depth = 0
    let maxDepth = 0
    const read: typeof readJsonlFile = async (p, o) => {
      depth++
      maxDepth = Math.max(maxDepth, depth)
      await sleep(15)
      const r = await readJsonlFile(p, o)
      depth--
      return r
    }
    const reg = new Registry({ opts: opts(home.configDir), cache: null, concurrency: 1, minTickMs: 10, read }, () => {})
    await reg.rescanOnce()
    reg.markDirty(home.liveId)
    reg.markDirty(home.idleId)
    await reg.settle()
    expect(maxDepth).toBe(1)
    await reg.stop()
  })

  it('a session crossing into ended gets exactly one final tick, then is untailed', async () => {
    const home = await makeFixtureHome(await tmp())
    let fakeNow = Date.now()
    const analyze = vi.fn(analyzeSession)
    const reg = new Registry(
      { opts: opts(home.configDir), cache: null, concurrency: 1, minTickMs: 10, now: () => fakeNow, analyze },
      () => {},
    )
    await reg.rescanOnce()
    await reg.settle()
    expect(reg.tailedIds()).toContain(home.liveId)
    analyze.mockClear()
    fakeNow += 31 * 60_000 // everything is now > 30 min old
    await reg.pollOnce()
    await reg.settle()
    // one final tick per formerly-tailed session, then untailed
    expect(analyze.mock.calls.length).toBe(2) // live + idle each got their final tick
    expect(reg.tailedIds()).toEqual([])
    analyze.mockClear()
    reg.markDirty(home.liveId) // no longer tailed → no tick
    await reg.settle()
    expect(analyze.mock.calls.length).toBe(0)
    await reg.stop()
  })

  it('caps tailed sessions at maxLive by most-recent mtime', async () => {
    const dir = await tmp()
    const now = Date.now()
    const proj = join(dir, 'projects', '-Users-test-Code-many')
    await mkdir(proj, { recursive: true })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      resetIds()
      const id = `${(i + 1).toString().repeat(8)}-0000-4000-8000-00000000cccc`
      const b = new SessionBuilder({ sessionId: id })
      b.userPrompt('hello ' + i)
      b.assistant([{ type: 'text', text: 'hi' }], { usage: { input_tokens: 2, output_tokens: 2 } })
      const p = join(proj, `${id}.jsonl`)
      await writeFile(p, b.toJsonl())
      const mtime = now - i * 10_000 // i=0 newest
      await utimes(p, new Date(mtime), new Date(mtime))
      ids.push(id)
    }
    const reg = new Registry({ opts: { ...opts(dir), maxLive: 3 }, cache: null, concurrency: 1, minTickMs: 10 }, () => {})
    await reg.rescanOnce()
    expect(reg.tailedIds().sort()).toEqual(ids.slice(0, 3).sort())
    await reg.stop()
  })

  it('rows carry a lastEvents ring (≤ 5, additive, redacted): the planted secret never appears', async () => {
    const home = await makeFixtureHome(await tmp())
    const SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKE'
    const MARKER = 'private-registry-marker-9073'
    // grow the live session with 6 tool calls; one smuggles the secret into its Bash command
    resetIds()
    const b = new SessionBuilder({ sessionId: home.liveId, startAt: new Date().toISOString() })
    b.userPrompt('more work')
    for (let i = 0; i < 6; i++)
      b.toolCall('Bash', { command: i === 4 ? `${MARKER} export KEY=${SECRET} && npm run x` : `echo step ${i}` }, 'ok', {
        durationMs: 5,
        usage: { input_tokens: 2, output_tokens: 2 },
      })
    await appendFile(home.sessions[0]!.path, '\n' + b.toJsonl())

    type RingRow = { lastEvents?: Array<{ ts?: number; name: string; category: string; summary: string }> }
    const reg = new Registry({ opts: opts(home.configDir), cache: null, concurrency: 1, minTickMs: 10 }, () => {})
    await reg.rescanOnce()
    await reg.settle()
    const row = reg.list().find((r) => r.id === home.liveId) as (typeof reg.list extends () => Array<infer R> ? R : never) & RingRow
    expect(row.lastEvents).toBeDefined()
    expect(row.lastEvents!.length).toBeGreaterThan(0)
    expect(row.lastEvents!.length).toBeLessThanOrEqual(5)
    // default serve (includeText false): summaries stripped like every other preview/feed body
    for (const e of row.lastEvents!) {
      expect(e.summary).toBe('')
      expect(e.name).toBeTruthy()
    }
    expect(JSON.stringify(row.lastEvents)).not.toContain(SECRET)
    expect(JSON.stringify(row.lastEvents)).not.toContain(MARKER)
    await reg.stop()

    // --include-text keeps the (scrubbed) summaries — the secret is still masked
    const reg2 = new Registry({ opts: { ...opts(home.configDir), includeText: true }, cache: null, concurrency: 1, minTickMs: 10 }, () => {})
    await reg2.rescanOnce()
    await reg2.settle()
    const row2 = reg2.list().find((r) => r.id === home.liveId) as typeof row
    const json2 = JSON.stringify(row2.lastEvents)
    expect(json2).toContain('npm run x') // non-secret text survives
    expect(json2).toContain(MARKER) // arbitrary text is retained only by explicit opt-in
    expect(json2).not.toContain(SECRET) // the key itself never leaves the process
    await reg2.stop()
  })

  it('rescan finds a newcomer and emits session-added; growth emits session-updated', async () => {
    const home = await makeFixtureHome(await tmp())
    const events: ServeEvent[] = []
    const reg = new Registry({ opts: opts(home.configDir), cache: null, concurrency: 1, minTickMs: 10 }, (ev) => events.push(ev))
    await reg.rescanOnce()
    await reg.settle()
    events.length = 0
    await appendTurn(home.sessions[0]!.path, home.liveId)
    await reg.pollOnce()
    await reg.settle()
    expect(events.some((e) => e.type === 'session-updated' && e.id === home.liveId)).toBe(true)
    const upd = events.find((e) => e.type === 'session-updated' && e.id === home.liveId)
    expect(upd && upd.type === 'session-updated' ? upd.row.turns : 0).toBeGreaterThan(1)
    // a brand-new session file appears → the rescan emits session-added
    resetIds()
    const newId = '33333333-0000-4000-8000-00000000dddd'
    const nb = new SessionBuilder({ sessionId: newId })
    nb.userPrompt('new session')
    nb.assistant([{ type: 'text', text: 'hello' }], { usage: { input_tokens: 2, output_tokens: 2 } })
    await writeFile(join(home.configDir, 'projects', '-Users-test-Code-demo', `${newId}.jsonl`), nb.toJsonl())
    await reg.rescanOnce()
    expect(events.some((e) => e.type === 'session-added' && e.row.id === newId)).toBe(true)
    await reg.stop()
  })
})
