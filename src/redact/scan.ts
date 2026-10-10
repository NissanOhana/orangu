/**
 * The rules of the redaction that a regex cannot read in a line: a key=value assignment in free text, a quoted key
 * with its value (JSON, a Python dict, and JSON escaped inside a JSON string: \"token\":\"…\"), an Authorization
 * credential that is the name of an inner pair, and a JWT. A regex for them starts again at each place where a name or
 * a token could start, and reads the rest of a long run each time (cubic on `password-` repeated, quadratic on `eyJ-`
 * repeated). These scanners find the separator, the quoted key or the run end first, and ask the name test of
 * ./secret-name.ts once. They match what the regexes matched.
 * Each one calls `mark` with each part that it masks and the text that it writes there.
 */
import type { Mark } from './origins.js'
import { endsWithSecretWord, isSecretKey, isSecretName } from './secret-name.js'

const MASK = '‹redacted›'
const NAME_CHAR = /[A-Za-z0-9_.\/-]/
const SPACE = /\s/
/** the end of a line: a quoted value with no closing quote goes to it, and not into a CRLF */
const LINE_END = /[\n\r]/
/** a character of a key=value value: no space, no quote, and no marker of a rule that ran before */
const VALUE_CHAR = /[^\s'"‹]/

/**
 * After a value that ends in `=` or `:` right before a quote (`token="…"`), the end of that quoted text. When the
 * quote does not close on its line, the end of the line: the inner name goes with the outer value, so its text must
 * go too.
 */
function quotedTail(text: string, end: number): number {
  const quote = text[end]
  if ((quote !== '"' && quote !== "'") || (text[end - 1] !== '=' && text[end - 1] !== ':')) return end
  let at = end + 1
  while (at < text.length && !LINE_END.test(text[at]!) && text[at] !== quote) at++
  return text[at] === quote ? at + 1 : at
}

/** The closing quote of a quoted value on its line, or the end of the line when it has none. */
function lineEnd(text: string, at: number, quote: string): number {
  let end = at
  while (end < text.length && !LINE_END.test(text[end]!) && text[end] !== quote) end++
  return end
}

/** A 1-word name and the word before it, when the 2 make a secret word with a space in it (`api key`, `access key`). */
function twoWordName(text: string, start: number, end: number, done: number): boolean {
  if (text[start - 1] !== ' ' || start - 1 <= done) return false
  let word = start - 1
  while (word > done && /[A-Za-z]/.test(text[word - 1]!)) word--
  return word < start - 1 && endsWithSecretWord(text.slice(word, end))
}

function skipSpaces(text: string, at: number): number {
  while (at < text.length && SPACE.test(text[at]!)) at++
  return at
}

/** True when the white space from `from` to `to` holds the end of a line. */
function crossesLine(text: string, from: number, to: number): boolean {
  for (let at = from; at < to; at++) if (LINE_END.test(text[at]!)) return true
  return false
}

/** The mark of the URL rule: the password of `scheme://user:<password>@host`, with the @ after it. */
const URL_PASSWORD = '‹redacted›@'

/**
 * The end of the run of value characters that starts at `at`. The mark that the URL rule wrote in the run is part of
 * it (`DB_PASSWORD=https://user:‹redacted›@host`), as the run was before that rule. A value on a later line is this
 * run only, so it never goes past its first space.
 */
function valueCharsEnd(text: string, at: number): number {
  let end = at
  for (;;) {
    while (end < text.length && VALUE_CHAR.test(text[end]!)) end++
    if (!text.startsWith(URL_PASSWORD, end)) return end
    end += URL_PASSWORD.length
  }
}

/** The end of the value run that starts at `at`, with a quoted `name="…"` at its end. */
const valueRunEnd = (text: string, at: number): number => quotedTail(text, valueCharsEnd(text, at))

const opensValue = (c: string | undefined): boolean => c !== undefined && (VALUE_CHAR.test(c) || c === '"' || c === "'")
const isSeparator = (c: string | undefined): boolean => c === '=' || c === ':'
const BLANK = /[ \t]/

/** True when the run of name characters that ends at `end` names a secret. */
function namesSecretAt(text: string, end: number): boolean {
  let start = end
  while (start > 0 && NAME_CHAR.test(text[start - 1]!)) start--
  return start < end && isSecretName(text.slice(start, end))
}

/** The end of the name before `end`, with the blanks after it left out (`"token ` in a quoted value with no end). */
function endOfName(text: string, end: number): number {
  while (end > 0 && BLANK.test(text[end - 1]!)) end--
  return end
}

/**
 * True when the text before `end` ends with a secret name and a separator, with blanks or a quote after them
 * (`token:`, `"token: `, `"token="`).
 */
function endsWithInnerName(text: string, end: number): boolean {
  const at = endOfName(text, text[end - 1] === '"' || text[end - 1] === "'" ? end - 1 : end)
  return isSeparator(text[at - 1]) && namesSecretAt(text, endOfName(text, at - 1))
}

/** True when a value of 6 or more characters starts at `at`, after a quote or none, as the key=value rule reads a value. */
function longValueAt(text: string, at: number): boolean {
  const from = text[at] === '"' || text[at] === "'" ? at + 1 : at
  let end = from
  while (end < from + 6 && VALUE_CHAR.test(text[end] ?? ' ')) end++
  return end === from + 6
}

/** A masked part on its line (from its start to `end`), and each part on a later line that goes with it. */
interface InnerPairs {
  end: number
  later: Array<[from: number, to: number]>
}

/**
 * The end of a masked value with each inner pair in it. On its line, a separator after the value (`abc = <v>`), or a
 * value that ends in a separator with a value after it (`abc: <v>`), makes the value the name of an inner pair, and
 * that pair goes with it. A value that ends with a secret name and a separator (`token=,<v>`) takes its inner value
 * right after it too. A pair goes across a line only after a secret name and with a value of 6 or more characters
 * (`token\n: <v>`, `token:\n<v>`), as the key=value rule reads a value. That value is a part of its own, so each line
 * end stays, and a command on the next line keeps all but that value.
 */
function withInnerPairs(text: string, end: number): InnerPairs {
  const later: Array<[number, number]> = []
  let first = -1
  let start = 0
  for (;;) {
    let blank = end
    while (BLANK.test(text[blank] ?? '')) blank++
    const next = skipSpaces(text, end)
    let inner = -1
    const after = isSeparator(text[next]) ? skipSpaces(text, next + 1) : -1
    if (after >= 0 && (!crossesLine(text, end, after) || (namesSecretAt(text, endOfName(text, end)) && longValueAt(text, after)))) inner = after
    else if (opensValue(text[next]) && endsWithInnerName(text, end) && (next === blank || longValueAt(text, next))) inner = next
    else if (isSeparator(text[end - 1]) && blank > end && opensValue(text[blank])) inner = blank
    if (inner < 0) break
    const from = text[inner] === '"' || text[inner] === "'" ? inner + 1 : inner
    if (crossesLine(text, end, inner)) {
      if (first < 0) first = end
      else later.push([start, end])
      start = from
      end = valueCharsEnd(text, from)
    } else end = valueRunEnd(text, from)
  }
  if (first < 0) return { end, later }
  later.push([start, end])
  return { end: first, later }
}

/** The text with each later part of `pairs` masked alone, from `at` on: the line ends between the parts stay. */
function maskLater(text: string, at: number, pairs: InnerPairs, mark: Mark): string {
  let out = ''
  for (const [from, to] of pairs.later) {
    out += text.slice(at, from) + MASK
    mark(from, to, MASK)
    at = to
  }
  return out
}

/** The end of the last part of `pairs`. */
const lastEnd = (pairs: InnerPairs): number => pairs.later.at(-1)?.[1] ?? pairs.end

/** True when the value from `at` to `end` holds a secret name and a separator (`token=abc,…` after `"password": `). */
function holdsInnerName(text: string, at: number, end: number): boolean {
  for (let sep = at; sep < end; sep++) if (isSeparator(text[sep]) && namesSecretAt(text, sep)) return true
  return false
}

/**
 * Each `name=value` and `name: value` whose name (the run of letters, digits, `_`, `-`, `.` and `/` before the
 * separator, or that run and the word before it, as `api key`) names a secret, and whose value has 6 or more
 * characters, becomes `name=‹redacted›`. A quoted value goes to its closing quote, or to the end of the line when it
 * has none, as in the quoted pair rule. A quoted `name="…"` at the end of a value goes too (`passphrase=token="…"`).
 * A value on a later line is its first run, masked alone (`token:\n‹redacted›`), so each line end stays.
 */
export function maskAssignments(text: string, mark: Mark): string {
  let out = ''
  let done = 0
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '=' && text[at] !== ':') continue
    let nameEnd = at
    while (nameEnd > done && SPACE.test(text[nameEnd - 1]!)) nameEnd--
    let nameStart = nameEnd
    while (nameStart > done && NAME_CHAR.test(text[nameStart - 1]!)) nameStart--
    if (nameStart === nameEnd || !(isSecretName(text.slice(nameStart, nameEnd)) || twoWordName(text, nameStart, nameEnd, done))) continue
    const value = skipSpaces(text, at + 1)
    const opened = text[value] === '"' || text[value] === "'"
    // a value on a later line is its first run, after a quote or none: it never goes to the end of that line
    const later = crossesLine(text, at + 1, value)
    const quote = opened && !later ? text[value]! : ''
    const from = opened && later ? value + 1 : value
    const close = quote ? lineEnd(text, value + 1, quote) : -1
    const end = quote ? (text[close] === quote ? close + 1 : close) : later ? valueCharsEnd(text, from) : valueRunEnd(text, from)
    if ((quote ? close - value - 1 : end - from) < 6) continue
    const pairs = withInnerPairs(text, end)
    // the mark starts after the name, or after the last line end before the value, so each line end stays
    const keep = later ? from : crossesLine(text, nameEnd, at) ? at : nameEnd
    const by = later ? MASK : '=' + MASK
    out += text.slice(done, keep) + by
    mark(keep, pairs.end, by)
    out += maskLater(text, pairs.end, pairs, mark)
    done = lastEnd(pairs)
    at = done - 1
  }
  return out + text.slice(done)
}

/**
 * A quoted key, with at most 7 backslashes before each quote (3 levels of escape). A start is only at a quote, and it
 * reads to the next quote, so the key needs no length limit. The key, its separator and its value are on 1 line.
 */
const QUOTED_KEY = /(\\{0,7}["'])([^"'\\\n]+)\1([ \t]*[:=][ \t]*)/g
const OPEN_QUOTE = /\\{0,7}["']/y
/**
 * An unquoted value (a number) takes 6 or more characters, as in the key=value rule: up to a comma or a bracket, and
 * when that is shorter, the value as the key=value rule reads it.
 */
const UNQUOTED_VALUES = [/[^\s'"\\,;}\]‹]{6,}/y, /[^\s'"‹]{6,}/y]

/**
 * A quoted value of 6 or more items: it ends at the quote that opened it, so it never reaches into the next pair. When
 * it has no closing quote on its line, it ends at the end of the line.
 */
function quotedValue(text: string, at: number): { end: number; mask: string } | undefined {
  OPEN_QUOTE.lastIndex = at
  const quote = OPEN_QUOTE.exec(text)?.[0]
  if (!quote || text[at + quote.length] === '‹') return undefined
  let items = 0
  let k = at + quote.length
  while (k < text.length && !LINE_END.test(text[k]!)) {
    if (text.startsWith(quote, k)) return items >= 6 ? { end: k + quote.length, mask: quote + MASK + quote } : undefined
    k += text[k] === '\\' && text[k + 1] !== undefined && !LINE_END.test(text[k + 1]!) ? 2 : 1
    items++
  }
  return items >= 6 ? { end: k, mask: quote + MASK } : undefined
}

/** An unquoted value that holds an inner pair goes as far as the key=value rule reads that pair's value. */
function unquotedValue(text: string, at: number): { end: number; mask: string } | undefined {
  for (const value of UNQUOTED_VALUES) {
    value.lastIndex = at
    if (value.exec(text)) return { end: holdsInnerName(text, at, value.lastIndex) ? valueRunEnd(text, at) : value.lastIndex, mask: MASK }
  }
  return undefined
}

/**
 * Each quoted key that names a secret (the object key test) keeps its quotes, and its value is masked. A quoted
 * `name="…"` at the end of the value and each inner pair in it go too, as in the key=value rule (`"passphrase":
 * token="…"`, `"password": token: …`).
 */
export function maskQuotedPairs(text: string, mark: Mark): string {
  let out = ''
  let done = 0
  QUOTED_KEY.lastIndex = 0
  for (let m = QUOTED_KEY.exec(text); m; m = QUOTED_KEY.exec(text)) {
    if (!isSecretKey(m[2]!)) continue
    const at = m.index + m[0].length
    const value = quotedValue(text, at) ?? unquotedValue(text, at)
    if (!value) continue
    const pairs = withInnerPairs(text, quotedTail(text, value.end))
    out += text.slice(done, at) + value.mask
    mark(at, pairs.end, value.mask)
    out += maskLater(text, pairs.end, pairs, mark)
    done = QUOTED_KEY.lastIndex = lastEnd(pairs)
  }
  return out + text.slice(done)
}

/**
 * The credential after any other scheme word of an Authorization header (Basic, Token, Negotiate, …), with its `=`
 * padding. A name=value parameter (`Token token="…"`) is no credential: the key=value rule masks its value. An @ is
 * part of a credential, and a credential never ends right before an @ and a letter or a digit: it never leaves the
 * rest of an e-mail address that the e-mail rule would mask. The scheme and the credential stay on the line of the
 * header, so a command on the next line stays whole.
 */
const AUTHORIZATION = /\b((?:proxy-)?authorization\\{0,7}["']?[ \t]*[:=][ \t]*\\{0,7}["']?[a-z][a-z0-9_-]*)[ \t]+([A-Za-z0-9+/._~@-]{4,})(?![A-Za-z0-9+/._~-]|@[A-Za-z0-9]|[ \t]*:|[ \t]+=|=+[ \t]*["']?[A-Za-z0-9+/._~-])={0,2}/dgi
const TRAILING_NAME = /[A-Za-z0-9_.\/-]*$/

/**
 * Each Authorization credential becomes ‹token›, and the scheme word stays. A credential that ends with a secret name
 * (`Basic token={}…`, `Basic token\n: …`) is the name of an inner pair, and that pair goes with it.
 */
export function maskAuthorizations(text: string, mark: Mark): string {
  let out = ''
  let done = 0
  AUTHORIZATION.lastIndex = 0
  for (let m = AUTHORIZATION.exec(text); m; m = AUTHORIZATION.exec(text)) {
    const credential = m.indices![2]![1]
    const name = TRAILING_NAME.exec(m[2]!)![0]
    const pairs = isSecretName(name) ? withInnerPairs(text, credential) : { end: 0, later: [] }
    const end = Math.max(m.index + m[0].length, pairs.end)
    const by = `${m[1]} ‹token›`
    out += text.slice(done, m.index) + by
    mark(m.index, end, by)
    out += maskLater(text, end, pairs, mark)
    done = AUTHORIZATION.lastIndex = Math.max(end, lastEnd(pairs))
  }
  return out + text.slice(done)
}

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/
const DOMAIN_CHAR = /[A-Za-z0-9.-]/
const LETTER = /[A-Za-z]/

/**
 * The end of the address whose domain starts at `from`: the domain characters, then the last `.` with 2 or more
 * letters after it that end at a word end. -1 when there is none. It reads the domain once.
 */
function addressEnd(text: string, from: number): number {
  let end = from
  while (end < text.length && DOMAIN_CHAR.test(text[end]!)) end++
  for (let dot = end - 1; dot > from; dot--) {
    if (text[dot] !== '.') continue
    let last = dot + 1
    while (last < end && LETTER.test(text[last]!)) last++
    if (last - dot > 2 && (last === text.length || !WORD_CHAR.test(text[last]!))) return last
  }
  return -1
}

/**
 * Each e-mail address becomes ‹email›, as the leftmost matches of `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`
 * were: an address starts at a word boundary, so after an address the next one may start at the `.` or `-` that
 * follows it (2 addresses glued by a dot). Every start in a run fails the same way, so a failed run is not read again.
 */
export function maskEmails(text: string, mark: Mark): string {
  let out = ''
  let done = 0
  for (let at = 0; at < text.length; ) {
    const boundary = WORD_CHAR.test(text[at]!) !== (at > 0 && WORD_CHAR.test(text[at - 1]!))
    if (!boundary || !LOCAL_CHAR.test(text[at]!)) {
      at++
      continue
    }
    let local = at
    while (local < text.length && LOCAL_CHAR.test(text[local]!)) local++
    const end = text[local] === '@' ? addressEnd(text, local + 1) : -1
    if (end < 0) {
      at = text[local] === '@' ? local + 1 : Math.max(local, at + 1)
      continue
    }
    out += text.slice(done, at) + '‹email›'
    mark(at, end, '‹email›')
    done = at = end
  }
  return out + text.slice(done)
}

const TOKEN_CHAR = /[A-Za-z0-9_-]/
const WORD_CHAR = /\w/
const runEnd = (text: string, from: number): number => {
  let at = from
  while (at < text.length && TOKEN_CHAR.test(text[at]!)) at++
  return at
}

/**
 * Each JWT (`eyJ` at a word start, 10 or more token characters, `.`, 10 or more, `.`, 5 or more) becomes ‹jwt›. The
 * first part ends where its run ends, so every `eyJ` in 1 run shares that end and the next 2 parts: it reads them
 * once for the run.
 */
export function maskJwts(text: string, mark: Mark): string {
  let out = ''
  let done = 0
  let skipTo = 0
  for (let at = text.indexOf('eyJ'); at >= 0; at = text.indexOf('eyJ', at + 1)) {
    if (at < skipTo || (at > 0 && WORD_CHAR.test(text[at - 1]!))) continue
    const first = runEnd(text, at + 3)
    const second = text[first] === '.' ? runEnd(text, first + 1) : first
    const third = text[second] === '.' && second !== first ? runEnd(text, second + 1) : second
    if (first - at < 13 || second - first - 1 < 10 || text[second] !== '.' || third - second - 1 < 5) {
      skipTo = first
      continue
    }
    out += text.slice(done, at) + '‹jwt›'
    mark(at, third, '‹jwt›')
    done = skipTo = third
    at = third - 1
  }
  return out + text.slice(done)
}
