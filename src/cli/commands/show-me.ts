/**
 * `orangu show-me`: the slide deck and the written report of /orangu:show-me, in 2 steps. Claude writes only the
 * 3 strings of words.json between them. orangu writes every byte of HTML.
 *
 *   orangu show-me [<session>] | --scope repo [--cwd <dir>] | --scope global  [--json]
 *     PREPARE: a new run directory <orangu home>/show-me/<scope>-<name>-<random>/ (mode 0700) with data.json, the
 *     redacted slim analysis of the session, or the evidence bundle of the scope with the folder and the version.
 *     It prints the directory, the size of data.json in bytes and about tokens, and the sessions that a scan could
 *     not read (skipped).
 *   orangu show-me --render <dir> [--open] [--json]
 *     RENDER: validate words.json and data.json, fill both embedded templates, check each file, then write
 *     slides.html and report.html (mode 0600). It prints both paths and the STE findings on the 3 words.
 *
 * Exit 0 when the step is done: STE findings are advice, as in `orangu ste`, and no length or score is a pass mark.
 * Exit 1 (a thrown Error, through main.ts) on a usage, path, validation, self-check or write failure, and then the
 * render writes nothing. Each printed value that comes from an input passes through oneLine (src/cli/tty.ts).
 */
import { basename, resolve } from 'node:path'
import { aggregate } from '../../analyze/aggregate.js'
import { AnalysisCache, analyzeRefCached } from '../../cache/index.js'
import { analyzeAllPooled, defaultJobs } from '../../cache/pool.js'
import { resolveCurrentSession } from '../../discover/current.js'
import { candidatesForPrefix, claudeRoots, findLatestSession, listSessions, resolveSession, type DiscoverOptions, type SessionRef } from '../../discover/discover.js'
import type { Analysis } from '../../model/analysis.js'
import { redactValue } from '../../redact/redact.js'
import { prepareRun, type PreparedRun, type ShowMeScope } from '../../show-me/prepare.js'
import { renderShowMe, type RenderResult } from '../../show-me/render.js'
import { projectEvidence } from '../../suggest/evidence.js'
import { ESTIMATE_TOKEN_THRESHOLD } from '../../suggest/types.js'
import { VERSION } from '../../version.js'
import { flagBool, flagStr } from '../args.js'
import { prepareAggregateForOutput, renderAnalysisJson } from '../json-out.js'
import { openInBrowser } from '../open-browser.js'
import { row } from '../summary.js'
import { detectCaps, oneLine, paint, type Caps } from '../tty.js'

const USAGE = 'usage: orangu show-me [<session>] | --scope repo [--cwd <dir>] | --scope global [--json], then orangu show-me --render <dir> [--open] [--json]'
/** the flags of each step, plus the output switches that every verb accepts */
const PREPARE_FLAGS = new Set(['scope', 'cwd', 'root', 'r', 'json', 'quiet', 'no-color', 'include-text', 'no-redact', 'strip-paths', 'no-cache', 'limit', 'jobs', 'j'])
/** the flags that size a scan of many sessions: refused for one session, where they would do nothing */
const SCAN_FLAGS = ['limit', 'jobs', 'j']
const RENDER_FLAGS = new Set(['render', 'open', 'json', 'quiet', 'no-color'])

const flagName = (name: string): string => `${name.length === 1 ? '-' : '--'}${name}`

function checkFlags(flags: Record<string, string | boolean>, allowed: ReadonlySet<string>, step: string): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) throw new Error(`${flagName(name)} is not a flag of orangu show-me ${step}. ${USAGE}`)
  }
}

function streams(flags: Record<string, string | boolean>): { out: Caps; err: Caps } {
  const machine = flagBool(flags, 'json') || flagBool(flags, 'quiet') || flagBool(flags, 'no-color')
  return { out: detectCaps(process.stdout, process.env, { machine }), err: detectCaps(process.stderr, process.env, { machine }) }
}

// ---------- prepare ----------

/** The session of `orangu analyze <session>`: the same selector forms, the same config dir and --cwd rules. */
async function selectSession(selector: string | undefined, flags: Record<string, string | boolean>, err: Caps): Promise<SessionRef> {
  const configDir = flagStr(flags, 'root', 'r')
  const cwd = flagStr(flags, 'cwd')
  const options: DiscoverOptions = { ...(configDir ? { configDir } : {}), ...(cwd ? { cwd } : {}) }
  if (selector === undefined || selector === 'latest') {
    const latest = await findLatestSession(options)
    if (!latest) throw new Error('orangu found no sessions. Is Claude Code installed? Try: orangu list')
    return latest
  }
  if (!selector.trim()) throw new Error('The session selector is empty.')
  if (selector === 'current') {
    const found = await resolveCurrentSession(options, process.env)
    if (found.note && !flagBool(flags, 'quiet') && !flagBool(flags, 'json')) process.stderr.write(`  ${paint(err, 'dim', found.note)}\n`)
    return found.ref
  }
  const resolved = await resolveSession(selector, options)
  if (resolved) return resolved
  const candidates = await candidatesForPrefix(selector, options)
  if (candidates.length > 1) throw new Error(`"${oneLine(selector)}" matches ${candidates.length} sessions. Give more of the id.`)
  throw new Error(`No session matches "${oneLine(selector)}". Try: orangu list`)
}

const cacheFor = (flags: Record<string, string | boolean>): AnalysisCache | null =>
  flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1' ? null : new AnalysisCache({ version: VERSION })

/** data.json of one session: exactly what `orangu analyze <session> --json --slim` prints, with its redaction. */
async function sessionData(selector: string | undefined, flags: Record<string, string | boolean>, err: Caps): Promise<{ name: string; json: string; skipped: number }> {
  const ref = await selectSession(selector, flags, err)
  const analysis = await analyzeRefCached(ref, { cache: cacheFor(flags), version: VERSION, now: Date.now() })
  const json = renderAnalysisJson(analysis, { slim: true, 'no-redact': flagBool(flags, 'no-redact'), 'include-text': flagBool(flags, 'include-text'), 'strip-paths': flagBool(flags, 'strip-paths') })
  // one session is read or the step fails: it never skips one
  return { name: ref.sessionId.slice(0, 8), json, skipped: 0 }
}

/**
 * data.json of a repository or the machine: the evidence bundle of the scope aggregate (as `orangu repo --out` and
 * `orangu evidence --scope` make it), with the folder name and the orangu version. Same session list, limits and
 * cache as `orangu repo` and `orangu global`.
 */
async function aggregateData(scope: 'repo' | 'global', flags: Record<string, string | boolean>, err: Caps): Promise<{ name: string; json: string; skipped: number }> {
  const rootArg = flagStr(flags, 'root', 'r')
  const cwd = resolve(flagStr(flags, 'cwd') ?? process.cwd())
  const refs = scope === 'global' ? await listSessions({ roots: await claudeRoots(rootArg) }) : await listSessions(rootArg ? { configDir: rootArg, cwd } : { cwd })
  if (!refs.length) throw new Error(scope === 'global' ? 'orangu found no sessions on this machine.' : 'orangu found no sessions for this repository.')
  const limitRaw = flagStr(flags, 'limit')
  const limit = limitRaw === undefined ? (scope === 'global' ? 500 : 200) : Number(limitRaw)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a whole number, 1 or more.')
  const use = refs.slice(0, limit)
  if (!flagBool(flags, 'quiet') && !flagBool(flags, 'json')) process.stderr.write(`  ${paint(err, 'dim', `analyzing ${use.length} session${use.length === 1 ? '' : 's'}`)}\n`)
  const now = Date.now()
  const cacheEnabled = !(flags['no-cache'] !== undefined || process.env['ORANGU_NO_CACHE'] === '1')
  const jobsRaw = flagStr(flags, 'jobs', 'j')
  const jobs = jobsRaw !== undefined ? Math.max(1, Math.floor(Number(jobsRaw)) || 1) : defaultJobs()
  // the pool loads the CLI bundle again as its worker entry, so it runs only from the built file
  const bundled = /\.(m?js)$/.test(new URL(import.meta.url).pathname)
  const analyses: Analysis[] = []
  let failed = 0
  if (jobs > 1 && use.length > 1 && bundled) {
    const pooled = await analyzeAllPooled(use, { entry: new URL(import.meta.url), jobs, version: VERSION, now, cacheEnabled })
    analyses.push(...pooled.analyses)
    failed = pooled.failed
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
  const agg = aggregate(analyses, scope === 'global' ? 'global' : `repo ${basename(cwd)}`, now)
  if (failed) agg.scope += ` (${failed} unreadable skipped)`
  // the same file `orangu repo --out` writes, read back as `orangu evidence --scope` reads it
  const bundle = projectEvidence(JSON.parse(JSON.stringify(prepareAggregateForOutput(agg, flags))) as unknown, { scope })
  const folder = scope === 'repo' ? (flagBool(flags, 'no-redact') ? basename(cwd) : redactValue(basename(cwd), { scrub: true })) : undefined
  const json = `${JSON.stringify({ ...bundle, ...(folder !== undefined ? { folder } : {}), version: VERSION }, null, 2)}\n`
  // the evidence projection drops agg.scope, so the count leaves through the prepare output instead
  return { name: scope === 'global' ? 'machine' : basename(cwd), json, skipped: failed }
}

function printPrepared(run: PreparedRun, out: Caps): void {
  const lines = [
    row(out, 'dir', oneLine(run.dir), { raw: true }),
    row(out, 'data', `${oneLine(run.data.path)} · ${run.data.bytes.toLocaleString('en-US')} bytes · about ${run.data.approxTokens.toLocaleString('en-US')} tokens`, { raw: true }),
    run.data.overThreshold
      ? row(out, 'gate', `over the ~${ESTIMATE_TOKEN_THRESHOLD.toLocaleString('en-US')}-token gate. Ask the user before you read data.json into a model.`, { style: 'warn' })
      : row(out, 'gate', `under the ~${ESTIMATE_TOKEN_THRESHOLD.toLocaleString('en-US')}-token gate`, { style: 'dim' }),
  ]
  if (run.skipped > 0) {
    lines.push(row(out, 'skipped', `${run.skipped.toLocaleString('en-US')} session${run.skipped === 1 ? '' : 's'} left out of data.json: ${run.skippedReason ?? ''}`, { style: 'warn' }))
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function prepare(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  checkFlags(flags, PREPARE_FLAGS, '(prepare)')
  const { out, err } = streams(flags)
  const scopeRaw = flags['scope'] ?? 'session'
  if (scopeRaw !== 'session' && scopeRaw !== 'repo' && scopeRaw !== 'global') throw new Error(`--scope must be repo or global. ${USAGE}`)
  const scope: ShowMeScope = scopeRaw
  if (positionals.length > 1) throw new Error(`orangu show-me takes one session. ${USAGE}`)
  if (scope !== 'session' && positionals.length) throw new Error(`A session goes with session scope only. --scope ${scope} reads every session of its scope.`)
  if (scope === 'global' && flags['cwd'] !== undefined) throw new Error('--cwd goes with a session or --scope repo. --scope global reads every session on this machine.')
  const scan = SCAN_FLAGS.find((name) => flags[name] !== undefined)
  if (scope === 'session' && scan) throw new Error(`${flagName(scan)} goes with --scope repo or --scope global. One session needs no scan limit.`)
  const { name, json, skipped } = scope === 'session' ? await sessionData(positionals[0], flags, err) : await aggregateData(scope, flags, err)
  const run = await prepareRun(scope, name, json, { skipped })
  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
    return
  }
  printPrepared(run, out)
}

// ---------- render ----------

function printRendered(result: RenderResult, opened: boolean, out: Caps): void {
  const lines = [row(out, 'slides', oneLine(result.slides), { raw: true }), row(out, 'report', oneLine(result.report), { raw: true })]
  for (const f of result.findings) lines.push(row(out, 'ste', `${f.slot}: ${f.rule} "${oneLine(f.text)}" ${oneLine(f.hint)}`))
  const count = result.findings.length
  lines.push(
    count
      ? row(out, 'words', `${count} STE finding${count === 1 ? '' : 's'}. This is advice: fix each real finding in words.json, then render again.`, { style: 'warn' })
      : row(out, 'words', 'no STE finding', { style: 'dim' }),
  )
  if (opened) lines.push(row(out, 'opened', 'both files, in the browser', { style: 'dim' }))
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function render(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  checkFlags(flags, RENDER_FLAGS, '--render')
  const { out } = streams(flags)
  const dir = flags['render']
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`--render needs the run directory that orangu show-me printed. ${USAGE}`)
  if (positionals.length) throw new Error(`orangu show-me --render takes only the run directory. ${USAGE}`)
  const result = await renderShowMe(dir)
  // both handoffs run: a refused one prints its path on stderr, and only 2 handoffs make the "opened" row
  const open = flagBool(flags, 'open') && [openInBrowser(result.slides), openInBrowser(result.report)].every(Boolean)
  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  printRendered(result, open, out)
}

export async function cmdShowMe(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  return flags['render'] !== undefined ? render(positionals, flags) : prepare(positionals, flags)
}
