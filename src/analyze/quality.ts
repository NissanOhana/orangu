import type { Session, ToolCall } from '../model/session.js'
import type { FileStat, FilesAnalysis, Outcomes, QualityAnalysis, QualitySignal } from '../model/analysis.js'
import { round, shortPath, topN } from './util.js'

// Command classification is SEGMENT-AWARE: it splits a shell command on &&, ||, ;, | and pipes,
// then inspects the LEADING executable of each segment, so `cat vitest.config.ts` or `grep jest`
// is never mistaken for a test run (that substring bug undermines the whole quality axis).
const TEST_RUNNERS = ['vitest', 'jest', 'pytest', 'mocha', 'rspec', 'phpunit', 'ava', 'tap', 'karma', 'jasmine']
const BUILD_TOOLS = ['tsc', 'eslint', 'ruff', 'mypy', 'prettier', 'webpack', 'rollup', 'esbuild', 'turbo']
function segments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean)
}
function words(seg: string): string[] {
  return seg.split(/\s+/).filter(Boolean)
}
function isTestSegment(seg: string): boolean {
  const w = words(seg)
  if (!w.length) return false
  let i = 0
  // skip env assignments (FOO=bar) and a leading sudo/time/npx-like wrapper
  while (i < w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[i]!)) i++
  const cmd0 = w[i] ?? ''
  const base = (cmd0.split('/').pop() ?? cmd0)
  const rest = w.slice(i + 1)
  const first = rest[0] ?? ''
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(base)) {
    const sub = first === 'run' ? rest[1] : first
    return sub === 'test' || TEST_RUNNERS.includes(sub ?? '')
  }
  if (base === 'npx') return TEST_RUNNERS.includes(first) || (first === 'playwright' && rest[1] === 'test')
  if (TEST_RUNNERS.includes(base)) return true
  if (base === 'python' || base === 'python3') return rest.includes('pytest') && rest[0] === '-m'
  if (base === 'go' && first === 'test') return true
  if (base === 'cargo' && first === 'test') return true
  if ((base === 'mvn' || base === 'gradle') && rest.includes('test')) return true
  if ((base === 'dotnet' || base === 'swift') && first === 'test') return true
  if (base === 'make' && first === 'test') return true
  return false
}
function isBuildSegment(seg: string): boolean {
  const w = words(seg)
  if (!w.length) return false
  let i = 0
  while (i < w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[i]!)) i++
  const cmd0 = w[i] ?? ''
  const base = cmd0.split('/').pop() ?? cmd0
  const rest = w.slice(i + 1)
  const first = rest[0] ?? ''
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(base) && first === 'run') {
    const script = rest[1] ?? ''
    return /^(build|typecheck|lint|compile|check)/.test(script)
  }
  if (base === 'npx') return BUILD_TOOLS.includes(first)
  if (base === 'tsc') return !rest.includes('--version')
  if (BUILD_TOOLS.includes(base)) return true
  if (base === 'go' && (first === 'build' || first === 'vet')) return true
  if (base === 'cargo' && (first === 'build' || first === 'check' || first === 'clippy')) return true
  if (base === 'make' && first !== 'test') return true
  if (base === 'gradle' && (first === 'build' || first === 'assemble')) return true
  if (base === 'mvn' && ['package', 'compile', 'install', 'verify'].includes(first)) return true
  if ((base === 'dotnet' || base === 'next' || base === 'vite') && first === 'build') return true
  return false
}
function classifyCommand(cmd: string): 'test' | 'build' | null {
  for (const seg of segments(cmd)) {
    if (isTestSegment(seg)) return 'test'
  }
  for (const seg of segments(cmd)) {
    if (isBuildSegment(seg)) return 'build'
  }
  return null
}
function hasCommit(cmd: string): boolean {
  return segments(cmd).some((seg) => {
    const w = words(seg)
    const base = (w[0] ?? '').split('/').pop()
    return base === 'git' && w[1] === 'commit'
  })
}
function hasPrCreate(cmd: string): boolean {
  return segments(cmd).some((seg) => {
    const w = words(seg)
    const base = (w[0] ?? '').split('/').pop()
    return base === 'gh' && w[1] === 'pr' && w[2] === 'create'
  })
}
const CORRECTION_RE = /^(no[,.!\s]|nope|wrong|not that|that'?s not|incorrect|revert|undo|again[,.!]|still (broken|failing|wrong|not)|didn'?t work|doesn'?t work|you broke|why did you|stop[,.!]|don'?t do that|i said|as i said|i asked)/i

function cmdOf(c: ToolCall): string {
  const i = c.input as Record<string, unknown> | undefined
  return typeof i?.['command'] === 'string' ? (i['command'] as string) : ''
}
function pathOf(c: ToolCall): string | undefined {
  const i = c.input as Record<string, unknown> | undefined
  const p = i?.['file_path'] ?? i?.['notebook_path'] ?? i?.['path']
  return typeof p === 'string' ? p : undefined
}

export function analyzeFiles(s: Session): FilesAnalysis {
  const map = new Map<string, FileStat>()
  const editHistory = new Map<string, string[]>() // path -> sequence of new_string hashes for revert detection
  const readsByContext = new Map<string, Map<string, number>>() // path -> (contextKey -> read count)
  for (const c of s.toolCalls) {
    const p = pathOf(c)
    if (!p) continue
    const key = shortPath(p, s.meta.cwd)
    let f = map.get(key)
    if (!f) {
      f = { path: key, reads: 0, edits: 0, writes: 0, bytesRead: 0, turnIndexes: [], agentReads: 0, redundantReads: 0 }
      map.set(key, f)
    }
    if (!f.turnIndexes.includes(c.turnIndex)) f.turnIndexes.push(c.turnIndex)
    if (c.category === 'read') {
      f.reads++
      f.bytesRead += c.resultBytes ?? 0
      if (c.agentId) f.agentReads++
      const ctxKey = c.agentId ?? 'main'
      const ctxMap = readsByContext.get(key) ?? new Map<string, number>()
      ctxMap.set(ctxKey, (ctxMap.get(ctxKey) ?? 0) + 1)
      readsByContext.set(key, ctxMap)
    } else if (c.category === 'edit') {
      f.edits++
      const i = c.input as Record<string, unknown>
      const h = editHistory.get(key) ?? []
      h.push(String(i['old_string'] ?? '').slice(0, 200) + '=>' + String(i['new_string'] ?? '').slice(0, 200))
      editHistory.set(key, h)
    } else if (c.category === 'write') f.writes++
  }
  let editedThenReverted = 0
  for (const [, h] of editHistory) {
    for (let i = 1; i < h.length; i++) {
      const [a, b] = (h[i] as string).split('=>')
      const [pa, pb] = (h[i - 1] as string).split('=>')
      if (a && b && a === pb && b === pa) editedThenReverted++
    }
  }
  for (const [key, ctxMap] of readsByContext) {
    let redundant = 0
    for (const n of ctxMap.values()) redundant += Math.max(0, n - 1)
    const f = map.get(key)
    if (f) f.redundantReads = redundant
  }
  const files = [...map.values()].sort((a, b) => b.reads + b.edits + b.writes - (a.reads + a.edits + a.writes))
  return { files, mostReRead: topN(files.filter((f) => f.redundantReads >= 1), 10, (f) => f.redundantReads), totalDistinct: files.length, editedThenReverted }
}

export function analyzeQuality(s: Session, files: FilesAnalysis): { quality: QualityAnalysis; outcomes: Outcomes } {
  const testRuns: QualityAnalysis['testRuns'] = []
  const buildRuns: QualityAnalysis['buildRuns'] = []
  const gitCommits: QualityAnalysis['gitCommits'] = []
  let webLookups = 0
  for (const c of s.toolCalls) {
    if (c.category === 'web') webLookups++
    if (c.name !== 'Bash') continue
    const cmd = cmdOf(c)
    if (!cmd) continue
    const kind = classifyCommand(cmd)
    if (kind === 'test') testRuns.push({ turnIndex: c.turnIndex, command: cmd.slice(0, 120), ok: !c.isError, agentId: c.agentId })
    else if (kind === 'build') buildRuns.push({ turnIndex: c.turnIndex, command: cmd.slice(0, 120), ok: !c.isError })
    if (hasCommit(cmd)) {
      const m = /-m\s+["']([^"']{0,80})/.exec(cmd)
      gitCommits.push({ turnIndex: c.turnIndex, ok: !c.isError, message: m?.[1] })
    }
  }
  const userCorrections = s.turns.filter((t) => t.kind === 'human' && CORRECTION_RE.test(t.promptPreview)).map((t) => ({ turnIndex: t.index, preview: t.promptPreview.slice(0, 100) }))
  const interruptions = s.events.filter((e) => e.kind === 'interrupt').length
  const apiErrors = s.events.filter((e) => e.kind === 'api_error').length
  const toolErrors = s.toolCalls.filter((c) => c.isError).length
  const toolErrorRate = s.toolCalls.length ? round(toolErrors / s.toolCalls.length, 4) : 0
  const reworkFiles = files.files.filter((f) => f.edits >= 4).length
  const prLinks = s.events.filter((e) => e.kind === 'pr_link').map((e) => ({ label: e.label, url: e.detail, turnIndex: e.turnIndex }))
  const prCreates = s.toolCalls.filter((c) => c.name === 'Bash' && hasPrCreate(cmdOf(c)) && !c.isError)
  if (!prLinks.length && prCreates.length) for (const c of prCreates) prLinks.push({ label: 'gh pr create', url: undefined, turnIndex: c.turnIndex })

  const outcomes: Outcomes = {
    prLinks,
    gitCommits: gitCommits.filter((g) => g.ok).length,
    testRuns: testRuns.length,
    testRunsFailed: testRuns.filter((t) => !t.ok).length,
    buildRuns: buildRuns.length,
    buildRunsFailed: buildRuns.filter((b) => !b.ok).length,
    filesRead: files.files.filter((f) => f.reads > 0).length,
    filesEdited: files.files.filter((f) => f.edits > 0).length,
    filesWritten: files.files.filter((f) => f.writes > 0).length,
    webLookups,
  }

  const lastTest = testRuns.length ? testRuns[testRuns.length - 1] : undefined
  const signals: QualitySignal[] = [
    { id: 'tests', label: 'Test runs', value: testRuns.length ? `${testRuns.length} (${testRuns.filter((t) => t.ok).length} passed)` : 'none', tone: !testRuns.length ? 'unknown' : lastTest?.ok ? 'good' : 'bad', detail: lastTest ? `last run ${lastTest.ok ? 'passed' : 'failed'}` : 'no test command detected', evidenceTurnIndexes: [...new Set(testRuns.map((t) => t.turnIndex))] },
    { id: 'builds', label: 'Build / typecheck / lint runs', value: buildRuns.length ? `${buildRuns.length} (${buildRuns.filter((b) => b.ok).length} ok)` : 'none', tone: !buildRuns.length ? 'unknown' : buildRuns[buildRuns.length - 1]!.ok ? 'good' : 'bad', evidenceTurnIndexes: [...new Set(buildRuns.map((b) => b.turnIndex))] },
    { id: 'commits', label: 'Git commits', value: outcomes.gitCommits, tone: outcomes.gitCommits ? 'good' : 'neutral', evidenceTurnIndexes: gitCommits.map((g) => g.turnIndex) },
    { id: 'prs', label: 'Pull requests', value: prLinks.length, tone: prLinks.length ? 'good' : 'neutral', evidenceTurnIndexes: prLinks.map((p) => p.turnIndex) },
    { id: 'tool-error-rate', label: 'Tool error rate', value: `${round(toolErrorRate * 100, 1)}%`, tone: toolErrorRate > 0.15 ? 'bad' : toolErrorRate > 0.05 ? 'neutral' : 'good', detail: `${toolErrors} of ${s.toolCalls.length} tool calls errored` },
    { id: 'corrections', label: 'User corrections', value: userCorrections.length, tone: userCorrections.length >= 3 ? 'bad' : userCorrections.length ? 'neutral' : 'good', detail: 'prompts that read as "no / wrong / again / revert"', evidenceTurnIndexes: userCorrections.map((u) => u.turnIndex) },
    { id: 'interruptions', label: 'Interruptions', value: interruptions, tone: interruptions >= 3 ? 'bad' : interruptions ? 'neutral' : 'good' },
    { id: 'api-errors', label: 'API errors', value: apiErrors, tone: apiErrors ? 'bad' : 'good' },
    { id: 'rework', label: 'Files edited 4+ times', value: reworkFiles, tone: reworkFiles >= 3 ? 'bad' : reworkFiles ? 'neutral' : 'good' },
    { id: 'reverts', label: 'Edit-then-revert pairs', value: files.editedThenReverted, tone: files.editedThenReverted ? 'neutral' : 'good' },
  ]

  return {
    quality: { signals, testRuns, buildRuns, gitCommits, userCorrections, interruptions, apiErrors, toolErrorRate, reworkFiles },
    outcomes,
  }
}
