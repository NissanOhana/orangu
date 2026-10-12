/**
 * The pin of the steps of an answers intent: the host of the executor takes `cmux send` of any text, so the executor
 * itself sends only 1 `cmux send` of 1 digit 1 to 9 to the mapped tab for each question, and then 1 of `1`. A plan of
 * any other form is refused before any key. planDelivery is wrapped, so a test can give the executor a plan of another
 * form. The fake machine is test/fixtures/god/deliver-machine.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { SF, T0, TARGET, WS, keyRuns, machine, promptLine, request, sendKey, sendText } from '../../../test/fixtures/god/deliver-machine.js'
import { COLOUR_SIZE, GREEN_SMALL, askLine, questionScreen } from '../../../test/fixtures/god/multi-dialog.js'
import * as plans from './deliver-plan.js'
import { deliver } from './deliver.js'

vi.mock('./deliver-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deliver-plan.js')>()
  return { ...actual, planDelivery: vi.fn(actual.planDelivery) }
})

const planDelivery = vi.mocked(plans.planDelivery)
const ANSWERS: plans.KeyIntent = { kind: 'answers', target: TARGET, toolUseId: 'toolu_multi', answers: GREEN_SMALL }
const target = () => ({ status: 'waiting' as const, waitingFor: 'input needed', lines: [promptLine('Pick.', T0 - 90_000), askLine('toolu_multi', COLOUR_SIZE, T0 - 60_000)], screen: questionScreen(COLOUR_SIZE, 0) })

describe('deliver: the steps of an answers intent', () => {
  const forms: Array<[string, string[][]]> = [
    ['no submit', [sendText('2'), sendText('1')]],
    ['1 step more', [sendText('2'), sendText('1'), sendText('1'), sendText('1')]],
    ['a submit of 2', [sendText('2'), sendText('1'), sendText('2')]],
    ['12', [sendText('12'), sendText('1'), sendText('1')]],
    ['a letter', [sendText('2'), sendText('y'), sendText('1')]],
    ['send-key of a digit', [sendText('2'), sendKey('1'), sendText('1')]],
    ['another tab', [sendText('2'), ['cmux', 'send', '--workspace', WS, '--surface', '00000000-0000-4000-8000-000000000000', '--', '1'], sendText('1')]],
    ['no --', [sendText('2'), sendText('1'), ['cmux', 'send', '--workspace', WS, '--surface', SF, '1']]],
  ]

  it.each(forms)('refuses a plan of %s, and sends nothing', async (_form, steps) => {
    const fake = machine(target())
    planDelivery.mockReturnValueOnce({ kind: 'send', steps })
    expect((await deliver(fake.ports, request(ANSWERS))).outcome).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
    expect(keyRuns(fake.runs)).toEqual([])
  })
})
