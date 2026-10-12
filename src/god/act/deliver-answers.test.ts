/**
 * The key path of an answers intent: 1 digit for each question of a dialog with 2 or more single-select questions, and
 * then `1` on the review screen, each as its own step. Before each step the executor reads the registry file, the
 * transcript tail and the screen again, binds to the same open question id, and checks the screen of that step
 * (src/god/model/question-dialog.ts). Any other screen or state stops it, and no later key goes out. A stop after 1 or
 * more digits says that the dialog stays open with some picks in it. The fake machine is
 * test/fixtures/god/deliver-machine.ts, and the screens are test/fixtures/god/multi-dialog.ts.
 */
import { describe, expect, it } from 'vitest'
import { REGISTRY, T0, TARGET, keyRuns, machine, promptLine, request, screenFixture, sendText, type Target } from '../../../test/fixtures/god/deliver-machine.js'
import { COLOUR_SIZE, GREEN_SMALL, askLine, questionScreen, reviewScreen } from '../../../test/fixtures/god/multi-dialog.js'
import type { OpenQuestion, ScreenRead } from '../types.js'
import { deliver } from './deliver.js'
import { nextAnswerRefusal, planDelivery, type KeyIntent, type TargetFacts } from './deliver-plan.js'

const ANSWERS: KeyIntent = { kind: 'answers', target: TARGET, toolUseId: 'toolu_multi', answers: GREEN_SMALL }
const Q1 = questionScreen(COLOUR_SIZE, 0)
const Q2 = questionScreen(COLOUR_SIZE, 1)
const REVIEW = reviewScreen(COLOUR_SIZE, ['Green', 'Small'])
const DONE = screenFixture('prompt-empty')
/** The screen that the dialog shows after the digits typed so far: question 1, question 2, the review, then the prompt. */
const flow = (typed: string): string => (typed === '' ? Q1 : typed === '2' ? Q2 : typed === '21' ? REVIEW : DONE)
const askLines = [promptLine('Pick the test colour and size.', T0 - 90_000), askLine('toolu_multi', COLOUR_SIZE, T0 - 60_000)]
const multi = (over: Partial<Target> = {}): Target => ({ status: 'waiting', waitingFor: 'input needed', lines: askLines, screen: flow, ...over })
const SENT = [sendText('2'), sendText('1'), sendText('1')]

describe('deliver: an answers intent', () => {
  it('sends the digit of each question and then 1 on the review screen, each after a fresh read of the registry, the transcript and the screen', async () => {
    const fake = machine(multi())
    const result = await deliver(fake.ports, request(ANSWERS))
    expect(result.outcome).toMatchObject({ status: 'sent' })
    expect(result.check?.expect).toEqual({ kind: 'question', toolUseId: 'toolu_multi' })
    expect(keyRuns(fake.runs)).toEqual(SENT)
    const sends = fake.log.flatMap((line, index) => (line.startsWith('run cmux send ') ? [index] : []))
    expect(sends).toHaveLength(3)
    for (const [step, at] of sends.entries()) {
      const before = fake.log.slice(step === 0 ? 0 : sends[step - 1]! + 1, at)
      const order = [before.indexOf(`read ${REGISTRY}`), before.findIndex((line) => line.startsWith('run tail ')), before.findIndex((line) => line.startsWith('run cmux read-screen '))]
      expect(order.every((index) => index >= 0), `step ${step}: ${before.join(' | ')}`).toBe(true)
      expect([...order].sort((a, b) => a - b), `step ${step}`).toEqual(order)
    }
  })

  it('refuses before any key when the first screen is not question 1', async () => {
    for (const screen of [Q2, REVIEW, DONE, screenFixture('question')]) {
      const fake = machine(multi({ screen }))
      expect((await deliver(fake.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed', screen: { text: screen } })
      expect(keyRuns(fake.runs)).toEqual([])
    }
  })

  it('stops after the first digit when the next screen is not question 2, and keeps that screen', async () => {
    for (const next of [Q1, REVIEW, screenFixture('permission'), questionScreen(COLOUR_SIZE, 1, { cursor: 3 })]) {
      const fake = machine(multi({ screen: (typed) => (typed === '' ? Q1 : next) }))
      const { outcome } = await deliver(fake.ports, request(ANSWERS))
      expect(outcome).toMatchObject({ status: 'failed', reason: 'partial', screen: { text: next } })
      expect(keyRuns(fake.runs)).toEqual([sendText('2')])
    }
  })

  it('stops before the submit when the review screen shows another label or another order', async () => {
    for (const review of [reviewScreen(COLOUR_SIZE, ['Green', 'Large']), reviewScreen([COLOUR_SIZE[1]!, COLOUR_SIZE[0]!], ['Small', 'Green'])]) {
      const fake = machine(multi({ screen: (typed) => (typed === '21' ? review : flow(typed)) }))
      expect((await deliver(fake.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'partial' })
      expect(keyRuns(fake.runs)).toEqual([sendText('2'), sendText('1')])
    }
  })

  it('stops when the open question of the transcript has another id after a digit, even with the same questions', async () => {
    const reopen = (keys: number, target: Target): void => {
      if (keys === 1) target.lines = [...askLines, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_multi', content: 'x' }] } }), askLine('toolu_again', COLOUR_SIZE, T0)]
    }
    const fake = machine(multi(), { onKey: reopen })
    expect((await deliver(fake.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'partial' })
    expect(keyRuns(fake.runs)).toEqual([sendText('2')])
  })

  it('stops when the registry says that the session no longer waits for input, or when a read between 2 steps is too old', async () => {
    const idle = machine(multi(), { onKey: (keys, target) => void (keys === 2 ? Object.assign(target, { status: 'busy', waitingFor: undefined }) : undefined) })
    expect((await deliver(idle.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'partial' })
    expect(keyRuns(idle.runs)).toEqual([sendText('2'), sendText('1')])
    let reads = 0
    const slow = machine(multi(), { onRun: (argv, clock) => void (argv[1] === 'read-screen' && ++reads === 2 ? (clock.t += 1500) : undefined) })
    expect((await deliver(slow.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'partial' })
    expect(keyRuns(slow.runs)).toEqual([sendText('2')])
  })

  it('stops after c, and after a cmux send that failed, with the partial line once a digit went out', async () => {
    const fake = machine(multi(), { onKey: (keys) => void (keys === 1 ? (fake.cancel.isCancelled = true) : undefined) })
    expect((await deliver(fake.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'partial' })
    expect(keyRuns(fake.runs)).toEqual([sendText('2')])
    let sends = 0
    const broken = machine(multi(), {
      onRun: (argv) => {
        if (argv[1] === 'send' && ++sends === 2) throw new Error('cmux did not answer')
      },
    })
    expect((await deliver(broken.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'partial' })
    const first = machine(multi(), { failing: ['send'] })
    expect((await deliver(first.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'failed', reason: 'step-failed' })
    expect(keyRuns(first.runs)).toEqual([sendText('2')])
  })
})

/** the time of every plan */
const NOW = T0
const OPEN: OpenQuestion = { toolUseId: 'toolu_multi', questions: COLOUR_SIZE }
const read = (text: string, over: Partial<ScreenRead> = {}): ScreenRead => ({ sessionId: TARGET.sessionId, workspaceRef: 'workspace:2', surfaceRef: 'surface:3', text, readAt: NOW - 200, ...over })
const facts = (over: Partial<TargetFacts> = {}, open: OpenQuestion | null = OPEN): TargetFacts => ({
  sessionId: TARGET.sessionId,
  status: 'waiting',
  waitingFor: 'input needed',
  ...(open === null ? {} : { transcript: { openQuestion: open } }),
  factsAt: NOW - 400,
  ...over,
})
const send = (digit: string): string[] => ['cmux', 'send', '--workspace', 'workspace:2', '--surface', 'surface:3', '--', digit]

describe('planDelivery and nextAnswerRefusal: an answers intent', () => {
  it('plans 1 send of each confirmed digit and then 1, when the screen shows question 1', () => {
    expect(planDelivery(ANSWERS, read(Q1), facts(), NOW)).toEqual({ kind: 'send', steps: [send('2'), send('1'), send('1')] })
  })

  it('refuses a state that does not take the answers', () => {
    const answers = (over: Partial<(typeof GREEN_SMALL)[number]>, k = 0): KeyIntent => ({ ...ANSWERS, answers: GREEN_SMALL.map((answer, index) => (index === k ? { ...answer, ...over } : answer)) }) as KeyIntent
    const cases: Array<[KeyIntent, TargetFacts, string]> = [
      [ANSWERS, facts({ status: 'idle', waitingFor: undefined }), 'screen-changed'],
      [ANSWERS, facts({ waitingFor: 'permission prompt' }), 'screen-changed'],
      [ANSWERS, facts({}, null), 'screen-changed'],
      [ANSWERS, facts({}, { ...OPEN, toolUseId: 'toolu_other' }), 'screen-changed'],
      [ANSWERS, facts({}, { ...OPEN, questions: [...COLOUR_SIZE, COLOUR_SIZE[1]!] }), 'screen-changed'],
      [ANSWERS, facts({}, { ...OPEN, questions: [COLOUR_SIZE[0]!, { ...COLOUR_SIZE[1]!, multiSelect: true }] }), 'multi-question'],
      [answers({ label: 'Red' }), facts(), 'screen-changed'],
      [answers({ option: 3 }), facts(), 'screen-changed'],
      [answers({ header: 'Color' }), facts(), 'screen-changed'],
      [answers({ question: 'Which size?' }, 1), facts(), 'screen-changed'],
      [ANSWERS, facts({ sessionId: 'another' }), 'screen-changed'],
    ]
    for (const [intent, state, refusal] of cases) expect(planDelivery(intent, read(Q1), state, NOW), JSON.stringify(state)).toEqual({ kind: 'refuse', refusal })
  })

  it('checks each next step on its own screen: question 2, then the review', () => {
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2), facts(), NOW)).toBeUndefined()
    expect(nextAnswerRefusal(ANSWERS, 2, read(REVIEW), facts(), NOW)).toBeUndefined()
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q1), facts(), NOW)).toBe('screen-changed')
    expect(nextAnswerRefusal(ANSWERS, 2, read(Q2), facts(), NOW)).toBe('screen-changed')
    expect(nextAnswerRefusal(ANSWERS, 3, read(REVIEW), facts(), NOW)).toBe('screen-changed')
  })

  it('refuses an old read, facts that lag, another tab form, another session and another intent between the steps', () => {
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2, { readAt: NOW - 1500 }), facts({ factsAt: NOW - 1600 }), NOW)).toBe('stale-screen')
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2), facts({ factsAt: NOW - 1500 }), NOW)).toBe('stale-screen')
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2), facts({ factsAt: NOW }), NOW)).toBe('stale-screen')
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2, { workspaceRef: '2' }), facts(), NOW)).toBe('no-tab')
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2, { sessionId: 'another' }), facts(), NOW)).toBe('screen-changed')
    expect(nextAnswerRefusal(ANSWERS, 1, read(Q2), facts({}, { ...OPEN, toolUseId: 'toolu_other' }), NOW)).toBe('screen-changed')
    expect(nextAnswerRefusal({ kind: 'prompt', target: TARGET, text: 'Go on.' }, 1, read(Q2), facts(), NOW)).toBe('screen-changed')
  })
})
