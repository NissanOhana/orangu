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
/** a full row of a wrap is 1 cell narrower than the rule, as the live check saw it: the gutter and 95 characters */
const FULL = W - 1
const CHUNK = FULL - GUTTER.length
const DESCRIPTION = 'Make an empty probe file'
const clean = textCleaner(HOME)
/** a command of 118 characters with the home folder whole on row 1 of its wrap */
const COMMAND = `touch ${HOME}/${'word-'.repeat(18)}/yes.txt`

/** The 2 gutter rows of 1 command line that wraps: the first is full. */
const wrapped = (line: string): string[] => [0, CHUNK].map((at) => `${GUTTER}${line.slice(at, at + CHUNK)}`)

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
const yes = (command: string, toolUseId = 'toolu_run0'): KeyIntent => ({ kind: 'permission', target: TARGET, choice: 'yes', toolUseId, tool: 'Bash', input: JSON.stringify(cleanValue({ command, description: DESCRIPTION }, clean)) })

/** 1 y on the screen of the rows `box`, for `intent`, with the given calls open in the transcript. */
async function deliverOn(box: readonly string[], intent: KeyIntent, lines: string[]) {
  const fake = machine(askPermission({ screen: boxScreen(box), lines }), { clean })
  return { fake, result: await deliver(fake.ports, request(intent)) }
}

describe('deliver: a Bash dialog whose wrapped command holds the home folder', () => {
  it('sends the digit 1 alone, because the box is measured on the raw rows and compared with the raw command', async () => {
    expect([...(wrapped(COMMAND)[0] ?? '')].length).toBe(FULL)
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
  it('refuses when the confirmed call closed and a new call opens whose input cleans to the same text', async () => {
    const curl = (n: string): string => `curl -H "Authorization: Bearer ghp_FAKE${n}${'a'.repeat(30)}" https://example.com/x`
    expect(clean(curl('1'))).toBe(clean(curl('2')))
    const at = new Date(T0 - 60_000).toISOString()
    const call = (id: string, command: string): string => JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: DESCRIPTION } }] } })
    const done = JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'done' }] } })
    const lines = [promptLine('Fetch the page.', T0 - 90_000), call('toolu_A', curl('1')), done, call('toolu_B', curl('2'))]
    const { fake, result } = await deliverOn([` ${curl('2')}`], yes(curl('1'), 'toolu_A'), lines)
    expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('refuses 2 calls in 1 reply, even when the screen shows the confirmed command', async () => {
    const { fake, result } = await deliverOn(wrapped(COMMAND), yes(COMMAND), asksToRun(COMMAND, 'rm -rf build'))
    expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
  })

  it('never takes the dialog of a command whose lines start with │ for the shorter command that its rows look like', async () => {
    const crafted = `│ ${'x'.repeat(CHUNK)}\n│ yy`
    const shorter = `${'x'.repeat(CHUNK)}yy`
    const drawn = [` │ ${'x'.repeat(CHUNK)}`, ' │ yy']
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

  it('refuses the same shapes on the dialog with no box: another raw key, and the home folder where the call wrote ~', async () => {
    const noBox = (command: string): string => ['❯ Make the file.', '', '─'.repeat(W), ' Bash command', '', ` ${DESCRIPTION}`, '', `   ${command}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
    const key = (c: string): string => `export ANTHROPIC_API_KEY=sk-ant-api03-${c.repeat(24)}`
    for (const [shown, asked] of [
      [key('B'), key('A')],
      [`ls ${HOME}/notes`, 'ls ~/notes'],
    ] as const) {
      expect(clean(shown)).toBe(clean(asked))
      const fake = machine(askPermission({ screen: noBox(shown), lines: asksToRun(asked) }), { clean })
      const result = await deliver(fake.ports, request(yes(asked)))
      expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
      expect(keyRuns(fake.runs)).toEqual([])
    }
    const same = machine(askPermission({ screen: noBox('ls ~/notes'), lines: asksToRun('ls ~/notes') }), { clean })
    expect((await deliver(same.ports, request(yes('ls ~/notes')))).outcome).toMatchObject({ status: 'sent' })
  })
})
