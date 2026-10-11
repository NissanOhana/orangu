/**
 * The pin of the 1 step of an answer and a permission: the host of the executor takes `cmux send` of any text, so the
 * executor itself sends only 1 `cmux send` of 1 digit 1 to 9 to the mapped tab. A plan of any other form is refused
 * before any key. planDelivery is wrapped, so a test can give the executor a plan of another form. The fake machine
 * is test/fixtures/god/deliver-machine.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { ANSWER, PERMISSION, SF, WS, askPermission, asks, keyRuns, machine, request, sendKey, sendText } from '../../../test/fixtures/god/deliver-machine.js'
import * as plans from './deliver-plan.js'
import { deliver } from './deliver.js'

vi.mock('./deliver-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deliver-plan.js')>()
  return { ...actual, planDelivery: vi.fn(actual.planDelivery) }
})

const planDelivery = vi.mocked(plans.planDelivery)

describe('deliver: the 1 step of an answer and a permission', () => {
  const forms: Array<[string, string[][]]> = [
    ['12', [sendText('12')]],
    ['a digit and a newline', [sendText('1\n')]],
    ['0', [sendText('0')]],
    ['a letter', [sendText('y')]],
    ['2 steps', [sendText('1'), sendText('2')]],
    ['no step', []],
    ['send-key of a digit', [sendKey('1')]],
    ['another tab', [['cmux', 'send', '--workspace', WS, '--surface', '00000000-0000-4000-8000-000000000000', '--', '1']]],
    ['no --', [['cmux', 'send', '--workspace', WS, '--surface', SF, '1']]],
  ]

  it.each(forms)('refuses a plan of %s, and sends nothing', async (_form, steps) => {
    for (const [target, intent] of [[asks(), ANSWER], [askPermission(), PERMISSION]] as const) {
      const fake = machine(target)
      planDelivery.mockReturnValueOnce({ kind: 'send', steps })
      expect((await deliver(fake.ports, request(intent))).outcome, intent.kind).toMatchObject({ status: 'refused', refusal: 'screen-changed' })
      expect(keyRuns(fake.runs), intent.kind).toEqual([])
    }
  })

  it('sends the plan of planDelivery: 1 send of the digit to the mapped tab', async () => {
    const answer = machine(asks())
    expect((await deliver(answer.ports, request(ANSWER))).outcome.status).toBe('sent')
    expect(keyRuns(answer.runs)).toEqual([sendText('1')])
    const permission = machine(askPermission())
    expect((await deliver(permission.ports, request(PERMISSION))).outcome.status).toBe('sent')
    expect(keyRuns(permission.runs)).toEqual([sendText('4')])
  })
})
