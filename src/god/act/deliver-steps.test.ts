/**
 * The executor of the key path between the steps of a prompt, and the checks that hold each key, over a fake machine:
 * - before each next step of a prompt it reads the registry file and the screen again, and it stops at the first
 *   change: a session that waits or runs, a dialog on the screen, a box that does not hold the text typed so far
 *   (as the text cleaner shows it), a new status time or another transcript size since the plan read, or a read that
 *   took too long. A stop sends no later key, and the outcome keeps the newest screen;
 * - a shell command, the help, an exit word, /exit or /quit gets no host call, so a box in the shell mode never holds
 *   its text;
 * - a prompt to an idle session whose background task or subagent runs gets no key;
 * - the cancel mark of c stops the steps that did not go out;
 * - ps shows the PID of the target with the start time of its registry file and the TTY of its tab, or no key goes out.
 * The fake machine is test/fixtures/god/deliver-machine.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  ANSWER,
  HOME,
  PID,
  PS_START,
  T0,
  asks,
  backgroundLines,
  idle,
  keyRuns,
  machine,
  prompt,
  promptLine,
  request,
  screenFixture,
  sendKey,
  sendText,
  typedScreen,
  type Target,
} from '../../../test/fixtures/god/deliver-machine.js'
import { deliver } from './deliver.js'

describe('deliver: a prompt between its steps', () => {
  const PROMPT = prompt('Run the tests.\nThen run test 2 again.\nKeep it short.')
  const dialog = (target: Target): void => {
    target.status = 'waiting'
    target.waitingFor = 'permission prompt'
    target.screen = screenFixture('permission')
  }

  it('stops when a dialog opens after step 2: line 2 and the Enter never go out, and the outcome keeps the dialog screen', async () => {
    const fake = machine(idle(), { onKey: (keys, target) => void (keys === 2 ? dialog(target) : undefined) })
    const { outcome } = await deliver(fake.ports, request(PROMPT))
    expect(keyRuns(fake.runs)).toEqual([sendText('Run the tests.'), sendKey('shift+enter')])
    expect(outcome).toMatchObject({ status: 'failed', reason: 'stopped', screen: { text: screenFixture('permission') } })
  })

  it('stops when only the registry says that the session waits, or only the screen shows a dialog', async () => {
    const byRegistry = machine(idle(), { onKey: (keys, target) => void (keys === 2 ? Object.assign(target, { status: 'waiting', waitingFor: 'permission prompt' }) : undefined) })
    await deliver(byRegistry.ports, request(PROMPT))
    expect(keyRuns(byRegistry.runs)).toEqual([sendText('Run the tests.'), sendKey('shift+enter')])
    const byScreen = machine(idle(), { onKey: (keys, target) => void (keys === 2 ? Object.assign(target, { screen: screenFixture('permission') }) : undefined) })
    await deliver(byScreen.ports, request(PROMPT))
    expect(keyRuns(byScreen.runs)).toEqual([sendText('Run the tests.'), sendKey('shift+enter')])
  })

  it('stops when the box does not hold the text typed so far, and when the check between 2 steps reads too slowly', async () => {
    const lost = machine(idle({ screen: (typed) => typedScreen(typed.replace('2', '')) }))
    await deliver(lost.ports, request(PROMPT))
    expect(keyRuns(lost.runs)).toEqual([sendText('Run the tests.'), sendKey('shift+enter'), sendText('Then run test 2 again.')])
    let reads = 0
    const slow = machine(idle(), { onRun: (argv, clock) => void (argv[1] === 'read-screen' && ++reads === 2 ? (clock.t += 1500) : undefined) })
    const { outcome } = await deliver(slow.ports, request(PROMPT))
    expect(outcome).toMatchObject({ status: 'failed', reason: 'stopped' })
    expect(keyRuns(slow.runs)).toEqual([sendText('Run the tests.')])
  })

  it('reads and plans again once when the first read came too late, before any key, and refuses when the second is late too', async () => {
    let reads = 0
    const once = machine(asks(), { onRun: (argv, clock) => void (argv[1] === 'read-screen' && ++reads === 1 ? (clock.t += 1500) : undefined) })
    expect((await deliver(once.ports, request(ANSWER))).outcome).toMatchObject({ status: 'sent' })
    expect(reads).toBe(2)
    let late = 0
    const twice = machine(asks(), { onRun: (argv, clock) => void (argv[1] === 'read-screen' ? ((late += 1), (clock.t += 1500)) : undefined) })
    expect((await deliver(twice.ports, request(ANSWER))).outcome).toMatchObject({ status: 'refused', refusal: 'stale-screen' })
    expect(late).toBe(2)
    expect(keyRuns(twice.runs)).toEqual([])
  })

  it('refuses a prompt to an idle session whose background task runs, before any key', async () => {
    const fake = machine(idle({ lines: backgroundLines }))
    expect((await deliver(fake.ports, request(PROMPT))).outcome).toMatchObject({ status: 'refused', refusal: 'task-running' })
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('stops before the next step once c marks the delivery cancelled', async () => {
    const fake = machine(idle(), { onKey: (keys) => void (keys === 1 ? (fakeCancel.isCancelled = true) : undefined) })
    const fakeCancel = fake.cancel
    const { outcome } = await deliver(fake.ports, request(PROMPT))
    expect(outcome).toMatchObject({ status: 'failed', reason: 'cancelled' })
    expect(keyRuns(fake.runs)).toEqual([sendText('Run the tests.')])
    const early = machine(asks())
    early.cancel.isCancelled = true
    expect((await deliver(early.ports, request(ANSWER))).outcome).toMatchObject({ status: 'failed', reason: 'cancelled' })
    expect(keyRuns(early.runs)).toEqual([])
  })
})

describe('deliver: the process of the target', () => {
  it('reads ps for the PID in UTC before the keys, and sends when the start time and the TTY are those of the session', async () => {
    const fake = machine(asks())
    expect((await deliver(fake.ports, request(ANSWER))).outcome.status).toBe('sent')
    const at = fake.runs.findIndex((argv) => argv[0] === 'ps')
    expect(fake.runs[at]).toEqual(['ps', '-o', 'pid=,tty=,lstart=', '-p', String(PID)])
    expect(fake.envs[at]).toEqual({ TZ: 'UTC' })
    expect(at).toBeLessThan(fake.runs.findIndex((argv) => argv[1] === 'send'))
  })

  it('refuses when the process has another start time, another TTY, or is gone, and fails when ps does not run', async () => {
    for (const ps of [{ lstart: 'Sat Oct 10 09:00:00 2026', tty: 'ttys005' }, { lstart: PS_START, tty: 'ttys009' }, 'none'] as const) {
      const fake = machine(asks({ ps }))
      expect((await deliver(fake.ports, request(ANSWER))).outcome, JSON.stringify(ps)).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
      expect(keyRuns(fake.runs)).toEqual([])
    }
    const noProcStart = machine(asks({ procStart: '' }))
    expect((await deliver(noProcStart.ports, request(ANSWER))).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    const fails = machine(asks({ ps: 'fails' }))
    expect((await deliver(fails.ports, request(ANSWER))).outcome).toMatchObject({ status: 'failed', reason: 'facts-unread' })
    expect(keyRuns(fails.runs)).toEqual([])
  })
})

describe('deliver: the text cleaner and the clock between the steps', () => {
  it('types the whole prompt when the cleaner shows a part of the text in another form, such as the home folder as ~', async () => {
    const clean = (text: string): string => text.replaceAll(HOME, '~')
    const fake = machine(idle(), { clean })
    const text = `Read ${HOME}/notes.md.\nThen fix the lint.`
    expect((await deliver(fake.ports, request(prompt(text)))).outcome.status).toBe('sent')
    expect(keyRuns(fake.runs)).toEqual([sendText(`Read ${HOME}/notes.md.`), sendKey('shift+enter'), sendText('Then fix the lint.'), sendKey('enter')])
  })

  it('stops with no later key, and never rejects, when the host clock fails between 2 steps', async () => {
    let keys = 0
    const fake = machine(idle(), { onKey: () => void (keys += 1), nowFails: () => keys >= 1 })
    const { outcome } = await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))
    expect(outcome).toMatchObject({ status: 'failed', reason: 'stopped' })
    expect(keyRuns(fake.runs)).toEqual([sendText('Run the tests.')])
  })
})

describe('deliver: a text that is no prompt, and the shell mode on the screen', () => {
  it('refuses a shell command, the help and an exit before any host call', async () => {
    for (const text of ['!ls', '  ?', 'exit', '\n:wq!']) {
      const fake = machine(idle())
      expect((await deliver(fake.ports, request(prompt(text)))).outcome, JSON.stringify(text)).toMatchObject({ status: 'refused', refusal: 'not-a-prompt' })
      expect(fake.log).toEqual([])
    }
  })

  it('refuses /exit and /quit before any host call, and types /compact and /clear as any prompt', async () => {
    for (const text of ['/exit', '/QUIT', '  /exit', '/exit now']) {
      const fake = machine(idle())
      expect((await deliver(fake.ports, request(prompt(text)))).outcome, JSON.stringify(text)).toMatchObject({ status: 'refused', refusal: 'not-a-prompt' })
      expect(fake.log).toEqual([])
    }
    for (const text of ['/compact', '/clear']) {
      const fake = machine(idle())
      expect((await deliver(fake.ports, request(prompt(text)))).outcome, text).toMatchObject({ status: 'sent' })
      expect(keyRuns(fake.runs)).toEqual([sendText(text), sendKey('enter')])
    }
  })

  it('sends no key when the box of the target shows the shell mode, before the first step or after it', async () => {
    const shell = (typed: string): string => typedScreen(typed).replace('❯\u00a0', '!\u00a0')
    const before = machine(idle({ screen: shell }))
    expect((await deliver(before.ports, request(prompt('Run the tests.')))).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(before.runs)).toEqual([])
    const after = machine(idle(), { onKey: (keys, target) => void (keys === 1 ? (target.screen = shell) : undefined) })
    expect((await deliver(after.ports, request(prompt('Run the tests.\nThen fix the lint.')))).outcome).toMatchObject({ status: 'failed', reason: 'stopped' })
    expect(keyRuns(after.runs)).toEqual([sendText('Run the tests.')])
    // a ! prompt turns the box to the shell mode after its first key, so it stopped there and left its text in the box
    for (const text of ['!ls\nThen stop.', ' !ls']) {
      const bang = machine(idle(), { onKey: (keys, target) => void (keys === 1 ? (target.screen = shell) : undefined) })
      expect((await deliver(bang.ports, request(prompt(text)))).outcome, JSON.stringify(text)).toMatchObject({ status: 'refused', refusal: 'not-a-prompt' })
      expect(keyRuns(bang.runs)).toEqual([])
    }
  })
})

describe('deliver: a write of the session between 2 steps', () => {
  it('stops when the transcript grows after the plan read', async () => {
    const fake = machine(idle(), { onKey: (keys, target) => void (keys === 1 ? (target.lines = [...(target.lines ?? []), promptLine('A task note.', T0)]) : undefined) })
    expect((await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))).outcome).toMatchObject({ status: 'failed', reason: 'stopped' })
    expect(keyRuns(fake.runs)).toEqual([sendText('Run the tests.')])
  })

  it('stops when the registry file writes a new status time after the plan read, with the same status', async () => {
    const fake = machine(idle(), { onKey: (keys, target) => void (keys === 1 ? (target.statusUpdatedAt = T0 - 1000) : undefined) })
    expect((await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))).outcome).toMatchObject({ status: 'failed', reason: 'stopped' })
    expect(keyRuns(fake.runs)).toEqual([sendText('Run the tests.')])
  })
})
