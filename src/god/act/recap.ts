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
 * - The prompt holds RECAP_PROMPT_MAX_BYTES UTF-8 bytes or fewer. The oldest turns go first. If the facts alone pass
 *   the cap, each fact text gets an equal share of the bytes (FACT_MIN_BYTES or more), with `…+N` for what its cut
 *   hid. The fact lines that still do not fit (only with very many open questions) are left out, the last first.
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

/** Each session text of the prompt keeps this many characters (code points) or fewer. */
export const RECAP_TEXT_MAX = 1500

/** The framed prompt of 1 Recap holds this many UTF-8 bytes or fewer: the limit at which orangu asks before a model reads more. */
export const RECAP_PROMPT_MAX_BYTES = 20_000

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

const encoder = new TextEncoder()

/** The UTF-8 bytes of a text, as the wire sends it. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

/** The UTF-8 bytes of prompt lines, with a line break between each 2. */
const bytesOf = (lines: readonly string[]): number => utf8Length(lines.join('\n'))

/** The bytes of the longest label, its `: ` and its line break: the most that a fact line adds to its text. */
const LINE_BYTES = Math.max(...Object.values(RECAP_LABEL).map(utf8Length)) + 3

/** A fact text keeps this many bytes or more when the facts share the cap, so very many lines push the last out, not cut each fact to its mark. */
const FACT_MIN_BYTES = 256

/** A session text in its frame: cleaned, cut to RECAP_TEXT_MAX characters and to maxBytes UTF-8 bytes with the count of what it cut, then a JSON string. */
function framed(text: string, clean: (text: string) => string, maxBytes: number): string {
  const chars = Array.from(clean(text))
  const whole = JSON.stringify(chars.join(''))
  if (chars.length <= RECAP_TEXT_MAX && utf8Length(whole) <= maxBytes) return whole
  const room = maxBytes - utf8Length(cutMark(chars.length))
  let kept = 0
  let bytes = 2 // the 2 quotes of the frame
  while (kept < Math.min(chars.length, RECAP_TEXT_MAX)) {
    const next = utf8Length(JSON.stringify(chars[kept])) - 2
    if (bytes + next > room) break
    bytes += next
    kept += 1
  }
  return `${JSON.stringify(chars.slice(0, kept).join(''))}${cutMark(chars.length - kept)}`
}

/** The first lines that fit in RECAP_PROMPT_MAX_BYTES together. */
function within(lines: readonly string[]): string[] {
  let bytes = -1 // the first line has no line break before it
  const kept: string[] = []
  for (const line of lines) {
    bytes += utf8Length(line) + 1
    if (bytes > RECAP_PROMPT_MAX_BYTES) break
    kept.push(line)
  }
  return kept
}

/** The request of the Recap of 1 session. */
export function recapRequest(session: GodSession, clean: (text: string) => string): ModelRequest {
  const transcript = session.transcript
  const line = (label: string, text: string | undefined, maxBytes = Number.POSITIVE_INFINITY): string[] =>
    text === undefined || text === '' ? [] : [`${label}: ${framed(text, clean, maxBytes)}`]
  const facts = (maxBytes?: number): string[] => [
    ...line(RECAP_LABEL.session, session.name, maxBytes),
    ...line(RECAP_LABEL.title, transcript?.title, maxBytes),
    `${RECAP_LABEL.level}: ${LEVEL_HEADING[session.level]}`,
    ...line(RECAP_LABEL.waits, session.waitingFor, maxBytes),
    ...(transcript?.openQuestion?.questions ?? []).flatMap((question) => line(RECAP_LABEL.question, question.text, maxBytes)),
    ...line(RECAP_LABEL.tool, transcript?.activity?.text, maxBytes),
  ]
  const whole = facts()
  const share = Math.max(Math.floor(RECAP_PROMPT_MAX_BYTES / whole.length) - LINE_BYTES, FACT_MIN_BYTES)
  const head = bytesOf(whole) <= RECAP_PROMPT_MAX_BYTES ? whole : within(facts(share))
  const turns = (transcript?.history ?? []).slice(-RECAP_TURNS).map((turn) => [...line(RECAP_LABEL.prompt, turn.prompt), ...line(RECAP_LABEL.reply, turn.reply)])
  let oldest = 0
  while (oldest < turns.length && bytesOf([...head, ...turns.slice(oldest).flat()]) > RECAP_PROMPT_MAX_BYTES) oldest += 1
  const lines = [...head, ...turns.slice(oldest).flat()]
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
