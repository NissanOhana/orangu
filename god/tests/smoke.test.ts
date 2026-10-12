// The god plugin loads in the engine, registers /god, and does no host work before the person asks for it:
// no host command, no file read, no timer, no tool and no pane until /god runs, when ORANGU_GOD is not set. A
// session that starts with ORANGU_GOD=1 registers the 2 tools before its first prompt, opens the pane and starts the
// board at once.
import { expect, mock, test } from 'claude-code/testing'
import { HOME, PANE, SURFACES, installMachine } from './fake-host'

for (const surface of SURFACES) {
  test(`${surface}: the plugin registers /god, and reads nothing and draws nothing before it`, async ($, on) => {
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
    for (const event of ['clock.every', 'clock.after', 'ui.open', 'session.id', 'store.get', 'config.list', 'tool.register'] as const) {
      on(event, () => {
        hostCalls.push(event)
        return { deny: 'nothing before /god' }
      })
    }
    mock.env(on, { HOME: '/tmp/god-home' })

    await $.session.start({ cwd: '/tmp/god-home', surface, isInteractive: true })
    expect(commands).toEqual(['god'])
    expect(hostCalls).toEqual([])
  })

  test(`${surface}: a session with ORANGU_GOD=1 registers the 2 tools before its first prompt, opens the pane and reads the sessions at start`, async ($, on) => {
    const calls = installMachine(on, { sessions: [], repos: {} })
    const clock = mock.clock(on, { now: Date.now() })
    mock.env(on, { HOME, ORANGU_GOD: '1' })
    // this hook sits beneath the plugin: it runs when the session start of the plugin hands the session on
    const toolsAtStart: string[][] = []
    on('session.start', (_$, e) => {
      toolsAtStart.push(calls.tools.map((tool) => tool.name))
      return { cwd: e.cwd }
    })
    await $.session.start({ cwd: HOME, surface, isInteractive: true })
    await clock.settle()
    expect(toolsAtStart).toEqual([['board', 'session']])
    expect(calls.tools.map((tool) => [tool.name, tool.isDeferred])).toEqual([
      ['board', false],
      ['session', false],
    ])
    // an open that the person did not ask for may not take the keys, so it asks for none
    expect(calls.opens).toEqual([{ id: PANE, title: 'orangu god', columns: 1000, rows: 20 }])
    expect(calls.runs.map((run) => run.argv.slice(0, 2).join(' '))).toContain('claude agents')
    expect(calls.boardWrites).toBeGreaterThan(0)
  })
}
