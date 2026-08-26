/**
 * Read-only performance probe over the configured local session sources.
 * Prints a four-stage timing split:
 *   1. readFile of every primary transcript
 *   2. raw JSON.parse of every line
 *   3. parseClaudeCodeSession (adapter, incl. sidecar discovery + linkage)
 *   4. analyzeSession (analyzer + rules)
 * plus per-session p50/p99 and the slowest sessions.
 *
 * Run: npm run bench      (never writes anything; the cache is NOT used — this measures the engine)
 * Output includes session-id prefixes and local metadata. Review it before sharing.
 */
import { readFile } from 'node:fs/promises'
import { claudeRoots, listSessions } from '../src/discover/discover.js'
import { parseClaudeCodeSession } from '../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../src/analyze/analyze.js'

async function main(): Promise<void> {
  const roots = await claudeRoots()
  const refs = await listSessions({ roots })
  process.stderr.write(`bench: ${refs.length} sessions\n`)
  const t = { read: 0, jsonParse: 0, adapter: 0, analyzer: 0 }
  const perSession: Array<{ id: string; sizeMb: number; adapterMs: number; analyzeMs: number }> = []
  let bytes = 0
  let lines = 0
  const t0 = performance.now()
  for (const ref of refs) {
    let raw: string
    const r0 = performance.now()
    try {
      raw = await readFile(ref.path, 'utf8')
    } catch {
      continue
    }
    t.read += performance.now() - r0
    bytes += raw.length
    const j0 = performance.now()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      lines++
      try {
        JSON.parse(line)
      } catch {
        /* counted-not-fatal in the real reader */
      }
    }
    t.jsonParse += performance.now() - j0
    const a0 = performance.now()
    const session = await parseClaudeCodeSession({ path: ref.path })
    const a1 = performance.now()
    const analysis = analyzeSession(session, { version: 'bench', now: 0 })
    const a2 = performance.now()
    t.adapter += a1 - a0
    t.analyzer += a2 - a1
    perSession.push({ id: ref.sessionId, sizeMb: ref.sizeBytes / 1e6, adapterMs: a1 - a0, analyzeMs: a2 - a1 })
    if (!analysis.parse.reconciliation.ok) process.stderr.write(`  reconBad: ${ref.sessionId}\n`)
  }
  const wall = performance.now() - t0
  const pct = (ms: number) => ((100 * ms) / wall).toFixed(1).padStart(5) + '%'
  const row = (label: string, ms: number) => process.stdout.write(`  ${label.padEnd(34)} ${(ms / 1000).toFixed(2).padStart(7)} s  ${pct(ms)}\n`)
  process.stdout.write(`\nbench over ${perSession.length} sessions · ${(bytes / 1e6).toFixed(0)} MB · ${lines.toLocaleString()} lines\n\n`)
  row('1. readFile (all primaries)', t.read)
  row('2. raw JSON.parse (every line)', t.jsonParse)
  row('3. parseClaudeCodeSession (adapter)', t.adapter)
  row('4. analyzeSession (analyzer+rules)', t.analyzer)
  process.stdout.write(`  ${'wall (probe total)'.padEnd(34)} ${(wall / 1000).toFixed(2).padStart(7)} s\n`)
  process.stdout.write(`  ${'max RSS'.padEnd(34)} ${(process.memoryUsage().rss / 1e9).toFixed(2).padStart(7)} GB\n`)
  const an = perSession.map((s) => s.analyzeMs).sort((a, b) => a - b)
  const q = (p: number) => an[Math.min(an.length - 1, Math.floor((p / 100) * an.length))] ?? 0
  process.stdout.write(`\n  analyze per session  p50 ${q(50).toFixed(0)} ms · p99 ${q(99).toFixed(0)} ms · max ${(an[an.length - 1] ?? 0).toFixed(0)} ms\n`)
  const worst = [...perSession].sort((a, b) => b.adapterMs + b.analyzeMs - (a.adapterMs + a.analyzeMs)).slice(0, 3)
  for (const w of worst) process.stdout.write(`    slow: ${w.id.slice(0, 8)}  ${w.sizeMb.toFixed(1)} MB  adapter ${w.adapterMs.toFixed(0)} ms  analyze ${w.analyzeMs.toFixed(0)} ms\n`)
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n')
  process.exit(1)
})
