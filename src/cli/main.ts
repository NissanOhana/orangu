/**
 * orangu CLI. Deterministic session observability. The CLI makes no network calls.
 *
 *   orangu                        interactive repo/global/session dashboard (TTY)
 *   orangu report [<session>]     build a self-contained HTML report and open it
 *   orangu analyze [<session>]    print the analysis (human summary, or --json for the full object)
 *   orangu list                   list discoverable sessions
 *   orangu pick                   choose an open session interactively and open its report
 *   orangu repo [<path>]          aggregate every session for a repo/cwd (--json / --out report)
 *   orangu global                 aggregate every session everywhere
 *   orangu watch [<session>]      live-tail a session and refresh the report
 *
 * Session selector: a session id, a unique id prefix, a path to a .jsonl, "latest" (default), or
 * "current" (the session the surrounding Claude Code process runs in; src/discover/current.ts).
 * `--session <sel>` / `-s <sel>` is the flag form of the positional.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, flagStr, flagBool, unknownFlags } from './args.js'
import { candidatesForPrefix, claudeRoots, findLatestSession, listSessions, resolveSession, type SessionRef } from '../discover/discover.js'
import { resolveCurrentSession } from '../discover/current.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { aggregate } from '../analyze/aggregate.js'
import { renderAggregateReport, renderReport } from '../report/render.js'
import { AnalysisCache, analyzeRefCached } from '../cache/index.js'
import { analyzeAllPooled, defaultJobs, isPoolWorker, runPoolWorker } from '../cache/pool.js'
import { fmtTokens } from '../analyze/util.js'
import { redactValue, type RedactOptions } from '../redact/redact.js'
import { watchSession } from './watch.js'
import { MACHINE_CAPS, detectCaps, paint, spinner, type Caps, type Spinner } from './tty.js'
import { analysisBlock, betaLine, briefBlock, doneLine, fmtBytes, listRows, nextStepLines, reportFooter, row, type NextStep } from './summary.js'
import { persistNextStep } from './next-step.js'
import { startServe } from '../serve/server.js'
import { DEFAULT_MAX_LIVE } from '../serve/registry.js'
import type { ServeOptions } from '../serve/types.js'
import { mascotLines } from './mascot-ascii.js'
import type { Analysis } from '../model/analysis.js'
import { EXTRA_COMMANDS, EXTRA_HELP } from './commands/index.js'
import { cmdPick } from './commands/pick.js'
import { cmdDashboard } from './commands/dashboard.js'
import { plural } from '../harness/report.js'
import { emitAnalysisJson, prepareAggregateForOutput, renderPreparedAggregateJson, type PreparedAggregate } from './json-out.js'
import { writePrivateOutput } from './private-output.js'
import { openInBrowser } from './open-browser.js'
import { VERSION } from '../version.js'

/**
 * Capabilities per stream, decided once in main(): stdout carries the answer, stderr the progress and
 * hints, and `orangu report 2>log` must not paint the log. --json / --quiet / --no-color set
 * `machine`, which beats every environment variable (no spinner frame may reach a 2>&1 capture).
 */
let out: Caps = MACHINE_CAPS
let err: Caps = MACHINE_CAPS
/** the spinner currently drawing on stderr, so an error message never lands on a frame */
let progress: Spinner | undefined

function detectStreams(flags: Record<string, string | boolean>): void {
  const machine = flagBool(flags, 'json') || flagBool(flags, 'quiet') || flagBool(flags, 'no-color')
  out = detectCaps(process.stdout, process.env, { machine })
  err = detectCaps(process.stderr, process.env, { machine })
}

function offerBetaFeedback(context: 'session' | 'repo' | 'global' | 'report'): void {
  process.stderr.write(betaLine(err, context) + '\n')
}

/**
 * The next step after a session was analyzed: the top finding persisted as a suggestion record and
 * the short improve command for it (src/cli/next-step.ts). Called only where the footer is printed,
 * so --json and --quiet reads stay side-effect free.
 */
function nextStep(a: Analysis, flags: Record<string, string | boolean>): Promise<NextStep> {
  return persistNextStep(a, redactOptions(flags))
}

function redactOptions(flags: Record<string, string | boolean>): RedactOptions | false {
  if (flagBool(flags, 'no-redact')) return false
  return { scrub: true, stripText: !flagBool(flags, 'include-text'), stripPaths: flagBool(flags, 'strip-paths') }
}

/**
 * The session title for a human stdout line. `analyzeRef` returns the raw Analysis (redaction is an
 * emit-boundary concern), and the title is transcript-authored, so it gets the same scrub the
 * `--json` path applies to `session.title` (scrubbed, never stripped) unless --no-redact.
 */
function displayTitle(a: Analysis, flags: Record<string, string | boolean>): string {
  const title = a.session.title || a.session.id.slice(0, 12)
  const ro = redactOptions(flags)
  return ro ? redactValue(title, { scrub: ro.scrub, stripPaths: ro.stripPaths }) : title
}

/** The verbs that read one session selector (positional or --session); `undefined` is bare `orangu`. */
const SESSION_SELECTOR_VERBS = new Set<string | undefined>([undefined, 'report', 'html', 'analyze', 'a', 'watch', 'estimate', 'evidence', 'suggest'])
const SELECTOR_FORMS = 'an id, a unique prefix, a .jsonl path, latest, or current'

/**
 * One selector from the positional and `--session` / `-s`. Both may be given only when they agree:
 * a silent preference would be an answer about the wrong session.
 */
function sessionSelector(sel: string | undefined, flags: Record<string, string | boolean>): string | undefined {
  const raw = flags['session'] ?? flags['s']
  if (raw === undefined) return sel
  if (typeof raw !== 'string' || !raw.trim()) fail(`--session needs a session selector: ${SELECTOR_FORMS}`)
  const flag = (raw as string).trim()
  if (flag.includes(',')) fail('--session takes one session here; comma lists belong to estimate and suggest')
  if (sel !== undefined && sel !== flag) fail(`--session ${flag} and "${sel}" name different sessions; give one`)
  return flag
}

async function selectSession(sel: string | undefined, flags: Record<string, string | boolean>): Promise<SessionRef> {
  sel = sessionSelector(sel, flags)
  const configArg = flagStr(flags, 'root', 'config', 'r')
  let opts: { configDir?: string; roots?: string[]; cwd?: string } = configArg ? { configDir: configArg } : {}
  if (flagBool(flags, 'global')) opts = { roots: await claudeRoots(configArg) }
  if (flags['cwd']) opts.cwd = String(flags['cwd'])
  if (!sel || sel === 'latest') {
    const s = await findLatestSession(opts)
    if (!s) fail('No sessions found. Is Claude Code installed? Try: orangu list')
    return s!
  }
  if (sel === 'current') {
    // resolved to a concrete session here and never persisted or passed on as the alias
    const found = await resolveCurrentSession(opts, process.env)
    if (found.note && !flagBool(flags, 'quiet') && !flagBool(flags, 'json')) process.stderr.write('  ' + paint(err, 'dim', found.note) + '\n')
    return found.ref
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
  progress?.pause()
  process.stderr.write(paint(err, 'bad', 'error: ') + msg + '\n')
  process.exit(1)
}

function makeCache(flags: Record<string, string | boolean>): AnalysisCache | null {
  const disabled = flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1'
  if (disabled) return null
  return new AnalysisCache({ version: VERSION })
}

/** A diagnostic, not an answer: --verbose only, dim, stderr (also under --json, whose stdout stays the contract). */
function printCacheStats(cache: AnalysisCache | null, flags: Record<string, string | boolean>): void {
  if (!cache || !flagBool(flags, 'verbose') || flagBool(flags, 'quiet')) return
  // the row lands while the spinner runs: erase its frame first, or the spinner's own stop() erases the row
  progress?.pause()
  const s = cache.stats()
  process.stderr.write(row(err, 'cache', `${s.hits} hits, ${s.misses} misses`, { style: 'dim' }) + '\n')
}

async function analyzeRef(ref: SessionRef, flags: Record<string, string | boolean>, cache?: AnalysisCache | null) {
  const c = cache !== undefined ? cache : makeCache(flags)
  const analysis = await analyzeRefCached(ref, { cache: c, version: VERSION, now: Date.now() })
  if (cache === undefined) printCacheStats(c, flags)
  return analysis
}

/** Analyze one session behind the stderr spinner (silent on a pipe); the caller prints the check line. */
async function analyzeWithProgress(ref: SessionRef, flags: Record<string, string | boolean>): Promise<{ analysis: Analysis; elapsedMs: number }> {
  const quiet = flagBool(flags, 'quiet') || flagBool(flags, 'json')
  const t0 = performance.now()
  const sp = spinner(err)
  progress = sp
  if (!quiet) sp.start(`analyzing ${ref.sessionId.slice(0, 8)} ${fmtBytes(ref.sizeBytes)}`)
  try {
    const analysis = await analyzeRef(ref, flags)
    return { analysis, elapsedMs: performance.now() - t0 }
  } finally {
    sp.stop()
    progress = undefined
  }
}

function outPath(flags: Record<string, string | boolean>, id: string, ext = 'html'): string {
  const out = flagStr(flags, 'o', 'out')
  if (out) return resolve(out)
  return join(tmpdir(), `orangu-${id.slice(0, 8)}.${ext}`)
}

// ---------- commands ----------
/**
 * stdout is the path and nothing else (a piping contract: `orangu report | xargs open`); the whole
 * human footer goes to stderr. Under --quiet or --json stderr is silent and nothing is persisted (a
 * machine read has no side effect); --stdout writes the HTML instead.
 */
async function cmdReport(sel: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  const ref = await selectSession(sel, flags)
  const { analysis, elapsedMs } = await analyzeWithProgress(ref, flags)
  const { html, redaction } = renderReport(analysis, { redact: redactOptions(flags) })
  if (flagBool(flags, 'stdout')) {
    process.stdout.write(html)
    return
  }
  const path = outPath(flags, ref.sessionId)
  await writePrivateOutput(path, html)
  const opened = !flagBool(flags, 'no-open') && (flagBool(flags, 'open') || out.tty)
  if (opened) openInBrowser(path)
  process.stdout.write(path + '\n')
  if (!flagBool(flags, 'quiet') && !flagBool(flags, 'json')) {
    process.stderr.write(doneLine(err, { sizeBytes: ref.sizeBytes, elapsedMs, redactions: redaction?.applied }) + '\n')
    const step = await nextStep(analysis, flags)
    process.stderr.write(reportFooter(err, { path, opened, step }).join('\n') + '\n')
  }
  thresholdExit(analysis, flags)
}

async function cmdAnalyze(sel: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  const ref = await selectSession(sel, flags)
  const { analysis, elapsedMs } = await analyzeWithProgress(ref, flags)
  if (flagBool(flags, 'json')) {
    emitAnalysisJson(analysis, flags)
    thresholdExit(analysis, flags)
    return
  }
  process.stdout.write(analysisBlock(out, analysis, displayTitle(analysis, flags)).join('\n') + '\n')
  if (!flagBool(flags, 'quiet')) {
    process.stderr.write(doneLine(err, { sizeBytes: ref.sizeBytes, elapsedMs }) + '\n')
    const step = await nextStep(analysis, flags)
    process.stderr.write(nextStepLines(err, step).join('\n') + '\n')
    offerBetaFeedback('session')
  }
  thresholdExit(analysis, flags)
}

/**
 * `orangu` with no verb: the loop in one screen. Analyze the latest session and print the true
 * sentence (the same outcomeHeadline the report leads with), the top finding and the exact next
 * command. `orangu --help` / `orangu help` are untouched; no sessions -> the usual error, not help.
 */
async function cmdBrief(flags: Record<string, string | boolean>): Promise<void> {
  const ref = await selectSession(undefined, flags)
  const { analysis } = await analyzeWithProgress(ref, flags)
  // the next step is part of the loop's own output (so `orangu > out.txt` keeps it); --quiet keeps
  // the answer and drops the trailing hint
  const step = await nextStep(analysis, flags)
  process.stdout.write(briefBlock(out, analysis, displayTitle(analysis, flags), step, { hint: !flagBool(flags, 'quiet') }).join('\n') + '\n')
  thresholdExit(analysis, flags)
}

/** Bind the shared picker to the real report command once; both `pick` and the dashboard use it. */
function pickSessions(flags: Record<string, string | boolean>): Promise<void> {
  return cmdPick(flags, {
    openReport: (id) => cmdReport(id, { ...flags, open: true }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    out,
    err,
  })
}

/** Flags that were removed but would otherwise be ignored in silence, turning a CI gate into a no-op. */
const RETIRED_FLAGS: Record<string, string> = {
  'max-cost': '--max-cost was removed; use --max-tokens <n>',
}

/** The CI gate flags read by thresholdExit; they gate ONE session, so only the session verbs accept them. */
const SESSION_GATE_FLAGS = ['max-tokens', 'fail-on-hook-errors'] as const
const SESSION_GATE_VERBS = new Set(['report', 'html', 'analyze', 'a'])

/** The scope verbs, whose answer is stdout: an HTML file and a browser handoff are opt-in extras. */
const AGGREGATE_VERBS = new Set(['repo', 'global', 'all'])
/** Side-effect flags that a machine read must never trigger on a scope verb. */
const AGGREGATE_SIDE_EFFECT_FLAGS = ['html', 'open'] as const

/**
 * Every verb parses the same flag table, so a retired flag, an unknown flag, or a session gate on a
 * verb that never evaluates it fails here before any verb runs. A gate that silently stops gating
 * is worse than a removed gate: exit non-zero and say what to use.
 */
function rejectUnusableFlags(command: string | undefined, flags: Record<string, string | boolean>): void {
  for (const [flag, message] of Object.entries(RETIRED_FLAGS)) if (flags[flag] !== undefined) fail(message)
  const unknown = unknownFlags(flags)
  if (unknown.length) fail(`unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Run: orangu --help`)
  if (command !== undefined && !SESSION_GATE_VERBS.has(command)) {
    for (const flag of SESSION_GATE_FLAGS) {
      if (flags[flag] !== undefined) fail(`--${flag} gates one session: use it with orangu analyze or orangu report`)
    }
  }
  if (!SESSION_SELECTOR_VERBS.has(command) && (flags['session'] !== undefined || flags['s'] !== undefined)) {
    fail('--session selects one session: use it with report, analyze, watch, estimate or evidence')
  }
  if (command !== undefined && AGGREGATE_VERBS.has(command)) {
    // A machine read has no side effect: refuse the combination here, before a single session is
    // read, rather than writing a file the caller piping JSON never asked for.
    if (flagBool(flags, 'json')) {
      for (const flag of AGGREGATE_SIDE_EFFECT_FLAGS) {
        if (flags[flag] !== undefined) fail(`--${flag} writes the HTML report; --json is a machine read with no side effect. Run them separately.`)
      }
    }
  } else if (command !== undefined && flags['html'] !== undefined) {
    // Only the scope verbs write an aggregate report; elsewhere --html would be silently ignored,
    // and an ignored output flag is a report the caller never gets and never hears about.
    fail('--html writes the scope report: use it with orangu repo or orangu global')
  }
}

function thresholdExit(analysis: ReturnType<typeof analyzeSession>, flags: Record<string, string | boolean>): void {
  let bad = false
  const maxTokensStr = flagStr(flags, 'max-tokens')
  if (maxTokensStr !== undefined && Number.isNaN(Number(maxTokensStr))) fail(`--max-tokens must be a number, got "${maxTokensStr}"`)
  const maxTokens = Number(maxTokensStr)
  if (maxTokensStr !== undefined && !Number.isNaN(maxTokens) && analysis.summary.totalTokens > maxTokens) {
    process.stderr.write(paint(err, 'bad', `FAIL: ${fmtTokens(analysis.summary.totalTokens)} tokens > --max-tokens ${fmtTokens(maxTokens)}`) + '\n')
    bad = true
  }
  if (flagBool(flags, 'fail-on-hook-errors') && analysis.hooks.errors > 0) {
    process.stderr.write(paint(err, 'bad', `FAIL: ${analysis.hooks.errors} hook errors`) + '\n')
    bad = true
  }
  if (bad) process.exit(2)
}

async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const configArg = flagStr(flags, 'root', 'config', 'r')
  // --cwd scopes the list to one repo, exactly as serve --cwd does
  const cwd = flags['cwd'] ? { cwd: String(flags['cwd']) } : {}
  const all: SessionRef[] = flagBool(flags, 'global')
    ? await listSessions({ roots: await claudeRoots(configArg), ...cwd })
    : await listSessions({ ...(configArg ? { configDir: configArg } : {}), ...cwd })
  const limit = Number(flagStr(flags, 'limit', 'l') ?? '40')
  const rows = all.slice(0, Number.isNaN(limit) ? 40 : limit)
  if (flagBool(flags, 'json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    return
  }
  process.stdout.write(listRows(out, rows, { total: all.length, global: flagBool(flags, 'global') }).join('\n') + '\n')
}

async function cmdAggregate(scope: 'repo' | 'global', selOrPath: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  let refs: SessionRef[]
  let scopeLabel: string
  if (scope === 'global') {
    const roots = await claudeRoots(flagStr(flags, 'root', 'r'))
    refs = await listSessions({ roots })
    scopeLabel = `global (${plural(roots.length, 'root')})`
  } else {
    const cwd = selOrPath ? resolve(selOrPath) : process.cwd()
    // --root scopes the repo scan to that config dir, exactly as `orangu harness` does
    const rootArg = flagStr(flags, 'root', 'r')
    refs = await listSessions(rootArg ? { configDir: rootArg, cwd } : { cwd })
    scopeLabel = `repo ${basename(cwd)}`
  }
  if (!refs.length) fail(`No sessions found for ${scopeLabel}.`)
  const max = Number(flagStr(flags, 'limit') ?? (scope === 'global' ? '500' : '200'))
  const use = refs.slice(0, Number.isNaN(max) ? refs.length : max)
  const quiet = flagBool(flags, 'quiet') || flagBool(flags, 'json')
  const t0 = performance.now()
  const sp = spinner(err)
  progress = sp
  if (!quiet) sp.start(`analyzing ${plural(use.length, 'session')}`)
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
    sp.stop(quiet ? undefined : doneLine(err, { sizeBytes: use.reduce((n, ref) => n + ref.sizeBytes, 0), elapsedMs: performance.now() - t0 }))
    progress = undefined
    if (!flagBool(flags, 'quiet') && flagBool(flags, 'verbose')) {
      process.stderr.write(row(err, 'jobs', String(jobsN), { style: 'dim' }) + '\n')
      if (cacheEnabled) process.stderr.write(row(err, 'cache', `${r.hits} hits, ${r.misses} misses`, { style: 'dim' }) + '\n')
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
    sp.stop(quiet ? undefined : doneLine(err, { sizeBytes: use.reduce((n, ref) => n + ref.sizeBytes, 0), elapsedMs: performance.now() - t0 }))
    progress = undefined
    printCacheStats(cache, flags)
  }
  const agg = aggregate(analyses, scopeLabel, Date.now())
  if (failed) agg.scope += ` (${failed} unreadable skipped)`
  const outputAggregate = prepareAggregateForOutput(agg, flags)
  const wroteHtml = await writeAggregateHtml(scope, outputAggregate, flags)
  const outFile = flagStr(flags, 'o', 'out')
  if (outFile) {
    await writePrivateOutput(resolve(outFile), renderPreparedAggregateJson(outputAggregate, flags, { pretty: true, trailingNewline: false }))
    if (!quiet) process.stderr.write(row(err, 'written', resolve(outFile), { raw: true }) + '\n')
    if (!flagBool(flags, 'json')) {
      if (!flagBool(flags, 'quiet')) offerBetaFeedback(scope)
      return
    }
  }
  if (flagBool(flags, 'json')) {
    process.stdout.write(renderPreparedAggregateJson(outputAggregate, flags))
    return
  }
  printAggregate(outputAggregate, wroteHtml)
  if (!flagBool(flags, 'quiet')) offerBetaFeedback(scope)
}

/**
 * The scope report as one self-contained HTML file, written only when --html or --open asks for it.
 *
 * The input is a PreparedAggregate, so the redaction boundary is the type: this function never
 * redacts and cannot be handed a raw aggregate. --json can never reach here (rejectUnusableFlags
 * refuses the combination first) and --no-open beats --open, exactly as it does for `orangu report`.
 * The default name carries the scope and a hash of the scope label and the aggregate clock, so two
 * repositories never collide and a re-run never overwrites the file a browser still has open.
 */
async function writeAggregateHtml(scope: 'repo' | 'global', a: PreparedAggregate, flags: Record<string, string | boolean>): Promise<boolean> {
  const open = flagBool(flags, 'open') && !flagBool(flags, 'no-open')
  if (flags['html'] === undefined && !open) return false
  const named = flagStr(flags, 'html')
  const stamp = createHash('sha256').update(`${a.scope}\n${a.generatedAt}`).digest('hex').slice(0, 8)
  const path = named ? resolve(named) : join(tmpdir(), `orangu-${scope}-${stamp}.html`)
  // includeText mirrors what survived prepareAggregateForOutput, so the client's "text hidden" note is true
  const includeText = flagBool(flags, 'no-redact') || flagBool(flags, 'include-text')
  const { html } = renderAggregateReport(a, { scope, scopeLabel: a.scope, includeText })
  await writePrivateOutput(path, html)
  if (open) openInBrowser(path)
  if (!flagBool(flags, 'quiet')) {
    process.stderr.write(row(err, 'report', path, { raw: true }) + (open ? paint(err, 'dim', '  (opened)') : '') + '\n')
  }
  return true
}

function printAggregate(a: ReturnType<typeof aggregate>, wroteHtml: boolean): void {
  process.stdout.write('\n' + paint(out, ['bold', 'accent'], 'orangu') + '  ' + paint(out, 'bold', a.scope) + '\n')
  process.stdout.write(paint(out, 'dim', `  ${plural(a.sessionCount, 'session')}\n\n`))
  const line = (l: string, v: string) => process.stdout.write('  ' + l.padEnd(20) + v + '\n')
  line('total tokens', fmtTokens(a.totals.tokens))
  line('tool calls', `${a.totals.toolCalls} (${a.totals.toolErrors} errors, ${(a.averages.toolErrorRate * 100).toFixed(1)}%)`)
  line('subagent runs', String(a.totals.agents))
  line('PRs / commits', `${a.totals.prs} / ${a.totals.commits}`)
  line('tokens / session', fmtTokens(a.averages.tokensPerSession))
  line('tokens / human turn', fmtTokens(a.averages.tokensPerHumanTurn))
  line('cache hit ratio', (a.averages.cacheHitRatio * 100).toFixed(1) + '%')
  if (a.byModel.length) {
    process.stdout.write('\n' + paint(out, 'bold', '  tokens by model\n'))
    for (const m of a.byModel.slice(0, 6)) process.stdout.write(`    ${m.key.padEnd(24)} ${fmtTokens(m.tokens).padStart(9)}  ${m.count} session${m.count === 1 ? '' : 's'}\n`)
  }
  if (a.crossFindings.length) {
    process.stdout.write('\n' + paint(out, 'bold', '  recurring findings (across sessions)\n'))
    // The bounded figure (median per session × sessions) so one outlier session cannot inflate the claim.
    for (const f of a.crossFindings.slice(0, 8)) process.stdout.write(`    ${paint(out, 'accent', (f.boundedSavingsTokens ? '~' + fmtTokens(f.boundedSavingsTokens) : '–').padStart(8))}  ${f.title}  ${paint(out, 'dim', '(' + plural(f.sessions, 'session') + ')')}\n`)
  }
  if (a.recurringErrors.length) {
    process.stdout.write('\n' + paint(out, 'bold', '  recurring tool errors (environment problems)\n'))
    // Under the default strip every signature is blank, so N identical rows would say nothing: collapse per tool.
    const hidden = new Map<string, { total: number; groups: number; sessions: number }>()
    for (const e of a.recurringErrors) {
      if (e.signature) continue
      const h = hidden.get(e.tool) ?? { total: 0, groups: 0, sessions: 0 }
      h.total += e.total
      h.groups += 1
      h.sessions = Math.max(h.sessions, e.sessions)
      hidden.set(e.tool, h)
    }
    for (const e of a.recurringErrors.filter((e) => e.signature).slice(0, 6)) process.stdout.write(`    ${paint(out, 'bad', String(e.total).padStart(4))}×  ${e.tool}: ${e.signature}  ${paint(out, 'dim', '(' + plural(e.sessions, 'session') + ')')}\n`)
    for (const [tool, h] of [...hidden].slice(0, 6)) process.stdout.write(`    ${paint(out, 'bad', String(h.total).padStart(4))}×  ${tool}: ${plural(h.groups, 'recurring signature')}, text hidden; use --include-text  ${paint(out, 'dim', '(' + plural(h.sessions, 'session') + ')')}\n`)
  }
  if (a.topReReadFiles.length) {
    process.stdout.write('\n' + paint(out, 'bold', '  most re-read files (context weight)\n'))
    for (const f of a.topReReadFiles.slice(0, 6)) process.stdout.write(`    ${String(f.totalReads).padStart(4)} reads  ${f.path}  ${paint(out, 'dim', '(' + plural(f.sessions, 'session') + ')')}\n`)
  }
  process.stdout.write('\n' + paint(out, 'bold', '  heaviest sessions (by tokens)\n'))
  for (const s of a.topSessions.slice(0, 8)) process.stdout.write(`    ${fmtTokens(s.tokens).padStart(9)}  ${s.id.slice(0, 8)}  ${paint(out, 'dim', s.title ? s.title.slice(0, 50) : '(title hidden; use --include-text)')}\n`)
  // --open already did what it offers: once the report is written and handed to a browser, repeating
  // the flag that wrote it is noise. The machine-readable half is still news either way.
  const offer = wroteHtml ? '--json for the full machine-readable aggregate' : '--open for the HTML report, --json for the full machine-readable aggregate'
  process.stdout.write(paint(out, 'dim', `\n  add ${offer}\n`))
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
    open: !flagBool(flags, 'no-open') && (flagBool(flags, 'open') || out.tty),
    // loopback + capability URL: the operator sees their own transcript by default; --no-include-text opts out
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
    paint(err, ['bold', 'accent'], 'orangu serve') +
      ` · ${srv.url}\n` +
      paint(err, 'dim', `  loopback + private capability · model handoff: copy-only · watching up to ${opts.maxLive ?? DEFAULT_MAX_LIVE} live sessions · ctrl-c stops\n`),
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
  process.stdout.write(`${out.tty ? '\n' + mascotLines(out).join('\n') + '\n' : ''}
${paint(out, 'bold', 'orangu')} v${VERSION}: observe the run, then improve the next outcome.
Deterministic observability for Claude Code sessions. No network calls.

${paint(out, 'bold', 'usage')}
  orangu                       interactive report dashboard (terminal)
                               latest-session brief when piped or in CI
  orangu report  [<session>]   build a self-contained HTML report and open it
  orangu analyze [<session>]   print the analysis  (--json for the full object)
  orangu list                  list discoverable sessions  (--global: all roots)
  orangu pick                  choose an open session, open its report
                               (--json lists; --plain numbers; --limit <n>)
  orangu repo    [<path>]      aggregate every session for a repo (--json/--out)
  orangu global                aggregate every session everywhere    (--json)
  orangu watch   [<session>]   live-tail a session, refresh the report
  orangu serve                 local live viewer for every session (fleet, SSE)
                               --port <n> · --open/--no-open · --max-live <n>
                               --no-include-text · --global · --cwd <dir>${EXTRA_HELP.map((l) => '\n' + l).join('')}

${paint(out, 'bold', 'session')}   a session id, a unique id prefix, a .jsonl path, "latest" (default),
          or "current" (the session Claude Code is running orangu from)

${paint(out, 'bold', 'flags')}
  -s, --session <sel>    the session, as a flag (same forms as the positional)
  -o, --out <file>       write the report/JSON here (default: temp dir)
  --json                 machine-readable output (the stable API)
  --stdout               write the HTML report to stdout
  --html <file>          repo/global: write the aggregate HTML report here
  --open / --no-open     open (or don't) the HTML report (report, repo/global)
  --no-redact            keep secrets/paths in the output (default: redacted)
  --slim                 with analyze --json: the slim projection LLMs read
  --include-text         keep prompt/result previews in report, analyze, watch,
                         evidence, repo/global output and serve's exported HTML
  --no-include-text      serve only: hide previews in the loopback viewer too
  --strip-paths          reduce absolute paths to basenames (home is ~ already)
  --global               scan all roots incl. Cowork/Desktop
  --root <dir>           scan only this Claude config dir (comma-separated list)
  --limit <n>            cap sessions scanned (repo/global) or listed
  --no-cache             skip the analysis cache under ~/.orangu/cache
  --verbose              also print the cache diagnostic (stderr)
  --quiet                no progress or hints on stderr (the answer only)
  --plain                pick only: a numbered list instead of the prompt
  --no-color             plain output (NO_COLOR, FORCE_COLOR, TERM=dumb and CI
                         are honoured; NO_COLOR, FORCE_COLOR=0 and
                         ORANGU_NO_ANIMATION=1 also stop the spinner)
  --jobs <n>             worker threads for repo/global scans (default: CPUs-1)
  --max-tokens <n>       exit 2 above this token total (CI: analyze/report)
  --fail-on-hook-errors  exit non-zero if any hook errored (CI; analyze, report)
  --version, --help

${paint(out, 'dim', 'privacy: generated locally, zero network requests, secrets redacted by default.')}
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
  detectStreams(flags)
  if (flagBool(flags, 'version')) {
    process.stdout.write(VERSION + '\n')
    return
  }
  if (flagBool(flags, 'help') || flagBool(flags, 'h') || command === 'help') {
    printHelp()
    return
  }
  rejectUnusableFlags(command, flags)
  // No verb: an interactive report dashboard on a terminal. Machine callers retain the compact
  // latest-session answer; --json has no unambiguous scope, so it continues to print help.
  if (!command) {
    if (flagBool(flags, 'json')) printHelp()
    else {
      const handled = await cmdDashboard(flags, {
        showRepo: (o) => cmdAggregate('repo', undefined, { ...flags, ...o }),
        showGlobal: (o) => cmdAggregate('global', undefined, { ...flags, ...o }),
        showSession: (id) => cmdReport(id, { ...flags, open: true }),
        browseSessions: () => pickSessions({ ...flags, global: true }),
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        out,
        err,
      })
      if (!handled) await cmdBrief(flags)
    }
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
    case 'pick':
      return pickSessions(flags)
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

// `orangu … | head` closes the pipe early: that is the reader's choice, not an error worth a stack trace
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0)
    throw e
  })
}

if (isPoolWorker()) {
  // this process is a worker thread of the aggregate pool: become one, never run the CLI
  runPoolWorker()
} else {
  // A thrown Error is a user-facing message (not found, bad flag value); the stack is noise unless
  // ORANGU_DEBUG=1 asks for it.
  main().catch((e) => fail(e instanceof Error ? (process.env['ORANGU_DEBUG'] === '1' ? e.stack ?? e.message : e.message) : String(e)))
}
