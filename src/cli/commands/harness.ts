/**
 * `orangu harness`: what your Claude Code config DECLARES vs what your sessions actually DID.
 *
 * Deterministic and offline: it reads the config dirs, analyzes the sessions through the same cached path
 * `orangu global` uses, and hands both to `src/harness/`. No model, no network. The verb recommends
 * nothing; it classifies each row `used | idle | undeclared` and prints the measured numbers. Recommendation
 * recommendation text belongs to the optional plugin skills.
 *
 * Everything here is in tokens and effort. There is no money on this surface, by rule.
 *
 *   orangu harness [--json] [--cwd <dir>] [--root <dir>] [--global] [--limit <n>]
 *                  [-o|--out <file>] [--no-redact] [--strip-paths] [--jobs <n>] [--no-cache] [--quiet]
 */
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { claudeRoots, defaultConfigDir, listSessions, type SessionRef } from '../../discover/discover.js'
import { AnalysisCache, analyzeRefCached } from '../../cache/index.js'
import { analyzeAllPooled, defaultJobs } from '../../cache/pool.js'
import { aggregate } from '../../analyze/aggregate.js'
import { collectInventory } from '../../harness/collect.js'
import { buildHarnessReport, plural } from '../../harness/report.js'
import type { HarnessReport } from '../../harness/types.js'
import { redactValue } from '../../redact/redact.js'
import { flagBool, flagStr } from '../args.js'
import type { Analysis } from '../../model/analysis.js'
import { writePrivateOutput } from '../private-output.js'
import { MACHINE_CAPS, detectCaps, glyphs, paint, type Caps } from '../tty.js'

declare const __ORANGU_VERSION__: string
const VERSION = typeof __ORANGU_VERSION__ !== 'undefined' ? __ORANGU_VERSION__ : '0.0.0-dev'

/** caps per stream, decided when the verb runs (src/cli/tty.ts); machine under --json / --quiet / --no-color */
let out: Caps = MACHINE_CAPS
let err: Caps = MACHINE_CAPS
function detectStreams(flags: Record<string, string | boolean>): void {
  const machine = flagBool(flags, 'json') || flagBool(flags, 'quiet') || flagBool(flags, 'no-color')
  out = detectCaps(process.stdout, process.env, { machine })
  err = detectCaps(process.stderr, process.env, { machine })
}

const n = (x: number) => x.toLocaleString('en-US')
const kb = (bytes: number) => (bytes / 1024).toFixed(1) + ' KB'

/**
 * Build the report the verb prints. Shared with `orangu estimate harness`, so the two never disagree about
 * what would be read, and so the second run of the pair is a cache hit rather than a second full scan.
 */
export async function runHarness(flags: Record<string, string | boolean>): Promise<HarnessReport> {
  detectStreams(flags)
  const isGlobal = flagBool(flags, 'global')
  const configArg = flagStr(flags, 'root', 'r')
  const cwd = flags['cwd'] ? resolve(String(flags['cwd'])) : process.cwd()

  let refs: SessionRef[]
  let roots: string[]
  let scopeLabel: string
  if (isGlobal) {
    roots = await claudeRoots(configArg)
    refs = await listSessions({ roots })
    scopeLabel = `global (${roots.length} roots)`
  } else {
    roots = [configArg ?? defaultConfigDir()]
    refs = await listSessions(configArg ? { configDir: configArg, cwd } : { cwd })
    scopeLabel = `repo ${basename(cwd)}`
  }

  // Same limit defaults as cmdAggregate (src/cli/main.ts): 500 global, 200 repo. Resolved ONCE and used for
  // both the slice and `scope.limit`: an unparseable `--limit abc` must not reach the report as NaN, which
  // JSON.stringify emits as `null` while HarnessScope.limit is declared `number`.
  const limitDefault = isGlobal ? 500 : 200
  const limitRaw = flagStr(flags, 'limit')
  const limitParsed = limitRaw === undefined ? limitDefault : Number(limitRaw)
  const limit = Number.isFinite(limitParsed) && limitParsed >= 0 ? Math.floor(limitParsed) : limitDefault
  const use = refs.slice(0, limit)
  const now = Date.now()

  const analyses: Analysis[] = []
  let failed = 0
  const cacheEnabled = !(flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1')
  const jobsStr = flagStr(flags, 'jobs', 'j')
  const jobsN = jobsStr !== undefined ? Math.max(1, Math.floor(Number(jobsStr)) || 1) : defaultJobs()
  // the pool re-loads the CLI bundle as its worker entry, so it only runs from the built file
  const bundledEntry = /\.(m?js)$/.test(new URL(import.meta.url).pathname)
  if (jobsN > 1 && use.length > 1 && bundledEntry) {
    const r = await analyzeAllPooled(use, { entry: new URL(import.meta.url), jobs: jobsN, version: VERSION, now, cacheEnabled })
    analyses.push(...r.analyses)
    failed = r.failed
  } else {
    const cache = cacheEnabled ? new AnalysisCache({ version: VERSION }) : null
    for (const ref of use) {
      try {
        analyses.push(await analyzeRefCached(ref, { cache, version: VERSION, now }))
      } catch {
        failed++
      }
    }
  }
  if (!flagBool(flags, 'quiet')) process.stderr.write(paint(err, 'dim', `analyzed ${plural(analyses.length, 'session')}: declared vs used`) + '\n')

  const home = homedir()
  const inventory = await collectInventory({ cwd, roots, home })
  const agg = aggregate(analyses, scopeLabel, now)
  const report = buildHarnessReport(inventory, analyses, agg, {
    version: VERSION,
    now,
    scope: { cwd, roots, global: isGlobal, limit, sessionsUnreadable: failed, home },
  })

  // the collector already scrubs at construction; this pass adds --strip-paths and is a no-op otherwise
  if (flagBool(flags, 'no-redact')) return report
  return redactValue(report, { scrub: true, stripPaths: flagBool(flags, 'strip-paths'), home })
}

export async function cmdHarness(_positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const report = await runHarness(flags)

  // mirrors cmdAggregate's --out contract exactly (src/cli/main.ts:262-267): the file gets the pretty JSON,
  // stderr gets one line, and stdout stays EMPTY unless --json was also asked for. That is what lets the
  // skill materialise the digest with `orangu harness --out <tmp>/harness.json` without it entering context.
  const outFile = flagStr(flags, 'o', 'out')
  if (outFile) {
    await writePrivateOutput(resolve(outFile), JSON.stringify(report, null, 2))
    process.stderr.write(paint(err, 'good', glyphs(err).ok) + ` harness written to ${resolve(outFile)}\n`)
    if (!flagBool(flags, 'json')) return
  }
  if (flagBool(flags, 'json')) {
    process.stdout.write(JSON.stringify(report, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')
    return
  }
  printHarness(report)
}

function printHarness(r: HarnessReport): void {
  const w = (s = '') => process.stdout.write(s + '\n')
  const inv = r.inventory
  const x = r.crosswalk
  const scopeLabel = r.scope.global ? `global (${r.scope.roots.length} roots)` : `repo ${basename(r.scope.cwd)}`

  w()
  w(paint(out, ['bold', 'accent'], 'orangu') + '  ' + paint(out, 'bold', 'harness · ' + scopeLabel))
  w(paint(out, 'dim', `  ${n(r.scope.sessionsScanned)} session${r.scope.sessionsScanned === 1 ? '' : 's'} scanned`))
  w()

  // designed empty state: never a blank report
  const nothing = inv.settings.length === 0 && inv.skills.length === 0 && inv.agents.length === 0 && inv.plugins.length === 0 && inv.mcpServers.length === 0 && inv.claudeMd.length === 0
  if (nothing) {
    w(`  no harness config found under ${r.scope.roots.join(', ')}. Nothing to cross-reference`)
    w(paint(out, 'dim', `\n  looked for: settings.json · skills/ · agents/ · plugins/ · .mcp.json · CLAUDE.md\n`))
    return
  }

  const line = (l: string, v: string) => w('  ' + l.padEnd(22) + v)
  line('inventory', `${plural(inv.totals.skills, 'skill')} · ${plural(inv.totals.agents, 'agent')} · ${plural(inv.totals.plugins, 'plugin')} · ${plural(inv.totals.mcpServers, 'MCP server')} · ${plural(inv.totals.hookCommands, 'hook command')}`)
  if (inv.claudeMd.length) {
    const carried = x.claudeMd.reduce((s, c) => s + c.approxTokensCarried, 0)
    line('CLAUDE.md', `${kb(inv.totals.claudeMdBytes)} · ≈${n(inv.totals.claudeMdApproxTokens)} tokens · ≈${n(carried)} tokens carried across the window`)
  }

  // Population guards come before the idle/used split. With nothing installed there is nothing to be idle,
  // and with no sessions in scope every declared row is config-only (crosswalk.ts classifies from session
  // evidence alone), so "every installed skill fired" would be a claim with no evidence behind it.
  const noSessions = r.scope.sessionsScanned === 0
  const NO_EVIDENCE = 'no sessions in scope: nothing can be classified'
  const idleSkills = x.skills.filter((s) => s.status === 'idle')
  const idleMcp = x.mcpServers.filter((m) => m.status === 'idle')
  const idleAgents = x.agents.filter((a) => a.status === 'idle')
  const classified = (total: number) => total > 0 && !noSessions
  line(
    'idle skills',
    inv.totals.skills === 0 ? 'no skills installed' : noSessions ? NO_EVIDENCE : idleSkills.length ? `${idleSkills.length} of ${inv.totals.skills} never fired` : 'none: every installed skill fired',
  )
  if (classified(inv.totals.skills) && idleSkills.length) w(paint(out, 'dim', '    ' + idleSkills.slice(0, 8).map((s) => s.name).join(', ')))
  line(
    'idle MCP',
    inv.totals.mcpServers === 0 ? 'no MCP servers configured' : noSessions ? NO_EVIDENCE : idleMcp.length ? `${idleMcp.length} of ${inv.totals.mcpServers} never called` : 'none: every configured server was called',
  )
  if (classified(inv.totals.mcpServers) && idleMcp.length) w(paint(out, 'dim', '    ' + idleMcp.slice(0, 8).map((m) => m.name).join(', ')))

  // the same four row kinds src/harness/report.ts counts in the "rows marked undeclared" note
  const undeclared = [
    ...x.skills.filter((s) => s.status === 'undeclared').map((s) => 'skill ' + s.name),
    ...x.mcpServers.filter((m) => m.status === 'undeclared').map((m) => 'mcp ' + m.name),
    ...x.agents.filter((a) => a.status === 'undeclared').map((a) => 'agent ' + a.name),
    ...x.hooks.filter((h) => h.status === 'undeclared').map((h) => 'hook ' + h.commandBasename),
  ]
  line('undeclared', undeclared.length ? `${undeclared.length} observed but not in the config read` : 'none')
  if (undeclared.length) w(paint(out, 'dim', '    ' + undeclared.slice(0, 8).join(', ')))

  // One population per clause, like the idle-skills line: "dispatched" and "never" both count the DEFINED
  // agents (crosswalk status used / idle), and the agent types the sessions ran that no config declares
  // are named separately as undeclared instead of being folded into the dispatched count.
  const usedAgents = x.agents.filter((a) => a.status === 'used').length
  const undeclaredAgents = x.agents.filter((a) => a.status === 'undeclared').length
  const undeclaredClause = undeclaredAgents ? ` · ${undeclaredAgents} undeclared` : ''
  line(
    'agents',
    inv.totals.agents === 0
      ? 'none defined' + undeclaredClause
      : noSessions
        ? NO_EVIDENCE
        : `${usedAgents} of ${inv.totals.agents} dispatched · ${idleAgents.length} never` + undeclaredClause,
  )

  const hooksRun = x.hooks.reduce((s, h) => s + h.runs, 0)
  const hookErrors = x.hooks.reduce((s, h) => s + h.errors, 0)
  const meanMs = hooksRun > 0 ? Math.round(x.hooks.reduce((s, h) => s + h.totalMs, 0) / hooksRun) : 0
  line('hooks (configured / runs / errors / mean ms)', '')
  w(paint(out, 'dim', `    ${inv.totals.hookCommands} / ${n(hooksRun)} / ${hookErrors ? paint(out, 'warn', String(hookErrors)) : '0'} / ${n(meanMs)} ms`))

  const modelDrift = x.models.configured && !x.models.matchesConfigured
  const effortDrift = x.effort.configured && !x.effort.matchesConfigured
  if (noSessions) line('drift', NO_EVIDENCE)
  else line('drift', `model ${x.models.configured ?? '(unset)'} ${modelDrift ? '≠' : '='} seen · effort ${x.effort.configured ?? '(unset)'} ${effortDrift ? '≠' : '='} seen · ${n(x.effort.slashEffortCommands)} /effort commands`)
  line('permissions', `${x.permissions.allowRules} allow / ${x.permissions.denyRules} deny / ${x.permissions.askRules} ask rules · ${n(x.permissions.promptEvents)} prompt events in ${x.permissions.promptSessions} sessions`)

  if (x.injectedListings.length) {
    w()
    w(paint(out, 'bold', '  injected listings (recurring context weight, per session)'))
    for (const l of x.injectedListings.slice(0, 6)) w(`    ${l.type.padEnd(20)} ≈${n(l.approxTokensPerSession).padStart(8)} tokens/session  ${paint(out, 'dim', `(${l.sessions} sessions)`)}`)
  }

  if (r.notes.length) {
    w()
    w(paint(out, 'bold', '  notes'))
    for (const note of r.notes) w(paint(out, 'dim', '    · ' + note))
  }
  w(paint(out, 'dim', '\n  add --json for the machine-readable inventory and declared-vs-used rows\n'))
}
