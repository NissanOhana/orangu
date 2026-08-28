import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../../../test/fixtures/home.js'
import { MACHINE_CAPS, stripAnsi, type Caps, type ExitHookProcess } from '../tty.js'
import { cmdPick, gatherPickRows, interactivePrecondition, type PickDeps } from './pick.js'

const tty: Caps = { tty: true, color: 1, animate: true, hyperlinks: false, columns: 80, unicode: true }

class FakeInput extends EventEmitter {
  isTTY = true
  setRawMode = vi.fn()
  setEncoding = vi.fn()
  resume = vi.fn()
  pause = vi.fn()
}
class FakeOutput extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  write(c: string): boolean {
    this.chunks.push(c)
    return true
  }
  get text(): string {
    return this.chunks.join('')
  }
}
const noopProc: ExitHookProcess = { pid: 1, once: () => undefined, on: () => undefined, removeListener: () => undefined, kill: () => undefined }

async function home() {
  return makeFixtureHome(await mkdtemp(join(tmpdir(), 'orangu-pick-')))
}

function deps(over: Partial<PickDeps> = {}): PickDeps & { stdin: FakeInput; stdout: FakeOutput; stderr: FakeOutput; openReport: ReturnType<typeof vi.fn> } {
  const stdin = new FakeInput()
  const stdout = new FakeOutput()
  const stderr = new FakeOutput()
  const openReport = vi.fn(async () => undefined)
  return { openReport, stdin, stdout, stderr, env: {}, out: tty, err: tty, proc: noopProc, ...over } as PickDeps & { stdin: FakeInput; stdout: FakeOutput; stderr: FakeOutput; openReport: ReturnType<typeof vi.fn> }
}

describe('interactivePrecondition', () => {
  const rawTty = { isTTY: true, setRawMode: () => undefined }
  it('needs two TTYs with raw mode and no machine flag, CI, dumb terminal or animation opt-out', () => {
    expect(interactivePrecondition(rawTty, { isTTY: true }, {}, {})).toBe(true)
    expect(interactivePrecondition({ isTTY: false, setRawMode: () => undefined }, { isTTY: true }, {}, {})).toBe(false)
    expect(interactivePrecondition(rawTty, { isTTY: false }, {}, {})).toBe(false)
    expect(interactivePrecondition({ isTTY: true }, { isTTY: true }, {}, {})).toBe(false)
    expect(interactivePrecondition(rawTty, { isTTY: true }, { CI: '1' }, {})).toBe(false)
    expect(interactivePrecondition(rawTty, { isTTY: true }, { CI: 'false' }, {})).toBe(true)
    expect(interactivePrecondition(rawTty, { isTTY: true }, { TERM: 'dumb' }, {})).toBe(false)
    expect(interactivePrecondition(rawTty, { isTTY: true }, { ORANGU_NO_ANIMATION: '1' }, {})).toBe(false)
    for (const f of ['json', 'plain', 'quiet']) expect(interactivePrecondition(rawTty, { isTTY: true }, {}, { [f]: true }), f).toBe(false)
  })
})

describe('gatherPickRows', () => {
  it('orders running sessions first (pid record or fresh mtime), then by recency, and titles the rows shown', async () => {
    const h = await home()
    await mkdir(join(h.configDir, 'sessions'), { recursive: true })
    await writeFile(join(h.configDir, 'sessions', '77.json'), JSON.stringify({ pid: 77, sessionId: h.endedId }))
    const now = Date.now()
    const { rows, counts } = await gatherPickRows({ root: h.configDir }, { now, isAlive: (pid) => pid === 77 })
    // live (30 s) and idle (10 min) are running by mtime; ended (2 h) is running by its pid record
    expect(rows.map((r) => [r.sessionId.slice(0, 8), r.running])).toEqual([
      ['11111111', true],
      ['22222222', true],
      ['aaaaaaaa', true],
    ])
    expect(counts).toEqual({ total: 3, running: 3 })
    expect(rows[1]!.title).toBe('Refactor the config loader')
    const dead = await gatherPickRows({ root: h.configDir }, { now, isAlive: () => false })
    expect(dead.rows[2]).toMatchObject({ sessionId: h.endedId, running: false })
    expect(dead.counts.running).toBe(2)
  })
  it('scrubs a secret out of a title by default and keeps it with --no-redact', async () => {
    const h = await home()
    const scrubbed = await gatherPickRows({ root: h.configDir }, { now: Date.now(), isAlive: () => false })
    expect(scrubbed.rows[0]!.title).not.toContain('sk-ant-api03-FAKE')
    const raw = await gatherPickRows({ root: h.configDir, 'no-redact': true }, { now: Date.now(), isAlive: () => false })
    expect(raw.rows[0]!.title).toContain('sk-ant-api03-FAKE')
  })
  it('--limit cuts after ordering, so running rows are never dropped first', async () => {
    const h = await home()
    const { rows, counts } = await gatherPickRows({ root: h.configDir, limit: '1' }, { now: Date.now(), isAlive: () => false })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe(h.liveId)
    expect(counts.total).toBe(3)
  })
})

describe('cmdPick', () => {
  it('interactive: down + Enter opens the second row, raw mode toggled on then off, cursor restored', async () => {
    const h = await home()
    const d = deps()
    const done = cmdPick({ root: h.configDir }, { ...d, isAlive: () => false })
    await new Promise((r) => setTimeout(r, 50))
    expect(d.stdin.setRawMode).toHaveBeenCalledWith(true)
    d.stdin.emit('data', '\x1b[B')
    d.stdin.emit('data', '\r')
    await done
    expect(d.openReport).toHaveBeenCalledWith(h.idleId)
    expect(d.stdin.setRawMode).toHaveBeenLastCalledWith(false)
    expect(d.stdout.text).toContain('\x1b[?25h')
    const plain = stripAnsi(d.stdout.text)
    expect(plain).toContain('choose a session')
    expect(plain).toContain('3 sessions, 2 running')
    expect(plain).toContain('> ● 11111111')
    expect(plain).toContain('running')
    expect(d.stdin.listenerCount('data')).toBe(0)
  })
  it('interactive: q cancels with a dim note and exit 0; Ctrl-C sets exitCode 130 and says nothing', async () => {
    const h = await home()
    const d = deps()
    const q = cmdPick({ root: h.configDir }, { ...d, isAlive: () => false })
    await new Promise((r) => setTimeout(r, 50))
    d.stdin.emit('data', 'q')
    await q
    expect(d.openReport).not.toHaveBeenCalled()
    expect(stripAnsi(d.stderr.text)).toBe('  cancelled\n')
    expect(process.exitCode ?? 0).toBe(0)

    const d2 = deps()
    const c = cmdPick({ root: h.configDir }, { ...d2, isAlive: () => false })
    await new Promise((r) => setTimeout(r, 50))
    d2.stdin.emit('data', '\x03')
    await c
    expect(process.exitCode).toBe(130)
    process.exitCode = 0
    expect(d2.stderr.text).toBe('')
    expect(d2.stdin.setRawMode).toHaveBeenLastCalledWith(false)
  })
  it('not a TTY: prints the numbered list and the hint, attaches no data listener, never waits', async () => {
    const h = await home()
    const d = deps({ out: MACHINE_CAPS, err: MACHINE_CAPS })
    d.stdin.isTTY = false
    await cmdPick({ root: h.configDir }, { ...d, isAlive: () => false })
    expect(d.stdin.listenerCount('data')).toBe(0)
    expect(d.stdin.setRawMode).not.toHaveBeenCalled()
    const lines = d.stdout.text.split('\n')
    expect(lines.some((l) => l.startsWith('  [1] ● 11111111'))).toBe(true)
    expect(lines.some((l) => l.startsWith('  [3]   aaaaaaaa'))).toBe(true)
    expect(d.stdout.text).toContain('run: orangu report <id>')
    expect(d.stdout.text).not.toMatch(/[\x1b\r]/)
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80)
  })
  it('--plain on a TTY takes the list path; --json prints the array and nothing else', async () => {
    const h = await home()
    const plain = deps()
    await cmdPick({ root: h.configDir, plain: true }, { ...plain, isAlive: () => false })
    expect(plain.stdin.setRawMode).not.toHaveBeenCalled()
    expect(stripAnsi(plain.stdout.text)).toContain('[1]')

    const json = deps()
    await cmdPick({ root: h.configDir, json: true }, { ...json, isAlive: () => false })
    const rows = JSON.parse(json.stdout.text) as Array<{ sessionId: string; running: boolean; project: string; title?: string }>
    expect(rows.map((r) => r.sessionId)).toEqual([h.liveId, h.idleId, h.endedId])
    expect(rows[0]).toMatchObject({ running: true, project: 'demo' })
    expect(json.stderr.text).toBe('')
  })
  it('no sessions: throws the same message as the other verbs (exit 1 through main)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orangu-pick-empty-'))
    await expect(cmdPick({ root: empty }, deps())).rejects.toThrow(/No sessions found/)
  })
})
