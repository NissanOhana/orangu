/**
 * The check after a send: whether the keys of a confirmed intent reached the session, read from the refreshes of the
 * board after the send. It reads no host and no clock, so the engine shell runs it after each tick.
 *
 * - An answer is in when the open question of the session is no longer the question that it answered.
 * - A Bash permission is in when its call has no open request: the open call has another id, or no call is open.
 *   When the fresh read at y gave no open call, it is in when the session waits on no permission prompt.
 * - A prompt is in when a turn of the transcript has it as the human prompt of the person (the record reducer keeps
 *   only a prompt that classifyPrompt calls human), written after the send less PROMPT_CLOCK_SLACK_MS. The text
 *   compares after the same text cleaner as the transcript text, with the white space at its 2 ends trimmed. A prompt
 *   that starts a mode (`!`, `/`, `?`) is no human prompt, so it reads as not delivered.
 * - Only a refresh that started after the send counts as a miss: its start is its end less its compute and wait
 *   time, which is never later than the true start. A refresh that ran during the send can have read the transcript
 *   before the keys. A refresh that shows the keys in counts at once, whenever it started. A tick that the collector
 *   dropped gives the facts of the last refresh again, with the same end time, and counts once.
 * - After CHECK_REFRESHES misses, the check says not delivered: the first refresh after the send can come a few
 *   milliseconds after the keys, before the session writes its record, so 1 miss is not enough.
 */
import type { KeyIntent } from './deliver-plan.js'
import type { Facts, SessionFacts, TranscriptFacts } from '../types.js'

/** The check says not delivered after this many refreshes that started after the send and did not show the keys. */
export const CHECK_REFRESHES = 2

/** A prompt record of the session can carry a time up to this much before the end of the send. */
export const PROMPT_CLOCK_SLACK_MS = 1000

/** What a refresh must show for the keys to be in. */
export type DeliverExpect =
  | { kind: 'question'; toolUseId: string }
  | { kind: 'permission'; toolUseId?: string }
  | { kind: 'prompt'; text: string; after: number }

/**
 * The check of 1 send: the session, what a refresh must show, the end of the send on the clock of the collector (the
 * clock of the refresh stats), the misses so far, and the end time of the last refresh that counted.
 */
export type DeliverCheck = { sessionId: string; expect: DeliverExpect; sentAt: number; misses: number; lastAt?: number }

/** What 1 refresh says of a check. */
export type CheckResult = { status: 'delivered' } | { status: 'not-delivered' } | { status: 'waiting'; check: DeliverCheck }

/** What a refresh must show for an intent that went out as keys, from the fresh read at y and the end of the send. */
export function expectOf(intent: KeyIntent, transcript: TranscriptFacts | undefined, clean: (text: string) => string, sentAt: number): DeliverExpect {
  if (intent.kind === 'answer') return { kind: 'question', toolUseId: intent.toolUseId }
  if (intent.kind === 'prompt') return { kind: 'prompt', text: clean(intent.text).trim(), after: sentAt - PROMPT_CLOCK_SLACK_MS }
  const activity = transcript?.activity
  return activity?.isOpen === true ? { kind: 'permission', toolUseId: activity.toolUseId } : { kind: 'permission' }
}

/** True when the facts of the session show the keys in. A session with no transcript facts shows nothing. */
function shows(expect: DeliverExpect, session: SessionFacts): boolean {
  const transcript = session.transcript
  if (transcript === undefined) return false
  if (expect.kind === 'question') return transcript.openQuestion?.toolUseId !== expect.toolUseId
  if (expect.kind === 'prompt') return transcript.history.some((turn) => turn.prompt?.trim() === expect.text && turn.promptAt !== undefined && turn.promptAt >= expect.after)
  if (expect.toolUseId !== undefined) return !(transcript.activity?.toolUseId === expect.toolUseId && transcript.activity.isOpen)
  return !(session.status === 'waiting' && session.waitingFor === 'permission prompt')
}

const waiting = (check: DeliverCheck): CheckResult => ({ status: 'waiting', check })

/** What the facts of the newest refresh say of the check. */
export function checkDelivery(check: DeliverCheck, facts: Facts | undefined): CheckResult {
  if (facts === undefined || facts.stats.at <= check.sentAt || facts.stats.at === check.lastAt) return waiting(check)
  const session = facts.sessions.find((candidate) => candidate.sessionId === check.sessionId)
  if (session !== undefined && shows(check.expect, session)) return { status: 'delivered' }
  const startedAt = facts.stats.at - facts.stats.computeMs - facts.stats.waitMs
  if (startedAt < check.sentAt) return waiting(check)
  const misses = check.misses + 1
  return misses >= CHECK_REFRESHES ? { status: 'not-delivered' } : waiting({ ...check, misses, lastAt: facts.stats.at })
}
