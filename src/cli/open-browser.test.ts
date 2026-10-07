import { describe, expect, it } from 'vitest'
import { openInBrowser, type OpenDeps } from './open-browser.js'

/** a stub spawn and stderr that record the call, so no browser and no shell ever runs */
function stub(platform: NodeJS.Platform) {
  const calls: Array<{ command: string; args: string[] }> = []
  const errors: string[] = []
  const deps: OpenDeps = {
    platform,
    spawn: (command, args) => {
      calls.push({ command, args })
      return { once: () => undefined, unref: () => undefined }
    },
    stderr: { write: (text: string) => errors.push(text) },
  }
  return { deps, calls, errors }
}

describe('openInBrowser', () => {
  // cmd.exe reads these characters in the target of `start`. A model can name a run directory with Write, so a
  // path such as session-a&calc&-x would run a second command. orangu prints the path and opens nothing.
  it('on Windows, refuses a target that holds a character that cmd reads, and tells the user to open it by hand', () => {
    for (const char of ['&', '^', '%', '!', '"', '<', '>', '|']) {
      const target = `C:\\Users\\a\\.orangu\\show-me\\session-a${char}calc${char}-x\\slides.html`
      const { deps, calls, errors } = stub('win32')
      expect(openInBrowser(target, deps), char).toBe(false)
      expect(calls, char).toEqual([])
      expect(errors.join(''), char).toContain(`Open it by hand: ${target}`)
    }
  })

  it('on Windows, opens a plain target through cmd /c start', () => {
    const target = 'C:\\Users\\a\\.orangu\\show-me\\session-aaaaaaaa-x1Y2z3\\slides.html'
    const { deps, calls, errors } = stub('win32')
    expect(openInBrowser(target, deps)).toBe(true)
    expect(calls).toEqual([{ command: 'cmd', args: ['/c', 'start', '', target] }])
    expect(errors).toEqual([])
  })

  it('on macOS and Linux, passes the target as one argument with no shell, so & is only a character', () => {
    for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open']] as const) {
      const target = '/home/a/.orangu/show-me/session-a&calc&-x/slides.html'
      const { deps, calls } = stub(platform)
      expect(openInBrowser(target, deps)).toBe(true)
      expect(calls).toEqual([{ command, args: [target] }])
    }
  })
})
