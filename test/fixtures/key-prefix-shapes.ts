/**
 * Texts that hold a key prefix inside a longer run, each with the redaction that main gives it. A key rule that
 * started inside a word would mask only the part after the prefix, and the rule that masks the whole run (the JWT,
 * the e-mail, the key=value or the blob rule) would then miss the rest. Fake values only.
 */
const v = 'Zq9xW2pL7mN4vB8k'
const signature = ['Q2x1sk', '4fKq9ZtR7mW2pL8nB3vX6cY0dE5gH_rT1uV9wAbCdEfGhIjKlMnOpQrStUvWxYz0123456789-FAKEsig'].join('-')
const header = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'
const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNzAwMDAwMDAwfQ'
const rs256 = [header, payload, signature].join('.')
const googleInPayload = ['eyJhbGciOiJIUzI1NiJ9', `eyJzdWIiOiJ4AIzaSy${v}${v}ab`, v].join('.')

/**
 * RS256 JWTs whose signature of 342 base64url characters holds a letter, `sk-` and 20 letters and digits, at a place
 * that a seeded generator picks, as a random signature can hold them.
 */
function seededRs256(count: number): string[] {
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let seed = 20_261_010
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    return (seed >>> 8) % n
  }
  const text = (length: number, alphabet: string): string => Array.from({ length }, () => alphabet[next(alphabet.length)]).join('')
  return Array.from({ length: count }, () => {
    const body = text(342, B64URL)
    const at = next(318)
    const key = `${text(1, B64URL.slice(0, 62))}sk-${text(20, B64URL.slice(0, 62))}`
    return [header, payload, body.slice(0, at) + key + body.slice(at + key.length)].join('.')
  })
}

export const KEY_PREFIX_SHAPES: ReadonlyArray<readonly [text: string, redacted: string]> = [
  [rs256, '‹jwt›'],
  [`Bearer ${rs256}`, 'Bearer ‹jwt›'],
  ...seededRs256(64).map((jwt) => [jwt, '‹jwt›'] as const),
  ['helpdesk-internationalsupport@example.com', '‹email›'],
  ['helpdesk-supportteamnotifications@example.com', '‹email›'],
  [`password=Xy9sk-proj-${v}${v}`, 'password=‹redacted›'],
  [`${v}${v}AIzaSy${v}${v}${v}`, '‹blob›'],
  [`token ${googleInPayload} end`, 'token ‹jwt› end'],
]

const KEYS = [
  `sk-ant-api03-${v}`,
  `sk-proj-${v}${v}`,
  ['sk', 'live', `${v}${v}`].join('_'),
  ['whsec', `${v}${v}`].join('_'),
  `sk-${v}${v}`,
  ['ghp', `${v}${v}`].join('_'),
  `glpat-${v}${v}`,
  ['npm', `${v}${v}`].join('_'),
  ['hf', `${v}${v}`].join('_'),
  `SG.${v}${v}.${v}${v}`,
  ['dop', 'v1', `${v}${v}${v}${v}`].join('_'),
  `xoxb-${v}`,
  ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  `AIza${v}${v}`,
  `eyJ${v}aa.${v}bbbb.${v}`,
  `Bearer ${v}${v}`,
  `Authorization: Basic ${v}`,
]

/**
 * Each key, a JWT, a Bearer token and an Authorization credential right after a word character, as the final byte
 * of a colour code leaves it. Main leaves each text as it is, because each of these rules starts at a word start:
 * known debt, so that the rules start where main starts them. Fake values only.
 */
export const AFTER_WORD_CHAR: readonly string[] = KEYS.flatMap((key) => [`m${key}`, `_${key}`])
