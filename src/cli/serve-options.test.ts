import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_LIVE } from '../serve/registry.js'
import { VERSION } from '../version.js'
import { serveOptions } from './serve-options.js'

const TERMINAL = { tty: true, env: {} }

describe('serveOptions: the 1 builder of the app options of orangu serve and bare orangu', () => {
  it('has the defaults of the app: transcript text on this machine, a redacted export, the browser on a terminal', () => {
    expect(serveOptions({}, { roots: ['/a', '/b'] }, TERMINAL)).toEqual({
      port: undefined,
      open: true,
      includeText: true,
      exportIncludeText: false,
      roots: ['/a', '/b'],
      noCache: false,
      version: VERSION,
      maxLive: undefined,
    })
    // a pipe opens no browser unless --open asks
    expect(serveOptions({}, {}, { tty: false, env: {} }).open).toBe(false)
    expect(serveOptions({ open: true }, {}, { tty: false, env: {} }).open).toBe(true)
  })

  it('reads each flag of serve', () => {
    const opts = serveOptions({ port: '8080', 'no-open': true, 'no-include-text': true, 'include-text': true, 'no-cache': true, 'max-live': '0' }, {}, TERMINAL)
    expect(opts).toMatchObject({ port: 8080, open: false, includeText: false, exportIncludeText: true, noCache: true, maxLive: DEFAULT_MAX_LIVE })
    expect(serveOptions({}, {}, { tty: true, env: { ORANGU_NO_CACHE: '1' } }).noCache).toBe(true)
  })

  it('keeps the sessions that the caller gives: 1 config dir and a cwd for serve, every root for bare orangu', () => {
    expect(serveOptions({}, { configDir: '/c', roots: undefined, cwd: '/w' }, TERMINAL)).toMatchObject({ configDir: '/c', roots: undefined, cwd: '/w' })
    expect(serveOptions({}, { roots: ['/r'] }, TERMINAL).configDir).toBeUndefined()
  })

  it('refuses a port outside 0 to 65535 with the message of serve', () => {
    for (const port of ['abc', '-1', '65536', '1.5']) {
      expect(() => serveOptions({ port }, {}, TERMINAL), port).toThrow(`--port must be an integer 0–65535, got "${port}"`)
    }
  })
})
