import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { SseHub } from './sse.js'
import type { ServeEvent } from './types.js'

/** minimal ServerResponse stand-in: captures writes, emits 'close' */
function fakeRes(): { res: ServerResponse; out: () => string; close: () => void } {
  const em = new EventEmitter() as EventEmitter & { chunks: string[]; headers: Record<string, unknown>; writeHead: unknown; write: unknown; end: unknown }
  em.chunks = []
  em.headers = {}
  em.writeHead = (_st: number, h: Record<string, unknown>) => {
    em.headers = h
    return em
  }
  em.write = (c: string) => {
    em.chunks.push(c)
    return true
  }
  em.end = () => {}
  return { res: em as unknown as ServerResponse, out: () => em.chunks.join(''), close: () => em.emit('close') }
}

const ev = (id: string): ServeEvent => ({ type: 'session-live', id, badge: 'live', ageMs: 0 })

describe('SseHub', () => {
  it('frames events as id/event/data and counts clients', () => {
    const hub = new SseHub({ pingMs: 0 })
    const a = fakeRes()
    hub.add(a.res)
    expect(hub.size()).toBe(1)
    hub.emit(ev('s1'))
    expect(a.out()).toMatch(/id: 1\nevent: session-live\ndata: \{.*"s1".*\}\n\n/)
    a.close()
    expect(hub.size()).toBe(0)
    hub.stop()
  })

  it('replays the ring from Last-Event-ID on reconnect', () => {
    const hub = new SseHub({ pingMs: 0 })
    const a = fakeRes()
    hub.add(a.res)
    hub.emit(ev('s1'))
    hub.emit(ev('s2'))
    hub.emit(ev('s3'))
    a.close()
    const b = fakeRes()
    hub.add(b.res, '1')
    // events 2 and 3 replayed, not 1
    expect(b.out()).not.toContain('"s1"')
    expect(b.out()).toContain('"s2"')
    expect(b.out()).toContain('"s3"')
    hub.stop()
  })

  it('the ring is bounded at 200 events', () => {
    const hub = new SseHub({ pingMs: 0 })
    for (let i = 0; i < 250; i++) hub.emit(ev('s' + i))
    const a = fakeRes()
    hub.add(a.res, '0') // asks for everything
    expect(a.out()).not.toContain('"s49"') // 250 emitted, first 50 dropped
    expect(a.out()).toContain('"s50"')
    expect(a.out()).toContain('"s249"')
    hub.stop()
  })
})
