/**
 * A fake machine for the executor of the key path (src/god/act/deliver.ts): 1 target session with its registry file,
 * its transcript, the ps row of its PID and the screen of its cmux tab. It logs each call in order. The screens are
 * the synthetic fixtures under test/fixtures/god/screens, and every session fact is made up.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DirEntry, Host, RunResult } from '../../../src/god/host.js'
import { transcriptPath } from '../../../src/god/source/transcript.js'
import type { DeliverPorts, DeliverRequest, DeliverRow } from '../../../src/god/act/deliver.js'
import type { KeyIntent } from '../../../src/god/act/deliver-plan.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), 'screens')
export const screenFixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')

export const HOME = '/tmp/god-home'
export const CWD = '/tmp/god-test/repo-a'
export const PID = 4242
export const ID = 'session-color'
export const WS = '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
export const SF = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'
export const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
export const TARGET = { sessionId: ID, name: 'color-picker' }
export const ROW: DeliverRow = { pid: PID, sessionId: ID, cwd: CWD, tab: { pid: PID, tty: 'ttys005', workspaceRef: WS, surfaceRef: SF, workspaceTitle: 'color' } }
export const REGISTRY = `${HOME}/.claude/sessions/${PID}.json`
export const TRANSCRIPT = transcriptPath(HOME, CWD, ID)

const OPTIONS = [
  { label: 'Red', description: 'A warm color for the main action.' },
  { label: 'Green', description: 'A calm color that means go.' },
  { label: 'Blue', description: 'A cool color that fits the brand.' },
]
const QUESTION_TEXT = 'Which color should the button use?'
export const ANSWER: KeyIntent = { kind: 'answer', target: TARGET, toolUseId: 'toolu_color', header: 'Color', question: QUESTION_TEXT, option: 1, label: 'Red' }
const TOUCH = { command: 'touch probe-yes.txt', description: 'Make an empty probe file' }
export const PERMISSION: KeyIntent = { kind: 'permission', target: TARGET, choice: 'no', tool: 'Bash', input: JSON.stringify(TOUCH) }
export const prompt = (text: string): KeyIntent => ({ kind: 'prompt', target: TARGET, text })

const at = (ms: number): string => new Date(ms).toISOString()
const askLine = JSON.stringify({ type: 'assistant', timestamp: at(T0 - 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_color', name: 'AskUserQuestion', input: { questions: [{ question: QUESTION_TEXT, header: 'Color', multiSelect: false, options: OPTIONS }] } }] } })
const bashLine = JSON.stringify({ type: 'assistant', timestamp: at(T0 - 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: TOUCH }] } })
export const promptLine = (text: string, ms: number): string => JSON.stringify({ type: 'user', timestamp: at(ms), message: { role: 'user', content: text } })
export const askLines = [promptLine('Pick a color.', T0 - 90_000), askLine]
export const resultLine = JSON.stringify({ type: 'user', timestamp: at(T0 - 30_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_color', content: 'Red' }] }, toolUseResult: { answers: { [QUESTION_TEXT]: 'Red' } } })

/** The start time that ps gives for the PID of the target, in UTC, as the registry writes it. */
export const PS_START = 'Fri Oct  9 08:00:00 2026'

/**
 * The target as the fake machine holds it: its registry state, its transcript lines and the screen of its tab. A
 * screen can be a function of the text typed into the input box so far. The ps row of its PID gives its start time
 * and its TTY.
 */
export type Target = {
  status: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  sessionId?: string
  lines?: string[]
  screen: string | ((typed: string) => string)
  procStart?: string
  ps?: { lstart: string; tty: string } | 'none' | 'fails'
}

/** The empty prompt screen with the input box holding `typed`: the first line after the prompt mark, the next ones after 2 spaces. */
export function typedScreen(typed: string): string {
  const [first = '', ...rest] = typed.split('\n')
  return screenFixture('prompt-empty')
    .split('\n')
    .flatMap((row) => (/^❯[  ]$/.test(row) ? [`❯ ${first}`, ...rest.map((line) => `  ${line}`)] : [row]))
    .join('\n')
}

/** The registry, transcript and screen of a target that waits on the color question, with the given fields over them. */
export const asks = (over: Partial<Target> = {}): Target => ({ status: 'waiting', waitingFor: 'input needed', lines: askLines, screen: screenFixture('question'), ...over })
export const askPermission = (over: Partial<Target> = {}): Target => ({ status: 'waiting', waitingFor: 'permission prompt', lines: [promptLine('Make the file.', T0 - 90_000), bashLine], screen: screenFixture('permission'), ...over })
export const idle = (over: Partial<Target> = {}): Target => ({ status: 'idle', lines: [promptLine('Run the tests.', T0 - 90_000)], screen: typedScreen, ...over })
export const backgroundLines = [
  promptLine('Start the server.', T0 - 90_000),
  JSON.stringify({ type: 'assistant', timestamp: at(T0 - 80_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_server', name: 'Bash', input: { command: 'npm run dev', description: 'Start the server', run_in_background: true } }] } }),
  JSON.stringify({ type: 'user', timestamp: at(T0 - 79_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_server', content: 'Command running in background with ID: b1' }] }, toolUseResult: { backgroundTaskId: 'b1' } }),
]

const ran = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/**
 * What a test changes on the machine: `failing` names the cmux verbs that exit 1, `onRun` can move the clock while a
 * command runs, `onKey` runs after each send or send-key with the count of key steps so far, `failRead` fails the
 * transcript tail, `nowFails` makes the host clock reject while it gives true, and `clean` is the text cleaner.
 */
export type MachineOptions = {
  failing?: string[]
  onRun?: (argv: readonly string[], clock: { t: number }) => void
  onKey?: (keys: number, target: Target) => void
  failRead?: boolean
  nowFails?: () => boolean
  clean?: (text: string) => string
}

/** A fake machine with 1 target. It logs each call in order, as `run <argv>`, `list <path>` or `read <path>`. The host clock is `clock.t`. */
export function machine(target: Target, options: MachineOptions = {}) {
  const log: string[] = []
  const runs: string[][] = []
  const envs: Array<Readonly<Record<string, string>> | undefined> = []
  const clock = { t: T0 }
  let typed = ''
  let keys = 0
  const cancel = { isCancelled: false }
  const content = (): string => `${(target.lines ?? []).join('\n')}\n`
  const registry = (): string =>
    JSON.stringify({ pid: PID, sessionId: target.sessionId ?? ID, cwd: CWD, name: 'color-picker', kind: 'interactive', status: target.status, ...(target.waitingFor === undefined ? {} : { waitingFor: target.waitingFor }), statusUpdatedAt: T0 - 60_000, procStart: target.procStart ?? PS_START })
  const host: Host = {
    run: async (argv, runOptions) => {
      log.push(`run ${argv.join(' ')}`)
      runs.push([...argv])
      envs.push(runOptions?.env)
      options.onRun?.(argv, clock)
      const [command, verb = ''] = argv
      if (command === 'stat') return ran(`7001 ${TRANSCRIPT}`)
      if (command === 'tail') return options.failRead === true ? ran('', 1) : ran(content().slice(Number((argv[2] ?? '+1').slice(1)) - 1))
      if (command === 'head') return ran(content().slice(0, Number(argv[2])))
      if (command === 'ps') {
        const row = target.ps ?? { lstart: PS_START, tty: 'ttys005' }
        if (row === 'fails') throw new Error('ps did not run')
        return row === 'none' ? ran('', 1) : ran(`${PID} ${row.tty}  ${row.lstart}\n`)
      }
      if (command === 'cmux' && options.failing?.includes(verb)) return ran('', 1)
      if (command === 'cmux' && verb === 'read-screen') return ran(typeof target.screen === 'string' ? target.screen : target.screen(typed))
      if (command === 'cmux' && (verb === 'send' || verb === 'send-key')) {
        const value = argv.at(-1) ?? ''
        typed = verb === 'send' ? typed + value : value === 'shift+enter' ? `${typed}\n` : ''
        keys += 1
        options.onKey?.(keys, target)
        return ran('')
      }
      throw new Error(`the fake machine has no ${command} ${verb}`)
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
    now: async () => {
      if (options.nowFails?.() === true) throw new Error('the clock did not answer')
      return clock.t
    },
  }
  const ports: DeliverPorts = { host, home: HOME, clean: options.clean ?? ((text) => text), clock: () => T0 + 5000, isCancelled: () => cancel.isCancelled }
  return { log, runs, envs, clock, ports, cancel }
}

export const request = (intent: KeyIntent, over: Partial<DeliverRequest> = {}): DeliverRequest => ({ intent, session: ROW, cmux: 'ok', ...over })
export const keyRuns = (runs: readonly string[][]): string[][] => runs.filter((argv) => argv[0] === 'cmux' && (argv[1] === 'send' || argv[1] === 'send-key'))
export const screenRuns = (runs: readonly string[][]): string[][] => runs.filter((argv) => argv[0] === 'cmux' && argv[1] === 'read-screen')
export const sendKey = (key: string): string[] => ['cmux', 'send-key', '--workspace', WS, '--surface', SF, '--', key]
export const sendText = (text: string): string[] => ['cmux', 'send', '--workspace', WS, '--surface', SF, '--', text]
