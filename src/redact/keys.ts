/**
 * The vendor keys of the redaction, in 2 passes. At a word start, each key rule masks a key as before (./rules.ts
 * PATTERNS builds them from KEYS). Right after a letter, a digit or `_`, as a variable name, a JSON escape (`\nsk-…`), a
 * URL escape (`%22sk-…`) or a model string (`claude-opus-5_sk-…`) leaves a key, the glued pass masks it. That pass runs
 * after the rules that mask a whole run (the JWT, the e-mail and the key=value rules), so a run that holds a key prefix
 * still goes whole. It runs before the blob rule, and a key that the run of a blob holds goes with that run.
 */
import type { Mark } from './origins.js'
import { gluedJwts } from './scan.js'

/** A key rule: its prefix and its body as regex source, its marker, and the test of a glued key. */
interface Key {
  prefix: string
  body: string
  /**
   * The body of the glued regex, when its shape must hold from the start: the regex then fails at a word that ends
   * with the prefix and goes on to a key after it. A body test cannot do that, because the search goes on only after
   * the word and its run (`weighs_and_measures_table_ghp_…`).
   */
  gluedBody?: string
  by: string
  /**
   * True when the body of a key right after a word character fits the alphabet of its kind. It never asks for more
   * length than the word-start rule: a preview can cut a key, and a GitHub or npm token cut after 30 characters gives
   * its last 6, a checksum. A prefix that no word ends with needs no test. A prefix that words end with tests the class
   * or the character that its words lack (`risk-managementdepartment`, `weighs_and_measures_table`,
   * `pnpm_abcdefghijklmnopqrstuvwxyz01234`, `MSG.someVeryLongFieldName.anotherVeryLongField`).
   */
  glued: (body: string) => boolean
}

/** A digit, an uppercase and a lowercase letter: a word or an id with a prefix of words (risk-, task-) lacks one. */
const random = (body: string): boolean => /\d/.test(body) && /[A-Z]/.test(body) && /[a-z]/.test(body)
/** An uppercase letter: a kebab-case or a lowercase word lacks it, and a random base62 or base64url body has it. */
const upper = (body: string): boolean => /[A-Z]/.test(body)
const always = (): boolean => true

export const KEYS: readonly Key[] = [
  // sk-ant-<kind><version>-<93 base64url>AA (api03, admin01, oat01): flask-ant-design-… has no version
  { prefix: 'sk-ant-', body: '[A-Za-z0-9_-]{10,}', by: '‹anthropic-key›', glued: (body) => /^[a-z]+\d+-/.test(body) || random(body) },
  // base64url on each side of T3BlbkFJ: task-proj-… and task-admin-… words are kebab-case
  { prefix: 'sk-(?:proj|svcacct|admin)-', body: '[A-Za-z0-9_-]{20,}', by: '‹openai-project-key›', glued: upper },
  // 24 or 99 alphanumerics: a test name such as network_test_ConnectionRefused1 holds 1 digit
  { prefix: '(?:sk|rk|pk)_(?:live|test)_', body: '[A-Za-z0-9]{16,}', by: '‹stripe-key›', glued: (body) => random(body) && /\d\D*\d/.test(body) },
  { prefix: 'whsec_', body: '[A-Za-z0-9]{16,}', by: '‹stripe-webhook-secret›', glued: always },
  // 20 alphanumerics, T3BlbkFJ and 20 more: risk-, task- and Task-<HEX> ids lack a class
  { prefix: 'sk-', body: '[A-Za-z0-9]{20,}', by: '‹api-key›', glued: random },
  // 20 base62 characters first (github_pat_11 and 20 more), as snake_case words after ghs_ hold a `_` (weighs_and_…)
  { prefix: '(?:ghp|gho|ghu|ghs|ghr|github_pat)_', body: '[A-Za-z0-9_]{20,}', gluedBody: '[A-Za-z0-9]{20}[A-Za-z0-9_]*', by: '‹github-token›', glued: always },
  { prefix: 'glpat-', body: '[A-Za-z0-9_-]{20,}', by: '‹gitlab-token›', glued: always },
  // base62: a pnpm_ word is lowercase
  { prefix: 'npm_', body: '[A-Za-z0-9]{30,}', by: '‹npm-token›', glued: upper },
  // 34 letters, with no digit
  { prefix: 'hf_', body: '[A-Za-z0-9]{30,}', by: '‹huggingface-token›', glued: always },
  // 22 base64url characters, a dot and 43: a field path after MSG. has another length
  { prefix: String.raw`SG\.`, body: String.raw`[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}`, by: '‹sendgrid-key›', glued: (body) => /^[A-Za-z0-9_-]{22}\./.test(body) },
  { prefix: 'dop_v1_', body: '[A-Za-z0-9]{60,}', by: '‹digitalocean-token›', glued: always },
  // a user token ends in lowercase hex
  { prefix: 'xox[baprs]-', body: '[A-Za-z0-9-]{10,}', by: '‹slack-token›', glued: always },
  // 16 base32 characters, a few with no digit
  { prefix: 'AKIA', body: String.raw`[0-9A-Z]{16}\b`, by: '‹aws-key›', glued: always },
  { prefix: 'AIza', body: '[0-9A-Za-z_-]{30,}', by: '‹google-key›', glued: always },
]

/** The blob rule of ./rules.ts: a long hex or base64 run. The glued pass reads its runs. */
export const BLOB = /\b[A-Za-z0-9+/]{60,}={0,2}\b/g

/** Each key rule at any place, with its body in group 1. */
const GLUED = KEYS.map((key) => ({ re: new RegExp(`${key.prefix}(${key.gluedBody ?? key.body})`, 'g'), key }))
/** Each prefix and the start of a JWT in 1 regex: a text with none of them needs no other read. */
const ANY_PREFIX = new RegExp([...KEYS.map((key) => key.prefix), 'eyJ'].join('|'))
/** The longest prefix (`github_pat_`): a body that is no key can end with the start of the next prefix. */
const LONGEST_PREFIX = 11

type Span = [from: number, to: number, by: string]

/**
 * The parts to mask, in order and apart: each find, with each run of the blob rule that it overlaps. A find inside 1
 * run stays out, because the blob rule masks that run whole. A find that overlaps another one joins it.
 */
function spansWithBlobs(text: string, found: Span[]): Span[] {
  found.sort((a, b) => a[0] - b[0])
  const blobs = Array.from(text.matchAll(BLOB), (m): [number, number] => [m.index, m.index + m[0].length])
  const spans: Span[] = []
  let b = 0
  for (const [start, end, by] of found) {
    while (b < blobs.length && blobs[b]![1] <= start) b++
    let k = b
    while (k < blobs.length && blobs[k]![0] < end) k++
    if (k - b === 1 && blobs[b]![0] <= start && end <= blobs[b]![1]) continue
    const from = k > b ? Math.min(start, blobs[b]![0]) : start
    const to = k > b ? Math.max(end, blobs[k - 1]![1]) : end
    const last = spans.at(-1)
    if (last && from < last[1]) last[1] = Math.max(last[1], to)
    else spans.push([from, to, by])
  }
  return spans
}

/**
 * Each key and JWT that the rules before this pass did not mask, at any place: in effect, right after a letter, a
 * digit or `_`. A key needs the real shape of its kind (Key.glued), and a JWT a second part that is JSON too
 * (./scan.ts).
 */
export function maskGluedKeys(text: string, mark: Mark): string {
  if (!ANY_PREFIX.test(text)) return text
  const found: Span[] = gluedJwts(text).map(([from, to]): Span => [from, to, '‹jwt›'])
  for (const { re, key } of GLUED) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const end = m.index + m[0].length
      if (key.glued(m[1]!)) found.push([m.index, end, key.by])
      // a body that is no key can end with the start of the next prefix, so the search goes on from there
      else re.lastIndex = Math.max(m.index + 1, end - LONGEST_PREFIX)
    }
  }
  if (!found.length) return text
  let out = ''
  let done = 0
  for (const [from, to, by] of spansWithBlobs(text, found)) {
    out += text.slice(done, from) + by
    mark(from, to, by)
    done = to
  }
  return out + text.slice(done)
}
