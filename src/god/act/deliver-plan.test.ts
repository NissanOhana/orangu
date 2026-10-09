/**
 * The deliver plan: an intent and a fresh screen give the cmux argv lists in order, or exactly 1 refusal. The
 * screens are the synthetic fixtures under test/fixtures/god/screens. The plan time and the screen time are
 * values, so no test reads a clock.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DeliverIntent, DeliverPlan, DeliverRefusal, ScreenRead } from '../types.js'
import { SCREEN_MAX_AGE_MS, planDelivery, textRefusal, type KeyIntent } from './deliver-plan.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
const fixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')

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

const ANSWER: KeyIntent = { kind: 'answer', target: TARGET, toolUseId: 'toolu_color', header: 'Color', question: 'Which color should the button use?', option: 1, label: 'Red' }
const TOUCH = JSON.stringify({ command: 'touch probe-yes.txt', description: 'Make an empty probe file' })
const permission = (choice: 'yes' | 'no'): KeyIntent => ({ kind: 'permission', target: TARGET, choice, tool: 'Bash', input: TOUCH })
const prompt = (text: string): KeyIntent => ({ kind: 'prompt', target: TARGET, text })

const sendText = (text: string): string[] => ['cmux', 'send', '--workspace', WS, '--surface', SURFACE, '--', text]
const sendKey = (key: string): string[] => ['cmux', 'send-key', '--workspace', WS, '--surface', SURFACE, '--', key]
const refused = (refusal: DeliverRefusal): DeliverPlan => ({ kind: 'refuse', refusal })

describe('planDelivery: the keys it sends', () => {
  it('answers a question with the option digit alone, and no Enter', () => {
    expect(planDelivery(ANSWER, screen('question'), NOW)).toEqual({ kind: 'send', steps: [sendKey('1')] })
    expect(planDelivery({ ...ANSWER, option: 3, label: 'Blue' }, screen('question'), NOW)).toEqual({ kind: 'send', steps: [sendKey('3')] })
  })

  it('answers a permission with the digit of Yes or No on the screen, and follows No when it moves', () => {
    expect(planDelivery(permission('yes'), screen('permission'), NOW)).toEqual({ kind: 'send', steps: [sendKey('1')] })
    expect(planDelivery(permission('no'), screen('permission'), NOW)).toEqual({ kind: 'send', steps: [sendKey('4')] })
    expect(planDelivery(permission('no'), screen('permission-older'), NOW)).toEqual({ kind: 'send', steps: [sendKey('3')] })
  })

  it('sends a 2-line prompt as exactly send, shift+enter, send, enter', () => {
    expect(planDelivery(prompt('first line\nsecond line'), screen('prompt-empty'), NOW)).toEqual({
      kind: 'send',
      steps: [sendText('first line'), sendKey('shift+enter'), sendText('second line'), sendKey('enter')],
    })
  })

  it('sends a 1-line prompt as send then enter, and sends no empty text for an empty line', () => {
    expect(planDelivery(prompt('run the tests'), screen('prompt-empty'), NOW)).toEqual({ kind: 'send', steps: [sendText('run the tests'), sendKey('enter')] })
    expect(planDelivery(prompt('a\n\nb'), screen('prompt-empty'), NOW)).toEqual({
      kind: 'send',
      steps: [sendText('a'), sendKey('shift+enter'), sendKey('shift+enter'), sendText('b'), sendKey('enter')],
    })
  })

  it('puts a text that looks like a flag after --, never as a flag', () => {
    const plan = planDelivery(prompt('--surface x'), screen('prompt-empty'), NOW)
    expect(plan).toEqual({ kind: 'send', steps: [sendText('--surface x'), sendKey('enter')] })
    const [first] = plan.kind === 'send' ? plan.steps : []
    expect(first?.indexOf('--')).toBe(6)
    expect(first?.indexOf('--surface x')).toBe(7)
    expect(first?.filter((arg) => arg === '--surface')).toHaveLength(1)
  })

  it('names the workspace and the surface, and puts -- right before the text or the key, in every argv', () => {
    const plans = [
      planDelivery(ANSWER, screen('question'), NOW),
      planDelivery(permission('no'), screen('permission'), NOW),
      planDelivery(prompt('--workspace w\n-- \n- \u00a0-'), screen('prompt-empty'), NOW),
    ]
    const steps = plans.flatMap((plan) => (plan.kind === 'send' ? plan.steps : []))
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
      expect(planDelivery(prompt(text), screen('prompt-empty'), NOW)).toEqual({ kind: 'send', steps: [sendText(text), sendKey('enter')] })
    }
  })
})

describe('planDelivery: each refusal from 1 screen fixture', () => {
  const cases: [DeliverRefusal, KeyIntent, ScreenRead][] = [
    ['stale-screen', ANSWER, screen('question', { readAt: NOW - SCREEN_MAX_AGE_MS - 1 })],
    ['screen-changed', { ...ANSWER, option: 2 }, screen('question-changed')],
    ['label-not-found', permission('yes'), screen('permission-amend')],
    ['multi-question', ANSWER, screen('question-two')],
    ['empty', prompt(''), screen('prompt-empty')],
    ['control-char', prompt('stop\u001b[2J'), screen('prompt-empty')],
    ['backslash-escape', prompt('one\\ntwo'), screen('prompt-empty')],
    ['no-tab', ANSWER, screen('question', { surfaceRef: '--surface' })],
  ]
  it.each(cases)('%s', (refusal, intent, read) => {
    expect(planDelivery(intent, read, NOW)).toEqual(refused(refusal))
  })
})

describe('planDelivery: the screen read', () => {
  it('takes a read of exactly 1 s, and refuses an older one and one from after the plan', () => {
    expect(planDelivery(ANSWER, screen('question', { readAt: NOW - SCREEN_MAX_AGE_MS }), NOW).kind).toBe('send')
    expect(planDelivery(ANSWER, screen('question', { readAt: NOW + 1 }), NOW)).toEqual(refused('stale-screen'))
    expect(planDelivery(ANSWER, screen('question', { readAt: Number.NaN }), NOW)).toEqual(refused('stale-screen'))
  })

  it('refuses a read of another session', () => {
    expect(planDelivery(ANSWER, screen('question', { sessionId: 'session-other' }), NOW)).toEqual(refused('screen-changed'))
  })

  it('refuses a workspace or surface ref that is empty, starts with a dash or holds a space', () => {
    for (const ref of ['', '-w', 'workspace 2', 'workspace:2\n']) {
      expect(planDelivery(ANSWER, screen('question', { workspaceRef: ref }), NOW)).toEqual(refused('no-tab'))
      expect(planDelivery(ANSWER, screen('question', { surfaceRef: ref }), NOW)).toEqual(refused('no-tab'))
    }
  })

  it('sends no key into a dialog for a prompt, and no digit into a prompt or the wrong dialog', () => {
    expect(planDelivery(prompt('1'), screen('question'), NOW)).toEqual(refused('screen-changed'))
    expect(planDelivery(prompt('yes'), screen('permission'), NOW)).toEqual(refused('screen-changed'))
    expect(planDelivery(ANSWER, screen('prompt-empty'), NOW)).toEqual(refused('screen-changed'))
    expect(planDelivery(permission('yes'), screen('question'), NOW)).toEqual(refused('screen-changed'))
    expect(planDelivery(ANSWER, screen('two-dialogs'), NOW)).toEqual(refused('screen-changed'))
  })

  it('refuses a peer message: it has no keys and goes through the engine', () => {
    const peer = { kind: 'peer', target: TARGET, text: 'hello' } as DeliverIntent
    expect(planDelivery(peer as KeyIntent, screen('prompt-empty'), NOW)).toEqual(refused('screen-changed'))
  })
})

describe('textRefusal', () => {
  it('refuses an empty text and a text of white space only', () => {
    for (const text of ['', ' ', '\n', ' \n \u00a0']) expect(textRefusal(text)).toBe('empty')
  })

  it('refuses every control character but the newline: C0, DEL and C1', () => {
    for (const code of [0x00, 0x03, 0x07, 0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f]) {
      expect(textRefusal(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)}`).toBe('control-char')
    }
  })

  it('refuses a backslash right before n, r or t, which cmux types as Enter or Tab', () => {
    for (const text of ['a\\nb', 'a\\rb', 'a\\tb', 'C:\\new', 'a\\\\nb', '\\t']) expect(textRefusal(text)).toBe('backslash-escape')
  })

  it('passes a newline, a tab-free text, and a backslash before any other character', () => {
    for (const text of ['line one\nline two', 'a\\b', 'a\\N', 'a\\x41', 'a\\u0041', 'ends with \\']) expect(textRefusal(text)).toBeUndefined()
  })
})
