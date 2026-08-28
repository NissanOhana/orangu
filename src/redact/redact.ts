/**
 * Redaction. The analysis object already excludes raw prompt/thinking/result *text* by construction
 * (only previews and summaries survive). This module scrubs those short strings for obvious secrets and PII
 * before they ever reach a report, and can strip previews entirely for a maximally private artifact.
 *
 * `stripText` removes prose the transcript authored; it never removes copy orangu's own rules generated.
 * Where a key name is used by both (`title`, `label`, `detail`) the containing record's shape decides.
 *
 * Redaction is DEFAULT-ON for any shareable output. It only ever removes information; it never adds.
 */
import type { Analysis } from '../model/analysis.js'
import { STRIPPED_KEY } from '../model/app-data.js'

export interface RedactOptions {
  /** mask secrets/emails/keys inside previews and summaries (default true) */
  scrub?: boolean
  /** drop preview/summary text entirely, keeping only structural fields (default false) */
  stripText?: boolean
  /**
   * Drop every filesystem path down to its last segment (default false; the stronger opt-in over ~). One
   * segment, never two: for a Claude Code transcript the second-to-last segment IS the encoded home slug
   * (`-Users-<user>-Code-<project>`), and for a file under $HOME it is the username. Project identities
   * (`projectSlug`, aggregate `project` / `byProject` keys) drop to the same leaf.
   */
  stripPaths?: boolean
  /**
   * Home directory whose prefix is rewritten to `~` wherever it appears while scrubbing:
   * absolute home paths reveal the username). Default: detected from $HOME/$USERPROFILE; '' disables.
   */
  home?: string
}

const PATTERNS: Array<[RegExp, string]> = [
  // API keys / tokens (do these before generic ones)
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '‹anthropic-key›'],
  [/\bsk-proj-[A-Za-z0-9_-]{20,}/g, '‹openai-project-key›'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '‹stripe-key›'],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, '‹stripe-webhook-secret›'],
  [/\bsk-[A-Za-z0-9]{20,}/g, '‹api-key›'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '‹github-token›'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '‹slack-token›'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '‹aws-key›'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '‹google-key›'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '‹jwt›'],
  [/\b[A-Fa-f0-9]{40}\b/g, '‹hash40›'],
  // connection strings
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]+/gi, '‹db-url›'],
  // bearer/authorization
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer ‹token›'],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/gi, '$1=‹redacted›'],
  // email
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '‹email›'],
  // long hex/base64 blobs
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '‹blob›'],
]

export interface RedactionReport {
  applied: number
  scrubbed: boolean
  strippedText: boolean
  strippedPaths: boolean
}

let counter = 0
function scrubStr(s: string): string {
  let out = s
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, () => {
      counter++
      return rep
    })
  }
  return out
}
/** The last path segment only (see RedactOptions.stripPaths for why never two). */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
}

/**
 * Claude Code encodes a project cwd as one directory name (every '/' '.' ':' … becomes '-',
 * src/discover/discover.ts projectSlug): `-Users-<user>-Code-<project>`. Walk from the end so a
 * redaction marker such as ‹anthropic-key› stays one unit. Exported for the CLI aggregate path.
 */
export function encodedProjectLeaf(value: string): string {
  let inMarker = false
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] === '›') inMarker = true
    else if (value[i] === '‹') inMarker = false
    else if (value[i] === '-' && !inMarker) return value.slice(i + 1) || 'project'
  }
  return value
}

function isEncodedProjectSlug(value: string): boolean {
  return value.startsWith('-') || /^[A-Za-z]--/.test(value)
}

/**
 * A project identity (`session.projectSlug`, aggregate `project` and `byProject[].key`). Encoded slugs
 * defeat the `~` rewrite (no separator to anchor on) and render in the nav label and the serve picker,
 * so they always drop to their leaf; a plain path drops to its basename only under stripPaths.
 */
function projectIdentity(value: string, opts: WalkOpts): string {
  if (!opts.scrub) return value
  // scrub first: a leaf is cut at the last '-', which may sit inside a credential the masks would have caught
  const scrubbed = scrubOne(value, opts)
  // decide the shape on the raw value: the home-slug rewrite may already have turned `-Users-me-…` into `~-…`
  if (isEncodedProjectSlug(value) || isEncodedProjectSlug(scrubbed)) return encodedProjectLeaf(scrubbed)
  if (opts.stripPaths && (scrubbed.includes('/') || scrubbed.includes('\\'))) return scrubOne(basename(scrubbed), opts)
  return scrubbed
}

/** guarded so the shared type file stays importable from the browser bundles (no node globals assumed) */
function detectHome(): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.['HOME'] ?? proc?.env?.['USERPROFILE'] ?? ''
}

function homeRegExp(home: string): RegExp | null {
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
function homeSlugRegExp(home: string): RegExp | null {
  if (home.length < 2) return null
  const slug = home.replace(/[^A-Za-z0-9-]/g, '-')
  if (slug.length < 2 || !/[A-Za-z0-9]/.test(slug)) return null
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?![A-Za-z0-9_.])', 'g')
}

/**
 * String fields whose values can contain transcript-authored prose.  Keep this
 * list about semantics, not spelling alone: `name` is deliberately handled by
 * `isAgentRecord` below so structural tool/skill/model names remain useful, and
 * `title` / `label` / `detail` are decided per record shape by `stripsText`
 * (rule-generated copy keeps them; transcript-derived records lose them,
 * including `Insight.detail`, which embeds raw commands and prompt previews).
 * `narrative` and `recommendation` are only ever generated copy and are therefore
 * not listed. `tools.errorGroups[].signature` is NOT generated copy: it is the raw
 * error hint lower-cased with paths/numbers masked (src/analyze/tools.ts
 * errorSignature), so it carries whatever a failing command printed.
 */
const TEXT_KEYS = new Set([
  'promptPreview',
  'summary',
  'inputSummary',
  'resultPreview',
  'preview',
  'detail',
  'sampleHint',
  'signature',
  'title',
  'label',
  'description',
  'args',
  'command',
  'commandName',
  'message',
  'errorHint',
  'teamName',
  'taskKind',
  'url',
  'template',
  'sample',
])
const PATH_KEYS = new Set(['path', 'cwd', 'transcriptPath', 'file'])
/** string[] of paths (Session.subagentPaths): each element is a path under stripPaths */
const PATH_ARRAY_KEYS = new Set(['subagentPaths'])
/** project identities: session.projectSlug, aggregate SessionRow.project (see projectIdentity) */
const PROJECT_KEYS = new Set(['projectSlug', 'project'])
/**
 * summary.narrative is generated copy except for its opening clause, where the analyzer quotes the session
 * title (the first user prompt, src/analyze/analyze.ts narrative()). The default strip rewrites only that
 * clause so the rest of the sentence survives without touching the analyzer or the golden corpus.
 */
const NARRATIVE_TITLE_RE = /^In “[\s\S]*?”, (?=the human made )/
const PRIVATE_STRING_ARRAY_KEYS = new Set(['gitBranches'])
const UNKNOWN_COUNT_MAP_KEYS = new Set([
  'unknownRecordTypes',
  'unknownBlockTypes',
  'attachmentTypes',
  'attachmentBytes',
  'systemSubtypes',
  'queueOperations',
])

interface WalkOpts {
  scrub: boolean
  stripText: boolean
  stripPaths: boolean
  /** compiled from RedactOptions.home; applied wherever the prefix appears, only while scrubbing */
  homeRe: RegExp | null
  /** the same home as an encoded project-slug prefix (`-Users-me`), see homeSlugRegExp */
  homeSlugRe: RegExp | null
}

function scrubOne(s: string, opts: WalkOpts): string {
  if (!opts.scrub) return s
  let out = scrubStr(s)
  for (const re of [opts.homeRe, opts.homeSlugRe]) {
    if (!re) continue
    out = out.replace(re, () => {
      counter++
      return '~'
    })
  }
  return out
}

function isAgentRecord(obj: Record<string, unknown>): boolean {
  // AgentStat has spawnDepth + agentId/hasTranscript. Insight evidence carries
  // a smaller agent projection (agentId + agentType/status). ToolCallView can
  // also have agentId, so explicitly exclude its toolUseId/category shape.
  if ('toolUseId' in obj || 'category' in obj) return false
  return (
    ('spawnDepth' in obj && ('agentId' in obj || 'hasTranscript' in obj)) ||
    ('agentId' in obj && ('agentType' in obj || 'status' in obj) && ('toolErrors' in obj || 'tokens' in obj))
  )
}

/**
 * Insight (analysis.ts) and CrossFinding (aggregate.ts). Their `title` and `recommendation` are copy written by an
 * orangu rule; their `detail` quotes transcript strings (commands, prompt previews, tool inputs) and stays stripped.
 */
function isRuleRecord(obj: Record<string, unknown>): boolean {
  return 'ruleId' in obj && 'severity' in obj && 'axis' in obj
}

/** QualitySignal: a rule-generated chip (label + detail) with a tone and a value. */
function isQualitySignal(obj: Record<string, unknown>): boolean {
  return 'tone' in obj && 'value' in obj && !('ruleId' in obj)
}

/**
 * Analysis.events[] kinds whose label the adapter always sets from a fixed string (parse.ts). 'scheduled_fire',
 * 'api_error' and 'other' pass raw transcript fields through as the label (cronKind, the system subtype, the
 * attachment type), the same undocumented keys the Coverage count maps collapse to ‹stripped›, so they stay
 * stripped. The detail is a transcript preview for every kind and is always stripped.
 */
const SAFE_EVENT_KINDS = new Set(['interrupt', 'pr_link', 'plan_mode', 'model_fallback', 'permission_prompt', 'away_summary'])
function isSafeEventRecord(obj: Record<string, unknown>): boolean {
  return 'kind' in obj && 'turnIndex' in obj && 'label' in obj && SAFE_EVENT_KINDS.has(String(obj['kind']))
}

/** Does `stripText` blank this string field, given the record it sits in? */
function stripsText(key: string, source: Record<string, unknown>): boolean {
  switch (key) {
    case 'name':
      return isAgentRecord(source)
    case 'title':
      return !isRuleRecord(source)
    case 'label':
      return !isQualitySignal(source) && !isSafeEventRecord(source)
    case 'detail':
      // Insight/CrossFinding.detail interpolates raw commands, prompt previews and tool inputs
      // (src/analyze/insights.ts); only the QualitySignal chip's detail is literal rule copy.
      return !isQualitySignal(source)
    default:
      return TEXT_KEYS.has(key)
  }
}

function strippedCountMap(value: unknown, opts: WalkOpts): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return walk(value, opts)
  const source = value as Record<string, unknown>
  if (!opts.stripText) {
    const out = new Map<string, unknown>()
    for (const [key, count] of Object.entries(source)) {
      const publicKey = scrubOne(key, opts)
      out.set(publicKey, typeof count === 'number' ? (Number(out.get(publicKey)) || 0) + count : walk(count, opts))
    }
    return Object.fromEntries(out)
  }
  const total = Object.values(source).reduce<number>((sum, count) => sum + (typeof count === 'number' ? count : 0), 0)
  return total ? { [STRIPPED_KEY]: total } : {}
}

function walk(obj: unknown, opts: WalkOpts): unknown {
  if (typeof obj === 'string') return scrubOne(obj, opts)
  if (Array.isArray(obj)) return obj.map((x) => walk(x, opts))
  if (obj && typeof obj === 'object') {
    const out = new Map<string, unknown>()
    const source = obj as Record<string, unknown>
    const unknownRecordTypes = source['unknownRecordTypes']
    const unknownRecordKeys =
      unknownRecordTypes && typeof unknownRecordTypes === 'object' && !Array.isArray(unknownRecordTypes)
        ? new Set(Object.keys(unknownRecordTypes as Record<string, unknown>))
        : undefined
    for (const [k, v] of Object.entries(source)) {
      if (UNKNOWN_COUNT_MAP_KEYS.has(k)) {
        out.set(k, strippedCountMap(v, opts))
        continue
      }
      if (k === 'recordCounts' && v && typeof v === 'object' && !Array.isArray(v)) {
        const counts = new Map<string, unknown>()
        for (const [recordType, count] of Object.entries(v as Record<string, unknown>)) {
          if (opts.stripText && unknownRecordKeys?.has(recordType)) continue
          const publicKey = scrubOne(recordType, opts)
          counts.set(publicKey, typeof count === 'number' ? (Number(counts.get(publicKey)) || 0) + count : walk(count, opts))
        }
        out.set(k, Object.fromEntries(counts))
        continue
      }
      if (opts.stripText && PRIVATE_STRING_ARRAY_KEYS.has(k) && Array.isArray(v)) {
        out.set(k, [])
        continue
      }
      if (opts.stripText && typeof v === 'string' && stripsText(k, source)) {
        out.set(k, '')
        continue
      }
      if (opts.stripText && k === 'narrative' && typeof v === 'string') {
        out.set(k, scrubOne(v.replace(NARRATIVE_TITLE_RE, 'In this session, '), opts))
        continue
      }
      if (opts.stripPaths && PATH_KEYS.has(k) && typeof v === 'string' && (v.includes('/') || v.includes('\\'))) {
        // Shortening must not skip the normal secret scrub: a basename can itself be a credential.
        out.set(k, scrubOne(basename(v), opts))
        continue
      }
      if (opts.stripPaths && PATH_ARRAY_KEYS.has(k) && Array.isArray(v)) {
        out.set(k, v.map((x) => (typeof x === 'string' ? scrubOne(basename(x), opts) : walk(x, opts))))
        continue
      }
      if (PROJECT_KEYS.has(k) && typeof v === 'string') {
        out.set(k, projectIdentity(v, opts))
        continue
      }
      if (k === 'byProject' && Array.isArray(v)) {
        out.set(
          k,
          v.map((item) => {
            const row = walk(item, opts)
            if (row && typeof row === 'object' && !Array.isArray(row) && typeof (row as { key?: unknown }).key === 'string') {
              return { ...(row as Record<string, unknown>), key: projectIdentity((item as { key: string }).key, opts) }
            }
            return row
          }),
        )
        continue
      }
      out.set(k, typeof v === 'string' ? scrubOne(v, opts) : walk(v, opts))
    }
    return Object.fromEntries(out)
  }
  return obj
}

/** Returns a redacted deep copy of the analysis plus a report of what was done. */
export function redactAnalysis(a: Analysis, options: RedactOptions = {}): { analysis: Analysis; report: RedactionReport } {
  const scrub = options.scrub ?? true
  const home = options.home ?? detectHome()
  const opts: WalkOpts = {
    scrub,
    stripText: options.stripText ?? false,
    stripPaths: options.stripPaths ?? false,
    homeRe: scrub ? homeRegExp(home) : null,
    homeSlugRe: scrub ? homeSlugRegExp(home) : null,
  }
  counter = 0
  const redacted = walk(a, opts) as Analysis
  return { analysis: redacted, report: { applied: counter, scrubbed: opts.scrub, strippedText: opts.stripText, strippedPaths: opts.stripPaths } }
}

/**
 * Redacted deep copy of ANY value leaving the process (session rows, aggregates, SSE payloads).
 * The same walk `redactAnalysis` uses, for shapes that are not a full Analysis.
 */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  const scrub = options.scrub ?? true
  const home = options.home ?? detectHome()
  const opts: WalkOpts = {
    scrub,
    stripText: options.stripText ?? false,
    stripPaths: options.stripPaths ?? false,
    homeRe: scrub ? homeRegExp(home) : null,
    homeSlugRe: scrub ? homeSlugRegExp(home) : null,
  }
  return walk(value, opts) as T
}

export { scrubStr }
