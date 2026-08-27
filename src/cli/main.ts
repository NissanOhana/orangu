/**
 * orangu CLI. Deterministic session observability. The CLI makes no network calls.
 *
 *   orangu report [<session>]     build a self-contained HTML report and open it
 *   orangu analyze [<session>]    print the analysis (human summary, or --json for the full object)
 *   orangu list                   list discoverable sessions
 *   orangu repo [<path>]          aggregate every session for a repo/cwd (--json / --out report)
 *   orangu global                 aggregate every session everywhere
 *   orangu watch [<session>]      live-tail a session and refresh the report
 *
 * Session selector: a session id, a unique id prefix, a path to a .jsonl, or "latest" (default).
 */
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, flagStr, flagBool } from './args.js'
import { candidatesForPrefix, claudeRoots, findLatestSession, listSessions, resolveSession, type SessionRef } from '../discover/discover.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { aggregate } from '../analyze/aggregate.js'
import { renderReport } from '../report/render.js'
import { AnalysisCache, analyzeRefCached } from '../cache/index.js'
import { analyzeAllPooled, defaultJobs, isPoolWorker, runPoolWorker } from '../cache/pool.js'
import { fmtMs, fmtTokens } from '../analyze/util.js'
import type { RedactOptions } from '../redact/redact.js'
import { watchSession } from './watch.js'
import { startServe } from '../serve/server.js'
import { DEFAULT_MAX_LIVE } from '../serve/registry.js'
import type { ServeOptions } from '../serve/types.js'
import { MASCOT_ASCII } from '../report/client/mascot.js'
import { EXTRA_COMMANDS, EXTRA_HELP } from './commands/index.js'
import { emitAnalysisJson } from './json-out.js'
import { openInBrowser } from './open-browser.js'
import { VERSION } from '../version.js'

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  o: (s: string) => `\x1b[38;5;209m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
}
const isTTY = process.stdout.isTTY
const paint = (fn: (s: string) => string, s: string) => (isTTY ? fn(s) : s)

function offerBetaFeedback(context: 'session' | 'repo' | 'global' | 'report'): void {
  process.stderr.write(paint(C.dim, `  beta: rant about the experience → orangu feedback --context ${context}\n`))
}

function redactOptions(flags: Record<string, string | boolean>): RedactOptions | false {
  if (flagBool(flags, 'no-redact')) return false
  return { scrub: true, stripText: !flagBool(flags, 'include-text'), stripPaths: flagBool(flags, 'strip-paths') }
}

async function selectSession(sel: string | undefined, flags: Record<string, string | boolean>): Promise<SessionRef> {
  const configArg = flagStr(flags, 'root', 'config', 'r')
  let opts: { configDir?: string; roots?: string[]; cwd?: string } = configArg ? { configDir: configArg } : {}
  if (flagBool(flags, 'global')) opts = { roots: await claudeRoots(configArg) }
  if (flags['cwd']) opts.cwd = String(flags['cwd'])
  if (!sel || sel === 'latest') {
    const s = await findLatestSession(opts)
    if (!s) fail('No sessions found. Is Claude Code installed? Try: orangu list')
    return s!
  }
  const r = await resolveSession(sel, opts)
  if (r) return r
  const cands = await candidatesForPrefix(sel, opts)
  if (cands.length > 1) {
    fail(`Ambiguous session "${sel}". ${cands.length} matches:\n` + cands.slice(0, 8).map((c) => '  ' + c.sessionId + '  ' + (basename(c.projectSlug))).join('\n'))
  }
  fail(`No session matches "${sel}". Try: orangu list`)
  throw new Error('unreachable')
}

function fail(msg: string): never {
  process.stderr.write(paint(C.r, 'error: ') + msg + '\n')
  process.exit(1)
}

function makeCache(flags: Record<string, string | boolean>): AnalysisCache | null {
  const disabled = flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1'
  if (disabled) return null
  return new AnalysisCache({ version: VERSION })
}

function printCacheStats(cache: AnalysisCache | null, flags: Record<string, string | boolean>): void {
  if (!cache || flagBool(flags, 'quiet')) return
  const s = cache.stats()
  process.stderr.write(paint(C.dim, `cache: ${s.hits} hits, ${s.misses} misses\n`))
}

async function analyzeRef(ref: SessionRef, flags: Record<string, string | boolean>, cache?: AnalysisCache | null) {
  const c = cache !== undefined ? cache : makeCache(flags)
  const analysis = await analyzeRefCached(ref, { cache: c, version: VERSION, now: Date.now() })
  if (cache === undefined) printCacheStats(c, flags)
  return analysis
}

function outPath(flags: Record<string, string | boolean>, id: string, ext = 'html'): string {
  const out = flagStr(flags, 'o', 'out')
  if (out) return resolve(out)
  return join(tmpdir(), `orangu-${id.slice(0, 8)}.${ext}`)
}

// ---------- commands ----------
async function cmdReport(sel: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  const ref = await selectSession(sel, flags)
  if (!flagBool(flags, 'quiet')) process.stderr.write(paint(C.dim, `analyzing ${ref.sessionId} (${(ref.sizeBytes / 1e6).toFixed(1)} MB)…\n`))
  const analysis = await analyzeRef(ref, flags)
  const { html, redaction } = renderReport(analysis, { redact: redactOptions(flags) })
  if (flagBool(flags, 'stdout')) {
    process.stdout.write(html)
    return
  }
  const path = outPath(flags, ref.sessionId)
  await writeFile(path, html)
  process.stderr.write(paint(C.g, '✓ ') + `report written to ${path}` + (redaction ? paint(C.dim, ` (${redaction.applied} redactions)`) : '') + '\n')
  if (!flagBool(flags, 'no-open') && (flagBool(flags, 'open') || isTTY)) openInBrowser(path)
  process.stdout.write(path + '\n')
  if (!flagBool(flags, 'quiet')) offerBetaFeedback('report')
}

async function cmdAnalyze(sel: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  const ref = await selectSession(sel, flags)
  const analysis = await analyzeRef(ref, flags)
  if (flagBool(flags, 'json')) {
    emitAnalysisJson(analysis, flags)
    thresholdExit(analysis, flags)
    return
  }
  printAnalysisSummary(analysis)
  if (!flagBool(flags, 'quiet')) offerBetaFeedback('session')
  thresholdExit(analysis, flags)
}

/** Flags that were removed but would otherwise be ignored in silence, turning a CI gate into a no-op. */
const RETIRED_FLAGS: Record<string, string> = {
  'max-cost': '--max-cost was removed; use --max-tokens <n>',
}

function thresholdExit(analysis: ReturnType<typeof analyzeSession>, flags: Record<string, string | boolean>): void {
  let bad = false
  // A gate that silently stops gating is worse than a removed gate: exit non-zero and say what to use.
  for (const [flag, message] of Object.entries(RETIRED_FLAGS)) if (flags[flag] !== undefined) fail(message)
  const maxTokensStr = flagStr(flags, 'max-tokens')
  if (maxTokensStr !== undefined && Number.isNaN(Number(maxTokensStr))) fail(`--max-tokens must be a number, got "${maxTokensStr}"`)
  const maxTokens = Number(maxTokensStr)
  if (maxTokensStr !== undefined && !Number.isNaN(maxTokens) && analysis.summary.totalTokens > maxTokens) {
    process.stderr.write(paint(C.r, `FAIL: ${fmtTokens(analysis.summary.totalTokens)} tokens > --max-tokens ${fmtTokens(maxTokens)}\n`))
    bad = true
  }
  if (flagBool(flags, 'fail-on-hook-errors') && analysis.hooks.errors > 0) {
    process.stderr.write(paint(C.r, `FAIL: ${analysis.hooks.errors} hook errors\n`))
    bad = true
  }
  if (bad) process.exit(2)
}

function printAnalysisSummary(a: ReturnType<typeof analyzeSession>): void {
  const s = a.summary
  const line = (label: string, val: string) => process.stdout.write('  ' + label.padEnd(18) + val + '\n')
  process.stdout.write('\n' + paint(C.o, paint(C.b, 'orangu')) + '  ' + paint(C.b, a.session.title || a.session.id.slice(0, 12)) + '\n')
  process.stdout.write(paint(C.dim, `  ${a.session.source} · ${a.session.id}\n\n`))
  line('quality', qualityLine(a))
  line('time', `${fmtMs(s.wallMs)} wall · ${fmtMs(s.activeMs)} active · ${fmtMs(s.humanWaitMs)} waiting`)
  line('tokens', `${fmtTokens(s.totalTokens)} · ${(s.cacheHitRatio * 100).toFixed(0)}% cache · ${fmtTokens(a.tokens.byKind.output)} output`)
  line('turns', `${s.turns} (${s.humanTurns} human)`)
  line('tools', `${s.toolCalls} calls · ${s.toolErrors} errors`)
  if (s.agents) line('agents', `${s.agents} runs · ${(a.agents.maxConcurrency)} max parallel · ${fmtTokens(a.tokens.agents)} tokens`)
  line('context', `peak ${fmtTokens(s.contextPeak)}${a.context.contextWindow ? ' of ' + fmtTokens(a.context.contextWindow) : ''} · ${s.compactions} compactions`)
  process.stdout.write('\n' + paint(C.b, '  findings') + '\n')
  if (!a.insights.length) process.stdout.write(paint(C.g, '    clean: no findings\n'))
  for (const ins of a.insights.slice(0, 6)) {
    const mark = ins.severity === 'high' ? paint(C.r, '●') : ins.severity === 'medium' ? paint(C.y, '●') : paint(C.dim, '●')
    const save = ins.savings?.tokens ? paint(C.o, `  save ~${fmtTokens(ins.savings.tokens)} tokens`) : ins.savings?.ms ? paint(C.o, `  save ~${fmtMs(ins.savings.ms)}`) : ''
    process.stdout.write(`    ${mark} ${ins.title}${save}\n`)
  }
  process.stdout.write('\n' + paint(C.dim, `  run 'orangu report ${a.session.id.slice(0, 8)}' for the full visual report\n`))
  if (!a.parse.reconciliation.ok) process.stdout.write(paint(C.y, `  ⚠ token totals reconcile within ${a.parse.reconciliation.matchesWithinPct}%\n`))
}

function qualityLine(a: ReturnType<typeof analyzeSession>): string {
  const o = a.summary.outcomes
  const bits: string[] = []
  if (o.prLinks.length) bits.push(`${o.prLinks.length} PR`)
  if (o.gitCommits) bits.push(`${o.gitCommits} commits`)
  if (o.testRuns) bits.push(`${o.testRuns} test runs${o.testRunsFailed ? ' (' + o.testRunsFailed + ' failed)' : ''}`)
  if (o.filesEdited + o.filesWritten) bits.push(`${o.filesEdited + o.filesWritten} files changed`)
  return bits.join(' · ') || 'no commits/PRs/tests detected'
}

async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const configArg = flagStr(flags, 'root', 'config', 'r')
  const all: SessionRef[] = flagBool(flags, 'global')
    ? await listSessions({ roots: await claudeRoots(configArg) })
    : await listSessions(configArg ? { configDir: configArg } : {})
  const limit = Number(flagStr(flags, 'limit', 'l') ?? '40')
  const rows = all.slice(0, Number.isNaN(limit) ? 40 : limit)
  if (flagBool(flags, 'json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    return
  }
  process.stdout.write(paint(C.b, `\n${all.length} sessions${flagBool(flags, 'global') ? ' (all roots)' : ''}\n\n`))
  for (const s of rows) {
    const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
    process.stdout.write(
      `  ${paint(C.o, s.sessionId.slice(0, 8))}  ${paint(C.dim, when)}  ${(s.sizeBytes / 1e6).toFixed(1).padStart(5)}MB  ${s.hasSidecarDir ? paint(C.dim, '⛓ ' + s.subagentFiles.length) : '    '}  ${basename(s.projectSlug)}\n`,
    )
  }
  process.stdout.write(paint(C.dim, `\n  orangu report <id>   ·   orangu analyze <id>\n`))
}

async function cmdAggregate(scope: 'repo' | 'global', selOrPath: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  let refs: SessionRef[]
  let scopeLabel: string
  if (scope === 'global') {
    const roots = await claudeRoots(flagStr(flags, 'root', 'r'))
    refs = await listSessions({ roots })
    scopeLabel = `global (${roots.length} roots)`
  } else {
    const cwd = selOrPath ? resolve(selOrPath) : process.cwd()
    refs = await listSessions({ cwd })
    scopeLabel = `repo ${basename(cwd)}`
  }
  if (!refs.length) fail(`No sessions found for ${scopeLabel}.`)
  const max = Number(flagStr(flags, 'limit') ?? (scope === 'global' ? '500' : '200'))
  const use = refs.slice(0, Number.isNaN(max) ? refs.length : max)
  if (!flagBool(flags, 'quiet')) process.stderr.write(paint(C.dim, `analyzing ${use.length} sessions…\n`))
  const jobsStr = flagStr(flags, 'jobs', 'j')
  const jobsN = jobsStr !== undefined ? Math.max(1, Math.floor(Number(jobsStr)) || 1) : defaultJobs()
  // the pool re-loads the CLI bundle as its worker entry, so it only runs from the built file
  const bundledEntry = /\.(m?js)$/.test(new URL(import.meta.url).pathname)
  let analyses = []
  let failed = 0
  if (jobsN > 1 && use.length > 1 && bundledEntry) {
    const cacheEnabled = !(flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1')
    const r = await analyzeAllPooled(use, { entry: new URL(import.meta.url), jobs: jobsN, version: VERSION, now: Date.now(), cacheEnabled })
    analyses = r.analyses
    failed = r.failed
    if (!flagBool(flags, 'quiet')) {
      process.stderr.write(paint(C.dim, `jobs: ${jobsN}\n`))
      if (cacheEnabled) process.stderr.write(paint(C.dim, `cache: ${r.hits} hits, ${r.misses} misses\n`))
    }
  } else {
    const cache = makeCache(flags)
    for (const ref of use) {
      try {
        analyses.push(await analyzeRef(ref, flags, cache))
      } catch {
        failed++
      }
    }
    printCacheStats(cache, flags)
  }
  const agg = aggregate(analyses, scopeLabel, Date.now())
  if (failed) agg.scope += ` (${failed} unreadable skipped)`
  const outFile = flagStr(flags, 'o', 'out')
  if (outFile) {
    await writeFile(resolve(outFile), JSON.stringify(agg, null, 2))
    process.stderr.write(paint(C.g, '✓ ') + `aggregate written to ${resolve(outFile)}\n`)
    if (!flagBool(flags, 'json')) {
      if (!flagBool(flags, 'quiet')) offerBetaFeedback(scope)
      return
    }
  }
  if (flagBool(flags, 'json')) {
    process.stdout.write(JSON.stringify(agg, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')
    return
  }
  printAggregate(agg)
  if (!flagBool(flags, 'quiet')) offerBetaFeedback(scope)
}

function printAggregate(a: ReturnType<typeof aggregate>): void {
  process.stdout.write('\n' + paint(C.o, paint(C.b, 'orangu')) + '  ' + paint(C.b, a.scope) + '\n')
  process.stdout.write(paint(C.dim, `  ${a.sessionCount} sessions\n\n`))
  const line = (l: string, v: string) => process.stdout.write('  ' + l.padEnd(20) + v + '\n')
  line('total tokens', fmtTokens(a.totals.tokens))
  line('tool calls', `${a.totals.toolCalls} (${a.totals.toolErrors} errors, ${(a.averages.toolErrorRate * 100).toFixed(1)}%)`)
  line('subagent runs', String(a.totals.agents))
  line('PRs / commits', `${a.totals.prs} / ${a.totals.commits}`)
  line('tokens / session', fmtTokens(a.averages.tokensPerSession))
  line('tokens / human turn', fmtTokens(a.averages.tokensPerHumanTurn))
  line('cache hit ratio', (a.averages.cacheHitRatio * 100).toFixed(1) + '%')
  if (a.byModel.length) {
    process.stdout.write('\n' + paint(C.b, '  tokens by model\n'))
    for (const m of a.byModel.slice(0, 6)) process.stdout.write(`    ${m.key.padEnd(24)} ${fmtTokens(m.tokens).padStart(9)}  ${m.count} session${m.count === 1 ? '' : 's'}\n`)
  }
  if (a.crossFindings.length) {
    process.stdout.write('\n' + paint(C.b, '  recurring findings (across sessions)\n'))
    for (const f of a.crossFindings.slice(0, 8)) process.stdout.write(`    ${paint(C.o, (f.totalSavingsTokens ? '~' + fmtTokens(f.totalSavingsTokens) : '–').padStart(8))}  ${f.title}  ${paint(C.dim, '(' + f.sessions + ' sessions)')}\n`)
  }
  if (a.recurringErrors.length) {
    process.stdout.write('\n' + paint(C.b, '  recurring tool errors (environment problems)\n'))
    for (const e of a.recurringErrors.slice(0, 6)) process.stdout.write(`    ${paint(C.r, String(e.total).padStart(4))}×  ${e.tool}: ${e.signature}  ${paint(C.dim, '(' + e.sessions + ' sessions)')}\n`)
  }
  if (a.topReReadFiles.length) {
    process.stdout.write('\n' + paint(C.b, '  most re-read files (context weight)\n'))
    for (const f of a.topReReadFiles.slice(0, 6)) process.stdout.write(`    ${String(f.totalReads).padStart(4)} reads  ${f.path}  ${paint(C.dim, '(' + f.sessions + ' sessions)')}\n`)
  }
  process.stdout.write('\n' + paint(C.b, '  heaviest sessions (by tokens)\n'))
  for (const s of a.topSessions.slice(0, 8)) process.stdout.write(`    ${fmtTokens(s.tokens).padStart(9)}  ${s.id.slice(0, 8)}  ${paint(C.dim, (s.title ?? '').slice(0, 50))}\n`)
  process.stdout.write(paint(C.dim, `\n  add --json for the full machine-readable aggregate\n`))
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  const portStr = flagStr(flags, 'port', 'p')
  const port = portStr !== undefined ? Number(portStr) : undefined
  if (portStr !== undefined && (!Number.isInteger(port) || port! < 0 || port! > 65535)) fail(`--port must be an integer 0–65535, got "${portStr}"`)
  const configArg = flagStr(flags, 'root', 'config', 'r')
  const roots = flagBool(flags, 'global') ? await claudeRoots(configArg) : undefined
  const maxLiveStr = flagStr(flags, 'max-live')
  const requestedAutomaticLaunch = flagBool(flags, 'allow-claude')
  const opts: ServeOptions = {
    port,
    // policy: open by default when TTY; --no-open suppresses
    open: !flagBool(flags, 'no-open') && (flagBool(flags, 'open') || Boolean(isTTY)),
    // loopback only (127.0.0.1): the operator sees their own transcript by default; --no-include-text opts out
    includeText: !flagBool(flags, 'no-include-text'),
    // the Export HTML download leaves the machine: redacted like `orangu report` unless --include-text
    exportIncludeText: flagBool(flags, 'include-text'),
    configDir: roots ? undefined : configArg,
    roots,
    cwd: flagStr(flags, 'cwd'),
    noCache: flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1',
    version: VERSION,
    maxLive: maxLiveStr !== undefined ? Math.max(1, Math.floor(Number(maxLiveStr)) || DEFAULT_MAX_LIVE) : undefined,
  }
  if (requestedAutomaticLaunch) process.stderr.write('  --allow-claude is retired: the report now provides copy-only Claude/Codex handoffs.\n')
  const srv = await startServe(opts)
  process.stderr.write(
    paint(C.o, paint(C.b, 'orangu serve')) +
      ` · ${srv.url}\n` +
      paint(C.dim, `  loopback only · model handoff: copy-only · watching up to ${opts.maxLive ?? DEFAULT_MAX_LIVE} live sessions · ctrl-c stops\n`),
  )
  if (opts.open) openInBrowser(srv.url)
  process.on('SIGINT', () => {
    void srv.close().then(() => {
      process.stderr.write('\n  stopped.\n')
      process.exit(0)
    })
  })
  await new Promise<void>(() => {})
}

function printHelp(): void {
  process.stdout.write(`${isTTY ? MASCOT_ASCII + '\n' : ''}
${paint(C.b, 'orangu')} v${VERSION}: observe the run, then improve the next outcome.
Deterministic observability for Claude Code sessions. The CLI makes no network calls.

${paint(C.b, 'usage')}
  orangu report  [<session>]   build a self-contained HTML report and open it
  orangu analyze [<session>]   print the analysis  (--json for the full object)
  orangu list                  list discoverable sessions  (--global for all roots)
  orangu repo    [<path>]      aggregate every session for a repo   (--json / --out)
  orangu global                aggregate every session everywhere    (--json)
  orangu watch   [<session>]   live-tail a session, refresh the report
  orangu serve                 local live viewer for EVERY session: fleet, SSE, aggregates
                               (--port <n> · --open/--no-open · --no-include-text · --max-live <n> · --global · --cwd <dir>)${EXTRA_HELP.map((l) => '\n' + l).join('')}

${paint(C.b, 'session')}   a session id, a unique id prefix, a path to a .jsonl, or "latest" (default)

${paint(C.b, 'flags')}
  -o, --out <file>       write the report/JSON here (default: temp dir)
  --json                 machine-readable output (the stable API)
  --stdout               write the HTML report to stdout
  --open / --no-open     open (or don't) the report in a browser
  --no-redact            keep secrets/paths in the report and --json (default: redacted)
  --slim                 with analyze --json: the slim projection LLM consumers read
  --include-text         keep prompt/result previews in report/analyze/watch output and in serve's exported HTML (default: stripped)
  --no-include-text      serve only: hide prompt/result previews in the loopback viewer too (serve shows them by default)
  --strip-paths          reduce absolute paths to basenames (home prefix is already ~ by default)
  --global               scan all roots incl. Cowork/Desktop
  --root <dir>           override the Claude config dir
  --limit <n>            cap sessions scanned (repo/global) or listed
  --no-cache             skip the analysis cache under ~/.orangu/cache (or ORANGU_NO_CACHE=1)
  --jobs <n>             worker threads for repo/global scans (default: CPUs - 1; 1 = sequential)
  --max-tokens <n>       exit non-zero if a session's total tokens exceed this (CI)
  --fail-on-hook-errors  exit non-zero if any hook errored (CI)
  --version, --help

${paint(C.dim, 'privacy: reports are generated locally, make zero network requests, and redact secrets by default.')}
`)
}

// ---------- main ----------
async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2))
  // `--no-cache` is a boolean; the generic parser may have eaten the next positional as its value
  if (typeof flags['no-cache'] === 'string') {
    positionals.push(flags['no-cache'] as string)
    flags['no-cache'] = true
  }
  if (flagBool(flags, 'version')) {
    process.stdout.write(VERSION + '\n')
    return
  }
  if (!command || flagBool(flags, 'help') || command === 'help') {
    printHelp()
    return
  }
  const sel = positionals[0]
  switch (command) {
    case 'report':
    case 'html':
      return cmdReport(sel, flags)
    case 'analyze':
    case 'a':
      return cmdAnalyze(sel, flags)
    case 'list':
    case 'ls':
      return cmdList(flags)
    case 'repo':
      return cmdAggregate('repo', sel, flags)
    case 'global':
    case 'all':
      return cmdAggregate('global', sel, flags)
    case 'watch': {
      const ref = await selectSession(sel, flags)
      return watchSession(ref, flags, { version: VERSION, openInBrowser, outPath: (id) => outPath(flags, id) })
    }
    case 'serve':
      return cmdServe(flags)
    default: {
      const extra = Object.prototype.hasOwnProperty.call(EXTRA_COMMANDS, command) ? EXTRA_COMMANDS[command] : undefined
      if (extra) return extra(positionals, flags)
      fail(`unknown command "${command}". Run: orangu --help`)
    }
  }
}

if (isPoolWorker()) {
  // this process is a worker thread of the aggregate pool: become one, never run the CLI
  runPoolWorker()
} else {
  main().catch((e) => fail(String(e instanceof Error ? e.stack ?? e.message : e)))
}
