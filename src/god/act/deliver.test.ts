/**
 * The executor of the key path, over a fake machine: what 1 y does with the intent of the confirm bar.
 * - It checks cmux and the tab of the target first, and a prompt text, and a refusal there runs no host call.
 * - It reads the registry file and the transcript tail of the target again, then the screen of its tab, then makes
 *   the plan, so each delivery reads the screen again and no fact of an older tick reaches the plan. The time of the
 *   facts is the host clock just before those reads.
 * - It runs only the plan steps, in order, and stops at the first one that fails. Its host runs only cmux send,
 *   send-key and read-screen, ps of 1 PID in UTC, and the reads of the transcript.
 * - A peer message goes through the engine with no screen check.
 * The checks between the steps of a prompt, the cancel mark and the process check are in deliver-steps.test.ts, and
 * the argv forms that the host of the executor takes in deliver-argv.test.ts. The fake machine is
 * test/fixtures/god/deliver-machine.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  ANSWER,
  HOME,
  ID,
  PERMISSION,
  REGISTRY,
  ROW,
  SF,
  T0,
  TARGET,
  TRANSCRIPT,
  WS,
  askLines,
  askPermission,
  asks,
  idle,
  keyRuns,
  machine,
  prompt,
  request,
  resultLine,
  screenFixture,
  screenRuns,
  sendKey,
  sendText,
} from '../../../test/fixtures/god/deliver-machine.js'
import type { PeerOutcome } from '../host.js'
import type { DeliverIntent, SourceState } from '../types.js'
import { deliver, deliverPeer, type DeliverRequest, type DeliverRow } from './deliver.js'

describe('deliver: the checks before any read', () => {
  it('refuses with no cmux, with no cmux read that worked, and with no usable tab, and runs no host call', async () => {
    const cases: Array<[Partial<DeliverRequest>, string]> = [
      [{ cmux: 'missing' }, 'no-cmux'],
      [{ cmux: 'off' as SourceState['status'] }, 'no-tab'],
      [{ cmux: 'unread' as SourceState['status'] }, 'no-tab'],
      [{ session: { ...ROW, tab: undefined } as DeliverRow }, 'no-tab'],
      [{ session: { ...ROW, tab: { ...ROW.tab!, workspaceRef: '3' } } }, 'no-tab'],
    ]
    for (const [over, refusal] of cases) {
      const fake = machine(asks())
      const { outcome } = await deliver(fake.ports, request(ANSWER, over))
      expect(outcome).toMatchObject({ status: 'refused', refusal })
      expect(fake.log, refusal).toEqual([])
    }
  })

  it('refuses a session that left the board, and a prompt text that cmux would type as keys, with no host call', async () => {
    const gone = machine(asks())
    const { session: _session, ...noSession } = request(ANSWER)
    expect((await deliver(gone.ports, noSession)).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(gone.log).toEqual([])
    for (const [text, refusal] of [['a\\nb', 'backslash-escape'], ['   ', 'empty'], [`a${String.fromCharCode(0x1b)}b`, 'control-char']] as const) {
      const fake = machine(idle())
      expect((await deliver(fake.ports, request(prompt(text)))).outcome).toMatchObject({ status: 'refused', refusal })
      expect(fake.log).toEqual([])
    }
  })
})

describe('deliver: the fresh reads, then the plan', () => {
  it('reads the registry file and the transcript of the target, then its screen, then sends the digit alone', async () => {
    const fake = machine(asks())
    const result = await deliver(fake.ports, request(ANSWER))
    expect(result.outcome).toMatchObject({ status: 'sent', intent: ANSWER })
    const screenAt = fake.log.findIndex((line) => line.includes('read-screen'))
    for (const read of [`list ${HOME}/.claude/sessions`, `read ${REGISTRY}`, `stat ${TRANSCRIPT}`]) expect(fake.log.indexOf(read), read).toBeGreaterThanOrEqual(0)
    expect(fake.log.findIndex((line) => line.startsWith('run tail'))).toBeLessThan(screenAt)
    expect(fake.log.indexOf(`read ${REGISTRY}`)).toBeLessThan(screenAt)
    expect(screenRuns(fake.runs)).toEqual([['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40']])
    expect(keyRuns(fake.runs)).toEqual([sendKey('1')])
    expect(fake.log.at(-1)).toBe(`run ${sendKey('1').join(' ')}`)
  })

  it('takes the time of the facts from the host clock before the reads, so slow reads make the plan refuse', async () => {
    // the transcript read takes 1.2 s: facts stamped after the reads would look fresh and send the digit
    const fake = machine(asks(), { onRun: (argv, clock) => void (argv[0] === 'tail' ? (clock.t += 1200) : undefined) })
    const { outcome } = await deliver(fake.ports, request(ANSWER))
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'stale-screen' })
    expect(outcome.status === 'refused' ? outcome.screen?.text : undefined).toBe(screenFixture('question'))
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('reads the state on disk, not the board: a question that closed since the last tick gets no key', async () => {
    const fake = machine(asks({ status: 'idle', waitingFor: undefined, lines: [...askLines, resultLine] }))
    expect((await deliver(fake.ports, request(ANSWER))).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('reads the screen again for each delivery', async () => {
    const fake = machine(asks())
    await deliver(fake.ports, request(ANSWER))
    await deliver(fake.ports, request(ANSWER))
    expect(screenRuns(fake.runs)).toHaveLength(2)
    expect(fake.runs.map((argv) => argv[1])).toEqual(expect.arrayContaining(['read-screen', 'send-key']))
    const order = fake.runs.filter((argv) => argv[0] === 'cmux').map((argv) => argv[1])
    expect(order).toEqual(['read-screen', 'send-key', 'read-screen', 'send-key'])
  })

  it('refuses a screen that changed, and keeps the fresh screen in the outcome', async () => {
    const fake = machine(asks({ screen: screenFixture('prompt-empty') }))
    const { outcome } = await deliver(fake.ports, request(ANSWER))
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed', screen: { sessionId: ID, workspaceRef: WS, surfaceRef: SF, text: screenFixture('prompt-empty') } })
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('refuses a registry file that names another session at the PID, before any screen read', async () => {
    const fake = machine(asks({ sessionId: 'session-other' }))
    expect((await deliver(fake.ports, request(ANSWER))).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(screenRuns(fake.runs)).toEqual([])
  })

  it('fails with no key when the transcript or the screen read fails, and says which read failed', async () => {
    const noTranscript = machine(asks(), { failRead: true })
    expect((await deliver(noTranscript.ports, request(ANSWER))).outcome).toMatchObject({ status: 'failed', reason: 'facts-unread' })
    expect(screenRuns(noTranscript.runs)).toEqual([])
    const noScreen = machine(asks(), { failing: ['read-screen'] })
    expect((await deliver(noScreen.ports, request(ANSWER))).outcome).toMatchObject({ status: 'failed', reason: 'screen-unread' })
    expect(keyRuns(noScreen.runs)).toEqual([])
  })

  it('answers a Bash permission with the digit of the exact No on the screen', async () => {
    const fake = machine(askPermission())
    expect((await deliver(fake.ports, request(PERMISSION))).outcome.status).toBe('sent')
    expect(keyRuns(fake.runs)).toEqual([sendKey('4')])
  })

  it('types a 2-line prompt as send, shift+enter, send, enter, and reads the registry and the screen again before each next step', async () => {
    const fake = machine(idle())
    const result = await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))
    expect(result.outcome.status).toBe('sent')
    const read = ['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40']
    expect(fake.runs.filter((argv) => argv[0] === 'cmux')).toEqual([read, sendText('Run the tests.'), read, sendKey('shift+enter'), read, sendText('Then fix the lint.'), read, sendKey('enter')])
    // each check reads the registry file, then the screen, after the step before it
    const keyLines = fake.log.flatMap((line, index) => (line.startsWith('run cmux send') ? [index] : []))
    for (const [from, to] of keyLines.slice(0, -1).map((index, at) => [index, keyLines[at + 1]!] as const)) {
      const between = fake.log.slice(from + 1, to)
      expect(between.indexOf(`read ${REGISTRY}`), between.join('\n')).toBeGreaterThanOrEqual(0)
      expect(between.indexOf(`read ${REGISTRY}`)).toBeLessThan(between.findIndex((line) => line.includes('read-screen')))
    }
  })

  it('stops at the first step that fails, and runs none after it', async () => {
    const fake = machine(idle(), { failing: ['send'] })
    const { outcome } = await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))
    expect(outcome).toMatchObject({ status: 'failed', reason: 'step-failed', screen: { text: screenFixture('prompt-empty') } })
    expect(keyRuns(fake.runs)).toEqual([sendText('Run the tests.')])
  })

  it('gives the check of the next refreshes for each kind of key', async () => {
    const answer = await deliver(machine(asks()).ports, request(ANSWER))
    expect(answer.check).toEqual({ sessionId: ID, expect: { kind: 'question', toolUseId: 'toolu_color' }, sentAt: T0 + 5000, misses: 0 })
    const permission = await deliver(machine(askPermission()).ports, request(PERMISSION))
    expect(permission.check?.expect).toEqual({ kind: 'permission', toolUseId: 'toolu_bash' })
    const typed = await deliver(machine(idle()).ports, request(prompt('Run the tests.\nThen fix the lint.')))
    expect(typed.check?.expect).toEqual({ kind: 'prompt', text: 'Run the tests.\nThen fix the lint.', after: T0 + 4000 })
    const refused = await deliver(machine(asks({ screen: screenFixture('prompt-empty') })).ports, request(ANSWER))
    expect(refused.check).toBeUndefined()
  })
})

describe('deliverPeer: a peer message through the engine', () => {
  const PEER: DeliverIntent & { kind: 'peer' } = { kind: 'peer', target: TARGET, text: 'Stop the deploy now.' }
  const now = async (): Promise<number> => T0

  it('sends 1 peer message, with no screen check, and gives the answer of the engine', async () => {
    const sent: Array<[string, string]> = []
    const peer = async (sessionId: string, text: string): Promise<PeerOutcome> => {
      sent.push([sessionId, text])
      return { isDelivered: true }
    }
    expect(await deliverPeer(peer, PEER, now)).toEqual({ status: 'delivered', intent: PEER, at: T0 })
    expect(sent).toEqual([[ID, 'Stop the deploy now.']])
    expect(await deliverPeer(async () => ({ isDelivered: false, reason: 'gone' }), PEER, now)).toMatchObject({ status: 'not-delivered' })
    expect(
      await deliverPeer(
        async () => {
          throw new Error('refused')
        },
        PEER,
        now,
      ),
    ).toMatchObject({ status: 'not-delivered' })
  })

  it('refuses an empty message and sends nothing', async () => {
    let calls = 0
    const peer = async (): Promise<PeerOutcome> => {
      calls += 1
      return { isDelivered: true }
    }
    expect(await deliverPeer(peer, { ...PEER, text: ' \n ' }, now)).toMatchObject({ status: 'refused', refusal: 'empty' })
    expect(calls).toBe(0)
  })
})
