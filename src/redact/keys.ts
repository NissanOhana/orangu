/**
 * The vendor keys of the redaction, in 2 passes. At a word start, each key rule masks a key as before (./rules.ts
 * PATTERNS builds them from KEYS). Right after a letter, a digit or `_`, as a variable name, a JSON escape (`\nsk-…`), a
 * URL escape (`%22sk-…`) or a model string (`claude-opus-5_sk-…`) leaves a key, the glued pass masks it. That pass runs
 * after the rules that mask a whole run (the JWT, the e-mail and the key=value rules), so a run that holds a key prefix
 * still goes whole. It runs before the blob rule, and a key that the run of a blob holds goes with that run.
 */
import type { Mark } from './origins.js'
import { gluedJwts } from './scan.js'

/** A key rule: its prefix and its body as regex source, its marker, and what a glued body holds. */
interface Key {
  prefix: string
  body: string
  by: string
  /**
   * What the body of a key right after a word character holds, as a random key of its kind does: `D` a digit (`DD` 2
   * digits), `U` an uppercase and `L` a lowercase letter. Words and ids that end with a prefix do not
   * (`risk-managementdepartment`, `task-0123456789abcdefghijkl`, `weighs_and_measures_table`, `pnpm_…`, `MSG.…`), and a
   * test name that ends with a digit holds 1 digit (`network_test_ConnectionRefused1`).
   */
  glued: string
}

export const KEYS: readonly Key[] = [
  { prefix: 'sk-ant-', body: '[A-Za-z0-9_-]{10,}', by: '‹anthropic-key›', glued: 'DUL' },
  { prefix: 'sk-proj-', body: '[A-Za-z0-9_-]{20,}', by: '‹openai-project-key›', glued: 'DUL' },
  { prefix: '(?:sk|rk|pk)_(?:live|test)_', body: '[A-Za-z0-9]{16,}', by: '‹stripe-key›', glued: 'DDUL' },
  { prefix: 'whsec_', body: '[A-Za-z0-9]{16,}', by: '‹stripe-webhook-secret›', glued: 'DUL' },
  { prefix: 'sk-', body: '[A-Za-z0-9]{20,}', by: '‹api-key›', glued: 'DUL' },
  { prefix: '(?:ghp|gho|ghu|ghs|ghr|github_pat)_', body: '[A-Za-z0-9_]{20,}', by: '‹github-token›', glued: 'DUL' },
  { prefix: 'glpat-', body: '[A-Za-z0-9_-]{20,}', by: '‹gitlab-token›', glued: 'DUL' },
  { prefix: 'npm_', body: '[A-Za-z0-9]{30,}', by: '‹npm-token›', glued: 'DUL' },
  { prefix: 'hf_', body: '[A-Za-z0-9]{30,}', by: '‹huggingface-token›', glued: 'DUL' },
  { prefix: String.raw`SG\.`, body: String.raw`[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}`, by: '‹sendgrid-key›', glued: 'DUL' },
  // a lowercase hex body
  { prefix: 'dop_v1_', body: '[A-Za-z0-9]{60,}', by: '‹digitalocean-token›', glued: 'DL' },
  { prefix: 'xox[baprs]-', body: '[A-Za-z0-9-]{10,}', by: '‹slack-token›', glued: 'DUL' },
  // an uppercase body
  { prefix: 'AKIA', body: String.raw`[0-9A-Z]{16}\b`, by: '‹aws-key›', glued: 'DU' },
  { prefix: 'AIza', body: '[0-9A-Za-z_-]{30,}', by: '‹google-key›', glued: 'DUL' },
]

/** The blob rule of ./rules.ts: a long hex or base64 run. The glued pass reads its runs. */
export const BLOB = /\b[A-Za-z0-9+/]{60,}={0,2}\b/g

/** Each key rule at any place, with its body in group 1. */
const GLUED = KEYS.map((key) => ({ re: new RegExp(`${key.prefix}(${key.body})`, 'g'), key }))
/** Each prefix and the start of a JWT in 1 regex: a text with none of them needs no other read. */
const ANY_PREFIX = new RegExp([...KEYS.map((key) => key.prefix), 'eyJ'].join('|'))
/** The longest prefix (`github_pat_`): a body that is no key can end with the start of the next prefix. */
const LONGEST_PREFIX = 11

/** True when the body holds what `glued` names (see Key.glued). */
function looksRandom(body: string, glued: string): boolean {
  let digits = 0
  let upper = false
  let lower = false
  for (const c of body) {
    if (c >= '0' && c <= '9') digits++
    else if (c >= 'A' && c <= 'Z') upper = true
    else if (c >= 'a' && c <= 'z') lower = true
  }
  return digits >= glued.split('D').length - 1 && (upper || !glued.includes('U')) && (lower || !glued.includes('L'))
}

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
 * digit or `_`. A body must look random (Key.glued), and a JWT needs a second part that is JSON too (./scan.ts).
 */
export function maskGluedKeys(text: string, mark: Mark): string {
  if (!ANY_PREFIX.test(text)) return text
  const found: Span[] = gluedJwts(text).map(([from, to]): Span => [from, to, '‹jwt›'])
  for (const { re, key } of GLUED) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const end = m.index + m[0].length
      if (looksRandom(m[1]!, key.glued)) found.push([m.index, end, key.by])
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
