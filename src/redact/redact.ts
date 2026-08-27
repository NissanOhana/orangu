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
  /** drop absolute filesystem paths down to basenames (default false; the stronger opt-in over ~) */
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
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts.slice(-2).join('/')
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
 * String fields whose values can contain transcript-authored prose.  Keep this
 * list about semantics, not spelling alone: `name` is deliberately handled by
 * `isAgentRecord` below so structural tool/skill/model names remain useful, and
 * `title` / `label` / `detail` are decided per record shape by `stripsText`
 * (rule-generated copy keeps them; transcript-derived records lose them,
 * including `Insight.detail`, which embeds raw commands and prompt previews).
 * `narrative`, `recommendation` and `signature` are only ever generated copy and
 * are therefore not listed.
 */
const TEXT_KEYS = new Set([
  'promptPreview',
  'summary',
  'inputSummary',
  'resultPreview',
  'preview',
  'detail',
  'sampleHint',
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
}

function scrubOne(s: string, opts: WalkOpts): string {
  if (!opts.scrub) return s
  let out = scrubStr(s)
  if (opts.homeRe) {
    out = out.replace(opts.homeRe, () => {
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

/** Analysis.events[]: the label is rule-generated; the detail is a transcript preview and stays stripped. */
function isEventRecord(obj: Record<string, unknown>): boolean {
  return 'kind' in obj && 'turnIndex' in obj && 'label' in obj
}

/** Does `stripText` blank this string field, given the record it sits in? */
function stripsText(key: string, source: Record<string, unknown>): boolean {
  switch (key) {
    case 'name':
      return isAgentRecord(source)
    case 'title':
      return !isRuleRecord(source)
    case 'label':
      return !isQualitySignal(source) && !isEventRecord(source)
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
    const out: Record<string, unknown> = {}
    for (const [key, count] of Object.entries(source)) {
      const publicKey = scrubOne(key, opts)
      out[publicKey] = typeof count === 'number' ? (Number(out[publicKey]) || 0) + count : walk(count, opts)
    }
    return out
  }
  const total = Object.values(source).reduce<number>((sum, count) => sum + (typeof count === 'number' ? count : 0), 0)
  return total ? { [STRIPPED_KEY]: total } : {}
}

function walk(obj: unknown, opts: WalkOpts): unknown {
  if (typeof obj === 'string') return scrubOne(obj, opts)
  if (Array.isArray(obj)) return obj.map((x) => walk(x, opts))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    const source = obj as Record<string, unknown>
    const unknownRecordTypes = source['unknownRecordTypes']
    const unknownRecordKeys =
      unknownRecordTypes && typeof unknownRecordTypes === 'object' && !Array.isArray(unknownRecordTypes)
        ? new Set(Object.keys(unknownRecordTypes as Record<string, unknown>))
        : undefined
    for (const [k, v] of Object.entries(source)) {
      if (UNKNOWN_COUNT_MAP_KEYS.has(k)) {
        out[k] = strippedCountMap(v, opts)
        continue
      }
      if (k === 'recordCounts' && v && typeof v === 'object' && !Array.isArray(v)) {
        const counts: Record<string, unknown> = {}
        for (const [recordType, count] of Object.entries(v as Record<string, unknown>)) {
          if (opts.stripText && unknownRecordKeys?.has(recordType)) continue
          counts[scrubOne(recordType, opts)] = walk(count, opts)
        }
        out[k] = counts
        continue
      }
      if (opts.stripText && PRIVATE_STRING_ARRAY_KEYS.has(k) && Array.isArray(v)) {
        out[k] = []
        continue
      }
      if (opts.stripText && typeof v === 'string' && stripsText(k, source)) {
        out[k] = ''
        continue
      }
      if (opts.stripPaths && PATH_KEYS.has(k) && typeof v === 'string' && (v.includes('/') || v.includes('\\'))) {
        out[k] = basename(v)
        continue
      }
      out[k] = typeof v === 'string' ? scrubOne(v, opts) : walk(v, opts)
    }
    return out
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
  }
  return walk(value, opts) as T
}

export { scrubStr }
