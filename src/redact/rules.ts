/**
 * The text rules of the redaction, in their order, and how a rule runs on a text. A rule is a regex and its
 * replacement, or a scanner (./scan.ts) for a rule that a regex cannot read in a line. Each rule calls `mark` with each
 * part that it masks and the text that it writes there: ./redact.ts counts the parts, and scrubWithOrigins keeps the
 * origin of each character (./origins.ts).
 */
import { BLOB, KEYS, maskGluedKeys } from './keys.js'
import { type Edit, type Mark, originsAfter } from './origins.js'
import { maskAssignments, maskAuthorizations, maskEmails, maskJwts, maskQuotedPairs } from './scan.js'

/** A regex and its replacement, or a scanner. */
type Rule = [RegExp, string] | ((text: string, mark: Mark) => string)

export const PATTERNS: Rule[] = [
  // key material first: its body would otherwise be cut into the blobs and hashes below
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '‹private-key›'],
  // API keys / tokens (do these before generic ones). Each key rule, the JWT rule, Bearer and Authorization start at a
  // word start: a rule that starts inside a word splits a JWT, an address, a value or a blob (`helpdesk-…@…`,
  // `password=Xy9sk-…`), and the rule that would mask it whole then sees only a part of it. A key or a JWT right after
  // a word character goes in the glued pass below the e-mail rule (./keys.ts).
  ...KEYS.map(({ prefix, body, by }): Rule => [new RegExp(`\\b${prefix}${body}`, 'g'), by]),
  maskJwts,
  [/\b[A-Fa-f0-9]{40}\b/g, '‹hash40›'],
  // connection strings
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]+/gi, '‹db-url›'],
  // the password of any other URL (scheme://user:<password>@host): the scheme, the user, the host and the path stay.
  // The password runs to the last @ before the host, so a password that holds an @ goes whole. The scheme starts at any
  // place (`_https://`, `7postgres://`, a word of more than 32 characters before it), so the password of a connection
  // string that a word character starts goes too. The scheme is a lookbehind: a match starts at `://`, which the regex
  // finds fast, and the scheme stays out of the match.
  [/(?<=[a-z][a-z0-9+.-]{0,31})(:\/\/[^\s:/?#@'"]*):(?!‹)[^\s/?#'"]+@/gi, '$1:‹redacted›@'],
  // bearer/authorization. Bearer starts at a word start: glued, it is another word (useBearer, torchBearer).
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer ‹token›'],
  // the credential after any other scheme word of an Authorization header (Basic, Token, Negotiate, …), as a scanner
  // so that a credential that names a secret takes its inner pair with it
  maskAuthorizations,
  // a quoted key and its value, then key=value assignments with env-style names around the secret word
  // (AWS_SECRET_ACCESS_KEY=, DB_PASSWORD=, _authToken=). A value a rule above already masked (‹…›) keeps its marker,
  // but a URL password that the URL rule masked inside a longer value goes with that value.
  maskQuotedPairs,
  maskAssignments,
  // email, as a scanner that reads each run once
  maskEmails,
  // each key and JWT right after a letter, a digit or `_`, after the rules that mask a whole run (./keys.ts)
  maskGluedKeys,
  // long hex/base64 blobs
  [BLOB, '‹blob›'],
]

/** A regex rule: each match is marked once, and its replacement gets the captured key name for `$1`. */
function replaceRule(text: string, [re, rep]: [RegExp, string], mark: Mark): string {
  return text.replace(re, (...m: unknown[]) => {
    // a replacer callback returns its text verbatim, so `$1` (the captured key name) is expanded here
    const by = rep.replace(/\$(\d)/g, (_, i: string) => String(m[Number(i)] ?? ''))
    // the arguments end with the offset and the whole text (no rule has a named group)
    const at = m[m.length - 2] as number
    mark(at, at + (m[0] as string).length, by)
    return by
  })
}
export const applyRule = (text: string, rule: Rule, mark: Mark): string => (typeof rule === 'function' ? rule(text, mark) : replaceRule(text, rule, mark))

/**
 * The text as the redaction of a string with this home gives it, and the origin of each of its characters: the index
 * in `s` that the character comes from, or -1 for a character that a rule wrote (src/redact/origins.ts). No origins
 * when no rule changed the text. The god cleaner reads a text in more than 1 way, and hides in the text that it shows
 * each place that another reading hides (src/god/sanitize.ts).
 */
export function scrubWithOrigins(s: string, home: string): { text: string; origins: Int32Array | undefined } {
  let text = s
  let origins: Int32Array | undefined
  const homeRules = [homeRegExp(home), homeSlugRegExp(home)].flatMap((re): Rule[] => (re ? [[re, '~']] : []))
  for (const rule of [...PATTERNS, ...homeRules]) {
    const edits: Edit[] = []
    const next = applyRule(text, rule, (from, to, by) => void edits.push([from, to, by]))
    if (!edits.length) continue
    origins = originsAfter(text, origins, edits, next.length)
    text = next
  }
  return { text, origins }
}

/** The home folder as a path prefix, on a segment boundary, for the `~` rewrite; none for a home of under 2 characters. */
export function homeRegExp(home: string): RegExp | null {
  if (home.length < 2) return null
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // only when the prefix ends a path segment: <home>/x becomes ~/x, but a sibling prefix stays
  return new RegExp(escaped + '(?![A-Za-z0-9_.-])', 'g')
}

/**
 * The same home prefix as Claude Code encodes it inside a project slug (`/Users/<user>` → `-Users-<user>`, see
 * src/discover/discover.ts projectSlug), so `~/.claude/projects/-Users-me-Code-x/…` and a slug quoted in
 * prose lose the username too. Anchored on a segment boundary: `-Users-me2` is a different home.
 */
export function homeSlugRegExp(home: string): RegExp | null {
  if (home.length < 2) return null
  const slug = home.replace(/[^A-Za-z0-9-]/g, '-')
  if (slug.length < 2 || !/[A-Za-z0-9]/.test(slug)) return null
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?![A-Za-z0-9_.])', 'g')
}
