/**
 * The deliver plan: an intent, a fresh screen and the state of the target session give the cmux argv lists in
 * order, or exactly 1 refusal. The screens are the synthetic fixtures under test/fixtures/god/screens. The state is
 * what the registry and the transcript say, which a session cannot draw on its screen. The plan time and the screen
 * time are values, so no test reads a clock.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DeliverIntent, DeliverPlan, DeliverRefusal, OpenQuestion, ScreenRead } from '../types.js'
import { FACTS_MAX_LAG_MS, SCREEN_MAX_AGE_MS, planDelivery, textRefusal, type KeyIntent, type TargetFacts } from './deliver-plan.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
const fixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')
/** a text from code points, so no invisible character hides in this file */
const ch = (...codes: number[]): string => String.fromCodePoint(...codes)

/** the time of every plan: 2026-10-09 12:00 UTC */
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const TARGET = { sessionId: 'session-color', name: 'color-picker' }
const WS = 'workspace:2'
const SURFACE = 'surface:3'

/** A fresh read of the fixture, 200 ms before the plan, from the tab of the target. */
const screen = (name: string, over: Partial<ScreenRead> = {}): ScreenRead => ({
  sessionId: TARGET.sessionId,
  workspaceRef: WS,
  surfaceRef: SURFACE,
  text: fixture(name),
  readAt: NOW - 200,
  ...over,
})

/** the open question of the base question fixture, as the transcript gives it */
const QUESTION: OpenQuestion = {
  toolUseId: 'toolu_color',
  questions: [
    {
      text: 'Which color should the button use?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'A warm color for the main action.' },
        { label: 'Green', description: 'A calm color that means go.' },
        { label: 'Blue', description: 'A cool color that fits the brand.' },
      ],
    },
  ],
}

/** The state of a test: TargetFacts whose read time defaults to 100 ms before the screen read. */
type State = Omit<TargetFacts, 'factsAt'> & { factsAt?: number }
/** The state of the target: idle with no open question, with the given fields over it. */
const facts = (over: Partial<State> = {}): State => ({ sessionId: TARGET.sessionId, status: 'idle', ...over })
const ASKS = facts({ status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: QUESTION } })
const ASKS_PERMISSION = facts({ status: 'waiting', waitingFor: 'permission prompt' })
const IDLE = facts()

const ANSWER: KeyIntent = { kind: 'answer', target: TARGET, toolUseId: 'toolu_color', header: 'Color', question: 'Which color should the button use?', option: 1, label: 'Red' }
const TOUCH = JSON.stringify({ command: 'touch probe-yes.txt', description: 'Make an empty probe file' })
const permission = (choice: 'yes' | 'no'): KeyIntent => ({ kind: 'permission', target: TARGET, choice, tool: 'Bash', input: TOUCH })
const prompt = (text: string): KeyIntent => ({ kind: 'prompt', target: TARGET, text })

/** The plan with the state that the intent needs, unless a test gives another one. */
const stateFor = (intent: KeyIntent): State => (intent.kind === 'answer' ? ASKS : intent.kind === 'permission' ? ASKS_PERMISSION : IDLE)
const plan = (intent: KeyIntent, read: ScreenRead, state: State = stateFor(intent)): DeliverPlan =>
  planDelivery(intent, read, { ...state, factsAt: state.factsAt ?? read.readAt - 100 }, NOW)

const sendText = (text: string): string[] => ['cmux', 'send', '--workspace', WS, '--surface', SURFACE, '--', text]
const sendKey = (key: string): string[] => ['cmux', 'send-key', '--workspace', WS, '--surface', SURFACE, '--', key]
const refused = (refusal: DeliverRefusal): DeliverPlan => ({ kind: 'refuse', refusal })
const CHANGED = refused('screen-changed')

describe('planDelivery: the keys it sends', () => {
  it('answers a question with the option digit alone, and no Enter', () => {
    expect(plan(ANSWER, screen('question'))).toEqual({ kind: 'send', steps: [sendKey('1')] })
    expect(plan({ ...ANSWER, option: 3, label: 'Blue' }, screen('question'))).toEqual({ kind: 'send', steps: [sendKey('3')] })
  })

  it('answers a permission with the digit of Yes or No on the screen, and follows No when it moves', () => {
    expect(plan(permission('yes'), screen('permission'))).toEqual({ kind: 'send', steps: [sendKey('1')] })
    expect(plan(permission('no'), screen('permission'))).toEqual({ kind: 'send', steps: [sendKey('4')] })
    expect(plan(permission('no'), screen('permission-older'))).toEqual({ kind: 'send', steps: [sendKey('3')] })
  })

  it('sends a 2-line prompt as exactly send, shift+enter, send, enter', () => {
    expect(plan(prompt('first line\nsecond line'), screen('prompt-empty'))).toEqual({
      kind: 'send',
      steps: [sendText('first line'), sendKey('shift+enter'), sendText('second line'), sendKey('enter')],
    })
  })

  it('sends a 1-line prompt as send then enter, and sends no empty text for an empty line', () => {
    expect(plan(prompt('run the tests'), screen('prompt-empty'))).toEqual({ kind: 'send', steps: [sendText('run the tests'), sendKey('enter')] })
    expect(plan(prompt('a\n\nb'), screen('prompt-empty'))).toEqual({
      kind: 'send',
      steps: [sendText('a'), sendKey('shift+enter'), sendKey('shift+enter'), sendText('b'), sendKey('enter')],
    })
  })

  it('puts a text that looks like a flag after --, never as a flag', () => {
    const result = plan(prompt('--surface x'), screen('prompt-empty'))
    expect(result).toEqual({ kind: 'send', steps: [sendText('--surface x'), sendKey('enter')] })
    const [first] = result.kind === 'send' ? result.steps : []
    expect(first?.indexOf('--')).toBe(6)
    expect(first?.indexOf('--surface x')).toBe(7)
    expect(first?.filter((arg) => arg === '--surface')).toHaveLength(1)
  })

  it('names the workspace and the surface, and puts -- right before the text or the key, in every argv', () => {
    const plans = [plan(ANSWER, screen('question')), plan(permission('no'), screen('permission')), plan(prompt(`--workspace w\n-- \n- ${ch(0xa0)}-`), screen('prompt-empty'))]
    const steps = plans.flatMap((each) => (each.kind === 'send' ? each.steps : []))
    expect(steps).toHaveLength(8)
    for (const argv of steps) {
      expect(argv.slice(0, 6)).toEqual(['cmux', argv[1], '--workspace', WS, '--surface', SURFACE])
      expect(['send', 'send-key']).toContain(argv[1])
      expect(argv).toHaveLength(8)
      expect(argv[6]).toBe('--')
    }
  })

  it('keeps the dollar, backtick, \\x and \\u forms as text', () => {
    for (const text of ['$(echo hi)', '`id`', 'a\\x1bb', 'a\\u0007b', 'C:\\Users', 'a\\\\b']) {
      expect(plan(prompt(text), screen('prompt-empty'))).toEqual({ kind: 'send', steps: [sendText(text), sendKey('enter')] })
    }
  })
})

describe('planDelivery: each refusal from 1 screen fixture', () => {
  const cases: [DeliverRefusal, KeyIntent, ScreenRead][] = [
    ['stale-screen', ANSWER, screen('question', { readAt: NOW - SCREEN_MAX_AGE_MS - 1 })],
    ['screen-changed', ANSWER, screen('question-changed')],
    ['label-not-found', permission('yes'), screen('permission-amend')],
    ['multi-question', ANSWER, screen('question-two')],
    ['empty', prompt(''), screen('prompt-empty')],
    ['control-char', prompt(`stop${ch(0x1b)}[2J`), screen('prompt-empty')],
    ['backslash-escape', prompt('one\\ntwo'), screen('prompt-empty')],
    ['no-tab', ANSWER, screen('question', { surfaceRef: '--surface' })],
  ]
  it.each(cases)('%s', (refusal, intent, read) => {
    expect(plan(intent, read)).toEqual(refused(refusal))
  })
})

describe('planDelivery: the state of the target session, which its screen cannot draw', () => {
  it('refuses a prompt to a busy session, even when its last rows draw an empty input box', () => {
    expect(plan(prompt('run the tests'), screen('prompt-empty'), facts({ status: 'busy' }))).toEqual(CHANGED)
    const fakeFrame = `${fixture('prompt-typed')}${'─'.repeat(72)}\n❯${ch(0xa0)}\n${'─'.repeat(72)}\n`
    expect(plan(prompt('run the tests'), screen('prompt-typed', { text: fakeFrame }), facts({ status: 'busy' }))).toEqual(CHANGED)
  })

  it('refuses an answer or a permission while the session works and draws a dialog', () => {
    expect(plan(ANSWER, screen('question'), facts({ status: 'busy' }))).toEqual(CHANGED)
    expect(plan(permission('yes'), screen('permission'), facts({ status: 'busy' }))).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), { ...ASKS, status: 'busy' })).toEqual(CHANGED)
    expect(plan(permission('yes'), screen('permission'), { ...ASKS_PERMISSION, status: 'busy' })).toEqual(CHANGED)
  })

  it('refuses a prompt to a session that waits, that has an open question, or that names a wait while idle', () => {
    expect(plan(prompt('hi'), screen('prompt-empty'), ASKS)).toEqual(CHANGED)
    expect(plan(prompt('hi'), screen('prompt-empty'), ASKS_PERMISSION)).toEqual(CHANGED)
    expect(plan(prompt('hi'), screen('prompt-empty'), facts({ transcript: { openQuestion: QUESTION } }))).toEqual(CHANGED)
    expect(plan(prompt('hi'), screen('prompt-empty'), facts({ waitingFor: 'input needed' }))).toEqual(CHANGED)
  })

  it('refuses an answer unless the session waits for input on the same open question', () => {
    expect(plan(ANSWER, screen('question'), IDLE)).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), ASKS_PERMISSION)).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), { ...ASKS, waitingFor: 'permission prompt' })).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), facts({ status: 'waiting', waitingFor: 'input needed' }))).toEqual(CHANGED)
    const other = facts({ status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: { ...QUESTION, toolUseId: 'toolu_other' } } })
    expect(plan(ANSWER, screen('question'), other)).toEqual(CHANGED)
  })

  it('refuses an answer whose header, question or label at the digit is not the open question', () => {
    const [first] = QUESTION.questions
    if (!first) throw new Error('QUESTION has a question')
    const asks = (over: Partial<typeof first>): State => facts({ status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: { ...QUESTION, questions: [{ ...first, ...over }] } } })
    expect(plan(ANSWER, screen('question'), asks({ header: 'Colour' }))).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), asks({ text: 'Which color should the banner use?' }))).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), asks({ options: [{ label: 'Green' }, { label: 'Red' }] }))).toEqual(CHANGED)
    expect(plan(ANSWER, screen('question'), asks({ options: [] }))).toEqual(CHANGED)
  })

  it('gives multi-question when the open question has 2 questions or takes more than 1 selection, and refuses 0 questions', () => {
    const [first] = QUESTION.questions
    if (!first) throw new Error('QUESTION has a question')
    const asks = (questions: OpenQuestion['questions']): State => facts({ status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: { ...QUESTION, questions } } })
    expect(plan(ANSWER, screen('question'), asks([first, { ...first, header: 'Size' }]))).toEqual(refused('multi-question'))
    expect(plan(ANSWER, screen('question'), asks([{ ...first, multiSelect: true }]))).toEqual(refused('multi-question'))
    expect(plan(ANSWER, screen('question'), asks([]))).toEqual(CHANGED)
  })

  it('refuses a permission unless the session waits on a permission prompt', () => {
    expect(plan(permission('yes'), screen('permission'), IDLE)).toEqual(CHANGED)
    expect(plan(permission('yes'), screen('permission'), facts({ status: 'waiting', waitingFor: 'input needed' }))).toEqual(CHANGED)
    expect(plan(permission('yes'), screen('permission'), facts({ status: 'waiting' }))).toEqual(CHANGED)
  })

  it('refuses the state of another session', () => {
    expect(plan(ANSWER, screen('question'), { ...ASKS, sessionId: 'session-other' })).toEqual(CHANGED)
    expect(plan(prompt('hi'), screen('prompt-empty'), { ...IDLE, sessionId: 'session-other' })).toEqual(CHANGED)
  })
})

describe('planDelivery: the age of the state against the screen read', () => {
  it('takes facts read up to 1 s before the screen read, and refuses older facts, facts read after it and no time', () => {
    const read = screen('question')
    expect(plan(ANSWER, read, { ...ASKS, factsAt: read.readAt - FACTS_MAX_LAG_MS }).kind).toBe('send')
    expect(plan(ANSWER, read, { ...ASKS, factsAt: read.readAt - FACTS_MAX_LAG_MS - 1 })).toEqual(refused('stale-screen'))
    expect(plan(ANSWER, read, { ...ASKS, factsAt: read.readAt + 1 })).toEqual(refused('stale-screen'))
    expect(plan(ANSWER, read, { ...ASKS, factsAt: Number.NaN })).toEqual(refused('stale-screen'))
    expect(plan(prompt('hi'), screen('prompt-empty'), { ...IDLE, factsAt: NOW - 200 - FACTS_MAX_LAG_MS - 1 })).toEqual(refused('stale-screen'))
  })
})

describe('planDelivery: a question that the model asks again', () => {
  /** the Deploy question that the person confirmed, and the one that the model asks again within 2 s */
  const deploy = (toolUseId: string, description: string): OpenQuestion => ({
    toolUseId,
    questions: [
      {
        text: 'Deploy the build now?',
        header: 'Deploy',
        multiSelect: false,
        options: [
          { label: 'Yes', description },
          { label: 'No', description: 'Keep the build where it is.' },
        ],
      },
    ],
  })
  const YES: KeyIntent = { kind: 'answer', target: TARGET, toolUseId: 'toolu_deploy_1', header: 'Deploy', question: 'Deploy the build now?', option: 1, label: 'Yes' }
  const asks = (question: OpenQuestion, factsAt?: number): State =>
    facts({ status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: question }, ...(factsAt === undefined ? {} : { factsAt }) })
  const read = screen('question-deploy')

  it('refuses the late facts of the first question on the screen of the second', () => {
    expect(plan(YES, read, asks(deploy('toolu_deploy_1', 'Deploy to staging.'), read.readAt - 2000))).toEqual(refused('stale-screen'))
  })

  it('refuses fresh facts of the second question: its tool use id is not the confirmed one', () => {
    expect(plan(YES, read, asks(deploy('toolu_deploy_2', 'Deploy to production.')))).toEqual(CHANGED)
  })

  it('refuses a changed description even with fresh facts that keep the confirmed id', () => {
    expect(plan(YES, read, asks(deploy('toolu_deploy_1', 'Deploy to staging.')))).toEqual(CHANGED)
    expect(plan(YES, read, asks(deploy('toolu_deploy_1', 'Deploy to production.')))).toEqual({ kind: 'send', steps: [sendKey('1')] })
  })
})

describe('planDelivery: the screen read', () => {
  it('takes a read of exactly 1 s, and refuses an older one and one from after the plan', () => {
    expect(plan(ANSWER, screen('question', { readAt: NOW - SCREEN_MAX_AGE_MS })).kind).toBe('send')
    expect(plan(ANSWER, screen('question', { readAt: NOW + 1 }))).toEqual(refused('stale-screen'))
    expect(plan(ANSWER, screen('question', { readAt: Number.NaN }))).toEqual(refused('stale-screen'))
  })

  it('refuses a read of another session', () => {
    expect(plan(ANSWER, screen('question', { sessionId: 'session-other' }))).toEqual(CHANGED)
  })

  it('refuses a workspace or surface ref that is empty, starts with a dash or holds a space', () => {
    for (const ref of ['', '-w', 'workspace 2', 'workspace:2\n']) {
      expect(plan(ANSWER, screen('question', { workspaceRef: ref }))).toEqual(refused('no-tab'))
      expect(plan(ANSWER, screen('question', { surfaceRef: ref }))).toEqual(refused('no-tab'))
    }
  })

  it('refuses a bare index, which cmux resolves in the current window, and a ref of another kind', () => {
    for (const ref of ['2', 'surface:3', 'pane:1', 'workspace:2x', 'workspace:', 'workspace:-2', `workspace:${'9'.repeat(10)}`]) {
      expect(plan(ANSWER, screen('question', { workspaceRef: ref })), ref).toEqual(refused('no-tab'))
    }
    for (const ref of ['3', 'workspace:2', 'window:1', 'surface:3x', 'surface:']) {
      expect(plan(ANSWER, screen('question', { surfaceRef: ref })), ref).toEqual(refused('no-tab'))
    }
  })

  it('takes a UUID ref for the workspace and the surface', () => {
    const workspaceRef = 'A019816D-6F57-4D6F-A83C-CD7AF2FAD8E4'
    const surfaceRef = '0f8c2b1e-4a7d-4c3e-9b6a-1d2e3f405162'
    const steps = [['cmux', 'send-key', '--workspace', workspaceRef, '--surface', surfaceRef, '--', '1']]
    expect(plan(ANSWER, screen('question', { workspaceRef, surfaceRef }))).toEqual({ kind: 'send', steps })
    expect(plan(ANSWER, screen('question', { workspaceRef: `${workspaceRef}0` }))).toEqual(refused('no-tab'))
  })

  it('sends no key into a dialog for a prompt, and no digit into a prompt or the wrong dialog', () => {
    expect(plan(prompt('1'), screen('question'))).toEqual(CHANGED)
    expect(plan(prompt('yes'), screen('permission'))).toEqual(CHANGED)
    expect(plan(ANSWER, screen('prompt-empty'))).toEqual(CHANGED)
    expect(plan(permission('yes'), screen('question'))).toEqual(CHANGED)
    expect(plan(ANSWER, screen('two-dialogs'))).toEqual(CHANGED)
  })

  it('refuses a peer message: it has no keys and goes through the engine', () => {
    const peer = { kind: 'peer', target: TARGET, text: 'hello' } as DeliverIntent
    expect(plan(peer as KeyIntent, screen('prompt-empty'), IDLE)).toEqual(CHANGED)
  })
})

describe('textRefusal', () => {
  it('refuses an empty text and a text of white space only', () => {
    for (const text of ['', ' ', '\n', ` \n ${ch(0xa0)}`]) expect(textRefusal(text)).toBe('empty')
  })

  it('refuses a text of only blank or invisible characters as empty', () => {
    const invisible = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x00ad, 0x2028, 0x2029, 0xfeff, 0x2060, 0x202e, 0x3000, 0xfe0f]
    for (const code of invisible) expect(textRefusal(ch(code)), `U+${code.toString(16)}`).toBe('empty')
    expect(textRefusal(ch(0x200b, 0x20, 0xad, 0xfeff, 0x0a, 0x2028))).toBe('empty')
  })

  it('refuses every control character but the newline: C0, DEL and C1', () => {
    for (const code of [0x00, 0x03, 0x07, 0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f]) {
      expect(textRefusal(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('control-char')
    }
  })

  it('refuses a backslash right before n, r or t in either case, which cmux can type as Enter or Tab', () => {
    for (const text of ['a\\nb', 'a\\rb', 'a\\tb', 'C:\\new', 'a\\\\nb', '\\t', 'a\\Nb', 'a\\Rb', 'a\\Tb', 'C:\\Temp']) expect(textRefusal(text), text).toBe('backslash-escape')
  })

  it('refuses a line that ends with a backslash, which Claude Code reads as a new line in place of Enter', () => {
    for (const text of ['ends with \\', 'ends with \\  ', `ends with \\${ch(0xa0)}`, 'first\\\nsecond', 'first\\  \nsecond', '\\']) {
      expect(textRefusal(text), JSON.stringify(text)).toBe('backslash-escape')
    }
  })

  it('refuses a line or paragraph separator in a text with a visible character, which cmux can type as a line break', () => {
    for (const code of [0x2028, 0x2029]) {
      expect(textRefusal(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('control-char')
      expect(textRefusal(`line one${ch(code)}`), `U+${code.toString(16)}`).toBe('control-char')
    }
  })

  it('passes a newline, a visible text with an invisible character in it, and a backslash before any other character', () => {
    for (const text of ['line one\nline two', 'a\\b', 'a\\x41', 'a\\u0041', 'a\\ b', `a${ch(0x200b)}b`]) expect(textRefusal(text), text).toBeUndefined()
  })
})
