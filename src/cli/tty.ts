/**
 * Terminal capabilities and the only raw ANSI in the CLI (test/lint.test.ts ratchets that).
 *
 * Every export is pure over its arguments: caps are detected per stream from `(stream, env)`,
 * never from process globals, so `orangu report 2>log` gets a clean log while the terminal gets
 * colour, and `--json` / `--quiet` set `machine: true` to beat every environment variable.
 *
 * Precedence (top wins): machine flag > NO_COLOR (non-empty) > FORCE_COLOR > isTTY + TERM=dumb >
 * stream.getColorDepth(env). Animation additionally needs !CI and ORANGU_NO_ANIMATION !== '1'.
 * NO_COLOR turns off dim/bold too (a documented, simpler contract than the letter of no-color.org).
 */
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'

export type ColorLevel = 0 | 1 | 2 | 3

export interface Caps {
  /** the stream is an interactive terminal */
  tty: boolean
  /** 0 none, 1 = 16 colours, 2 = 256, 3 = truecolor */
  color: ColorLevel
  /** spinner and cursor movement allowed */
  animate: boolean
  /** OSC 8 hyperlinks allowed */
  hyperlinks: boolean
  /** layout width; >= 40, 80 when unknown */
  columns: number
  /** braille / check mark render safely */
  unicode: boolean
}

/** The subset of a tty.WriteStream the detector reads; tests pass plain objects. */
export interface StreamLike {
  isTTY?: boolean
  columns?: number
  getColorDepth?: (env?: NodeJS.ProcessEnv) => number
}

export interface DetectOptions {
  /** --json / --quiet / --no-color: everything off, whatever the environment says */
  machine?: boolean
  /** override for tests; defaults to process.platform */
  platform?: string
}

/** Everything off: what `--json`, `--quiet` and a pipe get. */
export const MACHINE_CAPS: Caps = { tty: false, color: 0, animate: false, hyperlinks: false, columns: 80, unicode: true }

function ciSet(env: NodeJS.ProcessEnv): boolean {
  const ci = env['CI']
  return ci !== undefined && ci !== '' && ci !== 'false'
}

export function detectCaps(stream: StreamLike, env: NodeJS.ProcessEnv = process.env, opts: DetectOptions = {}): Caps {
  const platform = opts.platform ?? process.platform
  const tty = Boolean(stream.isTTY)
  const dumb = env['TERM'] === 'dumb'
  const ci = ciSet(env)
  let color: ColorLevel = 0
  if (!opts.machine) {
    const noColor = env['NO_COLOR']
    const force = env['FORCE_COLOR']
    if (noColor !== undefined && noColor !== '') color = 0
    else if (force !== undefined) color = force === '0' || force === 'false' ? 0 : force === '2' ? 2 : force === '3' ? 3 : 1
    else if (tty && !dumb) {
      const depth = typeof stream.getColorDepth === 'function' ? stream.getColorDepth(env) : 4
      color = depth >= 24 ? 3 : depth >= 8 ? 2 : depth >= 4 ? 1 : 0
    }
  }
  const animate = tty && !dumb && !ci && !opts.machine && env['ORANGU_NO_ANIMATION'] !== '1'
  const unicode = platform !== 'win32' ? env['TERM'] !== 'linux' : Boolean(env['WT_SESSION'] || env['TERM_PROGRAM'] === 'vscode' || env['ConEmuTask'])
  const columns = Math.max(40, Number.isFinite(stream.columns) && (stream.columns as number) > 0 ? (stream.columns as number) : 80)
  const hyperlinks = !opts.machine && supportsHyperlinks(stream, env, ci)
  return { tty, color, animate, hyperlinks, columns, unicode }
}

/**
 * The OSC 8 allowlist, after supports-hyperlinks: an unsupporting terminal ignores the sequence and
 * shows the text, but a log, a tmux pane without passthrough or a TERM=dumb wrapper (an Emacs shell
 * inherits TERM_PROGRAM from the terminal that launched it) shows garbage, so the default is off.
 * FORCE_HYPERLINK (the name Claude Code documents too) overrides in both directions.
 */
export function supportsHyperlinks(stream: StreamLike, env: NodeJS.ProcessEnv, ci = ciSet(env)): boolean {
  const force = env['FORCE_HYPERLINK']
  if (force !== undefined) return !(force === '0' || force === 'false' || force === '')
  if (!stream.isTTY || ci || env['TERM'] === 'dumb' || env['TEAMCITY_VERSION']) return false
  if (env['WT_SESSION']) return true
  if (/^(screen|tmux)/.test(env['TERM'] ?? '')) return false
  const prog = env['TERM_PROGRAM']
  const ver = env['TERM_PROGRAM_VERSION'] ?? ''
  const major = Number(ver.split('.')[0])
  const minor = Number(ver.split('.')[1] ?? 0)
  if (prog === 'iTerm.app') return major > 3 || (major === 3 && minor >= 1)
  if (prog === 'vscode') return major > 1 || (major === 1 && minor >= 72) || major === 0
  if (prog === 'WezTerm' || prog === 'ghostty' || prog === 'zed') return true
  if (env['VTE_VERSION']) return Number(env['VTE_VERSION']) >= 5000 && env['VTE_VERSION'] !== '5000'
  if (env['TERM'] === 'xterm-kitty' || env['TERM'] === 'alacritty') return true
  return false
}

// ---------- styling ----------

export type Style = 'dim' | 'bold' | 'accent' | 'good' | 'warn' | 'bad'

const ACCENT: Record<ColorLevel, string> = { 0: '', 1: '33', 2: '38;5;209', 3: '38;2;217;119;87' }
const SGR: Record<Exclude<Style, 'accent'>, string> = { dim: '2', bold: '1', good: '32', warn: '33', bad: '31' }

/** Wrap `s` in one SGR sequence (several styles combine into one), or return it untouched at level 0. */
export function paint(caps: Caps, style: Style | Style[], s: string): string {
  if (caps.color === 0 || s === '') return s
  const styles = Array.isArray(style) ? style : [style]
  const codes = styles.map((st) => (st === 'accent' ? ACCENT[caps.color] : SGR[st])).filter(Boolean)
  if (!codes.length) return s
  return `\x1b[${codes.join(';')}m${s}\x1b[0m`
}

export interface Glyphs {
  ok: string
  mark: string
  sep: string
  ellipsis: string
  up: string
  down: string
}

const UNICODE_GLYPHS: Glyphs = { ok: '✓', mark: '●', sep: ' · ', ellipsis: '…', up: '↑', down: '↓' }
const ASCII_GLYPHS: Glyphs = { ok: 'ok', mark: '*', sep: ' | ', ellipsis: '...', up: 'up', down: 'down' }

export function glyphs(caps: Pick<Caps, 'unicode'>): Glyphs {
  return caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS
}

// ---------- width ----------

const ANSI_OR_OSC = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/u
const EMOJI = /\p{Emoji_Presentation}|\uFE0F/u
// East Asian Width W/F is not an ECMAScript property; these ranges cover realistic input.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const isWide = (cp: number): boolean => WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Remove SGR/CSI and OSC sequences; what remains is what the terminal shows. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_OR_OSC, '')
}

/** Terminal columns a string occupies: escapes 0, ASCII 1, combining/format 0, CJK and emoji 2. */
export function displayWidth(s: string): number {
  let w = 0
  for (const { segment } of segmenter.segment(stripAnsi(s))) {
    const cp = segment.codePointAt(0)!
    if (cp >= 0x20 && cp <= 0x7e) {
      w += 1
      continue
    }
    if (ZERO_WIDTH.test(segment)) continue
    w += EMOJI.test(segment) || isWide(cp) ? 2 : 1
  }
  return w
}

/**
 * Cut plain text to `budget` columns, ending with an ellipsis. Escapes are stripped first, so colour
 * goes on after truncation and a cut can never land inside a sequence.
 */
export function truncate(s: string, budget: number, caps: Pick<Caps, 'unicode'>): string {
  const plain = stripAnsi(s)
  if (displayWidth(plain) <= budget) return plain
  const ell = glyphs(caps).ellipsis
  const room = budget - displayWidth(ell)
  if (room <= 0) return ell.slice(0, Math.max(0, budget))
  let out = ''
  let w = 0
  for (const { segment } of segmenter.segment(plain)) {
    const sw = displayWidth(segment)
    if (w + sw > room) break
    out += segment
    w += sw
  }
  return out + ell
}

/** Pad to `width` display columns (never cuts; truncate first). Pad after painting is wrong: pad, then paint. */
export function padCell(s: string, width: number, align: 'l' | 'r' = 'l'): string {
  const pad = Math.max(0, width - displayWidth(s))
  return align === 'l' ? s + ' '.repeat(pad) : ' '.repeat(pad) + s
}

/**
 * Split a separator-joined value into lines that each fit `budget`, breaking only at separators.
 * A single item wider than the budget stands alone (truncation is the caller's call).
 */
export function wrapValue(v: string, budget: number, sep = ' · '): string[] {
  const parts = v.split(sep)
  const lines: string[] = []
  let cur = ''
  for (const part of parts) {
    const next = cur ? cur + sep + part : part
    if (cur && displayWidth(next) > budget) {
      lines.push(cur)
      cur = part
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

// ---------- hyperlinks ----------

/**
 * OSC 8 link whose visible text is the path itself, so copy/paste and unsupporting terminals see the
 * same thing. file:// carries the hostname (the spec asks for it; Ghostty refuses links without it).
 */
export function fileLink(absPath: string, caps: Pick<Caps, 'hyperlinks'>, host = hostname()): string {
  if (!caps.hyperlinks) return absPath
  const u = pathToFileURL(absPath)
  const uri = `file://${host}${u.pathname}`.replace(/;/g, '%3B')
  return `\x1b]8;;${uri}\x1b\\${absPath}\x1b]8;;\x1b\\`
}

// ---------- cursor control and key decoding (used by select.ts; the escapes live here) ----------

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const CLEAR_LINE = '\r\x1b[2K'

/** Cursor and erase sequences for an inline redraw (never the alternate screen). */
export const CURSOR = {
  hide: HIDE_CURSOR,
  show: SHOW_CURSOR,
  /** move up n lines (nothing for n <= 0) */
  up: (n: number): string => (n > 0 ? `\x1b[${n}A` : ''),
  /** erase from the cursor to the end of the screen */
  eraseDown: '\x1b[0J',
  /** carriage return */
  home: '\r',
} as const

export type Key = 'up' | 'down' | 'home' | 'end' | 'pageup' | 'pagedown' | 'enter' | 'escape' | 'quit' | 'cancel' | 'digit' | 'other'

/**
 * Decode one raw-mode stdin chunk into the keys the picker knows. A terminal delivers a whole
 * escape sequence in one chunk, so a chunk that is exactly ESC is the Escape key (no readline
 * timeout). In raw mode Ctrl-C arrives as the byte 0x03, not as SIGINT.
 */
export function decodeKey(chunk: string): { key: Key; digit?: number } {
  if (chunk === '\x03') return { key: 'cancel' }
  if (chunk === '\x1b') return { key: 'escape' }
  if (chunk === '\r' || chunk === '\n') return { key: 'enter' }
  if (chunk === 'q' || chunk === 'Q' || chunk === '\x04') return { key: 'quit' }
  if (chunk === 'j' || chunk === '\x1b[B' || chunk === '\x1bOB') return { key: 'down' }
  if (chunk === 'k' || chunk === '\x1b[A' || chunk === '\x1bOA') return { key: 'up' }
  if (chunk === 'g' || chunk === '\x1b[H' || chunk === '\x1bOH' || chunk === '\x1b[1~') return { key: 'home' }
  if (chunk === 'G' || chunk === '\x1b[F' || chunk === '\x1bOF' || chunk === '\x1b[4~') return { key: 'end' }
  if (chunk === '\x1b[5~') return { key: 'pageup' }
  if (chunk === '\x1b[6~') return { key: 'pagedown' }
  if (/^[1-9]$/.test(chunk)) return { key: 'digit', digit: Number(chunk) }
  return { key: 'other' }
}

// ---------- line rewriting and the spinner ----------

export interface WritableLike {
  write(chunk: string): unknown
}

/** Redraw one status line in place on a terminal; on anything else, print it as a plain line. */
export function rewriteLine(stream: WritableLike, caps: Pick<Caps, 'animate'>, text: string): void {
  stream.write(caps.animate ? CLEAR_LINE + text : text + '\n')
}

const FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAMES_ASCII = ['-', '\\', '|', '/']

export interface Spinner {
  /** begin animating with this text; silent when the caps forbid animation */
  start(text: string): void
  /** replace the text (redrawn immediately while animating) */
  update(text: string): void
  /** clear the frame so another writer can print a full line */
  pause(): void
  /** clear, release the exit hook, then print `final` as its own line on every kind of stream */
  stop(final?: string): void
}

export interface ExitHookProcess {
  pid: number
  once(event: 'exit', fn: () => void): unknown
  on(event: NodeJS.Signals, fn: (sig: NodeJS.Signals) => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, fn: (...args: any[]) => void): unknown
  kill(pid: number, signal: NodeJS.Signals): unknown
}

const EXIT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Run `fn` exactly once at exit, on a fatal signal (then re-raise it so the status is 128+n, as
 * signal-exit does), or on dispose(). `fn` must be synchronous: 'exit' listeners get no event loop.
 */
export function onceOnExit(fn: () => void, proc: ExitHookProcess = process): { dispose(): void } {
  let done = false
  const run = (): void => {
    if (done) return
    done = true
    fn()
  }
  const onSignal = (sig: NodeJS.Signals): void => {
    run()
    for (const s of EXIT_SIGNALS) proc.removeListener(s, onSignal)
    proc.removeListener('exit', run)
    proc.kill(proc.pid, sig)
  }
  proc.once('exit', run)
  for (const s of EXIT_SIGNALS) proc.on(s, onSignal)
  return {
    dispose() {
      run()
      proc.removeListener('exit', run)
      for (const s of EXIT_SIGNALS) proc.removeListener(s, onSignal)
    },
  }
}

export interface SpinnerOptions {
  proc?: ExitHookProcess
  /** frame period override (tests) */
  intervalMs?: number
}

/**
 * A single-line stderr spinner. Frames redraw with `\r` + erase-line, the cursor is hidden while it
 * runs and shown again on stop, at exit and on SIGINT/SIGTERM/SIGHUP; the timer is unref'd so a
 * forgotten spinner can never keep the process alive. Writes nothing at all when `!caps.animate`.
 */
export function spinner(caps: Caps, stream: WritableLike = process.stderr, opts: SpinnerOptions = {}): Spinner {
  const frames = caps.unicode ? FRAMES_UNICODE : FRAMES_ASCII
  const ms = opts.intervalMs ?? (caps.unicode ? 80 : 130)
  let i = 0
  let text = ''
  let timer: NodeJS.Timeout | undefined
  let hook: { dispose(): void } | undefined
  const draw = (): void => {
    const frame = paint(caps, 'accent', frames[i++ % frames.length]!)
    stream.write(CLEAR_LINE + frame + ' ' + truncate(text, caps.columns - 4, caps))
  }
  const clear = (): void => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
    stream.write(CLEAR_LINE + SHOW_CURSOR)
  }
  return {
    start(t) {
      text = t
      if (!caps.animate || timer) return
      hook = hook ?? onceOnExit(clear, opts.proc)
      stream.write(HIDE_CURSOR)
      draw()
      timer = setInterval(draw, ms)
      timer.unref()
    },
    update(t) {
      text = t
      if (timer) draw()
    },
    pause: clear,
    stop(final) {
      clear()
      hook?.dispose()
      hook = undefined
      if (final !== undefined) stream.write(final + '\n')
    },
  }
}
