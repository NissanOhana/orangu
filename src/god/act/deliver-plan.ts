/**
 * The deliver plan: turns what the person confirmed, a fresh screen of the target tab and the state of the target
 * session into the cmux argv lists to run in order, or into exactly 1 refusal. It runs no command and reads no
 * clock: the plan time and the screen time come in as values, and the executor runs the lists.
 *
 * Every rule fails closed:
 * - the state comes from the registry and the transcript, which a session cannot draw on its screen. An answer
 *   needs a session that waits for input on the same open question (1 question, 1 selection, the same header,
 *   question and label at the digit). A permission answer needs a session that waits on a permission prompt, with no
 *   running subagent, whose own dialog can show in the same tab (task-running). A prompt needs an idle session with no open question, and with no running background task or subagent, which can
 *   open a dialog while the keys go out (task-running). So a busy session that prints a dialog or an input box
 *   gets no key;
 * - the screen must be of the target session, from a tab whose refs are `workspace:N` and `surface:N` or UUIDs
 *   (never a bare index, which cmux resolves in the current window), read 1 s or less before the
 *   plan, and the state must be read 1 s or less before the screen read, never after it. Late state gives
 *   stale-screen: the plan inputs are not of 1 moment, and the executor reads both again;
 * - an answer is the option digit alone, with no Enter, and only when the screen still shows the confirmed header,
 *   question and label at that digit, and each option of the open question with its description
 *   (src/god/model/screen-match.ts). The digit goes out as text, with `cmux send`: `cmux send-key` takes only a
 *   named key, such as enter, tab or escape, and exits 1 on a digit with "Unknown key";
 * - the answers of a dialog with 2 or more single-select questions are 1 `cmux send` of the confirmed digit for each
 *   question, then 1 of `1` on the review screen, each a step of its own. The session must wait on the same open
 *   question, with the same headers, questions and labels. The plan checks the screen of step 0 (question 1), and
 *   before each later step the executor reads the registry file, the transcript and the screen again, and
 *   nextAnswerRefusal checks them: the same checks, then the screen of that step (src/god/model/question-dialog.ts);
 * - a permission answer is the digit of the option labeled exactly Yes or exactly No, on a dialog that shows the
 *   confirmed shell command, also with `cmux send`. The executor gives the raw text of the same screen read, the open
 *   calls of the fresh transcript read and the cleaner (RawFacts). The answer binds to the only open call, a Bash call
 *   with the confirmed input (boundCommand), and the match compares the raw rows of the box with its raw command. Only
 *   the digit or a refusal comes back;
 * - a prompt is 1 `cmux send` for each line, `shift+enter` between the lines and `enter` at the end, only on an
 *   empty prompt row with no dialog on the screen. Its text passes these rules (textRefusal) before any host call:
 *   it holds a visible character (empty). It holds no control character but the newline, no line or paragraph
 *   separator, and no format character or other default ignorable character: such a character draws nothing in the
 *   confirm bar, so the person cannot see it before y, and an emoji can hold one (control-char). It holds no
 *   backslash right before n, r or t in either case: cmux types the lowercase pairs as Enter or Tab and has no escape
 *   for them, and the uppercase pairs are not tested. No line may end with a backslash (spaces after it count as its
 *   end): Claude Code reads a backslash and Enter as a new line, so the prompt would stay in the input box and block
 *   each later prompt (backslash-escape). It is a prompt for the model (not-a-prompt): its first character that is
 *   not white space is not `!` (a shell command) or `?` (the help), its trimmed first line is not an exit word
 *   (`exit`, `quit`, `:q`, `:q!`, `:wq`, `:wq!`), and its command name is not `/exit` or `/quit`, each in any case.
 *   The target would open a mode or end, and a prompt that stops in a mode leaves its text in the input box.
 * Each argv names the workspace and the surface, and puts `--` right before the text or the key, so a text that
 * looks like a flag stays text. A peer message has no keys: the engine sends it, and this plan refuses it. Its text
 * passes only the empty and control-char rules (peerRefusal), in deliverPeer and in the confirm bar.
 * A prompt has more than 1 step, and a dialog can open between 2 of them. So before each next step the executor reads
 * the registry file and the screen again, and nextStepRefusal checks them: the read is 1 s old or less and the facts
 * do not lag it, the session is still idle with no wait, no dialog is on the screen, and the input box holds the text
 * of the steps before (typedBy). The executor stops at the first refusal, and no later step goes out.
 */
import { isSteppable, matchAnswersStep } from '../model/question-dialog.js'
import { matchAnswer, matchPermission, matchPrompt, matchTyped, readScreen, type ScreenMatch } from '../model/screen-match.js'
import { cleanValue } from '../sanitize.js'
import type { DeliverIntent, DeliverPlan, DeliverRefusal, ScreenRead, SessionFacts, TranscriptFacts } from '../types.js'

/** A screen read older than this, at the plan time, is stale. */
export const SCREEN_MAX_AGE_MS = 1000

/** State read more than this before the screen read is stale: the model can ask a new question in that time. */
export const FACTS_MAX_LAG_MS = 1000

/** The intents that go out as keys: every intent but the peer message. */
export type KeyIntent = Exclude<DeliverIntent, { kind: 'peer' }>

/**
 * The state of the target session at the plan time: its registry status and wait, and the open question of its
 * transcript, with the time of that read. A SessionFacts or a GodSession of the target, with factsAt, fits it.
 */
export type TargetFacts = Pick<SessionFacts, 'sessionId' | 'status' | 'waitingFor'> & {
  /** the open question, and the subagents and background tasks; absent between 2 steps of a prompt, which read the registry only */
  transcript?: Pick<TranscriptFacts, 'openQuestion'> & Partial<Pick<TranscriptFacts, 'agents'>>
  /** when the executor read the registry file and the transcript tail (engine time, in ms): just before the screen read */
  factsAt: number
}

/** a text with no visible character: white space, format characters and the other characters that draw nothing */
const BLANK = /^[\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}]*$/u
/** C0 but the newline, DEL, C1, and the line and paragraph separators: a character that cmux can type as a key or a break */
const CONTROL_CHAR = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/
/** a format character or a default ignorable character: it draws nothing, so the person cannot see it in the bar or in a ring */
export const HIDDEN_CHAR = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u
/** the first character that opens a mode in place of a prompt: `!` runs a shell command, `?` shows the help */
const MODE_MARKS = new Set(['!', '?'])
/** a first line that ends the session in place of a prompt */
const EXIT_WORDS = new Set(['exit', 'quit', ':q', ':q!', ':wq', ':wq!'])
/** a command that ends the session: Claude Code reads the command name up to the first white space */
const EXIT_COMMANDS = new Set(['/exit', '/quit'])
/** a backslash right before n, r or t, in either case: cmux send types the lowercase pairs as Enter or Tab */
const BACKSLASH_ESCAPE = /\\[nrtNRT]/
/** a backslash at the end of a line, with only spaces after it: Claude Code reads it and Enter as a new line */
const LINE_END_BACKSLASH = /\\[^\S\n]*$/m
/** a cmux workspace ref: `workspace:N` or a UUID, never a bare index that cmux resolves in the current window */
export const WORKSPACE_REF = /^(?:workspace:[0-9]{1,9}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/
/** a cmux surface ref: `surface:N` or a UUID */
export const SURFACE_REF = /^(?:surface:[0-9]{1,9}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/

/** True when the text is no prompt for the model: a shell command, the help, an exit word on its first line, or /exit or /quit. */
function isNotPrompt(text: string): boolean {
  const start = text.trimStart()
  const firstLine = (start.split('\n', 1)[0] ?? '').trim().toLowerCase()
  const command = (start.split(/\s/, 1)[0] ?? '').toLowerCase()
  return MODE_MARKS.has(start.charAt(0)) || EXIT_WORDS.has(firstLine) || EXIT_COMMANDS.has(command)
}

/**
 * Why a text that the person approves in the bar cannot go out, or undefined when it can: it holds no visible
 * character (empty), or it holds a character that the bar cannot show (control-char). A peer message takes only these
 * rules: the engine sends it, so no rule of the input box applies to it.
 */
export function peerRefusal(text: string): DeliverRefusal | undefined {
  if (BLANK.test(text)) return 'empty'
  if (CONTROL_CHAR.test(text) || HIDDEN_CHAR.test(text)) return 'control-char'
  return undefined
}

/** Why a prompt text cannot go out as typed keys, or undefined when it can: the rules of peerRefusal, then those of the input box. */
export function textRefusal(text: string): DeliverRefusal | undefined {
  const shown = peerRefusal(text)
  if (shown) return shown
  if (BACKSLASH_ESCAPE.test(text) || LINE_END_BACKSLASH.test(text)) return 'backslash-escape'
  if (isNotPrompt(text)) return 'not-a-prompt'
  return undefined
}

/** Why the state of the target session does not take the intent, or undefined when it does. */
function stateRefusal(intent: KeyIntent, facts: TargetFacts): DeliverRefusal | undefined {
  if (facts.sessionId !== intent.target.sessionId) return 'screen-changed'
  const open = facts.transcript?.openQuestion
  if (intent.kind === 'prompt') {
    if (facts.status !== 'idle' || facts.waitingFor !== undefined || open !== undefined) return 'screen-changed'
    return (facts.transcript?.agents ?? []).some((task) => task.isRunning) ? 'task-running' : undefined
  }
  if (intent.kind === 'permission') {
    if (facts.status !== 'waiting' || facts.waitingFor !== 'permission prompt') return 'screen-changed'
    return (facts.transcript?.agents ?? []).some((task) => task.isRunning && task.kind === 'subagent') ? 'task-running' : undefined
  }
  if (facts.status !== 'waiting' || facts.waitingFor !== 'input needed' || !open || open.toolUseId !== intent.toolUseId) return 'screen-changed'
  if (intent.kind === 'answers') {
    if (!isSteppable(open.questions)) return 'multi-question'
    const isSame = open.questions.length === intent.answers.length && open.questions.every((question, k) => {
      const answer = intent.answers[k]
      return answer !== undefined && question.header === answer.header && question.text === answer.question && question.options[answer.option - 1]?.label === answer.label
    })
    return isSame ? undefined : 'screen-changed'
  }
  const [question, ...more] = open.questions
  if (!question) return 'screen-changed'
  if (more.length > 0 || question.multiSelect) return 'multi-question'
  const sameOption = question.options[intent.option - 1]?.label === intent.label
  return question.header === intent.header && question.text === intent.question && sameOption ? undefined : 'screen-changed'
}

const refuse = (refusal: DeliverRefusal): DeliverPlan => ({ kind: 'refuse', refusal })

/** 1 call with no result in the fresh transcript read, as the transcript wrote it: its tool use id, its tool name and its raw input. */
export type OpenCall = { id: string; name: string; input: unknown }

/**
 * The raw side of a permission answer, from the executor: the raw text of the same screen read, the calls with no
 * result of the fresh transcript read, and the text cleaner of the home folder. It stays in the plan: only the digit or
 * a refusal leaves it.
 */
export type RawFacts = { screen: string; calls: readonly OpenCall[]; clean: (text: string) => string }

/**
 * The raw command of the 1 call that a permission answer binds to, or undefined. The fresh read must have exactly 1 call
 * with no result: the Bash call with the tool use id that the confirm bar showed, whose input, cleaned as the transcript
 * source cleans it, is the input that the person confirmed. The id comes first, because the cleaner gives 1 text for 2
 * calls that differ only in a secret: a call that opens after the confirmed one closed never passes. With 2 open calls
 * the dialog on the screen can be for either one, and the dialog of a command whose lines start with `│ ` looks like
 * the wrap of another command. So 2 open calls give a refusal.
 */
function boundCommand(intent: Extract<KeyIntent, { kind: 'permission' }>, raw: RawFacts): string | undefined {
  const [call, ...more] = raw.calls
  if (call === undefined || more.length > 0 || call.id !== intent.toolUseId || call.name !== 'Bash' || intent.tool !== 'Bash') return undefined
  if (JSON.stringify(cleanValue(call.input, raw.clean)) !== intent.input) return undefined
  const command = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>)['command'] : undefined
  return typeof command === 'string' ? command : undefined
}

/** The argv of 1 cmux call to the tab of the screen, with `--` right before the text or the key. */
function cmux(verb: 'send' | 'send-key', screen: ScreenRead, value: string): readonly string[] {
  return ['cmux', verb, '--workspace', screen.workspaceRef, '--surface', screen.surfaceRef, '--', value]
}

/** The plan of an answer or a permission: the digit as typed text, since send-key takes no digit. */
const digitPlan = (match: ScreenMatch, screen: ScreenRead): DeliverPlan =>
  match.isMatch ? { kind: 'send', steps: [cmux('send', screen, String(match.digit))] } : refuse(match.refusal)

/** The steps of a prompt: each line that is not empty as text, shift+enter between the lines, then enter. */
function promptSteps(text: string, screen: ScreenRead): (readonly string[])[] {
  const lines = text.split('\n')
  const steps = lines.flatMap((line, i) => [...(line === '' ? [] : [cmux('send', screen, line)]), ...(i < lines.length - 1 ? [cmux('send-key', screen, 'shift+enter')] : [])])
  return [...steps, cmux('send-key', screen, 'enter')]
}

/**
 * Why a screen read and the facts read before it cannot plan a key, or undefined: a tab ref in a form that the key
 * guard does not take (no-tab), a read of another session (screen-changed), a read older than SCREEN_MAX_AGE_MS at
 * `now`, or facts read more than FACTS_MAX_LAG_MS before the read or after it (stale-screen).
 */
function readRefusal(intent: KeyIntent, screen: ScreenRead, facts: TargetFacts, now: number): DeliverRefusal | undefined {
  if (!WORKSPACE_REF.test(screen.workspaceRef) || !SURFACE_REF.test(screen.surfaceRef)) return 'no-tab'
  if (screen.sessionId !== intent.target.sessionId) return 'screen-changed'
  const age = now - screen.readAt
  const lag = screen.readAt - facts.factsAt
  return !(age >= 0 && age <= SCREEN_MAX_AGE_MS) || !(lag >= 0 && lag <= FACTS_MAX_LAG_MS) ? 'stale-screen' : undefined
}

/**
 * The plan of 1 confirmed intent on 1 fresh screen read and the state of the target, made at `now` (engine time, in
 * ms). The text checks of a prompt come first, then the tab refs, the session of the read, the age of the read and
 * of the state, the state of the session, then the match of the screen. A permission answer needs `raw`, which the
 * executor always gives: with none it is refused.
 */
export function planDelivery(intent: KeyIntent, screen: ScreenRead, facts: TargetFacts, now: number, raw?: RawFacts): DeliverPlan {
  if (intent.kind === 'prompt') {
    const refusal = textRefusal(intent.text)
    if (refusal) return refuse(refusal)
  }
  const readRefused = readRefusal(intent, screen, facts, now) ?? stateRefusal(intent, facts)
  if (readRefused) return refuse(readRefused)
  const view = readScreen(screen.text)
  switch (intent.kind) {
    case 'answer':
      return digitPlan(matchAnswer(view, { ...intent, options: facts.transcript?.openQuestion?.questions[0]?.options ?? [] }), screen)
    case 'answers': {
      const match = matchAnswersStep(screen.text, { questions: facts.transcript?.openQuestion?.questions ?? [], answers: intent.answers }, 0)
      return match.isMatch ? { kind: 'send', steps: [...intent.answers.map((answer) => cmux('send', screen, String(answer.option))), cmux('send', screen, '1')] } : refuse(match.refusal)
    }
    case 'permission': {
      const command = raw === undefined ? undefined : boundCommand(intent, raw)
      return raw === undefined || command === undefined ? refuse('screen-changed') : digitPlan(matchPermission(view, intent, { text: raw.screen, command, clean: raw.clean }), screen)
    }
    case 'prompt': {
      const refusal = matchPrompt(view)
      return refusal ? refuse(refusal) : { kind: 'send', steps: promptSteps(intent.text, screen) }
    }
    default:
      return refuse('screen-changed')
  }
}

/** The text that the steps typed into the input box: the text of each send, and a line break for each shift+enter. */
export function typedBy(steps: readonly (readonly string[])[]): string {
  return steps.map((argv) => (argv[1] === 'send' ? (argv.at(-1) ?? '') : argv.at(-1) === 'shift+enter' ? '\n' : '')).join('')
}

/**
 * Why the next step of a prompt cannot go out, or undefined when it can: a fresh read of the screen at `now` (engine
 * time, in ms), the registry state of the target read just before it, and the text of the steps before. An answer
 * and a permission have 1 step, so they never take a next step.
 */
export function nextStepRefusal(intent: KeyIntent, screen: ScreenRead, facts: TargetFacts, typed: string, now: number): DeliverRefusal | undefined {
  if (intent.kind !== 'prompt') return 'screen-changed'
  if (!WORKSPACE_REF.test(screen.workspaceRef) || !SURFACE_REF.test(screen.surfaceRef)) return 'no-tab'
  if (screen.sessionId !== intent.target.sessionId || facts.sessionId !== intent.target.sessionId) return 'screen-changed'
  const age = now - screen.readAt
  const lag = screen.readAt - facts.factsAt
  if (!(age >= 0 && age <= SCREEN_MAX_AGE_MS) || !(lag >= 0 && lag <= FACTS_MAX_LAG_MS)) return 'stale-screen'
  if (facts.status !== 'idle' || facts.waitingFor !== undefined) return 'screen-changed'
  return matchTyped(screen.text, typed)
}

/**
 * Why step `step` of an answers intent cannot go out, or undefined when it can: a fresh read of the screen at `now`
 * (engine time, in ms), and the registry state and the open question of the transcript read just before it. The checks
 * of planDelivery apply, then the screen of that step (src/god/model/question-dialog.ts): question `step` from 0 under
 * the chips of the questions before it, or the review screen after the last question. Step 0 is the plan itself.
 */
export function nextAnswerRefusal(intent: KeyIntent, step: number, screen: ScreenRead, facts: TargetFacts, now: number): DeliverRefusal | undefined {
  if (intent.kind !== 'answers') return 'screen-changed'
  const refused = readRefusal(intent, screen, facts, now) ?? stateRefusal(intent, facts)
  if (refused) return refused
  const match = matchAnswersStep(screen.text, { questions: facts.transcript?.openQuestion?.questions ?? [], answers: intent.answers }, step)
  return match.isMatch ? undefined : match.refusal
}
