/**
 * The check after a send: the refreshes after the keys went out say whether they reached the session. An answer is
 * in when its question closed, a permission when its call has no open request, a prompt when the transcript shows it
 * as a human prompt of the person. Only a refresh that started after the send counts, and the check says not
 * delivered after CHECK_REFRESHES such refreshes that did not show it.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, NOW, SECOND, facts, transcript, waiting, idle } from '../../../test/fixtures/god/sessions.js'
import type { Facts, SessionFacts } from '../types.js'
import { CHECK_REFRESHES, checkDelivery, type DeliverCheck } from './deliver-check.js'

const SENT_AT = NOW
const QUESTION = { toolUseId: 'tu-ask', questions: [{ text: 'Which set?', header: 'Set', multiSelect: false, options: [{ label: 'Small' }] }] }
const asking = (): SessionFacts => waiting('s-wait', { transcript: transcript({ openQuestion: QUESTION }) })
const answered = (): SessionFacts => idle('s-wait', { transcript: transcript() })

/** The facts of 1 refresh that ended at `at` and took `tookMs` in all. */
function refresh(sessions: readonly SessionFacts[], at: number, tookMs = 400): Facts {
  const base = facts(sessions)
  return { ...base, stats: { ...base.stats, at, computeMs: 20, waitMs: tookMs - 20 } }
}

const check = (expect: DeliverCheck['expect'], over: Partial<DeliverCheck> = {}): DeliverCheck => ({ sessionId: 's-wait', expect, sentAt: SENT_AT, misses: 0, ...over })
const QUESTION_CHECK = check({ kind: 'question', toolUseId: 'tu-ask' })

describe('checkDelivery', () => {
  it('says delivered once a refresh after the send shows the question closed', () => {
    expect(checkDelivery(QUESTION_CHECK, refresh([answered()], SENT_AT + 2 * SECOND))).toEqual({ status: 'delivered' })
  })

  it('says not delivered after 2 refreshes that started after the send and still show the question', () => {
    expect(CHECK_REFRESHES).toBe(2)
    const first = checkDelivery(QUESTION_CHECK, refresh([asking()], SENT_AT + 2 * SECOND))
    expect(first).toEqual({ status: 'waiting', check: { ...QUESTION_CHECK, misses: 1, lastAt: SENT_AT + 2 * SECOND } })
    if (first.status !== 'waiting') return
    expect(checkDelivery(first.check, refresh([asking()], SENT_AT + 4 * SECOND))).toEqual({ status: 'not-delivered' })
  })

  it('counts no refresh that ended before the send, that started before it, or that a dropped tick gave again', () => {
    const before = refresh([asking()], SENT_AT - SECOND)
    expect(checkDelivery(QUESTION_CHECK, before)).toEqual({ status: 'waiting', check: QUESTION_CHECK })
    // ended after the send, but it started 400 ms before it: it can have read the transcript before the keys
    expect(checkDelivery(QUESTION_CHECK, refresh([asking()], SENT_AT + 300))).toEqual({ status: 'waiting', check: QUESTION_CHECK })
    const counted = check(QUESTION_CHECK.expect, { misses: 1, lastAt: SENT_AT + 2 * SECOND })
    expect(checkDelivery(counted, refresh([asking()], SENT_AT + 2 * SECOND))).toEqual({ status: 'waiting', check: counted })
    expect(checkDelivery(QUESTION_CHECK, undefined)).toEqual({ status: 'waiting', check: QUESTION_CHECK })
  })

  it('takes a refresh that started before the send when it already shows the answer', () => {
    expect(checkDelivery(QUESTION_CHECK, refresh([answered()], SENT_AT + 300))).toEqual({ status: 'delivered' })
  })

  it('counts a miss when the session left the board or has no transcript facts', () => {
    expect(checkDelivery(QUESTION_CHECK, refresh([], SENT_AT + 2 * SECOND))).toMatchObject({ status: 'waiting', check: { misses: 1 } })
    expect(checkDelivery(QUESTION_CHECK, refresh([idle('s-wait', { transcript: undefined })], SENT_AT + 2 * SECOND))).toMatchObject({ status: 'waiting', check: { misses: 1 } })
  })

  it('says a permission is in when its call has no open request, or the session waits on no permission', () => {
    const open = (isOpen: boolean, toolUseId = 'tu-bash'): SessionFacts =>
      waiting('s-wait', { waitingFor: 'permission prompt', transcript: transcript({ activity: { toolUseId, tool: 'Bash', text: 'Bash npm test', isOpen } }) })
    const byCall = check({ kind: 'permission', toolUseId: 'tu-bash' })
    expect(checkDelivery(byCall, refresh([open(true)], SENT_AT + 2 * SECOND))).toMatchObject({ status: 'waiting' })
    expect(checkDelivery(byCall, refresh([open(false)], SENT_AT + 2 * SECOND))).toEqual({ status: 'delivered' })
    expect(checkDelivery(byCall, refresh([open(true, 'tu-next')], SENT_AT + 2 * SECOND))).toEqual({ status: 'delivered' })
    const byState = check({ kind: 'permission' })
    expect(checkDelivery(byState, refresh([open(true)], SENT_AT + 2 * SECOND))).toMatchObject({ status: 'waiting' })
    expect(checkDelivery(byState, refresh([answered()], SENT_AT + 2 * SECOND))).toEqual({ status: 'delivered' })
  })

  it('says a prompt is in when a turn after the send has it as the human prompt', () => {
    const prompted = (prompt: string, promptAt: number): SessionFacts => idle('s-wait', { transcript: transcript({ history: [{ prompt, promptAt }] }) })
    const typed = check({ kind: 'prompt', text: 'Run the tests.\nThen fix the lint.', after: SENT_AT - SECOND })
    expect(checkDelivery(typed, refresh([prompted('Run the tests.\nThen fix the lint.', SENT_AT)], SENT_AT + 2 * SECOND))).toEqual({ status: 'delivered' })
    expect(checkDelivery(typed, refresh([prompted('Run the tests.\nThen fix the lint.\n', SENT_AT)], SENT_AT + 2 * SECOND))).toEqual({ status: 'delivered' })
    // the same text from an older turn, and another text, are not this prompt
    expect(checkDelivery(typed, refresh([prompted('Run the tests.\nThen fix the lint.', SENT_AT - HOUR)], SENT_AT + 2 * SECOND))).toMatchObject({ status: 'waiting' })
    expect(checkDelivery(typed, refresh([prompted('Run the tests.', SENT_AT)], SENT_AT + 2 * SECOND))).toMatchObject({ status: 'waiting' })
  })
})
