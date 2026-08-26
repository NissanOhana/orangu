// Manual contributor diagnostic. Output can include session-id prefixes, paths in errors,
// and aggregate metadata; review it before sharing.
import { listSessions } from '../src/discover/discover.js'
import { parseClaudeCodeSession } from '../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../src/analyze/analyze.js'
const sessions = await listSessions()
let ok = 0, fail = 0, reconBad = 0, ms = 0
const rules: Record<string, number> = {}
let totalTokens = 0, totalTurns = 0, est = 0
const top: Array<{ id: string; tokens: number; turns: number; agents: number; wallH: number }> = []
for (const s of sessions) {
  try {
    const t0 = Date.now()
    const sess = await parseClaudeCodeSession({ path: s.path })
    const a = analyzeSession(sess, { version: 'gate' })
    ms += Date.now() - t0
    ok++
    if (!a.parse.reconciliation.ok) reconBad++
    for (const i of a.insights) rules[i.ruleId] = (rules[i.ruleId] ?? 0) + 1
    totalTokens += a.summary.totalTokens
    totalTurns += a.summary.turns
    if (a.session.models.some((m) => m.estimatedMatch)) est++
    top.push({ id: s.sessionId.slice(0, 8), tokens: a.summary.totalTokens, turns: a.summary.turns, agents: a.summary.agents, wallH: Math.round((a.summary.wallMs ?? 0) / 3600000) })
    // sanity: JSON serializable and size
    JSON.stringify(a)
  } catch (e) {
    fail++
    console.log('FAIL', s.sessionId.slice(0, 8), String((e as Error).stack).slice(0, 400))
  }
}
top.sort((a, b) => b.tokens - a.tokens)
console.log(JSON.stringify({ sessions: sessions.length, ok, fail, reconBad, analyzeMs: ms, totalTokens, totalTurns, estimatedModelMatchSessions: est, rules, top5: top.slice(0, 5) }, null, 1))
