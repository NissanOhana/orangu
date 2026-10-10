/**
 * The Recap of the god pane: the only model text of orangu god, made only when the person presses x on the Recap tab
 * of a session. This module builds the request and reads the reply, as pure code over the model port.
 *
 * - The request names RECAP_MODEL, a reply cap and a time limit. The system text is the task (src/god/copy.ts) and the
 *   quote rule of the god tools (src/god/view/tool-text.ts).
 * - The prompt holds the facts of 1 session (its name, title, level, wait, open question and last tool) and its last
 *   RECAP_TURNS turns, oldest first. Each session text is cleaned here again before it leaves the machine (no control
 *   character, the secrets masked, the home folder as `~`), then cut to RECAP_TEXT_MAX characters with `…+N` for the
 *   characters that it cut, then framed as a JSON string literal, so a quote, a backslash or a line break in it cannot
 *   end its frame or start a new prompt line. The cut comes after the redaction, so a cut never splits a secret open.
 * - The reply text is cleaned too: a model can echo a control character. The token count is the sum of the 4 usage
 *   counts. A reply with no text keeps its reason, and a call that the engine refuses to send gives `refused`.
 * The clock comes in through the ports.
 */
import { RECAP_LABEL, RECAP_SYSTEM } from '../copy.js'
import type { Effects, ModelReply, ModelRequest, TokenUsage } from '../host.js'
import type { GodSession, RecapState } from '../types.js'
import { LEVEL_HEADING } from '../view/board.js'
import { cutMark } from '../view/cut.js'
import { TOOL_QUOTE_RULE } from '../view/tool-text.js'

/** The model of the Recap: a small, fast model, since the Recap is a short summary. */
export const RECAP_MODEL = 'claude-haiku-5-5'

/** The Recap reads this many of the last turns of the session. */
export const RECAP_TURNS = 6

/**
 * Each session text of the prompt keeps this many characters (code points) or fewer, so the session texts of 1 Recap
 * stay under about 20 KB (RECAP_TURNS prompts and replies), the limit at which orangu asks before a model reads more.
 */
export const RECAP_TEXT_MAX = 1500

/** The reply cap of the Recap, in tokens. */
export const RECAP_MAX_TOKENS = 600

/** The Recap call stops after this many milliseconds, and the Recap says so. */
export const RECAP_TIMEOUT_MS = 60_000

/** What the Recap reads and calls through. */
export type RecapPorts = {
  complete: Effects['complete']
  /** the time now, with no wait */
  clock: () => number
  /** the text cleaner of the home folder (src/god/sanitize.ts) */
  clean: (text: string) => string
}

/** A session text in its frame: cleaned, cut to its limit with the count of what it cut, then a JSON string. */
function framed(text: string, clean: (text: string) => string): string {
  const chars = Array.from(clean(text))
  if (chars.length <= RECAP_TEXT_MAX) return JSON.stringify(chars.join(''))
  return `${JSON.stringify(chars.slice(0, RECAP_TEXT_MAX).join(''))}${cutMark(chars.length - RECAP_TEXT_MAX)}`
}

/** The request of the Recap of 1 session. */
export function recapRequest(session: GodSession, clean: (text: string) => string): ModelRequest {
  const transcript = session.transcript
  const fact = (label: string, text: string | undefined): string[] => (text === undefined || text === '' ? [] : [`${label}: ${framed(text, clean)}`])
  const turns = (transcript?.history ?? []).slice(-RECAP_TURNS).flatMap((turn) => [...fact(RECAP_LABEL.prompt, turn.prompt), ...fact(RECAP_LABEL.reply, turn.reply)])
  const lines = [
    ...fact(RECAP_LABEL.session, session.name),
    ...fact(RECAP_LABEL.title, transcript?.title),
    `${RECAP_LABEL.level}: ${LEVEL_HEADING[session.level]}`,
    ...fact(RECAP_LABEL.waits, session.waitingFor),
    ...(transcript?.openQuestion?.questions ?? []).flatMap((question) => fact(RECAP_LABEL.question, question.text)),
    ...fact(RECAP_LABEL.tool, transcript?.activity?.text),
    ...turns,
  ]
  return { model: RECAP_MODEL, system: `${RECAP_SYSTEM} ${TOOL_QUOTE_RULE}`, prompt: lines.join('\n'), maxTokens: RECAP_MAX_TOKENS, timeoutMs: RECAP_TIMEOUT_MS }
}

/** The tokens of 1 model call: the sum of its 4 usage counts. */
export function recapTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

/** The Recap state of a reply, or of a call that the engine refused to send (no reply). */
export function recapState(sessionId: string, reply: ModelReply | undefined, at: number, clean: (text: string) => string): RecapState {
  if (reply === undefined) return { status: 'failed', sessionId, reason: 'refused', tokens: 0, at }
  const tokens = recapTokens(reply.usage)
  return reply.isAnswered ? { status: 'answered', sessionId, text: clean(reply.text), tokens, at } : { status: 'failed', sessionId, reason: reply.reason, tokens, at }
}

/** Makes the Recap of 1 session with 1 model call. It never rejects: a call that rejects gives `refused`. */
export async function runRecap(ports: RecapPorts, session: GodSession): Promise<RecapState> {
  const reply = await ports.complete(recapRequest(session, ports.clean)).catch(() => undefined)
  return recapState(session.sessionId, reply, ports.clock(), ports.clean)
}
