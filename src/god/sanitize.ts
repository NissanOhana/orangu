/**
 * The text gate of orangu god. Every text from outside (transcript text, a registry name, a cmux title, a screen)
 * goes through cleanText before it enters a shape of src/god/types.ts, so no text that the pane draws or a tool
 * gives can act on the terminal, and no secret or home path gets past the redaction.
 *
 * 1. removeControls removes the C0 controls but tab and newline, then DEL and the C1 controls. ESC and BEL are in
 *    the first range: a bare ESC starts a terminal sequence, and a C1 character (U+009B) is a 1-byte sequence
 *    start. With ESC gone, the rest of a sequence (`[31m`) stays as inert text.
 * 2. Then the orangu redaction runs with the home folder that the engine gives. The god mod has no process, so the
 *    redaction cannot find the home folder alone, and an empty home rewrites no path.
 * 3. cleanValue cleans a JSON value (a tool input) key by key. It cleans a string under a key as `<key>=<value>`,
 *    because the key=value rule of the redaction needs the key, and JSON puts a quote between a key and its value.
 *
 * The control strip runs first, so a control character inside a secret cannot hide the secret from the redaction.
 * The character class is written as ranges of code points and never spells the escape byte, which only
 * src/cli/tty.ts may spell (test/lint.test.ts).
 */
import { redactValue } from '../redact/redact.js'

/** C0 but tab (U+0009) and newline (U+000A), then DEL (U+007F) and C1 (U+0080 to U+009F). */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** The text with no C0 control but tab and newline, no DEL and no C1 control. */
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
 * A string under a key, cleaned as `<key>=<value>` and given back without the key: the key=value rule of the
 * redaction masks a value whose key names a secret (`API_KEY`, `password`), and the value alone shows nothing.
 */
function cleanKeyed(key: string, value: string, clean: (text: string) => string): string {
  const prefix = `${clean(key)}=`
  const joined = clean(`${key}=${value}`)
  return joined.startsWith(prefix) ? joined.slice(prefix.length) : clean(value)
}

function cleanUnder(value: unknown, clean: (text: string) => string, key: string | undefined): unknown {
  if (typeof value === 'string') return key === undefined ? clean(value) : cleanKeyed(key, value, clean)
  if (Array.isArray(value)) return value.map((item) => cleanUnder(item, clean, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [clean(name), cleanUnder(item, clean, name)]))
}

/**
 * A JSON value (a tool input) with each key and each string cleaned, in any depth. A string under a key is cleaned
 * with its key, and an array item has the key of its array, so `{ "API_KEY": "..." }` shows no secret.
 */
export function cleanValue(value: unknown, clean: (text: string) => string): unknown {
  return cleanUnder(value, clean, undefined)
}
