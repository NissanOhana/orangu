import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  CURSOR,
  MACHINE_CAPS,
  decodeKey,
  detectCaps,
  displayWidth,
  fileLink,
  glyphs,
  onceOnExit,
  padCell,
  paint,
  rewriteLine,
  spinner,
  stripAnsi,
  supportsHyperlinks,
  truncate,
  wrapValue,
  type Caps,
} from './tty.js'

const tty = { isTTY: true, columns: 120, getColorDepth: () => 8 }
const pipe = { isTTY: false }
const posix = { platform: 'darwin' }

function caps(over: Partial<Caps> = {}): Caps {
  return { tty: true, color: 2, animate: true, hyperlinks: false, columns: 80, unicode: true, ...over }
}

describe('detectCaps', () => {
  it('a pipe gets nothing: no colour, no animation, no links, 80 columns', () => {
    expect(detectCaps(pipe, {}, posix)).toEqual({ tty: false, color: 0, animate: false, hyperlinks: false, columns: 80, unicode: true })
  })
  it('a TTY gets colour from getColorDepth, animation, its own width', () => {
    const c = detectCaps(tty, {}, posix)
    expect(c).toMatchObject({ tty: true, color: 2, animate: true, columns: 120 })
    expect(detectCaps({ ...tty, getColorDepth: () => 24 }, {}, posix).color).toBe(3)
    expect(detectCaps({ ...tty, getColorDepth: () => 4 }, {}, posix).color).toBe(1)
    expect(detectCaps({ ...tty, getColorDepth: () => 1 }, {}, posix).color).toBe(0)
    expect(detectCaps({ isTTY: true }, {}, posix).columns).toBe(80)
    expect(detectCaps({ isTTY: true, columns: 12 }, {}, posix).columns).toBe(40)
  })
  it('NO_COLOR (non-empty) beats FORCE_COLOR; an empty NO_COLOR is ignored', () => {
    expect(detectCaps(tty, { NO_COLOR: '1', FORCE_COLOR: '3' }, posix).color).toBe(0)
    expect(detectCaps(tty, { NO_COLOR: '' }, posix).color).toBe(2)
  })
  it('FORCE_COLOR maps 0/false -> 0, 1/true/empty -> 1, 2 -> 2, 3 -> 3, even on a pipe', () => {
    expect(detectCaps(pipe, { FORCE_COLOR: '0' }, posix).color).toBe(0)
    expect(detectCaps(pipe, { FORCE_COLOR: 'false' }, posix).color).toBe(0)
    expect(detectCaps(pipe, { FORCE_COLOR: '1' }, posix).color).toBe(1)
    expect(detectCaps(pipe, { FORCE_COLOR: 'true' }, posix).color).toBe(1)
    expect(detectCaps(pipe, { FORCE_COLOR: '' }, posix).color).toBe(1)
    expect(detectCaps(pipe, { FORCE_COLOR: '2' }, posix).color).toBe(2)
    expect(detectCaps(pipe, { FORCE_COLOR: '3' }, posix).color).toBe(3)
    // colour is allowed on a pipe by FORCE_COLOR, animation never is
    expect(detectCaps(pipe, { FORCE_COLOR: '3' }, posix).animate).toBe(false)
  })
  it('TERM=dumb: no colour, no animation on a TTY', () => {
    expect(detectCaps(tty, { TERM: 'dumb' }, posix)).toMatchObject({ tty: true, color: 0, animate: false })
  })
  it('CI keeps colour but never animates; CI=false and CI="" opt out', () => {
    expect(detectCaps(tty, { CI: '1' }, posix)).toMatchObject({ color: 2, animate: false })
    expect(detectCaps(tty, { CI: 'true' }, posix).animate).toBe(false)
    expect(detectCaps(tty, { CI: 'false' }, posix).animate).toBe(true)
    expect(detectCaps(tty, { CI: '' }, posix).animate).toBe(true)
  })
  it('ORANGU_NO_ANIMATION=1 stops the spinner only', () => {
    expect(detectCaps(tty, { ORANGU_NO_ANIMATION: '1' }, posix)).toMatchObject({ color: 2, animate: false })
  })
  it('machine beats every environment variable', () => {
    const c = detectCaps(tty, { FORCE_COLOR: '3', FORCE_HYPERLINK: '1' }, { machine: true, ...posix })
    expect(c).toMatchObject({ tty: true, color: 0, animate: false, hyperlinks: false })
  })
  it('unicode: off on the Linux console, on elsewhere; Windows only in WT / vscode / ConEmu', () => {
    expect(detectCaps(tty, { TERM: 'linux' }, posix).unicode).toBe(false)
    expect(detectCaps(tty, { TERM: 'xterm-256color' }, posix).unicode).toBe(true)
    expect(detectCaps(tty, {}, { platform: 'win32' }).unicode).toBe(false)
    expect(detectCaps(tty, { WT_SESSION: 'x' }, { platform: 'win32' }).unicode).toBe(true)
    expect(detectCaps(tty, { TERM_PROGRAM: 'vscode' }, { platform: 'win32' }).unicode).toBe(true)
  })
})

describe('supportsHyperlinks', () => {
  it('follows the allowlist and never links a pipe, CI or tmux', () => {
    expect(supportsHyperlinks(pipe, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' })).toBe(false)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' })).toBe(true)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.0.1' })).toBe(false)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0', CI: '1' })).toBe(false)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0', TERM: 'tmux-256color' })).toBe(false)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.72.0' })).toBe(true)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.60.0' })).toBe(false)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '0.45.1' })).toBe(true)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'ghostty' })).toBe(true)
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'WezTerm' })).toBe(true)
    expect(supportsHyperlinks(tty, { WT_SESSION: 'abc' })).toBe(true)
    expect(supportsHyperlinks(tty, { VTE_VERSION: '6003' })).toBe(true)
    expect(supportsHyperlinks(tty, { VTE_VERSION: '5000' })).toBe(false)
    expect(supportsHyperlinks(tty, { VTE_VERSION: '4800' })).toBe(false)
    expect(supportsHyperlinks(tty, { TERM: 'xterm-kitty' })).toBe(true)
    expect(supportsHyperlinks(tty, { TERM: 'alacritty' })).toBe(true)
  })
  it('Apple Terminal is not on the list', () => {
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455' })).toBe(false)
  })
  it('FORCE_HYPERLINK overrides in both directions', () => {
    expect(supportsHyperlinks(pipe, { FORCE_HYPERLINK: '1' })).toBe(true)
    expect(supportsHyperlinks(tty, { FORCE_HYPERLINK: '0', TERM_PROGRAM: 'ghostty' })).toBe(false)
    expect(supportsHyperlinks(tty, { FORCE_HYPERLINK: '', TERM_PROGRAM: 'ghostty' })).toBe(false)
  })
})

describe('paint', () => {
  it('is the identity at level 0 and wraps one SGR sequence otherwise', () => {
    expect(paint(MACHINE_CAPS, 'accent', 'x')).toBe('x')
    expect(paint(caps({ color: 1 }), 'accent', 'x')).toBe('\x1b[33mx\x1b[0m')
    expect(paint(caps({ color: 2 }), 'accent', 'x')).toBe('\x1b[38;5;209mx\x1b[0m')
    expect(paint(caps({ color: 3 }), 'accent', 'x')).toBe('\x1b[38;2;217;119;87mx\x1b[0m')
    expect(paint(caps(), ['bold', 'accent'], 'x')).toBe('\x1b[1;38;5;209mx\x1b[0m')
    expect(paint(caps(), 'dim', '')).toBe('')
  })
})

describe('glyphs', () => {
  it('swap to ASCII when unicode is off', () => {
    expect(glyphs({ unicode: true })).toMatchObject({ ok: '✓', mark: '●', sep: ' · ', ellipsis: '…' })
    expect(glyphs({ unicode: false })).toMatchObject({ ok: 'ok', mark: '*', sep: ' | ', ellipsis: '...' })
  })
})

describe('displayWidth', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['●', 1],
    ['·', 1],
    ['…', 1],
    ['✓', 1],
    ['日本語', 6],
    ['한글', 4],
    ['🙂', 2],
    ['⚠️', 2],
    ['é', 1],
    ['a\u200bb', 2],
    ['\x1b[1mbold\x1b[0m', 4],
    ['\x1b]8;;file://h/p\x1b\\path\x1b]8;;\x1b\\', 4],
    ['\x1b]8;;file://h/p\x07path\x1b]8;;\x07', 4],
  ])('%j -> %i', (s, w) => {
    expect(displayWidth(s)).toBe(w)
  })
  it('stripAnsi leaves the visible text', () => {
    expect(stripAnsi('\x1b[2m\x1b[38;5;209mx\x1b[0m y \x1b]8;;u\x1b\\z\x1b]8;;\x1b\\')).toBe('x y z')
  })
})

describe('truncate', () => {
  it('leaves short text alone, cuts long text to the budget with an ellipsis', () => {
    expect(truncate('short', 10, { unicode: true })).toBe('short')
    expect(truncate('exactly ten', 11, { unicode: true })).toBe('exactly ten')
    const t = truncate('a much longer title than fits', 12, { unicode: true })
    expect(t).toBe('a much long…')
    expect(displayWidth(t)).toBe(12)
    const a = truncate('a much longer title than fits', 12, { unicode: false })
    expect(a).toBe('a much lo...')
    expect(displayWidth(a)).toBe(12)
  })
  it('counts wide glyphs and never cuts inside an escape sequence', () => {
    const t = truncate('日本語テキスト', 7, { unicode: true })
    expect(displayWidth(t)).toBeLessThanOrEqual(7)
    expect(t.endsWith('…')).toBe(true)
    const styled = truncate('\x1b[1mabcdefghij\x1b[0m', 5, { unicode: true })
    expect(styled).toBe('abcd…')
    expect(styled).not.toContain('\x1b')
  })
})

describe('padCell / wrapValue', () => {
  it('pads by display width, never cuts', () => {
    expect(padCell('ab', 5)).toBe('ab   ')
    expect(padCell('ab', 5, 'r')).toBe('   ab')
    expect(padCell('日本', 5)).toBe('日本 ')
    expect(padCell('toolong', 3)).toBe('toolong')
  })
  it('splits only at separators', () => {
    expect(wrapValue('/plugin marketplace add NissanOhana/orangu · /plugin install orangu', 60)).toEqual([
      '/plugin marketplace add NissanOhana/orangu',
      '/plugin install orangu',
    ])
    expect(wrapValue('/plugin marketplace add NissanOhana/orangu · /plugin install orangu', 68)).toHaveLength(1)
    expect(wrapValue('a · b · c', 80)).toEqual(['a · b · c'])
    expect(wrapValue('a · b · c', 5)).toEqual(['a · b', 'c'])
    expect(wrapValue('', 5)).toEqual([])
  })
})

describe('fileLink', () => {
  it('is the plain path without hyperlink support', () => {
    expect(fileLink('/tmp/a b.html', { hyperlinks: false }, 'host')).toBe('/tmp/a b.html')
  })
  it('wraps the visible path in OSC 8 with a hostname and percent-encoding', () => {
    const l = fileLink('/tmp/a b;c.html', { hyperlinks: true }, 'myhost')
    expect(l).toBe('\x1b]8;;file://myhost/tmp/a%20b%3Bc.html\x1b\\/tmp/a b;c.html\x1b]8;;\x1b\\')
    expect(stripAnsi(l)).toBe('/tmp/a b;c.html')
    expect(displayWidth(l)).toBe('/tmp/a b;c.html'.length)
  })
})

function fakeProc(): { proc: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> } {
  const em = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> }
  em.pid = 4242
  em.kill = vi.fn()
  return { proc: em, kill: em.kill }
}

describe('onceOnExit', () => {
  it('runs once on exit, on dispose, or on a signal (which it re-raises after unhooking)', () => {
    const { proc, kill } = fakeProc()
    const fn = vi.fn()
    const h = onceOnExit(fn, proc as never)
    expect(proc.listenerCount('SIGINT')).toBe(1)
    proc.emit('SIGINT', 'SIGINT')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(4242, 'SIGINT')
    expect(proc.listenerCount('SIGINT')).toBe(0)
    expect(proc.listenerCount('exit')).toBe(0)
    proc.emit('exit')
    h.dispose()
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('dispose removes every listener and runs the hook exactly once', () => {
    const { proc } = fakeProc()
    const fn = vi.fn()
    const h = onceOnExit(fn, proc as never)
    h.dispose()
    h.dispose()
    expect(fn).toHaveBeenCalledTimes(1)
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) expect(proc.listenerCount(s)).toBe(0)
  })
})

function sink(): { stream: { write(c: string): boolean }; out: string[] } {
  const out: string[] = []
  return { stream: { write: (c: string) => (out.push(c), true) }, out }
}

describe('spinner', () => {
  it('writes nothing while disabled and still prints the final line', () => {
    const { stream, out } = sink()
    const sp = spinner(caps({ animate: false }), stream)
    sp.start('analyzing')
    sp.update('still')
    sp.pause()
    expect(out).toEqual([])
    sp.stop('done')
    expect(out).toEqual(['done\n'])
  })
  it('hides the cursor, redraws frames in place, and restores the cursor on stop', () => {
    vi.useFakeTimers()
    try {
      const { stream, out } = sink()
      const { proc } = fakeProc()
      const sp = spinner(caps({ color: 0 }), stream, { proc: proc as never, intervalMs: 10 })
      sp.start('analyzing abc')
      expect(out[0]).toBe('\x1b[?25l')
      expect(out[1]).toBe('\r\x1b[2K⠋ analyzing abc')
      vi.advanceTimersByTime(25)
      expect(out.length).toBe(4)
      expect(out[3]).toBe('\r\x1b[2K⠹ analyzing abc')
      sp.update('next')
      expect(out.at(-1)).toBe('\r\x1b[2K⠸ next')
      expect(proc.listenerCount('SIGINT')).toBe(1)
      sp.stop('done')
      expect(out.at(-2)).toBe('\r\x1b[2K\x1b[?25h')
      expect(out.at(-1)).toBe('done\n')
      expect(proc.listenerCount('SIGINT')).toBe(0)
      vi.advanceTimersByTime(100)
      expect(out.at(-1)).toBe('done\n')
    } finally {
      vi.useRealTimers()
    }
  })
  it('uses ASCII frames without unicode and keeps the frame under the width', () => {
    const { stream, out } = sink()
    const sp = spinner(caps({ color: 0, unicode: false, columns: 40 }), stream)
    sp.start('x'.repeat(100))
    expect(out[1]).toBe('\r\x1b[2K- ' + 'x'.repeat(33) + '...')
    sp.stop()
    expect(out.at(-1)).toBe('\r\x1b[2K\x1b[?25h')
  })
  it('a signal while spinning clears the line and shows the cursor before re-raising', () => {
    const { stream, out } = sink()
    const { proc, kill } = fakeProc()
    const sp = spinner(caps({ color: 0 }), stream, { proc: proc as never })
    sp.start('busy')
    proc.emit('SIGTERM', 'SIGTERM')
    expect(out.at(-1)).toBe('\r\x1b[2K\x1b[?25h')
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    sp.stop()
    expect(out.at(-1)).toBe('\r\x1b[2K\x1b[?25h')
  })
})

describe('rewriteLine', () => {
  it('redraws in place on a terminal and prints a plain line elsewhere', () => {
    const a = sink()
    rewriteLine(a.stream, { animate: true }, 'status')
    expect(a.out).toEqual(['\r\x1b[2Kstatus'])
    const b = sink()
    rewriteLine(b.stream, { animate: false }, 'status')
    expect(b.out).toEqual(['status\n'])
  })
})

describe('decodeKey', () => {
  it('maps the picker keys and treats anything else as other', () => {
    const table: Array<[string, ReturnType<typeof decodeKey>]> = [
      ['\x03', { key: 'cancel' }],
      ['\x1b', { key: 'escape' }],
      ['\r', { key: 'enter' }],
      ['\n', { key: 'enter' }],
      ['q', { key: 'quit' }],
      ['Q', { key: 'quit' }],
      ['\x04', { key: 'quit' }],
      ['j', { key: 'down' }],
      ['\x1b[B', { key: 'down' }],
      ['\x1bOB', { key: 'down' }],
      ['k', { key: 'up' }],
      ['\x1b[A', { key: 'up' }],
      ['\x1bOA', { key: 'up' }],
      ['g', { key: 'home' }],
      ['\x1b[H', { key: 'home' }],
      ['G', { key: 'end' }],
      ['\x1b[F', { key: 'end' }],
      ['\x1b[5~', { key: 'pageup' }],
      ['\x1b[6~', { key: 'pagedown' }],
      ['1', { key: 'digit', digit: 1 }],
      ['9', { key: 'digit', digit: 9 }],
      ['0', { key: 'other' }],
      ['x', { key: 'other' }],
      ['\x1b[Z', { key: 'other' }],
      ['jj', { key: 'other' }],
      ['', { key: 'other' }],
    ]
    for (const [chunk, want] of table) expect(decodeKey(chunk), JSON.stringify(chunk)).toEqual(want)
  })
  it('CURSOR.up is empty for zero and never negative', () => {
    expect(CURSOR.up(0)).toBe('')
    expect(CURSOR.up(-2)).toBe('')
    expect(CURSOR.up(3)).toBe('\x1b[3A')
  })
})
