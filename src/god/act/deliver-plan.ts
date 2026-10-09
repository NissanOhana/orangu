/**
 * The deliver plan: turns what the person confirmed and a fresh screen of the target tab into the cmux argv lists
 * to run in order, or into exactly 1 refusal. It runs no command and reads no clock: the plan time and the screen
 * time come in as values, and the executor runs the lists.
 *
 * Every rule fails closed:
 * - the screen must be of the target session, from a tab whose refs are plain tokens, read 1 s or less before the
 *   plan;
 * - an answer is the option digit alone, with no Enter, and only when the screen still shows the confirmed header,
 *   question and label at that digit (src/god/model/screen-match.ts);
 * - a permission answer is the digit of the option labeled exactly Yes or exactly No, on a dialog that shows the
 *   confirmed shell command;
 * - a prompt is 1 `cmux send` for each line, `shift+enter` between the lines and `enter` at the end, only on an
 *   empty prompt row with no dialog on the screen. Its text may hold no control character but the newline, and no
 *   backslash right before n, r or t: cmux types those 2 characters as Enter or Tab, and has no escape for them.
 * Each argv names the workspace and the surface, and puts `--` right before the text or the key, so a text that
 * looks like a flag stays text. A peer message has no keys: the engine sends it, and this plan refuses it.
 */
import { matchAnswer, matchPermission, matchPrompt, readScreen, type ScreenMatch } from '../model/screen-match.js'
import type { DeliverIntent, DeliverPlan, DeliverRefusal, ScreenRead } from '../types.js'

/** A screen read older than this, at the plan time, is stale. */
export const SCREEN_MAX_AGE_MS = 1000

/** The intents that go out as keys: every intent but the peer message. */
export type KeyIntent = Exclude<DeliverIntent, { kind: 'peer' }>

/** C0 but the newline, DEL and C1: a control character that a terminal reads as a key or a sequence */
const CONTROL_CHAR = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/
/** a backslash right before n, r or t: cmux send types it as Enter or Tab */
const BACKSLASH_ESCAPE = /\\[nrt]/
/** a cmux workspace or surface ref (`workspace:2`, `surface:3`): a plain token that cannot read as a flag */
const REF = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

/** Why a prompt text cannot go out as typed keys, or undefined when it can. */
export function textRefusal(text: string): DeliverRefusal | undefined {
  if (/^[\s]*$/.test(text)) return 'empty'
  if (CONTROL_CHAR.test(text)) return 'control-char'
  if (BACKSLASH_ESCAPE.test(text)) return 'backslash-escape'
  return undefined
}

const refuse = (refusal: DeliverRefusal): DeliverPlan => ({ kind: 'refuse', refusal })

/** The argv of 1 cmux call to the tab of the screen, with `--` right before the text or the key. */
function cmux(verb: 'send' | 'send-key', screen: ScreenRead, value: string): readonly string[] {
  return ['cmux', verb, '--workspace', screen.workspaceRef, '--surface', screen.surfaceRef, '--', value]
}

const digitPlan = (match: ScreenMatch, screen: ScreenRead): DeliverPlan =>
  match.isMatch ? { kind: 'send', steps: [cmux('send-key', screen, String(match.digit))] } : refuse(match.refusal)

/** The steps of a prompt: each line that is not empty as text, shift+enter between the lines, then enter. */
function promptSteps(text: string, screen: ScreenRead): (readonly string[])[] {
  const lines = text.split('\n')
  const steps = lines.flatMap((line, i) => [...(line === '' ? [] : [cmux('send', screen, line)]), ...(i < lines.length - 1 ? [cmux('send-key', screen, 'shift+enter')] : [])])
  return [...steps, cmux('send-key', screen, 'enter')]
}

/**
 * The plan of 1 confirmed intent on 1 fresh screen read, made at `now` (engine time, in ms). The text checks of a
 * prompt come first, then the tab refs, the session and the age of the read, then the match of the screen.
 */
export function planDelivery(intent: KeyIntent, screen: ScreenRead, now: number): DeliverPlan {
  if (intent.kind === 'prompt') {
    const refusal = textRefusal(intent.text)
    if (refusal) return refuse(refusal)
  }
  if (!REF.test(screen.workspaceRef) || !REF.test(screen.surfaceRef)) return refuse('no-tab')
  if (screen.sessionId !== intent.target.sessionId) return refuse('screen-changed')
  const age = now - screen.readAt
  if (!(age >= 0 && age <= SCREEN_MAX_AGE_MS)) return refuse('stale-screen')
  const view = readScreen(screen.text)
  switch (intent.kind) {
    case 'answer':
      return digitPlan(matchAnswer(view, intent), screen)
    case 'permission':
      return digitPlan(matchPermission(view, intent), screen)
    case 'prompt': {
      const refusal = matchPrompt(view)
      return refusal ? refuse(refusal) : { kind: 'send', steps: promptSteps(intent.text, screen) }
    }
    default:
      return refuse('screen-changed')
  }
}
