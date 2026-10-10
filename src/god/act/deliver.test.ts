/**
 * The executor of the key path, over a fake machine: what 1 y does with the intent of the confirm bar.
 * - It checks cmux and the tab of the target first, and a prompt text, and a refusal there runs no host call.
 * - It reads the registry file and the transcript tail of the target again, then the screen of its tab, then makes
 *   the plan, so each delivery reads the screen again and no fact of an older tick reaches the plan. The time of the
 *   facts is the host clock just before those reads.
 * - It runs only the plan steps, in order, and stops at the first one that fails. Its host runs only cmux send,
 *   send-key and read-screen, and the reads of the transcript.
 * - A peer message goes through the engine with no screen check.
 * The screens are the synthetic fixtures under test/fixtures/god/screens, and every session fact is made up.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DirEntry, Host, PeerOutcome, RunResult } from '../host.js'
import { transcriptPath } from '../source/transcript.js'
import type { DeliverIntent, SourceState } from '../types.js'
import { REFUSED_DELIVER_ARGV, deliver, deliverHost, deliverPeer, isDeliverArgv, type DeliverPorts, type DeliverRequest, type DeliverRow } from './deliver.js'
import type { KeyIntent } from './deliver-plan.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
const screenFixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')

const HOME = '/tmp/god-home'
const CWD = '/tmp/god-test/repo-a'
const PID = 4242
const ID = 'session-color'
const WS = '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const SF = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const TARGET = { sessionId: ID, name: 'color-picker' }
const ROW: DeliverRow = { pid: PID, sessionId: ID, cwd: CWD, tab: { pid: PID, tty: 'ttys005', workspaceRef: WS, surfaceRef: SF, workspaceTitle: 'color' } }
const REGISTRY = `${HOME}/.claude/sessions/${PID}.json`
const TRANSCRIPT = transcriptPath(HOME, CWD, ID)

const OPTIONS = [
  { label: 'Red', description: 'A warm color for the main action.' },
  { label: 'Green', description: 'A calm color that means go.' },
  { label: 'Blue', description: 'A cool color that fits the brand.' },
]
const QUESTION_TEXT = 'Which color should the button use?'
const ANSWER: KeyIntent = { kind: 'answer', target: TARGET, toolUseId: 'toolu_color', header: 'Color', question: QUESTION_TEXT, option: 1, label: 'Red' }
const TOUCH = { command: 'touch probe-yes.txt', description: 'Make an empty probe file' }
const PERMISSION: KeyIntent = { kind: 'permission', target: TARGET, choice: 'no', tool: 'Bash', input: JSON.stringify(TOUCH) }
const prompt = (text: string): KeyIntent => ({ kind: 'prompt', target: TARGET, text })

const at = (ms: number): string => new Date(ms).toISOString()
const askLine = JSON.stringify({ type: 'assistant', timestamp: at(T0 - 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_color', name: 'AskUserQuestion', input: { questions: [{ question: QUESTION_TEXT, header: 'Color', multiSelect: false, options: OPTIONS }] } }] } })
const bashLine = JSON.stringify({ type: 'assistant', timestamp: at(T0 - 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: TOUCH }] } })
const promptLine = (text: string, ms: number): string => JSON.stringify({ type: 'user', timestamp: at(ms), message: { role: 'user', content: text } })
const resultLine = JSON.stringify({ type: 'user', timestamp: at(T0 - 30_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_color', content: 'Red' }] }, toolUseResult: { answers: { [QUESTION_TEXT]: 'Red' } } })

/** The target as the fake machine holds it: its registry state, its transcript lines and the screen of its tab. */
type Target = { status: 'busy' | 'idle' | 'waiting'; waitingFor?: string; sessionId?: string; lines?: string[]; screen: string }

/** The registry, transcript and screen of a target that waits on the color question, with the given fields over them. */
const asks = (over: Partial<Target> = {}): Target => ({ status: 'waiting', waitingFor: 'input needed', lines: [promptLine('Pick a color.', T0 - 90_000), askLine], screen: screenFixture('question'), ...over })
const askPermission = (over: Partial<Target> = {}): Target => ({ status: 'waiting', waitingFor: 'permission prompt', lines: [promptLine('Make the file.', T0 - 90_000), bashLine], screen: screenFixture('permission'), ...over })
const idle = (over: Partial<Target> = {}): Target => ({ status: 'idle', lines: [promptLine('Run the tests.', T0 - 90_000)], screen: screenFixture('prompt-empty'), ...over })

const ran = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/**
 * A fake machine with 1 target. It logs each call in order, as `run <argv>`, `list <path>` or `read <path>`. The host
 * clock is `clock.t`, and `onRun` can move it while a command runs. `failing` names the cmux verbs that exit 1.
 */
function machine(target: Target, options: { failing?: string[]; onRun?: (argv: readonly string[], clock: { t: number }) => void; failRead?: boolean } = {}) {
  const log: string[] = []
  const runs: string[][] = []
  const clock = { t: T0 }
  const content = (): string => `${(target.lines ?? []).join('\n')}\n`
  const registry = (): string => JSON.stringify({ pid: PID, sessionId: target.sessionId ?? ID, cwd: CWD, name: 'color-picker', kind: 'interactive', status: target.status, ...(target.waitingFor === undefined ? {} : { waitingFor: target.waitingFor }), statusUpdatedAt: T0 - 60_000 })
  const host: Host = {
    run: async (argv) => {
      log.push(`run ${argv.join(' ')}`)
      runs.push([...argv])
      options.onRun?.(argv, clock)
      const [command, verb = ''] = argv
      if (command === 'stat') return ran(`7001 ${TRANSCRIPT}`)
      if (command === 'tail') return options.failRead === true ? ran('', 1) : ran(content().slice(Number((argv[2] ?? '+1').slice(1)) - 1))
      if (command === 'head') return ran(content().slice(0, Number(argv[2])))
      if (command === 'cmux' && options.failing?.includes(verb)) return ran('', 1)
      if (command === 'cmux' && verb === 'read-screen') return ran(target.screen)
      if (command === 'cmux') return ran('')
      throw new Error(`the fake machine has no ${command}`)
    },
    list: async (path) => {
      log.push(`list ${path}`)
      const entry: DirEntry = { name: `${PID}.json`, kind: 'file', size: registry().length, mtimeMs: T0 - 60_000, isLink: false }
      return path === `${HOME}/.claude/sessions` ? [entry] : []
    },
    read: async (path) => {
      log.push(`read ${path}`)
      if (path !== REGISTRY) throw new Error('no such file')
      return registry()
    },
    stat: async (path) => {
      log.push(`stat ${path}`)
      if (path !== TRANSCRIPT || target.lines === undefined) throw new Error('no such file')
      return { kind: 'file', size: content().length, mtimeMs: T0 - 60_000, isLink: false }
    },
    now: async () => clock.t,
  }
  const ports: DeliverPorts = { host, home: HOME, clean: (text) => text, clock: () => T0 + 5000 }
  return { log, runs, clock, ports }
}

const request = (intent: KeyIntent, over: Partial<DeliverRequest> = {}): DeliverRequest => ({ intent, session: ROW, cmux: 'ok', ...over })
const keyRuns = (runs: readonly string[][]): string[][] => runs.filter((argv) => argv[0] === 'cmux' && (argv[1] === 'send' || argv[1] === 'send-key'))
const screenRuns = (runs: readonly string[][]): string[][] => runs.filter((argv) => argv[0] === 'cmux' && argv[1] === 'read-screen')
const sendKey = (key: string): string[] => ['cmux', 'send-key', '--workspace', WS, '--surface', SF, '--', key]
const sendText = (text: string): string[] => ['cmux', 'send', '--workspace', WS, '--surface', SF, '--', text]

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
    const fake = machine(asks({ status: 'idle', waitingFor: undefined, lines: [promptLine('Pick a color.', T0 - 90_000), askLine, resultLine] }))
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

  it('fails with no key when the transcript or the screen read fails', async () => {
    const noTranscript = machine(asks(), { failRead: true })
    expect((await deliver(noTranscript.ports, request(ANSWER))).outcome.status).toBe('failed')
    expect(screenRuns(noTranscript.runs)).toEqual([])
    const noScreen = machine(asks(), { failing: ['read-screen'] })
    expect((await deliver(noScreen.ports, request(ANSWER))).outcome.status).toBe('failed')
    expect(keyRuns(noScreen.runs)).toEqual([])
  })

  it('answers a Bash permission with the digit of the exact No on the screen', async () => {
    const fake = machine(askPermission())
    expect((await deliver(fake.ports, request(PERMISSION))).outcome.status).toBe('sent')
    expect(keyRuns(fake.runs)).toEqual([sendKey('4')])
  })

  it('types a 2-line prompt as send, shift+enter, send, enter, after 1 screen read', async () => {
    const fake = machine(idle())
    const result = await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))
    expect(result.outcome.status).toBe('sent')
    expect(fake.runs.filter((argv) => argv[0] === 'cmux')).toEqual([
      ['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40'],
      sendText('Run the tests.'),
      sendKey('shift+enter'),
      sendText('Then fix the lint.'),
      sendKey('enter'),
    ])
  })

  it('stops at the first step that fails, and runs none after it', async () => {
    const fake = machine(idle(), { failing: ['send'] })
    const { outcome } = await deliver(fake.ports, request(prompt('Run the tests.\nThen fix the lint.')))
    expect(outcome).toMatchObject({ status: 'failed', screen: { text: screenFixture('prompt-empty') } })
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

describe('isDeliverArgv: the only commands of the executor', () => {
  it('takes cmux send and send-key with both refs and -- right before 1 value, the screen read, and the transcript reads', () => {
    for (const argv of [sendKey('1'), sendText('--surface x'), ['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40'], ['stat', '-f', '%i %N', TRANSCRIPT], ['tail', '-c', '+1', TRANSCRIPT], ['head', '-c', '100', TRANSCRIPT]]) {
      expect(isDeliverArgv(argv), argv.join(' ')).toBe(true)
    }
  })

  it('refuses every other cmux subcommand, a key with no --, a bad ref, more values, and every other command', () => {
    for (const argv of [
      ['cmux', 'notify', '--title', 't', '--body', 'b'],
      ['cmux', 'select-workspace', '--workspace', WS],
      ['cmux', 'focus-panel', '--panel', SF, '--workspace', WS],
      ['cmux', 'send', '--workspace', WS, '--surface', SF, 'text'],
      ['cmux', 'send', '--workspace', '3', '--surface', SF, '--', 'text'],
      ['cmux', 'send-key', '--workspace', WS, '--surface', SF, '--', '1', 'enter'],
      ['cmux', 'send-key', '--surface', SF, '--workspace', WS, '--', '1'],
      ['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40', '--scrollback'],
      ['claude', '-p', 'hi'],
      ['git', 'push'],
      ['ps', '-o', 'pid='],
      [],
    ]) {
      expect(isDeliverArgv(argv), argv.join(' ')).toBe(false)
    }
  })
})

describe('deliverHost: the host of the executor', () => {
  it('runs an argv that isDeliverArgv takes, and refuses any other one before the host port sees it', async () => {
    const fake = machine(asks())
    const host = deliverHost(fake.ports.host)
    await host.run(sendKey('1'))
    for (const argv of [['cmux', 'notify', '--title', 't', '--body', 'b'], ['cmux', 'select-workspace', '--workspace', WS], ['git', 'push'], ['claude', '-p', 'hi']]) {
      await expect(host.run(argv)).rejects.toThrow(REFUSED_DELIVER_ARGV)
    }
    expect(fake.runs).toEqual([sendKey('1')])
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
