/**
 * The pure rules of the key path controls: what a digit, the Yes or No of a Bash request, r, m, a line of the
 * draft, y, c and a refresh do to the delivery state. Nothing here sends a key: each rule only opens or closes the
 * confirm bar, keeps the draft, or takes the outcome of a delivery and the check of the next refreshes.
 */
import { describe, expect, it } from 'vitest'
import { INTENTS, OUTCOMES, SCREEN, detailSnapshot } from '../../test/fixtures/god/detail.js'
import { NOW, SECOND, facts, idle, transcript } from '../../test/fixtures/god/sessions.js'
import type { DeliverCheck } from './act/deliver-check.js'
import {
  afterDelivery,
  afterDraftLine,
  afterRefresh,
  answerIntent,
  cancelPressed,
  cancelled,
  draftFor,
  isSendable,
  isSendingOf,
  notSending,
  opensScreen,
  permissionIntent,
  screenDetail,
  scrolled,
  sendPressed,
  sending,
  stopsDelivery,
  withDraft,
  withIntent,
  withPicked,
} from './deliver-control.js'
import type { BoardSnapshot, DeliverOutcome } from './types.js'
import { NO_DELIVERY, type DeliverState } from './view/bar.js'

const SNAPSHOT = detailSnapshot()
const NO_CMUX: BoardSnapshot = { ...SNAPSHOT, sources: { ...SNAPSHOT.sources, cmux: { status: 'missing', reason: 'no cmux' } } }
// the confirm bar names a session by the name of its row: s-wait shows the title of its cmux tab
const WAIT = { sessionId: 's-wait', name: 'tab 2' }
const QUESTION = 'Which eval set do you want for the next run of the tests?'

describe('answerIntent', () => {
  it('gives the answer of a digit for the single-select question of the selected session', () => {
    expect(answerIntent(SNAPSHOT, 's-wait', 2)).toEqual({ kind: 'answer', target: WAIT, toolUseId: 'tu-ask', header: 'Eval set', question: QUESTION, option: 2, label: 'All' })
  })

  it('gives none for a digit with no option, a dialog with 2 questions or more than 1 choice, no selection, or no cmux', () => {
    expect(answerIntent(SNAPSHOT, 's-wait', 4)).toBeUndefined()
    expect(answerIntent(SNAPSHOT, 's-wait', 0)).toBeUndefined()
    expect(answerIntent(SNAPSHOT, 's-multi', 1)).toBeUndefined()
    expect(answerIntent(SNAPSHOT, 's-pick', 1)).toBeUndefined()
    expect(answerIntent(SNAPSHOT, 's-idle', 1)).toBeUndefined()
    expect(answerIntent(SNAPSHOT, undefined, 1)).toBeUndefined()
    expect(answerIntent(undefined, 's-wait', 1)).toBeUndefined()
    expect(answerIntent(NO_CMUX, 's-wait', 1)).toBeUndefined()
  })
})

describe('permissionIntent', () => {
  it('gives Yes or No for the open Bash request of the selected session, with its tool use id and its whole input', () => {
    expect(permissionIntent(SNAPSHOT, 's-perm', 'no')).toEqual({ kind: 'permission', target: { sessionId: 's-perm', name: 'ops-4' }, choice: 'no', toolUseId: 'tu-bash', tool: 'Bash', input: '{"command":"npm test","description":"Run the tests"}' })
  })

  it('gives none for a request of another tool, a session that waits on no permission, or no cmux', () => {
    const edit: BoardSnapshot = {
      ...SNAPSHOT,
      sessions: SNAPSHOT.sessions.map((session) =>
        session.sessionId === 's-perm' ? { ...session, transcript: { ...session.transcript!, activity: { ...session.transcript!.activity!, tool: 'Edit', text: 'Edit parse.ts' } } } : session,
      ),
    }
    expect(permissionIntent(edit, 's-perm', 'yes')).toBeUndefined()
    expect(permissionIntent(SNAPSHOT, 's-wait', 'yes')).toBeUndefined()
    expect(permissionIntent(NO_CMUX, 's-perm', 'yes')).toBeUndefined()
  })
})

describe('the draft of r and m', () => {
  it('opens a prompt draft only with cmux, and a peer message draft with or without it', () => {
    expect(draftFor(SNAPSHOT, 's-idle', 'prompt')).toEqual({ kind: 'prompt', target: { sessionId: 's-idle', name: 'api-1' }, lines: [] })
    expect(draftFor(NO_CMUX, 's-idle', 'prompt')).toBeUndefined()
    expect(draftFor(NO_CMUX, 's-idle', 'peer')).toEqual({ kind: 'peer', target: { sessionId: 's-idle', name: 'api-1' }, lines: [] })
    expect(draftFor(SNAPSHOT, undefined, 'peer')).toBeUndefined()
  })

  it('adds each line, splits a pasted value at its line breaks, and opens the bar on an empty line', () => {
    const draft = draftFor(SNAPSHOT, 's-idle', 'prompt')!
    let state = withDraft({ ...NO_DELIVERY, intent: INTENTS.answer }, draft)
    expect(state.intent).toBeUndefined()
    state = afterDraftLine(state, 'Run the tests.')
    state = afterDraftLine(state, 'Then fix the lint.\r\nKeep it short.')
    expect(state.draft?.lines).toEqual(['Run the tests.', 'Then fix the lint.', 'Keep it short.'])
    expect(state.intent).toBeUndefined()
    state = afterDraftLine(state, '  ')
    expect(state.draft).toBeUndefined()
    expect(state.intent).toEqual({ kind: 'prompt', target: draft.target, text: 'Run the tests.\nThen fix the lint.\nKeep it short.' })
  })

  it('closes a draft with no line on an empty line, and opens no bar', () => {
    const state = afterDraftLine(withDraft(NO_DELIVERY, draftFor(SNAPSHOT, 's-idle', 'peer')!), '')
    expect(state).toEqual(NO_DELIVERY)
  })
})

describe('the confirm bar', () => {
  it('opens on a new intent from the top, and closes the draft and the last outcome', () => {
    const state = withIntent({ ...NO_DELIVERY, scroll: 4, draft: draftFor(SNAPSHOT, 's-idle', 'peer')!, outcome: OUTCOMES.refused }, INTENTS.prompt)
    expect(state).toEqual({ scroll: 0, intent: INTENTS.prompt })
  })

  it('c closes the bar and the draft and keeps the check', () => {
    const check: DeliverCheck = { sessionId: 's-wait', expect: { kind: 'question', toolUseId: 'tu-ask' }, sentAt: NOW, misses: 0 }
    expect(cancelled({ scroll: 2, intent: INTENTS.answer, check, outcome: OUTCOMES.sent })).toEqual({ scroll: 0, check, outcome: OUTCOMES.sent })
    expect(scrolled({ scroll: 0, intent: INTENTS.prompt }, 3)).toEqual({ scroll: 3, intent: INTENTS.prompt })
  })

  it('keeps the intent and the bar open after stale-screen, so y reads again', () => {
    const state: DeliverState = { scroll: 2, intent: INTENTS.answer }
    const stale = { ...OUTCOMES.refused, refusal: 'stale-screen' as const }
    expect(afterDelivery(state, INTENTS.answer, { outcome: stale })).toEqual({ scroll: 2, intent: INTENTS.answer, outcome: stale })
  })

  it('closes the bar after any other outcome, and takes the check of a send', () => {
    const state: DeliverState = { scroll: 2, intent: INTENTS.answer }
    expect(afterDelivery(state, INTENTS.answer, { outcome: OUTCOMES.refused })).toEqual({ scroll: 0, outcome: OUTCOMES.refused })
    const check: DeliverCheck = { sessionId: 's-wait', expect: { kind: 'question', toolUseId: 'tu-ask' }, sentAt: NOW, misses: 0 }
    expect(afterDelivery(state, INTENTS.answer, { outcome: OUTCOMES.sent, check })).toEqual({ scroll: 0, outcome: OUTCOMES.sent, check })
  })

  it('keeps a bar or a draft that the person opened while the keys went out', () => {
    const state: DeliverState = { scroll: 0, intent: INTENTS.prompt }
    expect(afterDelivery(state, INTENTS.answer, { outcome: OUTCOMES.refused })).toEqual({ scroll: 0, intent: INTENTS.prompt, outcome: OUTCOMES.refused })
  })

  it('opens the Screen tab after a refusal or a failure with a fresh screen', () => {
    expect(opensScreen(OUTCOMES.refused)).toBe(true)
    const failed: DeliverOutcome = { status: 'failed', intent: INTENTS.answer, at: NOW, reason: 'send-key exit 1', screen: SCREEN }
    expect(opensScreen(failed)).toBe(true)
    expect(opensScreen({ ...OUTCOMES.refused, refusal: 'empty', screen: undefined } as typeof OUTCOMES.refused)).toBe(false)
    expect(opensScreen(OUTCOMES.sent)).toBe(false)
    expect(screenDetail({ tab: 'now', scroll: 5, isOpen: false })).toEqual({ tab: 'screen', scroll: 0, isOpen: true })
  })
})

describe('afterRefresh', () => {
  const check: DeliverCheck = { sessionId: 's-idle', expect: { kind: 'question', toolUseId: 'tu-ask' }, sentAt: NOW, misses: 0 }
  const later = (at: number) => ({ ...facts([idle('s-idle', { transcript: transcript() })]), stats: { at, computeMs: 20, waitMs: 380, sessions: 1 } })

  it('turns the sent outcome into delivered when a refresh shows the answer', () => {
    const state: DeliverState = { scroll: 0, outcome: OUTCOMES.sent, check }
    expect(afterRefresh(state, later(NOW + 2 * SECOND))).toEqual({ scroll: 0, outcome: { status: 'delivered', intent: OUTCOMES.sent.intent, at: NOW + 2 * SECOND } })
  })

  it('leaves the state as it is with no check, and drops the check when a later outcome took the place of the sent one', () => {
    const state: DeliverState = { scroll: 0, outcome: OUTCOMES.refused }
    expect(afterRefresh(state, later(NOW + 2 * SECOND))).toBe(state)
    expect(afterRefresh({ scroll: 0, outcome: OUTCOMES.refused, check }, later(NOW + 2 * SECOND))).toEqual({ scroll: 0, outcome: OUTCOMES.refused })
  })

  it('gives the same state for a refresh that does not count', () => {
    const state: DeliverState = { scroll: 0, outcome: OUTCOMES.sent, check }
    expect(afterRefresh(state, later(NOW - SECOND))).toBe(state)
  })
})

describe('a digit or Yes and No while a draft is open', () => {
  it('keeps the draft and opens no bar, so the digit arms no y', () => {
    const state = withDraft(NO_DELIVERY, draftFor(SNAPSHOT, 's-idle', 'prompt')!)
    expect(withPicked(state, INTENTS.answer)).toBe(state)
    expect(withPicked(state, INTENTS.permission)).toBe(state)
    expect(withPicked(NO_DELIVERY, INTENTS.answer)).toEqual({ scroll: 0, intent: INTENTS.answer })
  })
})

describe('y while the keys go out', () => {
  it('marks the state as sending, and the outcome of the delivery ends the mark', () => {
    const state = sending({ scroll: 0, intent: INTENTS.answer })
    expect(state).toEqual({ scroll: 0, intent: INTENTS.answer, isSending: true })
    expect(afterDelivery(state, INTENTS.answer, { outcome: OUTCOMES.refused })).toEqual({ scroll: 0, outcome: OUTCOMES.refused })
    const stale = { ...OUTCOMES.refused, refusal: 'stale-screen' as const }
    expect(afterDelivery(state, INTENTS.answer, { outcome: stale })).toEqual({ scroll: 0, intent: INTENTS.answer, outcome: stale })
  })

  it('sends only the intent that the bar shows, while the bar still shows it and no y runs', () => {
    const state: DeliverState = { scroll: 0, intent: INTENTS.answer }
    expect(isSendable(state, INTENTS.answer)).toBe(true)
    expect(isSendable(state, INTENTS.prompt)).toBe(false)
    expect(isSendable({ scroll: 0 }, INTENTS.answer)).toBe(false)
    expect(isSendable(sending(state), INTENTS.answer)).toBe(false)
    expect(isSendable(state, undefined)).toBe(false)
  })

  it('marks the state at the press of y only for the intent that its drawing shows, and the mark names that intent', () => {
    const state: DeliverState = { scroll: 0, intent: INTENTS.answer }
    const marked = sendPressed(state, INTENTS.answer)
    expect(marked).toEqual(sending(state))
    expect(isSendingOf(marked, INTENTS.answer)).toBe(true)
    expect(isSendingOf(marked, INTENTS.prompt)).toBe(false)
    for (const shown of [INTENTS.prompt, undefined]) expect(sendPressed(state, shown)).toBe(state)
    expect(sendPressed(marked, INTENTS.answer)).toBe(marked)
    expect(isSendingOf(state, INTENTS.answer)).toBe(false)
    expect(notSending(marked)).toEqual(state)
  })
})

describe('c of a bar', () => {
  it('closes only the bar that its drawing shows: a confirm bar of the same intent, or a draft with no bar', () => {
    const state: DeliverState = { scroll: 2, intent: INTENTS.answer, outcome: OUTCOMES.refused }
    expect(cancelPressed(state, INTENTS.answer)).toEqual(cancelled(state))
    expect(cancelPressed(state, INTENTS.prompt)).toBe(state)
    expect(cancelPressed(state, undefined)).toBe(state)
    const drafted = withDraft(NO_DELIVERY, draftFor(SNAPSHOT, 's-idle', 'prompt')!)
    expect(cancelPressed(drafted, undefined)).toEqual(cancelled(drafted))
    expect(cancelPressed(drafted, INTENTS.answer)).toBe(drafted)
  })

  it('stops the keys of a delivery only from the bar of that same intent', () => {
    expect(stopsDelivery(INTENTS.answer, INTENTS.answer)).toBe(true)
    // a digit pressed while the keys go out opens a new bar: its c closes that bar and stops nothing
    expect(stopsDelivery(INTENTS.answer, { ...INTENTS.answer, option: 3, label: 'None' } as typeof INTENTS.answer)).toBe(false)
    expect(stopsDelivery(INTENTS.answer, undefined)).toBe(false)
    expect(stopsDelivery(undefined, INTENTS.answer)).toBe(false)
  })
})
