/**
 * The text gate of orangu god. Every text from outside (transcript text, a registry name, a cmux title, a screen)
 * goes through cleanText before it enters a shape of src/god/types.ts, so no text that the pane draws or a tool
 * gives can act on the terminal, and no secret or home path gets past the redaction.
 *
 * 1. removeControls removes the C0 controls but tab and newline, then DEL and the C1 controls. ESC and BEL are in
 *    the first range: a bare ESC starts a terminal sequence, and a C1 character (U+009B) is a 1-byte sequence
 *    start. With ESC gone, the rest of a sequence (`[31m`) stays as inert text. It also removes the bidirectional
 *    controls, which can change the order of the text that the pane and the confirm bar show.
 * 2. Then the orangu redaction runs with the home folder that the engine gives. The god mod has no process, so the
 *    redaction cannot find the home folder alone, and an empty home rewrites no path.
 * 3. cleanValue cleans a JSON value (a tool input) key by key. JSON puts a quote between a key and its value, so
 *    the key=value rule of the redaction never sees a pair. cleanValue asks that rule about each key once, and it
 *    masks each value under a key that names a secret, and the value of a name and value pair whose name does.
 *
 * The control strip runs first, so a control character inside a secret cannot hide the secret from the redaction.
 * The character class is written as ranges of code points and never spells the escape byte, which only
 * src/cli/tty.ts may spell (test/lint.test.ts).
 */
import { redactValue } from '../redact/redact.js'

/**
 * C0 but tab (U+0009) and newline (U+000A), DEL (U+007F), C1 (U+0080 to U+009F), and the bidirectional controls:
 * U+061C, U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069.
 */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** The mark of the key=value rule of the redaction. */
const REDACTED = '‹redacted›'

/** The text with no C0 control but tab and newline, no DEL, no C1 control and no bidirectional control. */
export function removeControls(text: string): string {
  return text.replace(CONTROLS, '')
}

/** The text with no control character, its secrets masked and the home folder written as `~`. */
export function cleanText(text: string, home: string): string {
  return redactValue(removeControls(text), { home })
}

/** The text cleaner that a source takes: cleanText with the home folder of the engine. */
export function textCleaner(home: string): (text: string) => string {
  return (text) => cleanText(text, home)
}

/**
 * True when the key names a secret (`API_KEY`, `password`, `authToken`). The key=value rule of the redaction
 * decides, on the key with its space, tab and last colon trimmed and a value that the rule always masks.
 */
function isSecretKey(key: string): boolean {
  const name = key.trim().replace(/:$/, '').trim()
  return name !== '' && cleanText(`${name}=xxxxxxxxxx`, '').includes(REDACTED)
}

/** The value with each value in it masked, a number or null too, and the shape of its objects and arrays kept. */
function masked(value: unknown, clean: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => masked(item, clean))
  if (!value || typeof value !== 'object') return REDACTED
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [clean(name), masked(item, clean)]))
}

/**
 * A JSON value (a tool input) with each key and each string cleaned, in any depth. Each value under a key that
 * names a secret is masked, and so is the `value` of an object whose `name` or `key` names a secret.
 */
export function cleanValue(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, clean))
  if (!value || typeof value !== 'object') return value
  const entries = Object.entries(value)
  const isSecretPair = entries.some(([name, item]) => (name === 'name' || name === 'key') && typeof item === 'string' && isSecretKey(item))
  return Object.fromEntries(entries.map(([name, item]) => [clean(name), isSecretKey(name) || (isSecretPair && name === 'value') ? masked(item, clean) : cleanValue(item, clean)]))
}
