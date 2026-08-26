/**
 * Curated deterministic matcher (docs/DETERMINISM.md §The three layers).
 * Given an Analysis (the slim projection is enough), return the catalog entries whose pattern the
 * analysis exhibits, each with a human-readable evidence string. Zero network, zero clock, pure:
 * the same analysis always yields byte-identical matches. Content lives in catalog.json (pattern →
 * known tool/skill/feature) and features.json (Claude Code feature → finding it addresses); both are
 * bundled at build time; nothing is fetched.
 *
 * Pattern kinds:
 *   { ruleId }  : matches when an insight with that ruleId is present (or, on the create path where
 *                 no analysis is loaded yet, when the suggestion record's ruleId equals it).
 *   { signal }  : a deterministic detector over the analysis:
 *     file-ext:<.ext>        a path with that extension inside size-flavored insight evidence
 *                            (oversized-tool-results, truncated-reads, binary-attachments,
 *                            large-writes, reread-files) or files.mostReRead
 *     cache-miss:<type>      a cache_miss_reason of that type in the cache-invalidation insight's
 *                            byType evidence, or in full-Analysis context.cacheMisses
 *     bash-search-loop       a repeated-commands insight whose repeated command is grep/find
 */
import catalogJson from './catalog.json' with { type: 'json' }
import featuresJson from './features.json' with { type: 'json' }
import { CHANGE_CLASS_DEFINITIONS, type ChangeClass } from './change-classes.js'

export { CHANGE_CLASS_DEFINITIONS, isChangeClass, type ChangeClass } from './change-classes.js'

export interface CatalogPattern {
  ruleId?: string
  signal?: string
}

export interface CatalogEntry {
  id: string
  /** the concrete harness surface a proposal would change */
  changeClass: ChangeClass
  pattern: CatalogPattern
  tool?: string
  skill?: string
  feature?: string
  url: string | null
  /** YYYY-MM-DD the claim was last verified; null = research-found candidate, not yet verified */
  verifiedAt: string | null
  note: string
}

export interface CatalogMatch {
  entry: CatalogEntry
  /** why this entry matched: the insight / path / miss-type that triggered it */
  evidence: string
}

/** the structural slice of Analysis/SlimAnalysis the matcher reads; both satisfy it */
export interface MatchableInsight {
  ruleId: string
  id?: string
  title?: string
  evidence?: unknown
}
export interface MatchableAnalysis {
  insights: MatchableInsight[]
  files?: { mostReRead?: Array<{ path?: string }> }
  /** the index signature lets SlimAnalysis (whose context slice has no cacheMisses) satisfy this shape */
  context?: { cacheMisses?: Array<{ type?: string }>; [k: string]: unknown }
}

interface CatalogFile {
  catalogVersion: number
  entries: CatalogEntry[]
}

export function catalogEntries(): CatalogEntry[] {
  return (catalogJson as CatalogFile).entries
}
export function featureEntries(): CatalogEntry[] {
  return (featuresJson as CatalogFile).entries
}
/** catalog + features, catalog first: the order entries are matched and reported in */
export function allEntries(): CatalogEntry[] {
  return [...catalogEntries(), ...featureEntries()]
}

// ---------------- signal detectors ----------------

/** insight ruleIds whose evidence legitimately carries file paths with size implications */
const SIZE_RULES = new Set(['oversized-tool-results', 'truncated-reads', 'binary-attachments', 'large-writes', 'reread-files'])

const STRING_SCAN_CAP = 500

/** collect string leaves from an evidence object, bounded for determinism and safety */
function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (out.length >= STRING_SCAN_CAP || depth > 6 || v == null) return
  if (typeof v === 'string') {
    out.push(v)
    return
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1)
    return
  }
  if (typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1)
  }
}

function detectFileExt(ext: string, a: MatchableAnalysis): string | undefined {
  // ".pdf" must be followed by a non-alphanumeric or end-of-string (rejects ".pdfx")
  const re = new RegExp(ext.replace('.', '\\.') + '(?![a-z0-9])', 'i')
  for (const ins of a.insights) {
    if (!SIZE_RULES.has(ins.ruleId)) continue
    const strings: string[] = []
    collectStrings(ins.evidence, strings)
    const hit = strings.find((s) => re.test(s))
    if (hit !== undefined) return `${ins.ruleId}: ${hit.slice(0, 120)}`
  }
  const rr = a.files?.mostReRead?.find((f) => f.path !== undefined && re.test(f.path))
  if (rr?.path !== undefined) return `re-read file ${rr.path.slice(0, 120)}`
  return undefined
}

function detectCacheMiss(type: string, a: MatchableAnalysis): string | undefined {
  for (const ins of a.insights) {
    if (ins.ruleId !== 'cache-invalidation') continue
    const byType = (ins.evidence as { byType?: unknown } | undefined)?.byType
    if (!Array.isArray(byType)) continue
    for (const g of byType) {
      const t = (g as { type?: unknown; events?: unknown }) ?? {}
      if (t.type === type) return `cache_miss_reason ${type} ×${typeof t.events === 'number' ? t.events : '?'}`
    }
  }
  const misses = a.context?.cacheMisses?.filter((m) => m.type === type) ?? []
  if (misses.length) return `cache_miss_reason ${type} ×${misses.length}`
  return undefined
}

const SEARCH_CMD = /(^|[\s|;&(])(grep|egrep|fgrep|find)\s/

function detectBashSearchLoop(a: MatchableAnalysis): string | undefined {
  for (const ins of a.insights) {
    if (ins.ruleId !== 'repeated-commands') continue
    const commands = (ins.evidence as { commands?: unknown } | undefined)?.commands
    if (!Array.isArray(commands)) continue
    for (const c of commands) {
      const cmd = (c as { command?: unknown; count?: unknown }) ?? {}
      if (typeof cmd.command === 'string' && SEARCH_CMD.test(cmd.command)) {
        return `repeated search command "${cmd.command.slice(0, 120)}"${typeof cmd.count === 'number' ? ` ×${cmd.count}` : ''}`
      }
    }
  }
  return undefined
}

function detectSignal(signal: string, a: MatchableAnalysis): string | undefined {
  if (signal.startsWith('file-ext:')) return detectFileExt(signal.slice('file-ext:'.length), a)
  if (signal.startsWith('cache-miss:')) return detectCacheMiss(signal.slice('cache-miss:'.length), a)
  if (signal === 'bash-search-loop') return detectBashSearchLoop(a)
  return undefined // unknown signal kind: never matches (forward-compatible with future catalog versions)
}

// ---------------- matching ----------------

function matchEntry(entry: CatalogEntry, a: MatchableAnalysis): string | undefined {
  if (entry.pattern.ruleId !== undefined) {
    const ins = a.insights.find((i) => i.ruleId === entry.pattern.ruleId)
    if (!ins) return undefined
    return `finding ${ins.ruleId}${ins.title ? `: ${ins.title}` : ''}`
  }
  if (entry.pattern.signal !== undefined) return detectSignal(entry.pattern.signal, a)
  return undefined
}

/** all catalog + feature entries this analysis exhibits, in catalog order */
export function matchCatalog(a: MatchableAnalysis): CatalogMatch[] {
  const out: CatalogMatch[] = []
  for (const entry of allEntries()) {
    const evidence = matchEntry(entry, a)
    if (evidence !== undefined) out.push({ entry, evidence })
  }
  return out
}

/**
 * Catalog matches for one suggestion finding (the suggest show/proposal path).
 * ruleId-pattern entries match on the finding's ruleId alone (create path, no analysis loaded yet);
 * signal-pattern entries are detected on the finding's OWN insights in the loaded evidence sessions,
 * so an unrelated insight in the same session never attaches its catalog entries to this finding.
 */
export function matchRule(ruleId: string, analyses: MatchableAnalysis[] = []): CatalogMatch[] {
  const out: CatalogMatch[] = []
  const seen = new Set<string>()
  for (const entry of allEntries()) {
    if (entry.pattern.ruleId === ruleId) {
      out.push({ entry, evidence: `finding ruleId=${ruleId}` })
      seen.add(entry.id)
    }
  }
  for (const a of analyses) {
    const scoped: MatchableAnalysis = {
      insights: a.insights.filter((i) => i.ruleId === ruleId),
      ...(ruleId === 'reread-files' && a.files !== undefined ? { files: a.files } : {}),
      ...(ruleId === 'cache-invalidation' && a.context !== undefined ? { context: a.context } : {}),
    }
    for (const entry of allEntries()) {
      if (seen.has(entry.id) || entry.pattern.signal === undefined) continue
      const evidence = detectSignal(entry.pattern.signal, scoped)
      if (evidence !== undefined) {
        out.push({ entry, evidence })
        seen.add(entry.id)
      }
    }
  }
  return out
}
