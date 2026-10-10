/**
 * The check before each next step of a prompt (nextStepRefusal), and the text that the steps before it typed
 * (typedBy). A dialog can open between 2 steps, so each next step needs a fresh screen read of 1 s or less, facts read
 * just before it, a session that is still idle with no wait, no dialog, and a box that holds the text typed so far.
 * The screens are synthetic, and the plan time and the screen time are values, so no test reads a clock.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { OpenQuestion, ScreenRead } from '../types.js'
import { FACTS_MAX_LAG_MS, SCREEN_MAX_AGE_MS, nextStepRefusal, typedBy, type KeyIntent, type TargetFacts } from './deliver-plan.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
const fixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')
/** a text from code points, so no invisible character hides in this file */
const ch = (...codes: number[]): string => String.fromCodePoint(...codes)

/** the time of every check: 2026-10-09 12:00 UTC */
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const TARGET = { sessionId: 'session-color', name: 'color-picker' }
const WS = 'workspace:2'
const SURFACE = 'surface:3'

/** The state of a test: TargetFacts whose read time defaults to 100 ms before the screen read. */
type State = Omit<TargetFacts, 'factsAt'> & { factsAt?: number }
/** The state of the target: idle with no open question, with the given fields over it. */
const facts = (over: Partial<State> = {}): State => ({ sessionId: TARGET.sessionId, status: 'idle', ...over })
const IDLE = facts()
const QUESTION: OpenQuestion = {
  toolUseId: 'toolu_color',
  questions: [{ header: 'Color', text: 'Which color should the button use?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] }],
}
const ASKS = facts({ status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: QUESTION } })
const ANSWER: KeyIntent = { kind: 'answer', target: TARGET, toolUseId: 'toolu_color', header: 'Color', question: 'Which color should the button use?', option: 1, label: 'Red' }
const prompt = (text: string): KeyIntent => ({ kind: 'prompt', target: TARGET, text })
const sendText = (text: string): string[] => ['cmux', 'send', '--workspace', WS, '--surface', SURFACE, '--', text]
const sendKey = (key: string): string[] => ['cmux', 'send-key', '--workspace', WS, '--surface', SURFACE, '--', key]

describe('nextStepRefusal: the check before each next step of a prompt', () => {
  const RULE = '─'.repeat(72)
  const box = (rows: readonly string[]): string => ['❯ run the unit tests', '', RULE, `❯${ch(0xa0)}${rows[0] ?? ''}`, ...rows.slice(1).map((row) => `  ${row}`), RULE, '  ? for shortcuts'].join('\n')
  const PROMPT = prompt('Run the tests.\nThen run test 2 again.')
  const read = (text: string, over: Partial<ScreenRead> = {}): ScreenRead => ({ sessionId: TARGET.sessionId, workspaceRef: WS, surfaceRef: SURFACE, text, readAt: NOW - 200, ...over })
  const step = (text: string, state: State = IDLE, typed = 'Run the tests.\n', over: Partial<ScreenRead> = {}) => {
    const screenRead = read(text, over)
    return nextStepRefusal(PROMPT, screenRead, { ...state, factsAt: state.factsAt ?? screenRead.readAt - 100 }, typed, NOW)
  }

  it('takes an idle session whose box holds exactly the text typed so far, with no dialog', () => {
    expect(step(box(['Run the tests.', '']))).toBeUndefined()
  })

  it('stops for a dialog on the screen, a session that waits or runs, and a box that does not hold the typed text', () => {
    expect(step(fixture('permission'))).toBe('screen-changed')
    expect(step(box(['Run the tests.', '']), facts({ status: 'waiting', waitingFor: 'permission prompt' }))).toBe('screen-changed')
    expect(step(box(['Run the tests.', '']), facts({ status: 'busy' }))).toBe('screen-changed')
    expect(step(box(['Run the tests.', '']), facts({ sessionId: 'session-other' }))).toBe('screen-changed')
    expect(step(box(['Run the tests.']), IDLE, 'Run the tests.\nThen')).toBe('screen-changed')
    expect(step(box(['Run the tests.', '']), IDLE, 'Run the tests.\n', { sessionId: 'session-other' })).toBe('screen-changed')
  })

  it('stops for a screen read more than 1 s old, and for facts that lag the read or come after it', () => {
    expect(step(box(['Run the tests.', '']), IDLE, 'Run the tests.\n', { readAt: NOW - SCREEN_MAX_AGE_MS - 1 })).toBe('stale-screen')
    expect(step(box(['Run the tests.', '']), facts({ factsAt: NOW - 200 - FACTS_MAX_LAG_MS - 1 }))).toBe('stale-screen')
    expect(step(box(['Run the tests.', '']), facts({ factsAt: NOW - 100 }))).toBe('stale-screen')
  })

  it('gives no next step for an answer or a permission, which have 1 step', () => {
    expect(nextStepRefusal(ANSWER, read(fixture('question')), { ...ASKS, factsAt: NOW - 300 }, '', NOW)).toBe('screen-changed')
  })
})

describe('typedBy: the text that the steps typed into the box', () => {
  it('adds the text of each send and a line break for each shift+enter', () => {
    expect(typedBy([])).toBe('')
    expect(typedBy([sendText('first line'), sendKey('shift+enter')])).toBe('first line\n')
    expect(typedBy([sendText('a'), sendKey('shift+enter'), sendKey('shift+enter'), sendText('b')])).toBe('a\n\nb')
  })
})
