/**
 * words.json: the one input that Claude writes for a show-me render. It holds exactly 3 strings. Each one becomes
 * escaped text in one slot, so a value can never be markup, and no attribute value comes from it.
 *
 * The validation is strict on structure and has no length cap: a 10,000-character sentence renders whole. The STE
 * sentence rules give findings on the words (src/ste), and those findings never refuse a render.
 */
import { redactValue } from '../redact/redact.js'
import { checkText, type SteFinding } from '../ste/index.js'

/** The 3 strings that Claude writes in words.json. Every other slot value comes from orangu data. */
export interface Words {
  verdict: string
  summary: string
  improvementsTitle: string
}

/** the keys of words.json, in the order the findings are printed */
export const WORD_KEYS = ['verdict', 'summary', 'improvementsTitle'] as const
export type WordKey = (typeof WORD_KEYS)[number]

/** A C0 or C1 control character, DEL included: none may stand in a word (a newline and a tab too). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** An input that the render refuses. The message names the rule, never the refused value. */
export class ShowMeInputError extends Error {
  override readonly name = 'ShowMeInputError'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parse words.json: one object with exactly the keys verdict, summary and improvementsTitle, each a string that is
 * not empty and holds no control character. Any other key, a value that is not a string, or an empty string is an
 * error, and the render writes nothing.
 */
export function validateWords(raw: unknown): Words {
  if (!isRecord(raw)) throw new ShowMeInputError('words.json must hold one JSON object with the keys verdict, summary and improvementsTitle.')
  const keys = Object.keys(raw)
  if (keys.some((key) => !(WORD_KEYS as readonly string[]).includes(key))) {
    throw new ShowMeInputError('words.json may hold only the keys verdict, summary and improvementsTitle.')
  }
  const words: Partial<Words> = {}
  for (const key of WORD_KEYS) {
    const value = raw[key]
    if (typeof value !== 'string') throw new ShowMeInputError(`words.json: ${key} must be a string.`)
    if (!value.trim()) throw new ShowMeInputError(`words.json: ${key} is empty.`)
    if (CONTROL.test(value)) throw new ShowMeInputError(`words.json: ${key} holds a control character. Write each word on one line, with no tab.`)
    words[key] = value
  }
  return words as Words
}

/**
 * The 3 values after the default redaction of the data: a secret, a key or a home path that a model copied into a
 * value is masked before the fill and before the STE findings. data.json does not record a --no-redact choice, so
 * the render always redacts. Redaction only removes information.
 */
export function redactWords(words: Words): Words {
  return { verdict: redactValue(words.verdict), summary: redactValue(words.summary), improvementsTitle: redactValue(words.improvementsTitle) }
}

/** One STE finding on one word slot: advisory, never a reason to refuse the render. */
export interface WordFinding extends Omit<SteFinding, 'file'> {
  slot: WordKey
}

/** The STE findings of the 3 word slots, in key order. Each slot is scored as plain prose. */
export function wordFindings(words: Words): WordFinding[] {
  return WORD_KEYS.flatMap((slot) => checkText(words[slot]).findings.map(({ line, rule, text, hint }) => ({ slot, line, rule, text, hint })))
}
