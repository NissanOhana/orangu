import type { Session, ToolCall } from '../model/session.js'
import type { ToolCallView, ToolErrorGroup, ToolStat, ToolsAnalysis } from '../model/analysis.js'
import { percentile, round, sum, topN } from './util.js'
import { scrubStr } from '../redact/redact.js'

export function toolCallView(c: ToolCall): ToolCallView {
  return {
    toolUseId: c.toolUseId,
    name: c.name,
    category: c.category,
    summary: c.inputSummary,
    turnIndex: c.turnIndex,
    agentId: c.agentId,
    startTs: c.startTs,
    durationMs: c.durationMs,
    resultBytes: c.resultBytes,
    isError: c.isError,
    errorHint: c.errorHint,
    parallelGroupSize: c.parallelGroupSize,
  }
}

/**
 * Normalize an error hint into a grouping signature (strip numbers, paths, ids). The secret masks run
 * FIRST: once digits become `<n>` a key such as `sk-ant-api03-…` no longer matches its pattern, so the
 * signature would carry a credential past the redaction the raw hint gets. Under the default stripText
 * redaction the whole field is blanked anyway (src/redact/redact.ts TEXT_KEYS).
 */
export function errorSignature(c: ToolCall): string {
  const raw = scrubStr(c.errorHint ?? c.resultPreview ?? 'error').toLowerCase()
  return raw
    .replace(/\/[^\s'"]+/g, '<path>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export function analyzeTools(s: Session): ToolsAnalysis {
  const byName = new Map<string, ToolCall[]>()
  for (const c of s.toolCalls) {
    const arr = byName.get(c.name)
    if (arr) arr.push(c)
    else byName.set(c.name, [c])
  }
  const stats: ToolStat[] = []
  for (const [name, calls] of byName) {
    const durs = calls.map((c) => c.durationMs).filter((d): d is number => d !== undefined)
    const res = calls.map((c) => c.resultBytes ?? 0)
    stats.push({
      name,
      category: calls[0]!.category,
      count: calls.length,
      errors: calls.filter((c) => c.isError).length,
      unresolved: calls.filter((c) => c.unresolved).length,
      totalMs: sum(durs),
      avgMs: durs.length ? round(sum(durs) / durs.length, 0) : 0,
      p95Ms: percentile(durs, 95),
      maxMs: durs.length ? Math.max(...durs) : 0,
      resultBytesTotal: sum(res),
      resultBytesMax: res.length ? Math.max(...res) : 0,
      inputBytesTotal: sum(calls.map((c) => c.inputBytes)),
      parallelShare: calls.length ? round(calls.filter((c) => c.parallelGroupSize > 1).length / calls.length, 3) : 0,
      mainCount: calls.filter((c) => !c.agentId).length,
      agentCount: calls.filter((c) => !!c.agentId).length,
    })
  }
  stats.sort((a, b) => b.count - a.count)

  const catMap = new Map<string, { count: number; totalMs: number; errors: number }>()
  for (const c of s.toolCalls) {
    const e = catMap.get(c.category) ?? { count: 0, totalMs: 0, errors: 0 }
    e.count++
    e.totalMs += c.durationMs ?? 0
    if (c.isError) e.errors++
    catMap.set(c.category, e)
  }
  const byCategory = [...catMap.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count)

  const groups = new Map<string, ToolErrorGroup>()
  for (const c of s.toolCalls) {
    if (!c.isError) continue
    const sig = errorSignature(c)
    const key = c.name + '|' + sig
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { name: c.name, signature: sig, count: 1, sampleTurnIndex: c.turnIndex, sampleHint: c.errorHint ?? c.resultPreview })
  }
  const errorGroups = [...groups.values()].sort((a, b) => b.count - a.count)

  // parallelism: group by (messageUuid's provider message) approximated by identical (turnIndex, startTs, agentId) + parallelGroupSize
  const seen = new Set<string>()
  let groupsN = 0
  let parallelGroups = 0
  let maxGroupSize = 1
  let parallelCalls = 0
  for (const c of s.toolCalls) {
    const key = `${c.agentId ?? 'main'}|${c.messageUuid}|${c.parallelGroupSize}`
    if (c.parallelGroupSize > 1) parallelCalls++
    if (seen.has(key)) continue
    seen.add(key)
    groupsN++
    if (c.parallelGroupSize > 1) parallelGroups++
    if (c.parallelGroupSize > maxGroupSize) maxGroupSize = c.parallelGroupSize
  }

  return {
    byName: stats,
    byCategory,
    errorGroups,
    slowest: topN(s.toolCalls, 10, (c) => c.durationMs ?? 0).map(toolCallView),
    largestResults: topN(s.toolCalls, 10, (c) => c.resultBytes ?? 0).map(toolCallView),
    parallelism: { groups: groupsN, parallelGroups, maxGroupSize, parallelCallShare: s.toolCalls.length ? round(parallelCalls / s.toolCalls.length, 3) : 0 },
    calls: s.toolCalls.map(toolCallView),
  }
}

// ---------------- workflow-pattern helpers (used by script-candidate) ----------------

/**
 * Normalize a Bash command into a template: whitespace collapsed, then any token containing a `/`
 * (absolute/relative paths, URLs) → «path», bare 7+-char hex runs (git shas, digests) → «hash»,
 * numbers (including dotted versions) → «n». Two invocations that differ only in those values share
 * a template: the signature of a scriptable repeat.
 */
export function bashTemplate(cmd: string): string {
  return cmd
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^\s'"|;&<>()=]*\/[^\s'"|;&<>()]+/g, '«path»')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '«hash»')
    .replace(/\b\d+(?:\.\d+)*\b/g, '«n»')
}

export interface NgramHit {
  gram: string[]
  /** non-overlapping occurrence count */
  count: number
  /** start indexes of the counted (non-overlapping) occurrences */
  starts: number[]
}

/**
 * Repeated n-grams over one ordered symbol sequence. A cheap sliding pass collects candidates, then
 * each candidate ≥ `minCount` is re-counted greedily non-overlapping (so `AAAA…` is not overcounted
 * by its own overlaps). Returns hits with `count >= minCount`, most frequent first.
 */
export function repeatedNgrams(seq: string[], n: number, minCount: number): NgramHit[] {
  if (n < 1 || seq.length < n * minCount) return []
  const sliding = new Map<string, number>()
  const SEP = '\u0000'
  for (let i = 0; i + n <= seq.length; i++) {
    const key = seq.slice(i, i + n).join(SEP)
    sliding.set(key, (sliding.get(key) ?? 0) + 1)
  }
  const hits: NgramHit[] = []
  for (const [key, c] of sliding) {
    if (c < minCount) continue
    const gram = key.split(SEP)
    const starts: number[] = []
    for (let i = 0; i + n <= seq.length; ) {
      let match = true
      for (let j = 0; j < n; j++)
        if (seq[i + j] !== gram[j]) {
          match = false
          break
        }
      if (match) {
        starts.push(i)
        i += n
      } else i++
    }
    if (starts.length >= minCount) hits.push({ gram, count: starts.length, starts })
  }
  hits.sort((a, b) => b.count - a.count || (a.gram.join() < b.gram.join() ? -1 : 1))
  return hits
}
