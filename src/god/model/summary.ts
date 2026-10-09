/**
 * The 1-line summary of 1 session, from rules only. No model writes it:
 * - while the session waits: the open question, else the open tool call (the permission request), else the reason
 *   of the wait;
 * - while it works: the API error at the end of a stuck session, else the current activity, or the count of the
 *   running subagents when the open call started 1 of them;
 * - else, and when a busy session has no tool call: the first sentence of the last reply, else of the title.
 * A session with no transcript gets NO_TRANSCRIPT on each level. The wait time is not in the summary: the row
 * shows the time since levelSince. The summary is whole, so a view that cuts it says how much it cut. The texts of
 * TranscriptFacts are sanitized and redacted before they come here, so the summary is too.
 */
import type { Level, SessionFacts, TranscriptFacts } from '../types.js'

/** The summary of a session with no transcript file yet. */
export const NO_TRANSCRIPT = 'No transcript yet.'

/** The summary of a session whose transcript part holds no reply and no title. */
export const NO_REPLY = 'No reply yet.'

/** The summary of a waiting session when nothing names the reason of the wait. */
export const WAITS = 'The session waits for you.'

const FENCE = /^\s*(?:`{3}|~{3})/
const HEADING = /^\s*#{1,6}(?:\s|$)/
/** a rule line or a table rule: only dashes, stars, underscores, equals signs, pipes, colons and spaces */
const RULE = /^\s*(?:[-*_=|:]\s*)+$/
/** the marks at the start of a quote line or a list item */
const BLOCK_MARKS = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?/
/** a line that starts a new list item or quote: it ends the paragraph before it */
const NEW_BLOCK = /^\s*(?:>|[-*+]\s|\d+[.)]\s)/
/** a sentence end: . ! or ? (and a closing quote or bracket) before a space or the end, or a full-width end mark */
const SENTENCE_END = /[.!?][)\]"'”’]*(?=\s|$)|[。！？]/

/** A text on 1 line: each run of white space becomes 1 space, and the ends are trimmed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The first text that is not empty on 1 line, else ''. */
function firstOf(...texts: readonly (string | undefined)[]): string {
  for (const text of texts) {
    const line = text === undefined ? '' : oneLine(text)
    if (line !== '') return line
  }
  return ''
}

/**
 * The first sentence of a reply, whole. It reads the first paragraph of prose: headings, rules and code blocks do
 * not count, and the quote, list and bold marks go. The sentence ends at the first sentence end. A paragraph with
 * no sentence end is the whole paragraph. A text with only headings gives its first heading.
 */
export function firstSentence(text: string): string {
  const paragraph: string[] = []
  let heading: string | undefined
  let inFence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      if (paragraph.length > 0) break
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const isBlank = line.trim() === '' || RULE.test(line)
    if (isBlank || HEADING.test(line) || (paragraph.length > 0 && NEW_BLOCK.test(line))) {
      if (paragraph.length > 0) break
      if (!isBlank) heading ??= line.replace(/^\s*#+\s*/, '')
      continue
    }
    paragraph.push(line.replace(BLOCK_MARKS, ''))
  }
  const prose = oneLine(paragraph.join(' ').replace(/\*\*/g, ''))
  if (prose === '') return oneLine((heading ?? '').replace(/\*\*/g, ''))
  const end = SENTENCE_END.exec(prose)
  return end === null ? prose : prose.slice(0, end.index + end[0].length)
}

/** The summary of a waiting session: the question, else the permission request, else the reason of the wait. */
function waitLine(session: SessionFacts, transcript: TranscriptFacts): string {
  const openCall = transcript.activity?.isOpen === true ? transcript.activity.text : undefined
  return firstOf(transcript.openQuestion?.questions[0]?.text, openCall, session.waitingFor) || WAITS
}

/** The summary of a busy session: the running subagents when the open call started 1 of them, else the activity. */
function workLine(transcript: TranscriptFacts): string {
  const activity = transcript.activity
  if (activity === undefined) return ''
  const running = transcript.agents.filter((task) => task.kind === 'subagent' && task.isRunning)
  if (activity.isOpen && running.some((task) => task.toolUseId === activity.toolUseId)) {
    return running.length === 1 ? '1 subagent' : `${running.length} subagents`
  }
  return oneLine(activity.text)
}

/** The 1-line summary of 1 session at its level. */
export function summaryOf(session: SessionFacts, level: Level): string {
  const transcript = session.transcript
  if (transcript === undefined) return NO_TRANSCRIPT
  if (level === 'needs-you') return waitLine(session, transcript)
  if (level === 'stuck' || level === 'working') {
    const work = firstOf(level === 'stuck' ? transcript.errorTail?.text : undefined, workLine(transcript))
    if (work !== '') return work
  }
  return firstSentence(transcript.lastReply ?? '') || firstSentence(transcript.title ?? '') || NO_REPLY
}
