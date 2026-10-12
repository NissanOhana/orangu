/**
 * The pure rules of the picks of a dialog with 2 or more single-select questions: a digit picks for the question that
 * the detail shows and moves on, the last pick opens the confirm bar of all the picks, p goes back 1 question, and c or
 * a delivery of those answers ends the picks. Nothing here sends a key.
 */
import { describe, expect, it } from 'vitest'
import { INTENTS, OUTCOMES, detailSnapshot } from '../../test/fixtures/god/detail.js'
import type { DeliverCheck } from './act/deliver-check.js'
import { afterDelivery, afterPick, cancelled, pickedBack, steppedDialog, withDraft, withIntent } from './deliver-control.js'
import type { BoardSnapshot, DeliverOutcome } from './types.js'
import { NO_DELIVERY, type DeliverState, type Picks } from './view/bar.js'

const SNAPSHOT = detailSnapshot()
const NO_CMUX: BoardSnapshot = { ...SNAPSHOT, sources: { ...SNAPSHOT.sources, cmux: { status: 'missing', reason: 'no cmux' } } }
const DIALOG = steppedDialog(SNAPSHOT, 's-multi')!
const picks = (...digits: number[]): Picks => ({ sessionId: 's-multi', toolUseId: 'tu-multi', digits })
const check: DeliverCheck = { sessionId: 's-multi', expect: { kind: 'question', toolUseId: 'tu-multi' }, sentAt: 1, misses: 0 }

describe('steppedDialog', () => {
  it('gives the target and the open question of a selected session with 2 or more single-select questions', () => {
    expect(DIALOG.target).toEqual({ sessionId: 's-multi', name: 'web-5' })
    expect(DIALOG.open.toolUseId).toBe('tu-multi')
  })

  it('gives none for 1 question, a question with more than 1 choice, no question, no selection, or no cmux', () => {
    for (const key of ['s-wait', 's-pick', 's-idle', 'nobody']) expect(steppedDialog(SNAPSHOT, key), key).toBeUndefined()
    expect(steppedDialog(SNAPSHOT, undefined)).toBeUndefined()
    expect(steppedDialog(undefined, 's-multi')).toBeUndefined()
    expect(steppedDialog(NO_CMUX, 's-multi')).toBeUndefined()
  })
})

describe('afterPick', () => {
  it('keeps the digit of question 1 and opens no bar, then opens the bar of all the picks after the last question', () => {
    const first = afterPick(NO_DELIVERY, DIALOG, 2)
    expect(first).toEqual({ scroll: 0, picks: picks(2) })
    expect(afterPick(first, DIALOG, 1)).toEqual({ scroll: 0, picks: picks(2, 1), intent: INTENTS.answers })
  })

  it('picks again for the last question while its bar is open, with a new bar', () => {
    const open = afterPick(afterPick(NO_DELIVERY, DIALOG, 2), DIALOG, 1)
    const again = afterPick({ ...open, scroll: 3 }, DIALOG, 2)
    expect(again.picks).toEqual(picks(2, 2))
    expect(again.scroll).toBe(0)
    expect(again.intent).toMatchObject({ kind: 'answers', answers: [{ option: 2, label: '8080' }, { option: 2, label: 'Shared' }] })
  })

  it('changes nothing for a digit with no option, or while a draft is open', () => {
    expect(afterPick(NO_DELIVERY, DIALOG, 3)).toBe(NO_DELIVERY)
    expect(afterPick(NO_DELIVERY, DIALOG, 0)).toBe(NO_DELIVERY)
    const drafting = withDraft(NO_DELIVERY, { kind: 'prompt', target: DIALOG.target, lines: [] })
    expect(afterPick(drafting, DIALOG, 1)).toBe(drafting)
  })

  it('starts again at question 1 when the picks are of another question or another session', () => {
    for (const old of [{ ...picks(2), toolUseId: 'tu-old' }, { ...picks(2), sessionId: 's-wait' }]) {
      expect(afterPick({ scroll: 0, picks: old }, DIALOG, 1)).toEqual({ scroll: 0, picks: picks(1) })
    }
  })

  it('closes another bar and the note of the last outcome, and keeps the check of the last send', () => {
    expect(afterPick({ scroll: 2, intent: INTENTS.prompt, outcome: OUTCOMES.sent, check }, DIALOG, 2)).toEqual({ scroll: 0, picks: picks(2), check })
  })
})

describe('pickedBack', () => {
  it('goes back 1 question: the pick of that question and the picks after it go, and so does the bar', () => {
    expect(pickedBack({ scroll: 0, picks: picks(2) }, DIALOG)).toEqual({ scroll: 0, picks: picks() })
    expect(pickedBack({ scroll: 1, picks: picks(2, 1), intent: INTENTS.answers, check }, DIALOG)).toEqual({ scroll: 0, picks: picks(), check })
  })

  it('changes nothing on question 1, for picks of another question, or while a draft is open', () => {
    const none: DeliverState = { scroll: 0, picks: picks() }
    expect(pickedBack(none, DIALOG)).toBe(none)
    expect(pickedBack(NO_DELIVERY, DIALOG)).toBe(NO_DELIVERY)
    const other: DeliverState = { scroll: 0, picks: { ...picks(2), toolUseId: 'tu-old' } }
    expect(pickedBack(other, DIALOG)).toBe(other)
    const drafting: DeliverState = { ...withDraft(NO_DELIVERY, { kind: 'peer', target: DIALOG.target, lines: [] }), picks: picks(2) }
    expect(pickedBack(drafting, DIALOG)).toBe(drafting)
  })
})

describe('the end of the picks', () => {
  const open: DeliverState = { scroll: 0, picks: picks(2, 1), intent: INTENTS.answers }

  it('c closes the bar and drops the picks', () => {
    expect(cancelled({ ...open, check })).toEqual({ scroll: 0, check })
  })

  it('a delivery of those answers drops the picks, but an old read keeps them with the bar', () => {
    expect(afterDelivery(open, INTENTS.answers, { outcome: OUTCOMES.refused })).toEqual({ scroll: 0, outcome: OUTCOMES.refused })
    const stale: DeliverOutcome = { status: 'refused', intent: INTENTS.answers, at: 1, refusal: 'stale-screen' }
    expect(afterDelivery(open, INTENTS.answers, { outcome: stale })).toEqual({ ...open, outcome: stale })
  })

  it('a delivery of another intent keeps the picks, and a new bar or draft drops them', () => {
    const picking: DeliverState = { scroll: 0, picks: picks(2) }
    expect(afterDelivery(picking, INTENTS.prompt, { outcome: OUTCOMES.sent })).toEqual({ scroll: 0, picks: picks(2), outcome: OUTCOMES.sent })
    expect(withIntent(picking, INTENTS.prompt).picks).toBeUndefined()
    expect(withDraft(picking, { kind: 'peer', target: DIALOG.target, lines: [] }).picks).toBeUndefined()
  })
})
