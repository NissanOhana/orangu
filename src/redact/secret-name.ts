/**
 * The name of a secret, as a key or a variable spells it: the 1 source for the key=value and quoted pair rules
 * (./scan.ts) and for the key test of an object (redactValue in ./redact.ts, and cleanValue in src/god/sanitize.ts).
 * A name ends with a secret word and then any separator parts: AWS_SECRET_ACCESS_KEY, DB_PASSWORD, _authToken,
 * clientSecret, apiKeys, token_count. Any text may come before the word. A bare plural such as `tokens` names no
 * secret.
 */

/** The secret words. `sep` is the separators that may sit inside a word (api_key, api-key, api key). */
const secretWords = (sep: string): string =>
  `password|passwd|passphrase|secret[${sep}]?keys?|secret|token|api[${sep}]?keys?|access[${sep}]?keys?|private[${sep}]?keys?|authorization|auth`

/**
 * In free text a name is a run of letters, digits, `_`, `-`, `.` and `/` (`db.password`, `vault/token`), so prose
 * such as "the auth flow: …" is no name. After the secret word only `_` and `-` parts may follow (`DB_PASSWORD_PROD`):
 * a `.` or a `/` there starts a file name or a path (`password.file`, `src/lib/auth.ts:13`), not a name.
 */
const NAME_SEPARATORS = '_./-'
const NAME_END_SEPARATORS = '_-'
/** A quoted key and an object key have a clear end, so a space, `.`, `:` and `/` separate its parts too. */
const KEY_SEPARATORS = ' _.:/-'
const wordAtEnd = (sep: string): RegExp => new RegExp(`(?:${secretWords(sep)})$`, 'i')
const [NAME_WORD, KEY_WORD] = [wordAtEnd(NAME_SEPARATORS), wordAtEnd(KEY_SEPARATORS)]
const ALPHANUMERIC = /[A-Za-z0-9]/

/**
 * True when the name ends with a secret word and then any parts that one of `sep` starts. It cuts the parts off the
 * end and looks for a word before each cut, so it reads the name once at any length, where a regex reads it once for
 * each place a name could start (cubic on `password-` repeated). The longest word has 13 characters, so 16 before
 * each cut hold it.
 */
function endsWithSecretName(name: string, sep: string, word: RegExp): boolean {
  let end = name.length
  while (end > 0) {
    if (word.test(name.slice(Math.max(0, end - 16), end))) return true
    let start = end
    while (start > 0 && ALPHANUMERIC.test(name[start - 1]!)) start--
    if (start === end || start === 0 || !sep.includes(name[start - 1]!)) return false
    end = start - 1
  }
  return false
}

/** True when a run of letters, digits, `_`, `-`, `.` and `/` (the name of a key=value in free text) names a secret. */
export const isSecretName = (run: string): boolean => endsWithSecretName(run, NAME_END_SEPARATORS, NAME_WORD)

/** True when the text ends with a secret word, with a space allowed in it (`api key`): a name of 2 words in free text. */
export const endsWithSecretWord = (text: string): boolean => KEY_WORD.test(text.slice(-16))

/** Keys come back on each record, so each answer is kept, for keys of up to 256 characters and up to 4,096 keys. */
const answers = new Map<string, boolean>()

/**
 * The value under a key that names a secret: each scalar in it masked whole, at any depth, with the shape, null and
 * '' kept. `mark` counts each masked scalar.
 */
export function maskedSecret(value: unknown, mark: () => void): unknown {
  if (value && typeof value === 'object') {
    return Array.isArray(value) ? value.map((item) => maskedSecret(item, mark)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskedSecret(v, mark)]))
  }
  if (!['string', 'number', 'boolean'].includes(typeof value) || value === '') return value
  mark()
  return '‹redacted›'
}

/** True when an object key or a quoted key names a secret, with its space and last colon trimmed. */
export function isSecretKey(key: string): boolean {
  const known = answers.get(key)
  if (known !== undefined) return known
  const answer = endsWithSecretName(key.trim().replace(/:$/, '').trim(), KEY_SEPARATORS, KEY_WORD)
  if (key.length <= 256) {
    if (answers.size >= 4096) answers.clear()
    answers.set(key, answer)
  }
  return answer
}
