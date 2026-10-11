/**
 * The confirm bar and the outcome lines of the key path. Nothing goes out until the person presses y, so the bar
 * names the session and what goes to it: the option with its digit and the question, the permission choice with
 * the tool and its whole input, or the whole prompt or peer message. The target and the question stay fixed, and a
 * long text scrolls with w and z in the row limit of the bar, so the person can read all of it before y. Each
 * refusal code has 1 line, and a code with 2 meanings has 1 line that names both. No line is wider than the pane.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INTENTS, NOW, OUTCOMES, QUESTION } from '../../../test/fixtures/god/detail.js'
import { planDelivery, type KeyIntent, type TargetFacts } from '../act/deliver-plan.js'
import type { DeliverIntent, DeliverRefusal, OpenQuestion, ScreenRead } from '../types.js'
import { cellWidth } from './cells.js'
import { CONFIRM_HINTS, FAILURE_TEXT, NOT_DELIVERED, PEER_NOT_DELIVERED, REFUSAL_TEXT, SEND_FAILED, SENDING, confirmView, outcomeLines, type ConfirmInput, type ConfirmView } from './confirm.js'
import { NOT_A_PROMPT } from '../copy.js'
import { MULTI_DIALOG } from './confirm.js'
import { scrollBy } from './detail.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const view = (intent: DeliverIntent, over: Partial<ConfirmInput> = {}): ConfirmView => confirmView({ intent, width: 110, rows: 20, scroll: 0, ...over })
const bar = (intent: DeliverIntent, over: Partial<ConfirmInput> = {}): string[] => view(intent, over).lines.map(text)
const squeeze = (value: string): string => value.replace(/\s+/g, '')
const COUNT = /^ ([wz]): \+(\d+) lines?$/

/** every refusal code of the contract: a code that the record misses fails the type check of REFUSAL_TEXT */
const CODES: readonly DeliverRefusal[] = ['no-cmux', 'no-tab', 'stale-screen', 'screen-changed', 'label-not-found', 'multi-question', 'empty', 'control-char', 'backslash-escape', 'task-running', 'not-a-prompt']

/** the line of each code, word for word as the pane shows it */
const LINES: Readonly<Record<DeliverRefusal, string>> = {
  'no-cmux': 'cmux is not on this machine, so the pane sent nothing.',
  'no-tab': 'The session has no cmux tab, so the pane sent nothing.',
  'stale-screen': 'The screen or the session facts are too old, so the pane sent nothing. Press y again.',
  'screen-changed': 'The screen or the session changed, so the pane sent nothing.',
  'label-not-found': 'The screen shows no option with the exact label Yes or No, so the pane sent nothing.',
  'multi-question': 'This dialog has more than 1 question or more than 1 choice. Press j to answer it in its tab.',
  empty: 'The text is empty, so the pane sent nothing.',
  'control-char': 'The text has a control character or a character that does not show, so the pane sent nothing. An emoji can hold such a character.',
  'backslash-escape': 'A line ends with a backslash, or holds \\n, \\r or \\t in any case, so the pane sent nothing.',
  'task-running': 'The session runs a background task or a subagent that can open a dialog, so the pane sent nothing.',
  'not-a-prompt': 'The pane does not type a shell command, the help or an exit. Press j and type it in its tab.',
}

/** A Bash input of 2,483 characters with runs of spaces in it, as a tool call can write it. */
function longInput(): string {
  const command = `${'printf "%s  %s"   one  two && '.repeat(70)}echo end`
  const length = JSON.stringify({ command, description: '' }).length
  return JSON.stringify({ command, description: `Run it ${'x'.repeat(2483 - length - 7)}` })
}

describe('the confirm bar', () => {
  it('names the option with its digit, the session, the keys, and then the question of an answer', () => {
    expect(bar(INTENTS.answer)).toEqual([' Send "2 All" to api-7?  y: send  c: cancel', ` ☐ Eval set  ${QUESTION}`])
    const first = view(INTENTS.answer).lines[0]!
    expect(first.segments[1]).toEqual({ text: 'Send "2 All" to api-7?', token: '--accent', bold: true })
    // the engine paints a plain hotkey Button as `y: send`, so each key is 1 press segment in that painted form
    expect(first.segments.filter((segment) => segment.press !== undefined)).toEqual([
      { text: 'y: send', press: { hotkey: 'y', label: 'send' } },
      { text: 'c: cancel', press: { hotkey: 'c', label: 'cancel' } },
    ])
  })

  it('keeps each key whole on its own line when the question fills the row', () => {
    const lines = view({ ...INTENTS.answer, label: 'A label that fills the row' } as DeliverIntent, { width: 36 }).lines
    const keys = lines.flatMap((line) => line.segments.filter((segment) => segment.press !== undefined))
    expect(keys.map((segment) => segment.text)).toEqual(['y: send', 'c: cancel'])
  })

  it('gives the y and c keys as hotkeys', () => {
    expect(view(INTENTS.answer).hints).toEqual(CONFIRM_HINTS)
    expect(CONFIRM_HINTS).toEqual([
      { keys: 'y', label: 'send', hotkey: 'y', isOff: false },
      { keys: 'c', label: 'cancel', hotkey: 'c', isOff: false },
    ])
  })

  it('names the permission choice and the tool, and shows the whole tool input', () => {
    expect(bar(INTENTS.permission)).toEqual([' Send "Yes" to the Bash request of ops-4?  y: send  c: cancel', ' Input', '   {"command":"npm test","description":"Run the tests"}'])
    expect(bar({ ...INTENTS.permission, choice: 'no' } as DeliverIntent)[0]).toBe(' Send "No" to the Bash request of ops-4?  y: send  c: cancel')
    const { input: _input, ...noInput } = INTENTS.permission as Extract<DeliverIntent, { kind: 'permission' }>
    expect(bar(noInput)).toEqual([' Send "Yes" to the Bash request of ops-4?  y: send  c: cancel', ' Input  none'])
  })

  it('keeps the runs of spaces of a tool input as written', () => {
    const input = '{"command":"echo  a   b    c"}'
    expect(bar({ ...INTENTS.permission, input } as DeliverIntent)).toContain(`   ${input}`)
  })

  it('shows the whole prompt and the whole peer message under the question', () => {
    expect(bar(INTENTS.prompt)).toEqual([' Send this prompt to api-7?  y: send  c: cancel', '   Run the eval tests again.', '   Then write the result in the notes.', '   Keep the notes short.'])
    expect(bar(INTENTS.peer)).toEqual([' Send this peer message to api-7?  y: send  c: cancel', '   Stop the deploy now.', '   I check the logs first.'])
  })

  it('names the command mode of a / prompt, and says before y that the pane does not type a shell command, the help or an exit', () => {
    const COMMAND = 'The first line starts with /, so the session runs it as a command.'
    const lines = view({ ...INTENTS.prompt, text: '/status\nThen stop.' } as DeliverIntent).lines
    expect(lines.map(text)).toEqual([' Send this prompt to api-7?  y: send  c: cancel', ` ${COMMAND}`, '   /status', '   Then stop.'])
    expect(lines[1]!.segments[1]).toEqual({ text: COMMAND, token: '--warn' })
    for (const prompt of ['!status', '?', ' !status', '\n\n?help', 'exit', '  :wq!']) expect(bar({ ...INTENTS.prompt, text: prompt } as DeliverIntent)[1], JSON.stringify(prompt)).toBe(` ${NOT_A_PROMPT}`)
    for (const prompt of ['status !', 'Then /stop', 'exit the loop']) expect(bar({ ...INTENTS.prompt, text: prompt } as DeliverIntent)).toHaveLength(2)
    // the mode comes from the first character that is not white space, on any line
    expect(bar({ ...INTENTS.prompt, text: '   \n/clear' } as DeliverIntent)[1]).toBe(` ${COMMAND}`)
    expect(bar({ ...INTENTS.peer, text: '/stop now' } as DeliverIntent)).toHaveLength(2)
    expect(bar({ ...INTENTS.peer, text: '!stop now' } as DeliverIntent)).toHaveLength(2)
  })

  it('names each text refusal of a prompt before y, and offers c only, because y can send nothing', () => {
    const texts: Readonly<Record<string, string>> = { empty: '\u200b', 'control-char': 'Ship it \u2764\ufe0f', 'backslash-escape': 'Open C:\\new', 'not-a-prompt': '/exit' }
    for (const [code, prompt] of Object.entries(texts)) {
      const shown = view({ ...INTENTS.prompt, text: prompt } as DeliverIntent, { width: 200 })
      expect(shown.lines.slice(0, 2).map(text), code).toEqual([' Send this prompt to api-7?  c: cancel', ` ${LINES[code as DeliverRefusal]}`])
      expect(shown.lines[1]!.segments[1], code).toEqual({ text: LINES[code as DeliverRefusal], token: '--warn' })
      expect(shown.lines.flatMap((line) => line.segments).flatMap((segment) => (segment.press === undefined ? [] : [segment.press.hotkey])), code).toEqual(['c'])
      expect(shown.hints, code).toEqual([CONFIRM_HINTS[1]])
    }
  })

  it('names the empty and control-char refusals of a peer message before y, offers c only, and keeps y for any other text', () => {
    const texts: Readonly<Record<string, string>> = { empty: '\u200b \n', 'control-char': 'Stop\u200bthe deploy.' }
    for (const hidden of ['\u202e', '\u{e0061}', '\u001b']) expect(view({ ...INTENTS.peer, text: `a${hidden}b` } as DeliverIntent).hints, JSON.stringify(hidden)).toEqual([CONFIRM_HINTS[1]])
    for (const [code, message] of Object.entries(texts)) {
      const shown = view({ ...INTENTS.peer, text: message } as DeliverIntent, { width: 200 })
      expect(shown.lines.slice(0, 2).map(text), code).toEqual([' Send this peer message to api-7?  c: cancel', ` ${LINES[code as DeliverRefusal]}`])
      expect(shown.hints, code).toEqual([CONFIRM_HINTS[1]])
    }
    for (const message of ['/exit', '!stop now', 'exit', 'Open C:\\new']) expect(view({ ...INTENTS.peer, text: message } as DeliverIntent).hints, message).toEqual(CONFIRM_HINTS)
  })

  it('shows no y and no c while the keys go out, and says so in their place', () => {
    const lines = view(INTENTS.answer, { isSending: true }).lines
    expect(lines.flatMap((line) => line.segments).some((segment) => segment.press !== undefined)).toBe(false)
    expect(lines.map(text)[0]).toBe(` Send "2 All" to api-7?  ${SENDING}`)
  })

  it('wraps a long label whole, and puts the keys after it', () => {
    const label = 'A very long option label that goes on and on past the edge'
    const lines = bar({ ...INTENTS.answer, label } as DeliverIntent, { width: 30 })
    for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(30)
    expect(squeeze(lines.join(''))).toContain(squeeze(`Send "2 ${label}" to api-7?`))
    expect(lines.join('\n')).toMatch(/y: send {2}c: cancel/)
  })
})

describe('the row limit of the confirm bar', () => {
  it('scrolls a 2,483-character Bash input at 60 columns with w and z, the target fixed, and every character readable before y', () => {
    const input = longInput()
    expect(input).toHaveLength(2483)
    const intent = { ...INTENTS.permission, input } as DeliverIntent
    /** each line of the input by its index: the last page can start before the end of the page above it */
    const pieces = new Map<number, string>()
    let scroll = 0
    let pages = 0
    for (;;) {
      const page = view(intent, { width: 60, rows: 12, scroll })
      pages += 1
      const lines = page.lines.map(text)
      expect(lines.length).toBeLessThanOrEqual(12)
      for (const line of lines) expect(cellWidth(line), line).toBeLessThanOrEqual(60)
      // at 60 columns the 2 painted keys do not fit after the question, so they take their own line
      expect(lines.slice(0, 3)).toEqual([' Send "Yes" to the Bash request of ops-4?', ' y: send  c: cancel', ' Input'])
      const body = lines.slice(3)
      if (scroll > 0) expect(body[0]).toMatch(/^ w: \+\d+ lines$/)
      body.filter((line) => !COUNT.test(line)).forEach((line, index) => pieces.set(page.window.first + index, line.slice(3)))
      if (page.window.first + page.window.shown >= page.window.total) break
      expect(body.at(-1)).toMatch(/^ z: \+\d+ lines$/)
      scroll = scrollBy(page.window, 'down')
    }
    expect(pages).toBeGreaterThan(3)
    expect([...pieces.keys()]).toEqual([...Array(pieces.size).keys()])
    expect([...pieces.values()].join('')).toBe(input)
  })

  it('scrolls a long prompt the same way, and the counts add up to the whole text', () => {
    const textOf = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of the prompt.`).join('\n')
    const page = view({ ...INTENTS.prompt, text: textOf } as DeliverIntent, { width: 60, rows: 10 })
    const lines = page.lines.map(text)
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe(' Send this prompt to api-7?  y: send  c: cancel')
    const hidden = Number(COUNT.exec(lines.at(-1)!)![2])
    expect(hidden + lines.length - 2).toBe(30)
  })

  it('keeps the target and the question of an answer whole, whatever the row limit', () => {
    expect(bar(INTENTS.answer, { width: 30, rows: 1 }).join('')).toContain('Which eval set')
    expect(squeeze(bar(INTENTS.answer, { width: 30, rows: 1 }).join(''))).toContain(squeeze(QUESTION))
  })

  it('takes its fixed lines and 3 more when the row limit is smaller, so the text never hides', () => {
    const lines = bar({ ...INTENTS.permission, input: longInput() } as DeliverIntent, { width: 60, rows: 2 })
    expect(lines).toHaveLength(3 + 3)
    expect(lines.at(-1)).toMatch(/^ z: \+\d+ lines$/)
  })
})

describe('the outcome lines', () => {
  it('has 1 line for each refusal code, in the active voice but for the 3 lines that say what to do', () => {
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual([...CODES].sort())
    expect(REFUSAL_TEXT).toEqual(LINES)
    const says = ['multi-question', 'stale-screen', 'not-a-prompt']
    for (const code of CODES.filter((code) => !says.includes(code))) expect(REFUSAL_TEXT[code], code).toMatch(/, so the pane sent nothing\./)
    expect(REFUSAL_TEXT['not-a-prompt']).toBe(NOT_A_PROMPT)
    expect(Object.values(REFUSAL_TEXT).join(' ')).not.toMatch(/was sent/)
    expect(REFUSAL_TEXT['multi-question']).toBe(MULTI_DIALOG)
  })

  it('draws an old read in the warn color, every other refusal in the bad color, and the not-delivered line in the warn color', () => {
    for (const code of CODES) {
      const token = code === 'stale-screen' ? '--warn' : '--bad'
      expect(outcomeLines({ ...OUTCOMES.refused, refusal: code } as never, 200), code).toEqual([{ segments: [{ text: ' ' }, { text: LINES[code], token }] }])
    }
    expect(NOT_DELIVERED).toBe('Not delivered. Check the Screen tab.')
    expect(outcomeLines(OUTCOMES['not-delivered'], 110)).toEqual([{ segments: [{ text: ' ' }, { text: NOT_DELIVERED, token: '--warn' }] }])
  })

  it('says what became of a sent, a delivered, a failed and an undelivered peer message', () => {
    expect(outcomeLines(OUTCOMES.sent, 110).map(text)).toEqual([' Sent to api-7. The next refresh checks it.'])
    expect(outcomeLines(OUTCOMES.delivered, 110).map(text)).toEqual([' Delivered to api-7.'])
    expect(outcomeLines(OUTCOMES.failed, 110).map(text)).toEqual([` ${SEND_FAILED}`])
    expect(outcomeLines({ ...OUTCOMES['not-delivered'], intent: INTENTS.peer }, 110).map(text)).toEqual([` ${PEER_NOT_DELIVERED}`])
  })

  it('says which part of a failed delivery failed, and the command line for any other reason', () => {
    expect(FAILURE_TEXT).toEqual({
      'facts-unread': 'The pane could not read the session again, so it sent nothing.',
      'screen-unread': 'cmux did not read the screen, so the pane sent nothing.',
      'step-failed': SEND_FAILED,
      stopped: 'The screen or the session changed while the pane typed, so it sent no more keys. Check the Screen tab.',
      cancelled: 'You pressed c, so the pane sent no more keys.',
    })
    for (const [reason, line] of Object.entries(FAILURE_TEXT)) expect(outcomeLines({ ...OUTCOMES.failed, reason } as never, 110).map(text)).toEqual([` ${line}`])
    expect(outcomeLines(OUTCOMES.failed, 110).map(text)).toEqual([` ${SEND_FAILED}`])
  })
})

describe('each meaning of a refusal code gives its 1 line', () => {
  const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
  const target = { sessionId: 'session-color', name: 'color-picker' }
  const read = (name: string, readAt = NOW - 200): ScreenRead => ({ sessionId: target.sessionId, workspaceRef: 'workspace:2', surfaceRef: 'surface:3', text: readFileSync(join(SCREENS, `${name}.txt`), 'utf8'), readAt })
  const color: OpenQuestion = {
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
  const answer: KeyIntent = { kind: 'answer', target, toolUseId: 'toolu_color', header: 'Color', question: 'Which color should the button use?', option: 1, label: 'Red' }
  const asks = (factsAt: number): TargetFacts => ({ sessionId: target.sessionId, status: 'waiting', waitingFor: 'input needed', transcript: { openQuestion: color }, factsAt })
  /** the line that the pane shows for the plan of an intent */
  const lineOf = (intent: KeyIntent, screen: ScreenRead, facts: TargetFacts): string => {
    const plan = planDelivery(intent, screen, facts, NOW)
    if (plan.kind !== 'refuse') throw new Error('the plan sent keys')
    return outcomeLines({ status: 'refused', intent, at: NOW, refusal: plan.refusal }, 110).map(text).join('')
  }

  it('says that the screen or the session changed for a changed question on the screen', () => {
    const screen = read('question-changed')
    expect(planDelivery(answer, screen, asks(screen.readAt - 100), NOW)).toEqual({ kind: 'refuse', refusal: 'screen-changed' })
    expect(lineOf(answer, screen, asks(screen.readAt - 100))).toBe(` ${LINES['screen-changed']}`)
  })

  it('says the same for r then y on a WORKING session, whose state does not take a prompt', () => {
    const screen = read('prompt-empty')
    const working: TargetFacts = { sessionId: target.sessionId, status: 'busy', factsAt: screen.readAt - 100 }
    const prompt: KeyIntent = { kind: 'prompt', target, text: 'Run the tests again.' }
    expect(planDelivery(prompt, screen, working, NOW)).toEqual({ kind: 'refuse', refusal: 'screen-changed' })
    expect(lineOf(prompt, screen, working)).toBe(` ${LINES['screen-changed']}`)
    expect(planDelivery(prompt, screen, { ...working, status: 'idle' }, NOW).kind).toBe('send')
  })

  it('says that the screen or the session facts are too old for an old screen read', () => {
    const screen = read('question', NOW - 2000)
    expect(lineOf(answer, screen, asks(screen.readAt - 100))).toBe(` ${LINES['stale-screen']}`)
  })

  it('says the same for session facts that lag the screen read', () => {
    const screen = read('question')
    expect(planDelivery(answer, screen, asks(screen.readAt - 100), NOW).kind).toBe('send')
    expect(lineOf(answer, screen, asks(screen.readAt - 2000))).toBe(` ${LINES['stale-screen']}`)
  })
})

describe('no line is wider than the pane', () => {
  it.each([30, 60, 89, 90, 110])('holds the bar of every intent and every outcome line to %i columns', (columns) => {
    const lines = [
      ...[...Object.values(INTENTS), { ...INTENTS.permission, input: longInput() } as DeliverIntent].flatMap((intent) => confirmView({ intent, width: columns, rows: 12, scroll: 0 }).lines),
      ...Object.values(OUTCOMES).flatMap((outcome) => outcomeLines(outcome, columns)),
      ...CODES.flatMap((refusal) => outcomeLines({ ...OUTCOMES.refused, refusal } as never, columns)),
    ]
    for (const line of lines) expect(cellWidth(text(line)), `${columns}: ${text(line)}`).toBeLessThanOrEqual(columns)
  })
})
