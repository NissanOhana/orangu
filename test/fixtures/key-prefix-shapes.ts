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

/** Each key rule of the redaction, and a JWT, with the marker that each gets. Fake values only. */
const KEYS: ReadonlyArray<readonly [key: string, marker: string]> = [
  [`sk-ant-api03-${v}`, '‹anthropic-key›'],
  [`sk-proj-${v}${v}`, '‹openai-project-key›'],
  [['sk', 'live', `${v}${v}`].join('_'), '‹stripe-key›'],
  [['whsec', `${v}${v}`].join('_'), '‹stripe-webhook-secret›'],
  [`sk-${v}${v}`, '‹api-key›'],
  [['ghp', `${v}${v}`].join('_'), '‹github-token›'],
  [['github', 'pat', `${v}${v}`].join('_'), '‹github-token›'],
  [`glpat-${v}${v}`, '‹gitlab-token›'],
  [['npm', `${v}${v}`].join('_'), '‹npm-token›'],
  [['hf', `${v}${v}`].join('_'), '‹huggingface-token›'],
  [`SG.${v}${v}.${v}${v}`, '‹sendgrid-key›'],
  [['dop', 'v1', `${v}${v}${v}${v}`].join('_'), '‹digitalocean-token›'],
  [`xoxb-${v}`, '‹slack-token›'],
  [['AKIA', 'IOSFODNN7EXAMPLE'].join(''), '‹aws-key›'],
  [`AIza${v}${v}`, '‹google-key›'],
  [[header, payload, v].join('.'), '‹jwt›'],
]

/**
 * Each key and a JWT right after `_`, a letter and a digit, and inside a model id, as a variable name, a JSON escape
 * (`\nsk-…`), a URL escape (`%22sk-…`) or a model string leaves it, with the marker in its place. Fake values only.
 */
export const GLUED_KEYS: ReadonlyArray<readonly [text: string, redacted: string]> = KEYS.flatMap(([key, marker]) =>
  ['_', 'm', '7', 'claude-opus-5_'].map((glue) => [`${glue}${key}`, `${glue}${marker}`] as const),
)

/**
 * An Authorization credential after a header name that a word character starts (an environment dump, a JSON escape)
 * and before a scheme word, and a URL password whose scheme a word character starts. Fake values only.
 */
export const GLUED_HEADERS: ReadonlyArray<readonly [text: string, redacted: string]> = [
  [`HTTP_AUTHORIZATION=Basic ${v}`, 'HTTP_AUTHORIZATION=Basic ‹token›'],
  // a scheme word of 6 or more characters is the value of the secret name, as at a word start
  [`proxy_authorization: Negotiate ${v}`, 'proxy_authorization=‹redacted› ‹token›'],
  [`mAuthorization: Basic ${v}`, 'mAuthorization: Basic ‹token›'],
  [`_Authorization: Basic ${v}`, '_Authorization: Basic ‹token›'],
  [`7Authorization: Token ${v}`, '7Authorization: Token ‹token›'],
  [`{"raw": "GET / HTTP/1.1\\r\\nAuthorization: Basic ${v}\\r\\n"}`, '{"raw": "GET / HTTP/1.1\\r\\nAuthorization: Basic ‹token›\\r\\n"}'],
  // a host with no dotted name: the e-mail rule does not take the password with it
  [`_https://deploy:${v}@localhost:8080/r.git`, '_https://deploy:‹redacted›@localhost:8080/r.git'],
  [`7postgres://app:${v}@db:5432/app`, '7postgres://app:‹redacted›@db:5432/app'],
  [`${'a'.repeat(40)}https://deploy:${v}@host/x`, `${'a'.repeat(40)}https://deploy:‹redacted›@host/x`],
]

/**
 * The glued shapes that stay, because glued they are another word: `Bearer` after a letter (useBearer), a JWT shape
 * whose second part is no JSON object (a dotted camelCase path such as `surveyJs….items`), and an authorization name
 * with no scheme word after it (code). Fake values only.
 */
export const KEEP_WORD_START: readonly string[] = [
  `mBearer ${v}${v}`,
  `_Bearer ${v}${v}`,
  `meyJ${v}aa.${v}bbbb.${v}`,
  `_eyJ${v}aa.${v}bbbb.${v}`,
  'installation_authorization = await client.check',
  'requireAuthorization: the reader',
]
