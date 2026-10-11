/**
 * The executor on a Bash dialog of Claude Code 2.1.296 whose command wraps, over the fake machine of
 * test/fixtures/god/deliver-machine.ts with the real text cleaner of the home folder. The plan binds the answer to the
 * only open call of the fresh transcript read, measures the command box on the raw text of the same screen read, and
 * compares the raw lines with the raw command of that call. Only the digit leaves the match: no outcome holds the raw
 * text. Every screen and every command is synthetic.
 */
import { describe, expect, it } from 'vitest'
import { HOME, T0, TARGET, askPermission, keyRuns, machine, promptLine, request, sendText } from '../../../test/fixtures/god/deliver-machine.js'
import { cleanValue, textCleaner } from '../sanitize.js'
import type { KeyIntent } from './deliver-plan.js'
import { deliver } from './deliver.js'

const W = 99
const GUTTER = ' │ '
const DESCRIPTION = 'Make an empty probe file'
const clean = textCleaner(HOME)
/** a command of 118 characters with the home folder whole on row 1 of its wrap */
const COMMAND = `touch ${HOME}/${'word-'.repeat(18)}/yes.txt`

/** The gutter rows of 1 command line that wraps at the box width. */
const wrapped = (line: string): string[] => [0, W - GUTTER.length].map((at) => `${GUTTER}${line.slice(at, at + W - GUTTER.length)}`)

/** The screen of a 2.1.296 Bash dialog with the rows of `box` between the 2 dashed rules. */
function boxScreen(box: readonly string[]): string {
  return ['❯ Make the file.', '', '─'.repeat(W), ' Bash command', ` ${DESCRIPTION}`, '╌'.repeat(W), ...box, '╌'.repeat(W), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
}

/** The transcript of a session that asks to run each command, all in 1 reply, with no result yet. */
function asksToRun(...commands: string[]): string[] {
  const content = commands.map((command, k) => ({ type: 'tool_use', id: `toolu_run${k}`, name: 'Bash', input: { command, description: DESCRIPTION } }))
  return [promptLine('Make the file.', T0 - 90_000), JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 60_000).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content } })]
}

/** Yes to the Bash request of `command`, with the input as the transcript source gives it: each value cleaned. */
const yes = (command: string): KeyIntent => ({ kind: 'permission', target: TARGET, choice: 'yes', tool: 'Bash', input: JSON.stringify(cleanValue({ command, description: DESCRIPTION }, clean)) })

/** 1 y on the screen of the rows `box`, for `intent`, with the given calls open in the transcript. */
async function deliverOn(box: readonly string[], intent: KeyIntent, lines: string[]) {
  const fake = machine(askPermission({ screen: boxScreen(box), lines }), { clean })
  return { fake, result: await deliver(fake.ports, request(intent)) }
}

describe('deliver: a Bash dialog whose wrapped command holds the home folder', () => {
  it('sends the digit 1 alone, because the box is measured on the raw rows and compared with the raw command', async () => {
    expect([...(wrapped(COMMAND)[0] ?? '')].length).toBe(W)
    const { fake, result } = await deliverOn(wrapped(COMMAND), yes(COMMAND), asksToRun(COMMAND))
    expect(result.outcome).toMatchObject({ status: 'sent' })
    expect(keyRuns(fake.runs)).toEqual([sendText('1')])
  })

  it('refuses a dialog for another command, and the outcome holds the cleaned screen, never the raw text', async () => {
    const { fake, result } = await deliverOn(wrapped(COMMAND.replace('yes.txt', 'no.txt')), yes(COMMAND), asksToRun(COMMAND))
    expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
    expect(JSON.stringify(result)).toContain('touch ~/word-')
    expect(JSON.stringify(result)).not.toContain(HOME)
  })
})

describe('deliver: the answer binds to the only open call', () => {
  it('refuses 2 calls in 1 reply, even when the screen shows the confirmed command', async () => {
    const { fake, result } = await deliverOn(wrapped(COMMAND), yes(COMMAND), asksToRun(COMMAND, 'rm -rf build'))
    expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('never takes the dialog of a command whose lines start with │ for the shorter command that its rows look like', async () => {
    const crafted = `│ ${'x'.repeat(W - 3)}\n│ yy`
    const shorter = `${'x'.repeat(W - 3)}yy`
    const drawn = [` │ ${'x'.repeat(W - 3)}`, ' │ yy']
    for (const [intent, lines] of [
      [yes(shorter), asksToRun(crafted, shorter)],
      [yes(shorter), asksToRun(crafted)],
      [yes(crafted), asksToRun(crafted)],
    ] as const) {
      const { fake, result } = await deliverOn(drawn, intent, lines)
      expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
      expect(keyRuns(fake.runs)).toEqual([])
    }
  })

  it('refuses a raw key on the screen that differs from the key of the call, though both clean to the same text', async () => {
    const key = (c: string): string => `export ANTHROPIC_API_KEY=sk-ant-api03-${c.repeat(24)} && touch ${HOME}/${'word-'.repeat(12)}`
    expect(clean(key('A'))).toBe(clean(key('B')))
    const { fake, result } = await deliverOn(wrapped(key('B')), yes(key('A')), asksToRun(key('A')))
    expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
    expect(JSON.stringify(result)).not.toContain('A'.repeat(24))
    expect(JSON.stringify(result)).not.toContain('B'.repeat(24))
  })
})
