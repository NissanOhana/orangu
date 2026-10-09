// The god plugin loads in the engine, registers /god, and does no host work before the person asks for it:
// no host command, no file read and no timer until /god runs, when ORANGU_GOD is not set.
import { expect, mock, test } from 'claude-code/testing'

test('the plugin registers /god, reads nothing before it, and /god answers its line', async ($, on) => {
  const hostCalls: string[] = []
  const commands: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', (_$, e) => {
    hostCalls.push(`process.run ${e.argv.join(' ')}`)
    return { deny: 'no host command before /god' }
  })
  on('fs.*', (_$, _e, next) => {
    hostCalls.push(next.event)
    return { deny: 'no file read before /god' }
  })
  on('clock.every', () => {
    hostCalls.push('clock.every')
    return { deny: 'no timer before /god' }
  })
  on('clock.after', () => {
    hostCalls.push('clock.after')
    return { deny: 'no timer before /god' }
  })
  mock.env(on, { HOME: '/tmp/god-home' })

  await $.session.start({ cwd: '/tmp/god-home', surface: 'terminal', isInteractive: true })
  expect(commands).toEqual(['god'])
  expect(hostCalls).toEqual([])

  const out = await $.command.run({ command: 'god', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(out.text).toBe('The god pane is not ready in this build.')
})
