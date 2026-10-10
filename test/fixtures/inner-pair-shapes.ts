/**
 * Texts where a masked part is itself the name of an inner pair (a secret name and a separator, with the secret after
 * it), or where a rule masks only a part of a run. Main masks the secret in each of them, because its key=value rule
 * starts again at the inner name and reads the whole run, and its e-mail rule reads the whole address. The redaction
 * must mask it too. Fake values only.
 */
export const INNER_SECRET = 'Zq9xW2pL7mN4vB8k'
/** Each 4-character part of INNER_SECRET, so a test sees a part of it too. */
export const INNER_SECRET_PART = /Zq9x|W2pL|7mN4|vB8k/

const v = INNER_SECRET
const keys = ['"password"', "'password'", '"api_key"', '"token"', '"secret"', '"Authorization"', '\\"token\\"', '"passphrase"']
const separators = [': ', ':', '=', ' = ', ' : ']
const inners = ['token', 'secret', 'passwd', 'password', 'api_key', 'auth_token', 'apiKey', 'access_key']
const tails = [`: ${v}`, `= ${v}`, `="${v} x"`, `: "${v} x"`, `:\n${v}`, `= '${v}'`]

/** A quoted secret key, its separator, an unquoted inner name and its own separator, then the secret: 1,920 texts. */
export const INNER_PAIR_FORMS: readonly string[] = keys.flatMap((key) =>
  separators.flatMap((separator) => inners.flatMap((inner) => tails.map((tail) => `{${key}${separator}${inner}${tail}}`))),
)

export const INNER_PAIR_RELATIVES: readonly string[] = [
  // a key=value value, or a quoted value with no closing quote, that ends in a separator at the end of its line
  `authorization=abcpassword=\n${v}`,
  `Authorization: abcpassword=\n${v}`,
  `passphrase: abc_token=\n${v}`,
  `private_key=abcpassword=\t\n ${v}`,
  `"Authorization": "DB_PASSWORD=\n${v}`,
  `{"secretKey": "xyz_secret:\n${v}`,
  `"Authorization": "token: \n${v}`,
  // an inner pair right after the separator, or after a comma that ends an unquoted value
  `{"password": token=,${v}}`,
  `{"password": abc=token:\n${v}}`,
  `{"password": token=abc,${v}}`,
  // a quoted value whose closing quote opens the value of its inner pair
  `{"password": "abc passwd="${v} x"}`,
  `password="abc token="${v} x"`,
  // an Authorization credential that a separator and a value follow
  `Authorization: Basic token={}${v}`,
  `Authorization: XL 8PEdb.secret=:${v}`,
  `Authorization: Basic token\n: ${v}`,
  `Authorization: Basic token=\n${v}`,
  `Authorization: Basic token= {}${v}`,
  `Authorization: Basic token="{${v} x"`,
  `Authorization: Basic abctoken\n=${v}`,
  // a URL password inside the value of a secret name, or after a user that names a secret
  `DB_PASSWORD=https://user:pw12345@${v}.example.com/x`,
  `mypassword://u:pw@${v}`,
  `https://token:abcdef@${v}.example.com/x`,
  // an Authorization credential that an e-mail address goes on from
  `Authorization: Basic abcd@${v}.example.com`,
  `Authorization: X\nsecretKey@${v}.example.com://`,
]

/**
 * A command on the next line, as a confirm bar shows it, and the part of that line that must stay: all of it, or the
 * quoted command after a first run of 6 or more characters (a value on a later line is its first run only).
 */
export const NEXT_LINES: ReadonlyArray<readonly [line: string, stays: string]> = [
  ['sudo rm -rf ~/x', 'sudo rm -rf ~/x'],
  ['"sudo rm -rf ~/x"', '"sudo rm -rf ~/x"'],
  ['deploy="sudo rm -rf ~/x"', '"sudo rm -rf ~/x"'],
]

/**
 * Lines that end with a masked value or a secret name: an inner pair, a quoted tail, a quote with no end, a URL
 * password and an Authorization header. The secret, when there is one, is on the line itself.
 */
export const LINE_END_SHAPES: readonly string[] = [
  `password=x=y="${v}"`,
  `passphrase=token="${v}`,
  `password: abc=`,
  `password=${v} token:`,
  `{"password": token:`,
  `{"password": abc=token=`,
  `{"password": "abc token="`,
  `"Authorization": "token: `,
  `"api_key": "${v}`,
  `password="abc token="`,
  `DB_PASSWORD=https://user:${v}@host token=`,
  `Authorization: Basic token=`,
  `Authorization: Basic ${v}`,
  'Authorization: Basic',
  'authorization:',
  'token\\":\\"',
  'password=',
  '{"password":',
  `{'token' = "${v}",`,
]
