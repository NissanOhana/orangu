/**
 * SSE hub: one shared event stream for every connected page.
 * Frames: `id: <seq>\nevent: <type>\ndata: <json>\n\n` · comment ping every 15 s keeps proxies open ·
 * a 200-event ring lets a browser reconnect with Last-Event-ID (the browser sends it automatically)
 * and miss nothing across a short gap.
 */
import type { ServerResponse } from 'node:http'
import type { ServeEvent } from './types.js'

const RING_SIZE = 200

export class SseHub {
  private clients = new Set<ServerResponse>()
  private ring: Array<{ seq: number; frame: string }> = []
  private seq = 0
  private ping: ReturnType<typeof setInterval> | undefined

  constructor(o: { pingMs?: number } = {}) {
    const pingMs = o.pingMs ?? 15_000
    if (pingMs > 0) {
      this.ping = setInterval(() => {
        for (const res of this.clients) this.write(res, ': ping\n\n')
      }, pingMs)
      this.ping.unref?.()
    }
  }

  private write(res: ServerResponse, chunk: string): void {
    try {
      res.write(chunk)
    } catch {
      this.clients.delete(res)
    }
  }

  private frame(seq: number, ev: ServeEvent): string {
    return `id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
  }

  /** Attach a response; replays ring events with seq > lastEventId. `hello` (id-less) greets this client only. */
  add(res: ServerResponse, lastEventId?: string, hello?: ServeEvent): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    this.write(res, ': connected\n\n')
    if (hello) this.write(res, `event: ${hello.type}\ndata: ${JSON.stringify(hello)}\n\n`)
    const after = lastEventId !== undefined && /^\d+$/.test(lastEventId) ? Number(lastEventId) : undefined
    if (after !== undefined) for (const e of this.ring) if (e.seq > after) this.write(res, e.frame)
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  /** Broadcast one event to every client and remember it in the ring. */
  emit(ev: ServeEvent): void {
    const seq = ++this.seq
    const frame = this.frame(seq, ev)
    this.ring.push({ seq, frame })
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    for (const res of this.clients) this.write(res, frame)
  }

  size(): number {
    return this.clients.size
  }

  /** Close every stream and stop the ping timer (server shutdown). */
  stop(): void {
    if (this.ping) clearInterval(this.ping)
    for (const res of this.clients) {
      try {
        res.end()
      } catch {
        /* already gone */
      }
    }
    this.clients.clear()
  }
}
