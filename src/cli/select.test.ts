import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { select, windowFor, type InputLike, type OutputLike, type SelectView } from './select.js'
import { CURSOR, type Caps, type ExitHookProcess } from './tty.js'

const caps: Caps = { tty: true, color: 0, animate: true, hyperlinks: false, columns: 80, unicode: true }

class FakeInput extends EventEmitter implements InputLike {
  isTTY = true
  setRawMode = vi.fn()
  setEncoding = vi.fn()
  resume = vi.fn()
  pause = vi.fn()
  press(chunk: string | Buffer): void {
    this.emit('data', chunk)
  }
}

class FakeOutput extends EventEmitter implements OutputLike {
  columns = 80
  rows = 24
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  get text(): string {
    return this.chunks.join('')
  }
}

function fakeProc(): ExitHookProcess & { handlers: Map<string, (...a: unknown[]) => void>; kill: ReturnType<typeof vi.fn<(pid: number, signal: NodeJS.Signals) => unknown>> } {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    pid: 1,
    handlers,
    once: (ev, fn) => handlers.set(ev, fn as (...a: unknown[]) => void),
    on: (ev, fn) => handlers.set(ev, fn as (...a: unknown[]) => void),
    removeListener: (ev) => handlers.delete(ev),
    kill: vi.fn<(pid: number, signal: NodeJS.Signals) => unknown>(),
  }
}

const render = (view: SelectView): string[] => {
  const lines = ['header']
  for (let i = view.start; i < Math.min(view.start + view.size, 5); i++) lines.push(`${i === view.cursor ? '>' : ' '} row ${i} w${view.columns}`)
  lines.push('hint')
  return lines
}

function start(input = new FakeInput(), output = new FakeOutput(), proc = fakeProc()) {
  const promise = select({ count: 5, render, input, output, caps, proc })
  return { promise, input, output, proc }
}

describe('windowFor', () => {
  it('keeps the cursor inside the window and the window inside the list', () => {
    expect(windowFor(0, 0, 3, 2)).toBe(0)
    expect(windowFor(3, 0, 3, 5)).toBe(1)
    expect(windowFor(0, 2, 3, 5)).toBe(0)
    expect(windowFor(4, 0, 3, 5)).toBe(2)
    expect(windowFor(1, 1, 3, 5)).toBe(1)
  })
})

describe('select', () => {
  it('turns raw mode on, hides the cursor, draws the frame, and resolves the row under the cursor on Enter', async () => {
    const { promise, input, output } = start()
    expect(input.setRawMode).toHaveBeenCalledWith(true)
    expect(input.resume).toHaveBeenCalled()
    expect(output.text.startsWith(CURSOR.hide + 'header\n> row 0')).toBe(true)
    input.press('\x1b[B')
    input.press('j')
    input.press('k')
    input.press('\r')
    await expect(promise).resolves.toEqual({ kind: 'pick', index: 1 })
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(input.pause).toHaveBeenCalled()
    expect(input.listenerCount('data')).toBe(0)
    expect(output.chunks[output.chunks.length - 1]).toBe(CURSOR.show)
    // each redraw moves up over the previous frame (7 lines) and erases down before reprinting
    expect(output.chunks[1]!.startsWith(CURSOR.up(7) + CURSOR.home + CURSOR.eraseDown + 'header\n  row 0 w80\n> row 1 w80')).toBe(true)
  })
  it('q and Escape cancel with code 0; Ctrl-C (0x03 in raw mode) cancels with 130; nothing exits the process', async () => {
    for (const [key, code] of [
      ['q', 0],
      ['\x1b', 0],
      ['\x04', 0],
      ['\x03', 130],
    ] as const) {
      const { promise, input, output } = start()
      input.press(Buffer.from(key))
      await expect(promise).resolves.toEqual({ kind: 'cancel', code })
      expect(input.setRawMode).toHaveBeenLastCalledWith(false)
      expect(output.text.endsWith(CURSOR.show)).toBe(true)
    }
  })
  it('home, end, page keys and digits move; digits never select on their own', async () => {
    const { promise, input } = start()
    input.press('G')
    input.press('g')
    input.press('3')
    input.press('9')
    input.press('\x1b[5~')
    input.press('\x1b[6~')
    input.press('x')
    input.press('\n')
    await expect(promise).resolves.toEqual({ kind: 'pick', index: 4 })
  })
  it('windows a long list to the terminal height and scrolls with the cursor', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    output.rows = 8 // 8 - 5 chrome = 3 visible rows
    const views: SelectView[] = []
    const promise = select({
      count: 5,
      render: (v) => {
        views.push({ ...v })
        return render(v)
      },
      input,
      output,
      caps,
      proc: fakeProc(),
    })
    expect(views[0]).toMatchObject({ cursor: 0, start: 0, size: 3 })
    input.press('j')
    input.press('j')
    input.press('j')
    expect(views[views.length - 1]).toMatchObject({ cursor: 3, start: 1, size: 3 })
    input.press('G')
    expect(views[views.length - 1]).toMatchObject({ cursor: 4, start: 2 })
    input.press('g')
    expect(views[views.length - 1]).toMatchObject({ cursor: 0, start: 0 })
    input.press('\r')
    await promise
  })
  it('redraws with the new width on resize and drops the listener afterwards', async () => {
    const { promise, input, output } = start()
    output.columns = 100
    output.emit('resize')
    expect(output.chunks[output.chunks.length - 1]).toContain('w100')
    input.press('\r')
    await promise
    expect(output.listenerCount('resize')).toBe(0)
  })
  it('a signal from outside restores the terminal, then re-raises through the exit hook', async () => {
    const { input, output, proc } = start()
    const onSigint = proc.handlers.get('SIGINT')!
    onSigint('SIGINT')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(output.text.endsWith(CURSOR.show)).toBe(true)
    expect(proc.kill).toHaveBeenCalledWith(1, 'SIGINT')
    // a late keystroke after the restore is ignored, and the restore ran exactly once
    input.press('\r')
    expect(input.setRawMode.mock.calls.filter((c) => c[0] === false)).toHaveLength(1)
  })
  it('works without setRawMode / setEncoding / resize support on the streams', async () => {
    const input = new EventEmitter() as EventEmitter & InputLike
    input.resume = vi.fn()
    input.pause = vi.fn()
    const output = { write: vi.fn() }
    const promise = select({ count: 2, render, input, output, caps, proc: fakeProc() })
    input.emit('data', '\r')
    await expect(promise).resolves.toEqual({ kind: 'pick', index: 0 })
  })
})
