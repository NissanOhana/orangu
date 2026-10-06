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
import { claudeRoots, defaultConfigDir, listSessions, managedSettingsDirs, type SessionRef } from '../../discover/discover.js'
import { AnalysisCache, analyzeRefCached } from '../../cache/index.js'
import { analyzeAllPooled, defaultJobs } from '../../cache/pool.js'
import { aggregate } from '../../analyze/aggregate.js'
import { collectInventory } from '../../harness/collect.js'
import { buildHarnessReport, plural, sizeLabel } from '../../harness/report.js'
import { RETENTION_DEFAULT_DAYS } from '../../harness/retention.js'
import type { HarnessConfigScope, HarnessListingRow, HarnessReport } from '../../harness/types.js'
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

/** the vendor's names for the settings scopes (what `/status` prints), for display only; the JSON keeps its enum */
const SCOPE_LABEL: Record<HarnessConfigScope, string> = { managed: 'managed settings', global: 'user', 'global-local': 'user local', repo: 'shared project', 'repo-local': 'project local' }

/**
 * The listing rows the printout shows, ranked by the column it prints. The JSON array is ranked by whole-tree
 * tokens (the payload contract); a slice taken in that order would hide the rows heaviest per main session.
 */
export function printedListings(rows: readonly HarnessListingRow[], n = 6): HarnessListingRow[] {
  return [...rows].sort((a, b) => b.approxTokensPerMainSession - a.approxTokensPerMainSession || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)).slice(0, n)
}

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
  // the declared side follows the observed one: a global scan reads every project entry, and managed policy
  // is read wherever the platform keeps it (ORANGU_CLAUDE_MANAGED_DIRS overrides; empty reads none)
  const inventory = await collectInventory({ cwd, roots, home, managedDirs: managedSettingsDirs(), allProjects: isGlobal })
  const agg = aggregate(analyses, scopeLabel, now)
  const report = buildHarnessReport(inventory, analyses, agg, {
    version: VERSION,
    now,
    scope: { cwd, roots, global: isGlobal, limit, sessionsUnreadable: failed, home },
    // every discovered session, not the `--limit` slice: the cleanup sweep reaches all of them
    sessions: refs,
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

/**
 * The measured retention block. Claude Code deletes the transcripts every line above is computed from, so
 * this states how much is in reach of that sweep and when. It names `cleanupPeriodDays` and both directions
 * of the tradeoff; it recommends no value, in keeping with this file's header.
 */
function printRetention(r: HarnessReport, line: (l: string, v: string) => void, w: (s?: string) => void): void {
  const t = r.retention
  const oldest = t.oldestSweepableDays === undefined ? '' : ` · oldest ${plural(t.oldestSweepableDays, 'day')}`
  // `${n}-day window` is an attributive compound, not a count, so it does not take the plural helper
  line('retention', `${t.effectiveDays}-day window · ${plural(t.sweepable.sessions, 'session')} (${sizeLabel(t.sweepable.bytes)}) in reach of the sweep${oldest}`)
  const dim = (s: string) => w(paint(out, 'dim', '    ' + s))
  dim('sizes count primary transcripts only')
  dim('the sweep also removes the subagent and tool-result files of each session')
  // Three states, because `isDefault` means "no USABLE value", not "no value": a rejected setting is set.
  if (t.source) dim(`set by ${t.source.file} (${SCOPE_LABEL[t.source.scope]})`)
  else if (t.invalidConfigured) dim(`no settings file set a usable cleanupPeriodDays, so Claude Code's default of ${RETENTION_DEFAULT_DAYS} days applies`)
  else dim(`cleanupPeriodDays is unset, so the window is Claude Code's default of ${RETENTION_DEFAULT_DAYS} days`)
  if (t.invalidConfigured) {
    dim(`${plural(t.invalidConfigured, 'settings file')} set cleanupPeriodDays below the minimum of 1 or not to a whole number, and ${t.invalidConfigured === 1 ? 'was' : 'were'} ignored`)
  }
  if (t.expiringSoon.sessions > 0) {
    const verb = t.expiringSoon.sessions === 1 ? 'is' : 'are'
    dim(`${plural(t.expiringSoon.sessions, 'session')} (${sizeLabel(t.expiringSoon.bytes)}) ${verb} within ${plural(t.expiringSoon.windowDays, 'day')} of the cutoff`)
  }
  if (t.pastCutoff.sessions > 0) {
    const verb = t.pastCutoff.sessions === 1 ? 'is' : 'are'
    dim(`${plural(t.pastCutoff.sessions, 'session')} (${sizeLabel(t.pastCutoff.bytes)}) ${verb} already past the cutoff and still on disk`)
  }
  if (t.exempt.sessions > 0) {
    const label = `${plural(t.exempt.sessions, 'Desktop/Cowork session')} (${sizeLabel(t.exempt.bytes)})`
    dim(
      t.exempt.configuredDays === undefined
        ? `${label} ${t.exempt.sessions === 1 ? 'is' : 'are'} kept at any age by default`
        : `${label} follow${t.exempt.sessions === 1 ? 's' : ''} desktopSessionCleanupPeriodDays: ${plural(t.exempt.configuredDays, 'day')}`,
    )
  }
  dim('cleanupPeriodDays sets the window, minimum 1. A larger value keeps more history to measure, and leaves plaintext transcripts on disk for longer')
}

function printHarness(r: HarnessReport): void {
  const w = (s = '') => process.stdout.write(s + '\n')
  const inv = r.inventory
  const x = r.crosswalk
  const scopeLabel = r.scope.global ? `global (${r.scope.roots.length} roots)` : `repo ${basename(r.scope.cwd)}`

  w()
  w(paint(out, ['bold', 'accent'], 'orangu') + '  ' + paint(out, 'bold', 'harness · ' + scopeLabel))
  w(paint(out, 'dim', `  ${n(r.scope.sessionsScanned)} session${r.scope.sessionsScanned === 1 ? '' : 's'} scanned`))
  if (r.scope.global) {
    // under --global the observed side spans every project; say exactly what the declared side covered
    const entries = inv.totals.projectEntries ?? 0
    w(paint(out, 'dim', `  declared side: ${plural(r.scope.roots.length, 'config root')} · ${entries} project ${entries === 1 ? 'entry' : 'entries'} in ~/.claude.json`))
    w(paint(out, 'dim', `                 repo files from ${r.scope.cwd}`))
  }
  w()

  // designed empty state: never a blank report
  const nothing = inv.settings.length === 0 && inv.skills.length === 0 && inv.agents.length === 0 && inv.plugins.length === 0 && inv.mcpServers.length === 0 && inv.claudeMd.length === 0
  if (nothing) {
    w(`  orangu found no harness config under ${r.scope.roots.join(', ')}. It found nothing to compare.`)
    w(paint(out, 'dim', `\n  looked for: settings.json · skills/ · agents/ · plugins/ · .mcp.json · CLAUDE.md\n`))
    return
  }

  const line = (l: string, v: string) => w('  ' + l.padEnd(22) + v)
  // the 80-column contract every other verb keeps (src/cli/summary.ts): a name list wraps onto continuation
  // lines rather than being cut, so no name is lost; a path is never touched
  const width = Math.min(out.columns || 80, 80)
  const dim = (s: string) => w(paint(out, 'dim', '    ' + s))
  /** word-wrap a sentence into lines that fit the layout width under a given indent */
  const wrapped = (s: string, indent: string): string[] => {
    const max = Math.max(20, width - indent.length)
    const lines: string[] = []
    let cur = ''
    for (const word of s.split(' ')) {
      const next = cur ? `${cur} ${word}` : word
      if (cur && next.length > max) {
        lines.push(cur)
        cur = word
      } else cur = next
    }
    if (cur) lines.push(cur)
    return lines.map((l, i) => (i === 0 ? indent + l : ' '.repeat(indent.length) + l))
  }
  const dimList = (items: string[]) => {
    let cur = ''
    for (const item of items) {
      const next = cur ? `${cur}, ${item}` : item
      if (cur && next.length > width - 4) {
        dim(cur + ',')
        cur = item
      } else cur = next
    }
    if (cur) dim(cur)
  }
  line('inventory', `${plural(inv.totals.skills, 'skill')} · ${plural(inv.totals.agents, 'agent')} · ${plural(inv.totals.plugins, 'plugin')} · ${plural(inv.totals.mcpServers, 'MCP server')} · ${plural(inv.totals.hookCommands, 'hook command')}`)
  if (inv.claudeMd.length) {
    const carried = x.claudeMd.reduce((s, c) => s + c.approxTokensCarried, 0)
    line('CLAUDE.md', `${sizeLabel(inv.totals.claudeMdBytes)} · ≈${n(inv.totals.claudeMdApproxTokens)} tokens · ≈${n(carried)} tokens carried across the window`)
  }

  // Population guards come before the idle/used split. With nothing installed there is nothing to be idle,
  // and with no sessions in scope every declared row is config-only (crosswalk.ts classifies from session
  // evidence alone), so "every installed skill fired" would be a claim with no evidence behind it.
  const noSessions = r.scope.sessionsScanned === 0
  const NO_EVIDENCE = 'no sessions in scope: nothing can be classified'
  // every COUNT comes from `x.counts`, taken over the whole population before the 50-row cap cut the idle
  // rows; the row arrays supply names only, so a name list may be shorter than the count beside it
  const c = x.counts
  const idleSkills = x.skills.filter((s) => s.status === 'idle')
  const idleMcp = x.mcpServers.filter((m) => m.status === 'idle')
  const classified = (total: number) => total > 0 && !noSessions
  line(
    'idle skills',
    inv.totals.skills === 0 ? 'no skills installed' : noSessions ? NO_EVIDENCE : c.skills.idle ? `${c.skills.idle} of ${inv.totals.skills} never fired` : 'none: every installed skill fired',
  )
  if (classified(inv.totals.skills) && idleSkills.length) dimList(idleSkills.slice(0, 8).map((s) => s.name))
  line(
    'idle MCP',
    inv.totals.mcpServers === 0 ? 'no MCP servers configured' : noSessions ? NO_EVIDENCE : c.mcpServers.idle ? `${c.mcpServers.idle} of ${inv.totals.mcpServers} never called` : 'none: every configured server was called',
  )
  if (classified(inv.totals.mcpServers) && idleMcp.length) dimList(idleMcp.slice(0, 8).map((m) => m.name))

  // the same four row kinds src/harness/report.ts counts in the "rows marked undeclared" note
  const undeclaredCount = c.skills.undeclared + c.mcpServers.undeclared + c.agents.undeclared + c.hooks.undeclared
  const undeclaredNames = [
    ...x.skills.filter((s) => s.status === 'undeclared').map((s) => 'skill ' + s.name),
    ...x.mcpServers.filter((m) => m.status === 'undeclared').map((m) => 'mcp ' + m.name),
    ...x.agents.filter((a) => a.status === 'undeclared').map((a) => 'agent ' + a.name),
    ...x.hooks.filter((h) => h.status === 'undeclared').map((h) => 'hook ' + (h.commandBasename ?? `${h.event} (no command recorded)`)),
  ]
  line('undeclared', noSessions ? NO_EVIDENCE : undeclaredCount ? `${undeclaredCount} observed but not in the config read` : 'none')
  if (!noSessions && undeclaredNames.length) dimList(undeclaredNames.slice(0, 8))

  // One population per clause, like the idle-skills line: "dispatched" and "never" both count the DEFINED
  // agents (crosswalk status used / idle), and the agent types the sessions ran that no config declares
  // are named separately as undeclared instead of being folded into the dispatched count.
  const undeclaredClause = c.agents.undeclared ? ` · ${c.agents.undeclared} undeclared` : ''
  line(
    'agents',
    inv.totals.agents === 0
      ? 'none defined' + undeclaredClause
      : noSessions
        ? NO_EVIDENCE
        : `${c.agents.used} of ${inv.totals.agents} dispatched · ${c.agents.idle} never` + undeclaredClause,
  )

  const hooksRun = x.hooks.reduce((s, h) => s + h.runs, 0)
  const hookErrors = x.hooks.reduce((s, h) => s + h.errors, 0)
  const meanMs = hooksRun > 0 ? Math.round(x.hooks.reduce((s, h) => s + h.totalMs, 0) / hooksRun) : 0
  line('hooks', noSessions ? `${inv.totals.hookCommands} configured · ${NO_EVIDENCE}` : `${inv.totals.hookCommands} configured · ${n(hooksRun)} runs · ${hookErrors} errors · ${n(meanMs)} ms mean`)
  // the pooled figures hide their own story: name the hook that carries the errors
  const worst = [...x.hooks].sort((a, b) => b.errors - a.errors)[0]
  if (!noSessions && worst && worst.errors > 0) dim(`most errors: ${worst.commandBasename ?? worst.event} · ${n(worst.errors)} of ${n(hookErrors)} on ${plural(worst.runs, 'run')}`)

  const modelDrift = x.models.configured && !x.models.matchesConfigured
  const effortDrift = x.effort.configured && !x.effort.matchesConfigured
  if (noSessions) line('drift', NO_EVIDENCE)
  else line('drift', `model ${x.models.configured ?? '(unset)'} ${modelDrift ? '≠' : '='} seen · effort ${x.effort.configured ?? '(unset)'} ${effortDrift ? '≠' : '='} seen · ${n(x.effort.slashEffortCommands)} /effort commands`)
  line('permissions', `${x.permissions.allowRules} allow / ${x.permissions.denyRules} deny / ${x.permissions.askRules} ask rules · ${n(x.permissions.promptEvents)} prompt events in ${x.permissions.promptSessions} sessions`)
  printRetention(r, line, w)

  if (x.injectedListings.length) {
    w()
    w(paint(out, 'bold', '  injected listings (recurring context weight, ranked by tokens per session)'))
    w(paint(out, 'dim', '    per session counts the primary transcript of each session that carried the'))
    w(paint(out, 'dim', '    listing. The subagent line is a sum over the sessions that had subagents.'))
    for (const l of printedListings(x.injectedListings)) {
      w(`    ${l.type.padEnd(22)} ≈${n(l.approxTokensPerMainSession).padStart(8)} tokens/session`)
      w(paint(out, 'dim', `      ${plural(l.main.injections, 'injection')} in ${plural(l.main.sessions, 'session')} · ≈${n(l.approxTokensPerInjection)} per injection anywhere in the tree`))
      if (l.subagent.injections) w(paint(out, 'dim', `      subagents ≈${n(l.subagent.approxTokens)} tokens over ${plural(l.subagent.injections, 'injection')} in ${plural(l.subagent.sessions, 'session')}`))
    }
  }

  if (r.notes.length) {
    w()
    w(paint(out, 'bold', '  notes'))
    for (const note of r.notes) for (const l of wrapped(note, '    · ')) w(paint(out, 'dim', l))
  }
  w(paint(out, 'dim', '\n  add --json for the machine-readable inventory and declared-vs-used rows\n'))
}
