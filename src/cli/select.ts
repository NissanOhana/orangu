/**
 * An inline single-choice prompt over injected streams: raw-mode keys in, a redrawn frame out.
 * Kept out of tty.ts so tty.ts has no interactivity and no process-global state; the escape
 * sequences it needs come from there (CURSOR, decodeKey).
 *
 * Contract:
 * - never the alternate screen: the frame is drawn in place, redrawn with cursor-up + erase-down,
 *   and left on screen when the prompt ends so the user still sees what they chose
 * - raw mode on for the prompt only; restore (raw mode off, input paused, cursor shown) runs
 *   exactly once: on resolve, on Ctrl-C (0x03, which raw mode delivers as data), and on
 *   SIGINT/SIGTERM/SIGHUP from outside through the shared onceOnExit hook (which re-raises)
 * - never calls process.exit(); Ctrl-C resolves { kind: 'cancel', code: 130 } and the caller sets
 *   process.exitCode
 * - the caller decides whether a prompt is possible at all (TTY, raw mode, CI, --json, --plain)
 */
import { CURSOR, decodeKey, onceOnExit, type Caps, type ExitHookProcess, type WritableLike } from './tty.js'

export interface InputLike {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
  setEncoding?: (encoding: BufferEncoding) => unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', fn: (chunk: string | Buffer) => void): unknown
  removeListener(event: 'data', fn: (chunk: string | Buffer) => void): unknown
}

export interface OutputLike extends WritableLike {
  columns?: number
  rows?: number
  on?(event: 'resize', fn: () => void): unknown
  removeListener?(event: 'resize', fn: () => void): unknown
}

/** What the renderer sees: the cursor, the visible window, and the current width. */
export interface SelectView {
  cursor: number
  /** first visible row */
  start: number
  /** visible row count */
  size: number
  columns: number
}

export type SelectResult = { kind: 'pick'; index: number } | { kind: 'cancel'; code: 0 | 130 }

export interface SelectOptions {
  /** number of choices (>= 1) */
  count: number
  /** the whole frame for a view, as lines without trailing newlines */
  render: (view: SelectView) => string[]
  input: InputLike
  output: OutputLike
  caps: Caps
  /** rows the frame may use for choices; default from output.rows */
  viewRows?: number
  initial?: number
  proc?: ExitHookProcess
}

/** Lines the frame spends outside the choice rows (header, blanks, hint); the window fills the rest. */
export const FRAME_CHROME_LINES = 5

/** Keep the cursor inside a window of `size` rows starting at `start`; page moves keep it aligned. */
export function windowFor(cursor: number, start: number, size: number, count: number): number {
  if (count <= size) return 0
  let s = start
  if (cursor < s) s = cursor
  if (cursor >= s + size) s = cursor - size + 1
  return Math.max(0, Math.min(s, count - size))
}

export function select(o: SelectOptions): Promise<SelectResult> {
  const count = Math.max(1, o.count)
  const columns = (): number => Math.max(40, o.output.columns ?? o.caps.columns)
  const size = Math.max(1, Math.min(count, o.viewRows ?? Math.max(3, (o.output.rows ?? 24) - FRAME_CHROME_LINES)))
  let cursor = Math.max(0, Math.min(o.initial ?? 0, count - 1))
  let start = windowFor(cursor, 0, size, count)
  let drawn = 0

  const frame = (): string => {
    const lines = o.render({ cursor, start, size, columns: columns() })
    drawn = lines.length
    return lines.join('\n') + '\n'
  }
  const draw = (): void => {
    o.output.write(CURSOR.up(drawn) + CURSOR.home + CURSOR.eraseDown + frame())
  }

  return new Promise<SelectResult>((resolve) => {
    let done = false
    const restore = (): void => {
      if (done) return
      done = true
      o.input.removeListener('data', onData)
      if (o.output.removeListener) o.output.removeListener('resize', onResize)
      try {
        o.input.setRawMode?.(false)
      } catch {
        /* the stream may already be gone */
      }
      o.input.pause()
      o.output.write(CURSOR.show)
    }
    const hook = onceOnExit(restore, o.proc)
    const finish = (r: SelectResult): void => {
      restore()
      hook.dispose()
      resolve(r)
    }
    const move = (to: number): void => {
      cursor = Math.max(0, Math.min(to, count - 1))
      start = windowFor(cursor, start, size, count)
      draw()
    }
    const onResize = (): void => draw()
    const onData = (chunk: string | Buffer): void => {
      const { key, digit } = decodeKey(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      switch (key) {
        case 'cancel':
          return finish({ kind: 'cancel', code: 130 })
        case 'quit':
        case 'escape':
          return finish({ kind: 'cancel', code: 0 })
        case 'enter':
          return finish({ kind: 'pick', index: cursor })
        case 'up':
          return move(cursor - 1)
        case 'down':
          return move(cursor + 1)
        case 'home':
          return move(0)
        case 'end':
          return move(count - 1)
        case 'pageup':
          return move(cursor - size)
        case 'pagedown':
          return move(cursor + size)
        case 'digit':
          return move((digit ?? 1) - 1)
        default:
          return
      }
    }
    o.input.setEncoding?.('utf8')
    o.input.setRawMode?.(true)
    o.input.resume()
    o.input.on('data', onData)
    if (o.output.on) o.output.on('resize', onResize)
    o.output.write(CURSOR.hide + frame())
  })
}
