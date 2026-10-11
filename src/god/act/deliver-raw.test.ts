/**
 * The executor on a Bash dialog of Claude Code 2.1.296 whose command wraps, over the fake machine of
 * test/fixtures/god/deliver-machine.ts with the real text cleaner of the home folder. The plan measures the command box
 * on the raw text of the same screen read, joins each wrapped line, cleans it and compares it with the cleaned input.
 * Only the digit leaves the match: no outcome holds the raw text. Every screen and every command is synthetic.
 */
import { describe, expect, it } from 'vitest'
import { HOME, TARGET, askPermission, keyRuns, machine, request, sendText } from '../../../test/fixtures/god/deliver-machine.js'
import { cleanValue, textCleaner } from '../sanitize.js'
import type { KeyIntent } from './deliver-plan.js'
import { deliver } from './deliver.js'

const W = 99
const GUTTER = ' │ '
const DESCRIPTION = 'Make an empty probe file'
const clean = textCleaner(HOME)
/** a command of 118 characters with the home folder whole on row 1 of its wrap */
const COMMAND = `touch ${HOME}/${'word-'.repeat(18)}/yes.txt`

/** The screen of a 2.1.296 Bash dialog for `command`, wrapped at the box width with the gutter. */
function boxScreen(command: string): string {
  const rows = [0, W - GUTTER.length].map((at) => `${GUTTER}${command.slice(at, at + W - GUTTER.length)}`)
  return ['❯ Make the file.', '', '─'.repeat(W), ' Bash command', ` ${DESCRIPTION}`, '╌'.repeat(W), ...rows, '╌'.repeat(W), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
}

/** Yes to the Bash request of `command`, with the input as the transcript source gives it: each value cleaned. */
const yes = (command: string): KeyIntent => ({ kind: 'permission', target: TARGET, choice: 'yes', tool: 'Bash', input: JSON.stringify(cleanValue({ command, description: DESCRIPTION }, clean)) })

describe('deliver: a Bash dialog whose wrapped command holds the home folder', () => {
  it('sends the digit 1 alone, because the box is measured on the raw rows of the same read', async () => {
    expect([...boxScreen(COMMAND).split('\n')[6]!].length).toBe(W)
    const fake = machine(askPermission({ screen: boxScreen(COMMAND) }), { clean })
    const result = await deliver(fake.ports, request(yes(COMMAND)))
    expect(result.outcome).toMatchObject({ status: 'sent' })
    expect(keyRuns(fake.runs)).toEqual([sendText('1')])
  })

  it('refuses a dialog for another command, and the outcome holds the cleaned screen, never the raw text', async () => {
    const fake = machine(askPermission({ screen: boxScreen(COMMAND.replace('yes.txt', 'no.txt')) }), { clean })
    const result = await deliver(fake.ports, request(yes(COMMAND)))
    expect(result.outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
    expect(JSON.stringify(result)).toContain('touch ~/word-')
    expect(JSON.stringify(result)).not.toContain(HOME)
  })
})
