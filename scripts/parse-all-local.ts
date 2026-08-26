// Manual contributor diagnostic. Output can include relative paths, session metadata,
// client versions, model names, and error text; review it before sharing.
import { listSessions } from '../src/discover/discover.js'
import { parseClaudeCodeSession } from '../src/adapters/claude-code/parse.js'

const sessions = await listSessions()
let ok = 0, fail = 0, totalMs = 0, badLines = 0, turns = 0, tools = 0, agents = 0, unresolvedT = 0
const unknownTypes: Record<string, number> = {}
const unknownBlocks: Record<string, number> = {}
const warnCodes: Record<string, number> = {}
const versions = new Set<string>()
const models = new Set<string>()
let slowest = { path: '', ms: 0, bytes: 0 }
let biggestTurns = 0
const start = Date.now()
const limit = Number(process.env.LIMIT ?? '100000')
for (const s of sessions.slice(0, limit)) {
  try {
    const t = Date.now()
    const sess = await parseClaudeCodeSession({ path: s.path })
    const ms = Date.now() - t
    totalMs += ms
    ok++
    badLines += sess.parseReport.badLines
    turns += sess.turns.length
    tools += sess.toolCalls.length
    agents += sess.agents.length
    unresolvedT += sess.toolCalls.filter((c) => c.unresolved).length
    for (const [k, v] of Object.entries(sess.parseReport.unknownRecordTypes)) unknownTypes[k] = (unknownTypes[k] ?? 0) + v
    for (const [k, v] of Object.entries(sess.parseReport.unknownBlockTypes)) unknownBlocks[k] = (unknownBlocks[k] ?? 0) + v
    for (const w of sess.parseReport.warnings) warnCodes[w.code] = (warnCodes[w.code] ?? 0) + w.count
    sess.meta.clientVersions.forEach((v) => versions.add(v))
    sess.meta.models.forEach((m) => models.add(m))
    if (ms > slowest.ms) slowest = { path: s.path.split('/').slice(-2).join('/'), ms, bytes: s.sizeBytes }
    if (sess.turns.length > biggestTurns) biggestTurns = sess.turns.length
  } catch (e) {
    fail++
    console.log('FAIL', s.path.split('/').slice(-2).join('/'), String((e as Error).message).slice(0, 200))
  }
}
console.log(JSON.stringify({ sessions: sessions.length, ok, fail, wallMs: Date.now() - start, parseMs: totalMs, badLines, turns, tools, agents, unresolvedToolCalls: unresolvedT, unknownTypes, unknownBlocks, warnCodes, versions: [...versions].sort(), models: [...models].sort(), slowest, biggestTurns }, null, 2))
