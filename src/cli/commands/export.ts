/**
 * `orangu export`: orangu-export.json, the bounded, redacted evidence that the brain reads in a Claude chat outside
 * Claude Code (docs/DATA-CONTRACTS.md, "Export v1"), in a new run directory under <orangu home>/export/.
 *
 *   orangu export [--json] [--quiet] [--no-color] [--root <dir>] [--no-cache] [--jobs <n>]
 *
 * It reads the 500 newest sessions of every root, as `orangu global` does. From the same analyses it builds the
 * evidence of the global aggregate (the projection of `orangu evidence --scope global`) and the harness of
 * `orangu harness --global`. It adds the profile and the lessons of every workspace. src/export/build.ts gives the
 * text, and src/export/write.ts writes it. The file leaves the machine when the user uploads it, so the verb refuses
 * --include-text and --no-redact: it always redacts, and it never holds prompt text.
 *
 * Exit 0 when the file is written. Exit 1 (a thrown Error, through main.ts) on a usage error, when this machine has no
 * session, or when the write fails. A session that does not analyze is counted, not an error. A store that does not
 * read leaves the lessons out, and the index of the file says so.
 */
import { homedir } from 'node:os'
import { aggregate } from '../../analyze/aggregate.js'
import { AnalysisCache, analyzeRefCached } from '../../cache/index.js'
import { analyzeAllPooled, defaultJobs } from '../../cache/pool.js'
import { claudeRoots, listSessions, managedSettingsDirs, type SessionRef } from '../../discover/discover.js'
import { buildExport } from '../../export/build.js'
import { writeExportRun, type ExportRun } from '../../export/write.js'
import { collectInventory } from '../../harness/collect.js'
import { loadedMemoryIndexPaths } from '../../harness/enforcement.js'
import { buildHarnessReport } from '../../harness/report.js'
import type { Analysis } from '../../model/analysis.js'
import { redactValue } from '../../redact/redact.js'
import { SKIPPED_REASON } from '../../show-me/prepare.js'
import { MAX_EVIDENCE_LIMIT, projectEvidence } from '../../suggest/evidence.js'
import { buildLessonRead, type LessonRead } from '../../suggest/lessons.js'
import { loadProfile } from '../../suggest/profile.js'
import { SuggestionStore } from '../../suggest/store.js'
import { VERSION } from '../../version.js'
import { flagBool, flagStr } from '../args.js'
import { prepareAggregateForOutput } from '../json-out.js'
import { row } from '../summary.js'
import { detectCaps, oneLine, paint } from '../tty.js'

const USAGE = 'usage: orangu export [--json] [--quiet] [--no-color] [--root <dir>] [--no-cache] [--jobs <n>]'
/** the flags of the verb, and the output switches that every verb accepts */
const EXPORT_FLAGS = new Set(['json', 'quiet', 'no-color', 'root', 'r', 'no-cache', 'jobs', 'j'])
/** the 2 flags that would put raw text in a file that leaves this machine */
const RAW_FLAGS = new Set(['include-text', 'no-redact'])
/** the newest sessions that the export reads, as `orangu global` and `orangu harness --global` read them */
const SESSION_LIMIT = 500

const flagName = (name: string): string => `${name.length === 1 ? '-' : '--'}${name}`

function checkInput(positionals: string[], flags: Record<string, string | boolean>): void {
  for (const name of Object.keys(flags)) {
    if (RAW_FLAGS.has(name)) {
      throw new Error(`${flagName(name)} is not a flag of orangu export. The export leaves this machine when you upload it, so it always redacts and never holds prompt text.`)
    }
    if (!EXPORT_FLAGS.has(name)) throw new Error(`${flagName(name)} is not a flag of orangu export. ${USAGE}`)
  }
  if (positionals.length) throw new Error(`orangu export takes no session. It reads every session on this machine. ${USAGE}`)
}

/** The analyses of the sessions, through the cache and the pool of `orangu global`, and the count that did not analyze. */
async function analyze(use: SessionRef[], flags: Record<string, string | boolean>, now: number): Promise<{ analyses: Analysis[]; failed: number }> {
  const cacheEnabled = !(flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1')
  const jobsRaw = flagStr(flags, 'jobs', 'j')
  const jobs = jobsRaw !== undefined ? Math.max(1, Math.floor(Number(jobsRaw)) || 1) : defaultJobs()
  // the pool loads the CLI bundle again as its worker entry, so it runs only from the built file
  const bundled = /\.(m?js)$/.test(new URL(import.meta.url).pathname)
  if (jobs > 1 && use.length > 1 && bundled) {
    const pooled = await analyzeAllPooled(use, { entry: new URL(import.meta.url), jobs, version: VERSION, now, cacheEnabled })
    return { analyses: pooled.analyses, failed: pooled.failed }
  }
  const cache = cacheEnabled ? new AnalysisCache({ version: VERSION }) : null
  const analyses: Analysis[] = []
  let failed = 0
  for (const ref of use) {
    try {
      analyses.push(await analyzeRefCached(ref, { cache, version: VERSION, now }))
    } catch {
      failed++
    }
  }
  return { analyses, failed }
}

/** The end of the newest session that orangu read: a time from the transcripts, never the clock of the run. */
function newestEnd(analyses: readonly Analysis[]): number | null {
  let newest: number | null = null
  for (const a of analyses) {
    const end = a.session.endedAt ?? a.session.startedAt
    if (end !== undefined && Number.isFinite(end) && (newest === null || end > newest)) newest = end
  }
  return newest
}

/** Every lesson of every workspace, as `orangu suggest --lessons --all` reads them, or null when the store does not read. */
async function readAllLessons(): Promise<LessonRead | null> {
  try {
    const store = new SuggestionStore()
    const [records, lines] = [await store.all(), await store.lines()]
    return buildLessonRead({ records, lines, scope: 'all', maxBytes: null })
  } catch {
    return null
  }
}

function printRun(run: ExportRun, unreadable: number, flags: Record<string, string | boolean>): void {
  const out = detectCaps(process.stdout, process.env, { machine: flagBool(flags, 'quiet') || flagBool(flags, 'no-color') })
  const lines = [
    row(out, 'dir', oneLine(run.dir), { raw: true }),
    row(out, 'export', `${oneLine(run.export.path)} · ${run.export.bytes.toLocaleString('en-US')} bytes · about ${run.export.approxTokens.toLocaleString('en-US')} tokens`, { raw: true }),
  ]
  if (unreadable > 0) lines.push(row(out, 'skipped', `${unreadable.toLocaleString('en-US')} session${unreadable === 1 ? '' : 's'} left out of the export: ${SKIPPED_REASON}`, { style: 'warn' }))
  process.stdout.write(`${lines.join('\n')}\n`)
}

export async function cmdExport(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  checkInput(positionals, flags)
  const roots = await claudeRoots(flagStr(flags, 'root', 'r'))
  const refs = await listSessions({ roots })
  if (!refs.length) throw new Error('orangu found no sessions on this machine.')
  const use = refs.slice(0, SESSION_LIMIT)
  if (!flagBool(flags, 'quiet') && !flagBool(flags, 'json')) {
    const err = detectCaps(process.stderr, process.env, { machine: flagBool(flags, 'no-color') })
    process.stderr.write(`  ${paint(err, 'dim', `analyzing ${use.length} session${use.length === 1 ? '' : 's'}`)}\n`)
  }
  // the clock of the analyses, the aggregate and the harness: no field of the export keeps it (src/export/build.ts)
  const now = Date.now()
  const { analyses, failed } = await analyze(use, flags, now)
  const agg = aggregate(analyses, 'global', now)
  // the default redaction of `orangu global --out`, read back as `orangu evidence --scope global` reads it
  const evidence = projectEvidence(JSON.parse(JSON.stringify(prepareAggregateForOutput(agg, {}))) as unknown, { scope: 'global', limit: MAX_EVIDENCE_LIMIT })
  const home = homedir()
  const cwd = process.cwd()
  const instructionWords = new Set<string>()
  const inventory = await collectInventory({ cwd, roots, home, managedDirs: managedSettingsDirs(), allProjects: true, memoryIndexPaths: loadedMemoryIndexPaths(analyses), instructionWords })
  const report = buildHarnessReport(inventory, analyses, agg, { instructionWords, version: VERSION, now, scope: { cwd, roots, global: true, limit: SESSION_LIMIT, sessionsUnreadable: failed, home }, sessions: refs })
  const file = buildExport({
    version: VERSION,
    roots: roots.length,
    found: refs.length,
    sessions: analyses.length,
    unreadable: failed,
    asOf: newestEnd(analyses),
    profile: await loadProfile(),
    evidence,
    harness: redactValue(report, { scrub: true, home }),
    lessons: await readAllLessons(),
    home,
  })
  const run = await writeExportRun(file.text)
  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
    return
  }
  printRun(run, failed, flags)
}
