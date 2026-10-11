/**
 * The text gate of orangu god. Every text from outside (transcript text, a registry name, a cmux title, a screen)
 * goes through cleanText before it enters a shape of src/god/types.ts, so no text that the pane draws or a tool
 * gives can act on the terminal, and no secret or home path gets past the redaction.
 *
 * 1. removeControls takes out each whole terminal sequence (CSI and OSC, 7-bit and 8-bit) and each run of control
 *    characters (C0 but tab and newline, DEL, C1, the bidirectional controls, the zero-width characters and the tag
 *    characters). It puts 1 space where 2 words would meet, so they never join and a word never hides a secret start.
 *    The pane shows this text, after step 2.
 * 2. Then the orangu redaction runs on the whole text with the home folder that the engine gives. The god mod has no
 *    process, so the redaction cannot find the home folder alone, and an empty home rewrites no path.
 * 3. A secret that a control or a sequence split is whole only in another reading of the text. The redaction reads
 *    each reading too, and each place of the text that a reading hides is hidden in the pane text: each run of
 *    letters and digits that holds such a place, and nothing else (src/redact/origins.ts maps each reading back to
 *    the places of the text). The readings, each read once when 2 of them are the same:
 *    - the controls out, with no space: a key that a control split (`sk-ant-…<BEL>…`, `pass<SHY>word=…`);
 *    - the controls as 1 space each: a reader that does not know an 8-bit sequence sees a gap, and the hash after
 *      it is whole (`x<CSI>3f9a…`, where the pane takes `<CSI>3f` as 1 sequence and shows 38 hex characters);
 *    - each loose sequence out, with no space: a terminal or a simple reader may take a space as an intermediate
 *      byte, take the final byte or stop before it, and run a C0 control among the bytes or end the sequence there.
 *      So a sequence can take the first characters of a secret (`<ESC>[ m<hash>`), or leave a byte that the pane
 *      does not show between 2 parts of it (`password<ESC>[1 =…`);
 *    - each loose sequence as 1 space: a join glues 2 words, and the rule of a 40-hex hash needs a word edge and the
 *      Bearer rule a space, so only a gap shows them (`x<ESC> F<hash>`, `Bearer<ESC>(  <token>`);
 *    - the narrow strip: only C0 but tab and newline, DEL, C1 and the bidirectional controls out, with no space, as
 *      the text gate took them out before it knew the invisible characters. An invisible character that it keeps (a
 *      soft hyphen, a zero-width character) is a word edge, so a key after a word is whole here when a control
 *      split it (`w<ZWSP>ghp_…<BEL>…`). So the pane hides at least what that strip hid.
 *    Each reading shows a shape whole that the others do not. A text with no ESC and no 8-bit start of a sequence
 *    has only the first 2 readings and the narrow strip.
 * 4. cleanText keeps the cleaned text of each raw text that it read last, so a refresh cleans only a new text.
 * 5. cleanValue cleans a JSON value (a tool input) key by key. A parsed object has no key=value text, so the text
 *    rules of the redaction never see a pair. cleanValue asks the key test of the redaction about each key once, and
 *    it masks each value under a key that names a secret, and the value of a name and value pair whose name does.
 *
 * The sequences and classes are written as ranges of code points and never spell the escape byte, which only
 * src/cli/tty.ts may spell (test/lint.test.ts).
 */
import { applyEdits, type Edit, originsAfter } from '../redact/origins.js'
import { scrubWithOrigins } from '../redact/redact.js'
import { isSecretKey as namesSecret } from '../redact/secret-name.js'

/** The escape byte, made from its code point. */
const ESC = String.fromCharCode(27)
/**
 * A control character: C0 but tab and newline, DEL, C1, the bidirectional controls (U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069), and the characters that a model reads and the pane does not show: the soft hyphen
 * (U+00AD), the zero-width characters (U+200B to U+200D, U+2060 to U+2064, U+FEFF), the format characters U+034F,
 * U+180B to U+180F and U+206A to U+206F, U+17B4 and U+17B5, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the
 * interlinear annotation characters (U+FFF9 to U+FFFB), the variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF)
 * and the tag characters (U+E0000 to U+E007F). A character above U+FFFF is a surrogate pair.
 */
const CONTROL = '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb]|\\udb40[\\udc00-\\udc7f\\udd00-\\uddef]'
/**
 * A whole CSI sequence (ESC [ or U+009B): parameter bytes, intermediate bytes and 1 final byte. A space is an
 * intermediate byte only after a parameter (ESC [ 0 SP q), so a CSI with no parameter never reaches across a space.
 */
const CSI = `(?:${ESC}\\[|\\u009b)(?:[\\u0030-\\u003f]+[\\u0020-\\u002f]*|[\\u0021-\\u002f]*)[\\u0040-\\u007e]`
/**
 * A whole string sequence: OSC (ESC ] or U+009D, a window title), DCS (ESC P or U+0090), SOS (ESC X or U+0098), PM
 * (ESC ^ or U+009E) or APC (ESC _ or U+009F), ended by BEL, ESC \ or U+009C. Its text has no control. The 7-bit form
 * with no end runs to the next control or the end of its line, as a terminal reads it. A lone 8-bit introducer with no
 * end is 1 control (text that a wrong code page made often holds one).
 */
const STRING_TEXT = '[^\\u0000-\\u001f\\u007f-\\u009f]*'
const STRING_END = `(?:\\u0007|${ESC}\\\\|\\u009c)`
const STRING = `${ESC}[\\]PX^_]${STRING_TEXT}${STRING_END}?|[\\u0090\\u0098\\u009d-\\u009f]${STRING_TEXT}${STRING_END}`
/** Any other ESC sequence (ESC ( B, ESC 7): intermediate bytes and 1 final byte. A space after ESC is text, not a byte of it. */
const ESCAPE = `${ESC}[\\u0021-\\u002f]*[\\u0030-\\u007e]`
const SEQUENCES = new RegExp(`(?:${CSI}|${STRING}|${ESCAPE}|${CONTROL})+`, 'g')
const CONTROLS = new RegExp(`(?:${CONTROL})+`, 'g')
/**
 * The sequences as other readers may read them, for the hidden forms only (the pane shows the strict ones above). A
 * space is an intermediate byte. A reader may take the final byte or stop before it, and a C0 control among the bytes
 * (all but LF, CAN, SUB and ESC) may end the sequence or be run while the sequence goes on. An 8-bit string may have no
 * end. A sequence never takes a newline, so an open sequence at a line end cannot hide the next line.
 */
const C0_INSIDE = '[\\u0000-\\u0009\\u000b-\\u0017\\u0019\\u001c-\\u001f]'
const LOOSE_STRING = `(?:${ESC}[\\]PX^_]|[\\u0090\\u0098\\u009d-\\u009f])${STRING_TEXT}${STRING_END}?`
function looseSequences(c0Inside: boolean, final: boolean): RegExp {
  const inside = c0Inside ? `|${C0_INSIDE}` : ''
  const csi = `(?:${ESC}\\[|\\u009b)(?:[\\u0030-\\u003f]${inside})*(?:[\\u0020-\\u002f]${inside})*${final ? '[\\u0040-\\u007e]?' : ''}`
  const escape = `${ESC}(?:[\\u0020-\\u002f]${inside})*${final ? '[\\u0030-\\u007e]?' : ''}`
  return new RegExp(`(?:${csi}|${LOOSE_STRING}|${escape}|${CONTROL})+`, 'g')
}
const LOOSE = [true, false].flatMap((c0Inside) => [true, false].map((final) => looseSequences(c0Inside, final)))
/** ESC, or an 8-bit start of a sequence: with none of them in a text, each loose reading is its controls out. */
const SEQUENCE_START = new RegExp(`[${ESC}\\u0090\\u0098\\u009b\\u009d-\\u009f]`)
/** The controls of the narrow strip (the top of this file): C0 but tab and newline, DEL, C1 and the bidirectional ones. */
const NARROW_CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]+', 'g')

/** The mark that the redaction puts in place of a secret value. */
const REDACTED = '‹redacted›'

/** 1 space where 2 characters that are not white space would meet at `run`, and nothing at an edge or beside white space. */
function spaceBetween(text: string, at: number, run: string): string {
  return at > 0 && at + run.length < text.length && !/\s/.test(text[at - 1]!) && !/\s/.test(text[at + run.length]!) ? ' ' : ''
}

/**
 * The text with each terminal sequence and each run of control characters taken out. Where 2 other characters that
 * are not white space meet there, 1 space goes in, so they never join. At an edge or beside white space, nothing does.
 */
export function removeControls(text: string): string {
  return text.replace(SEQUENCES, (run, at: number) => spaceBetween(text, at, run))
}

/** A reading of the text, and for each of its characters the index in the text that it comes from (-1: a space that went in). */
interface Reading {
  text: string
  origins: Int32Array
}

/** Each run that `pattern` finds in the text, and what goes in its place. */
function cutsOf(text: string, pattern: RegExp, put: (at: number, run: string) => string): Edit[] {
  return Array.from(text.matchAll(pattern), (m): Edit => [m.index, m.index + m[0].length, put(m.index, m[0])])
}

function readingOf(text: string, cuts: readonly Edit[]): Reading {
  const read = applyEdits(text, cuts)
  return { text: read, origins: originsAfter(text, undefined, cuts, read.length) }
}

const sameCuts = (a: readonly Edit[], b: readonly Edit[]): boolean => a.length === b.length && a.every(([from, to, by], i) => from === b[i]![0] && to === b[i]![1] && by === b[i]![2])

/** The other readings of the text (see the top of this file), each different one once. */
function readings(text: string): Reading[] {
  // with no ESC and no 8-bit start, each loose reading is the controls out or the controls as spaces
  const patterns = [CONTROLS, ...(SEQUENCE_START.test(text) ? LOOSE : [])]
  const all = [...patterns.flatMap((pattern) => [cutsOf(text, pattern, () => ''), cutsOf(text, pattern, () => ' ')]), cutsOf(text, NARROW_CONTROLS, () => '')]
  return all.filter((cuts, i) => !all.slice(0, i).some((seen) => sameCuts(seen, cuts))).map((cuts) => readingOf(text, cuts))
}

/** Marks in `hidden` each place of the text that the redaction of the reading hides. */
function markHidden(reading: Reading, home: string, hidden: Uint8Array): void {
  const { origins } = scrubWithOrigins(reading.text, home)
  if (!origins) return
  const kept = new Uint8Array(reading.text.length)
  for (const at of origins) if (at >= 0) kept[at] = 1
  for (let i = 0; i < kept.length; i++) if (!kept[i] && reading.origins[i]! >= 0) hidden[reading.origins[i]!] = 1
}

const MARKER_OR_RUN = /‹[^›]*›|[A-Za-z0-9]+/g

/**
 * The text with each run of characters that `isHidden` names replaced by 1 marker. A run of letters and digits, or a
 * marker, that holds such a character goes whole. White space never goes.
 */
function hideIn(text: string, isHidden: (at: number) => boolean): string {
  const hide = new Uint8Array(text.length)
  for (let at = 0; at < text.length; at++) if (isHidden(at) && !/\s/.test(text[at]!)) hide[at] = 1
  if (!hide.includes(1)) return text
  for (const m of text.matchAll(MARKER_OR_RUN)) if (hide.subarray(m.index, m.index + m[0].length).includes(1)) hide.fill(1, m.index, m.index + m[0].length)
  let out = ''
  for (let at = 0; at < text.length; ) {
    let end = at
    while (end < text.length && hide[end] === hide[at]) end++
    out += hide[at] ? REDACTED : text.slice(at, end)
    at = end
  }
  return out
}

/**
 * The text with its sequences and controls spaced out and redacted (the pane text), and each place that another
 * reading hides hidden too: each reading maps back to the places of the text, and the pane text too.
 */
function cleanControls(text: string, home: string): string {
  const pane = readingOf(text, cutsOf(text, SEQUENCES, (at, run) => spaceBetween(text, at, run)))
  const { text: out, origins } = scrubWithOrigins(pane.text, home)
  if (pane.text === text) return out
  const hidden = new Uint8Array(text.length)
  for (const reading of readings(text)) markHidden(reading, home, hidden)
  return hideIn(out, (at) => {
    const from = origins ? origins[at]! : at
    return from >= 0 && pane.origins[from]! >= 0 && hidden[pane.origins[from]!] === 1
  })
}

/** The longest text that cleanText reads whole: a longer text is cut first, as below. */
const MAX_READ_CHARS = 262_144
/** The longest cleaned text that cleanText gives; its marker counts the rest. */
const MAX_SHOW_CHARS = 65_536

/**
 * A character that is never part of a secret: white space, a quote, a bracket, a comma or a semicolon. `=`, `:`,
 * `.`, `-`, `/` and `@` are in secrets (`password=…`, a JWT, a key, a URL password), so a cut never stops at them.
 */
const CUT_CHAR = /[\s"'`,;(){}[\]<>]/

/** The last CUT_CHAR at or before `limit`: there a cut keeps every run whole. 0 when there is none. */
function cutBefore(text: string, limit: number): number {
  let at = limit
  while (at > 0 && !CUT_CHAR.test(text[at]!)) at--
  return at
}

/** How much wider the text is that checks a cut, and how many characters the moves of a cut may clean again. */
const CHECK_CHARS = 4_096
const MOVE_CHARS = 2 * MAX_READ_CHARS

/**
 * Where a text over MAX_READ_CHARS is cut before it is read, and its cleaned part. A rule or a reading can read across
 * a CUT_CHAR (a quoted value with a space in it, its closing quote, or a sequence that a loose reading takes). So the
 * kept text, cleaned, must start the cleaned text that is CHECK_CHARS wider: if it does not, a rule saw a secret
 * across the cut, and the cut moves back to the CUT_CHAR before the first place where the 2 differ. There the kept
 * text holds the secret as it came in. When it does not, the cut moves back to half the kept text. Each move cleans
 * the kept text again: when the moves together would clean more than MOVE_CHARS, nothing is kept.
 */
function readCut(text: string, clean: (text: string) => string): { at: number; kept: string } {
  let at = cutBefore(text, MAX_READ_CHARS)
  const wide = clean(text.slice(0, at + CHECK_CHARS))
  let kept = clean(text.slice(0, at))
  for (let moved = 0; at > 0 && !wide.startsWith(kept); moved += at) {
    let same = 0
    while (kept[same] === wide[same]) same++
    const from = at - (kept.length - same)
    const asItCameIn = from >= 0 && text.slice(from, at) === kept.slice(same)
    at = cutBefore(text, asItCameIn ? from : Math.floor(at / 2))
    if (moved + at > MOVE_CHARS) at = 0
    kept = clean(text.slice(0, at))
  }
  return { at, kept }
}

/**
 * The cleaned text as the pane shows it: at most MAX_SHOW_CHARS, never ending inside a marker or a surrogate pair,
 * with `…+N chars` for the N characters that it does not show (and `lost` more that the read cut dropped).
 */
function shown(cleaned: string, lost: number): string {
  if (cleaned.length <= MAX_SHOW_CHARS && lost === 0) return cleaned
  let at = Math.min(cleaned.length, MAX_SHOW_CHARS)
  const open = cleaned.lastIndexOf('‹', at - 1)
  if (open >= 0 && cleaned.indexOf('›', open) >= at) at = open
  if (at > 0 && /[\ud800-\udbff]/.test(cleaned[at - 1]!)) at--
  return `${cleaned.slice(0, at)}…+${cleaned.length - at + lost} chars`
}

/**
 * The cleaned text of each raw text that cleanText read last, for 1 home. A refresh reads the same texts again (a
 * prompt stays in the last 10 turns), so it cleans only a text that it did not see. The text read longest ago goes
 * first when the cache holds more than CACHE_ENTRIES texts or more than CACHE_CHARS characters of raw and cleaned
 * text, and a text that is longer alone is not kept.
 */
const CACHE_ENTRIES = 4_096
const CACHE_CHARS = 8_388_608
const cache = new Map<string, string>()
let cacheHome = ''
let cacheChars = 0

function remembered(text: string, home: string, clean: () => string): string {
  if (home !== cacheHome) {
    cache.clear()
    cacheChars = 0
    cacheHome = home
  }
  const known = cache.get(text)
  if (known !== undefined) {
    cache.delete(text)
    cache.set(text, known)
    return known
  }
  const cleaned = clean()
  if (text.length + cleaned.length > CACHE_CHARS) return cleaned
  cache.set(text, cleaned)
  cacheChars += text.length + cleaned.length
  for (const [raw, value] of cache) {
    if (cache.size <= CACHE_ENTRIES && cacheChars <= CACHE_CHARS) break
    cache.delete(raw)
    cacheChars -= raw.length + value.length
  }
  return cleaned
}

/**
 * The text with no control character, its secrets masked and the home folder written as `~`. The whole text is
 * cleaned first, so each rule sees each secret whole, and then it is cut for the pane. Only a text over
 * MAX_READ_CHARS is cut before it is read.
 */
export function cleanText(text: string, home: string): string {
  return remembered(text, home, () => {
    const clean = (part: string): string => cleanControls(part, home)
    if (text.length <= MAX_READ_CHARS) return shown(clean(text), 0)
    const { at, kept } = readCut(text, clean)
    return shown(kept, text.length - at)
  })
}

/** The text cleaner that a source takes: cleanText with the home folder of the engine. */
export function textCleaner(home: string): (text: string) => string {
  return (text) => cleanText(text, home)
}

/**
 * True when the key names a secret (`API_KEY`, `password`, `authToken`, `api key`). The key test of the redaction
 * decides, on the key with its controls spaced out, and with them taken out, and with its space, tab and last colon
 * trimmed.
 */
function isSecretKey(key: string): boolean {
  return [removeControls(key), key.replace(SEQUENCES, ''), key.replace(CONTROLS, '')].some(namesSecret)
}

/**
 * The keys of a name and value pair, in lower case: an env list (`name`, `value`), the AWS forms (`Name` or `Key`,
 * and `Value`) and a CloudFormation parameter (`ParameterKey`, `ParameterValue`).
 */
const PAIR_NAMES = new Set(['name', 'key', 'parameterkey'])
const PAIR_VALUES = new Set(['value', 'parametervalue'])

/** The value with each value in it masked, a number or null too, and the shape of its objects and arrays kept. */
function masked(value: unknown, clean: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => masked(item, clean))
  if (!value || typeof value !== 'object') return REDACTED
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [clean(name), masked(item, clean)]))
}

/**
 * A JSON value (a tool input) with each key and each string cleaned, in any depth. Each value under a key that
 * names a secret is masked, and so is the value of a pair (PAIR_NAMES and PAIR_VALUES, in any case) whose name
 * names a secret.
 */
export function cleanValue(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, clean))
  if (!value || typeof value !== 'object') return value
  const entries = Object.entries(value)
  const isSecretPair = entries.some(([name, item]) => PAIR_NAMES.has(name.toLowerCase()) && typeof item === 'string' && isSecretKey(item))
  return Object.fromEntries(entries.map(([name, item]) => [clean(name), isSecretKey(name) || (isSecretPair && PAIR_VALUES.has(name.toLowerCase())) ? masked(item, clean) : cleanValue(item, clean)]))
}
