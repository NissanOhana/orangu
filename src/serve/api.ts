/**
 * Core serve routes. Loopback JSON API + the app shell + SSE.
 * Never transcript text unless --include-text; everything leaving the process is redacted with the
 * same policy (scrub on, text stripped unless --include-text): Analyses here, session rows at their
 * construction point (registry.rowFor, which covers /api/sessions, /api/app and the SSE frames), and
 * Aggregates below before they are served. Suggestion records and the 3 store reads (queue, history, lessons) are
 * scrubbed and keep their stored titles, as the CLI prints them (`redactValue(…, { scrub: true })`).
 * Kickoff and export routes live in routes-extra.ts.
 */
import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { aggregate, type Aggregate } from '../analyze/aggregate.js'
import { defaultConfigDir, managedSettingsDirs } from '../discover/discover.js'
import { collectInventory } from '../harness/collect.js'
import { buildHarnessReport } from '../harness/report.js'
import { loadedMemoryIndexPaths } from '../harness/enforcement.js'
import type { HarnessReport } from '../harness/types.js'
import type { Analysis } from '../model/analysis.js'
import { APP_DATA_VERSION, type AppCapabilities, type AppData, type SessionSummaryRow, type SuggestionViewRecord } from '../model/app-data.js'
import { redactAnalysis, redactValue } from '../redact/redact.js'
import { renderShell } from '../report/render.js'
import { feedbackBootstrap } from '../feedback/diagnostics.js'
import { CohortFactsCache } from '../suggest/cohort-cache.js'
import { createQueueReadDeps, readHistory, readLessons, readQueue, type LessonTarget, type QueueReadDeps, type QueueReadStore } from '../suggest/queue-read.js'
import { REJECT_REASON_CODES } from '../suggest/reason-codes.js'
import { rejectWorkspaceCwd } from '../suggest/reject-workspace.js'
import { TRANSITIONS, type SuggestionRecord, type SuggestionStoreLike } from '../suggest/types.js'
import { isTrustedComputedVerification } from '../suggest/verification-policy.js'
import { HTML_ANTI_FRAMING_HEADERS } from './http-security.js'
import { DEFAULT_MAX_LIVE } from './registry.js'
import type { SseHub } from './sse.js'
import type { Route, ServeContext } from './types.js'

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}

/** Suggestion artifacts may contain model-authored copy or paths; scrub every HTTP copy. */
function publicSuggestion(record: SuggestionRecord): SuggestionViewRecord {
  const view: SuggestionViewRecord = {
    ...record,
    // Always overwrite any unknown JSONL property with the computed result.
    // JSON.stringify omits undefined, so untrusted records expose no claim.
    verificationTrusted: isTrustedComputedVerification(record) ? true : undefined,
  }
  return redactValue(view, { scrub: true })
}

function publicSuggestions(records: SuggestionRecord[]): SuggestionViewRecord[] {
  return records.map(publicSuggestion)
}

/** An error that can name a path or stored text, scrubbed as every other serve output. */
function jsonError(res: ServerResponse, status: number, error: unknown): void {
  json(res, status, redactValue({ error: String(error instanceof Error ? error.message : error) }, { scrub: true }))
}

/** The 3 store reads of the app, and the query options of each: the options of its CLI read (`orangu suggest --queue`, `--history`, `--lessons`). */
const STORE_READS = {
  queue: ['cwd', 'all'],
  history: ['cwd', 'all', 'scope', 'rule'],
  lessons: ['cwd', 'all', 'scope', 'rule'],
} as const
type StoreRead = keyof typeof STORE_READS
const STORE_READ_OPTIONS: readonly string[] = ['cwd', 'all', 'scope', 'rule']
/** The body of a 404 for a cwd that is not a workspace of serve. It names no path. */
const UNKNOWN_WORKSPACE = 'unknown workspace'
/** The body of a 409 for a second rejection of 1 record while the first one runs. */
const REJECT_RUNNING = 'another rejection of this suggestion runs now'

interface StoreReadQuery {
  target: LessonTarget
  /** true when the query named the cwd, false when the read takes the `--cwd` of serve */
  namedCwd: boolean
  rules?: string[]
}

/**
 * The scope and the rule filter of 1 store read, from its query, as the CLI reads parse their flags. Each option is
 * singular, as `cwd` is on `/api/repo`, and a read refuses a name that it does not take, so no option goes unread.
 * `cwd=<dir>`, `all=1` and `scope=global` name different scopes, so 2 of them together are refused. With none of them,
 * the read takes the `--cwd` of serve, as `/api/repo` does. A string is the message of a 400. The message names no
 * value of the request.
 */
function storeReadQuery(read: StoreRead, query: URLSearchParams, serveCwd: string | undefined): StoreReadQuery | string {
  const takes: readonly string[] = STORE_READS[read]
  for (const name of new Set(query.keys())) {
    if (!STORE_READ_OPTIONS.includes(name)) return `the query has a name that /api/${read} does not take`
    if (!takes.includes(name)) return `${name} is not valid on /api/${read}`
    if (query.getAll(name).length > 1) return `${name} must be singular`
  }
  const cwd = query.get('cwd')
  const all = query.get('all')
  const scope = query.get('scope')
  if (cwd === '') return 'cwd requires a folder'
  if (all !== null && all !== '1') return 'all takes only the value 1'
  if (scope !== null && scope !== 'global') return 'scope takes only global. It reads the global records, which belong to no workspace'
  if ([cwd, all, scope].filter((value) => value !== null).length > 1) return 'cwd, all=1 and scope=global name different scopes. Give 1 of them'
  let target: LessonTarget
  if (scope !== null) target = 'global'
  else if (all !== null) target = 'all'
  else {
    const dir = cwd ?? serveCwd
    if (!dir) return 'cwd or all=1 is required'
    if (Buffer.byteLength(dir, 'utf8') > MAX_REPO_CWD_BYTES) return 'cwd is too long'
    target = { cwd: dir }
  }
  const namedCwd = cwd !== null
  const rule = query.get('rule')
  if (rule === null) return { target, namedCwd }
  const rules = rule.split(',').map((id) => id.trim()).filter(Boolean)
  if (!rules.length) return 'rule requires 1 or more rule ids'
  return { target, namedCwd, rules }
}

/** The line read of the serve store. The store of `orangu feedback` has none, so its store reads answer 503. */
function queueReadStore(store: SuggestionStoreLike): QueueReadStore | undefined {
  const lines = (store as Partial<QueueReadStore>).lines
  if (typeof lines !== 'function') return undefined
  return { all: () => store.all(), lines: (id) => lines.call(store, id) }
}

/**
 * 1 store read of the app: the read core of the CLI over the serve store, at the clock of the request, past the scrub
 * of the CLI output (`visible`, src/cli/commands/suggest.ts). So the route JSON equals the `--json` output of the CLI
 * read for the same store, sessions and clock. `GET /api/lessons` has no cap (`maxBytes: null`), because the app is no
 * model context. A read writes no record. Only the queue check may write cohort facts cache entries.
 *
 * A named cwd must be a workspace of serve (`knownCwd`): the `--cwd` of serve, or a workspace that the registry knows,
 * as `/api/repo` takes it. Any other cwd gets 404 before any read, so a request cannot make serve resolve a path.
 */
async function storeRead(
  ctx: ServeContext,
  res: ServerResponse,
  read: StoreRead,
  query: URLSearchParams,
  knownCwd: (requested: string) => Promise<string | undefined>,
): Promise<void> {
  const request = storeReadQuery(read, query, ctx.opts.cwd)
  if (typeof request === 'string') return json(res, 400, { error: request })
  let target = request.target
  if (typeof target === 'object' && request.namedCwd) {
    const known = await knownCwd(target.cwd)
    if (!known) return json(res, 404, { error: UNKNOWN_WORKSPACE })
    target = { cwd: known }
  }
  const store = queueReadStore(ctx.store)
  if (!store) return json(res, 503, { error: 'the store reads are not available in this mode' })
  const now = ctx.now()
  // The deps that the CLI makes for 1 read (src/cli/commands/suggest.ts, readDeps): 1 byte budget for this read.
  const deps: QueueReadDeps = ctx.queueReadDeps
    ? ctx.queueReadDeps(now)
    : createQueueReadDeps({ now, cache: ctx.opts.noCache ? null : new CohortFactsCache({ version: ctx.opts.version }) })
  if (typeof target === 'object') {
    try {
      await deps.canonical(target.cwd)
    } catch {
      return json(res, 404, { error: UNKNOWN_WORKSPACE })
    }
  }
  try {
    const filter = request.rules ? { rules: request.rules } : {}
    let value: unknown
    if (read === 'queue') {
      if (target === 'global') return json(res, 400, { error: 'scope is not valid on /api/queue' })
      value = await readQueue(store, target, deps)
    } else if (read === 'history') value = await readHistory(store, target, deps, filter)
    else value = await readLessons(store, target, deps, { ...filter, maxBytes: null })
    json(res, 200, redactValue(value, { scrub: true }))
  } catch (error) {
    jsonError(res, 500, error)
  }
}

function capabilitiesOf(ctx: ServeContext): AppCapabilities {
  return { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: ctx.opts.includeText }
}

function redacted(ctx: ServeContext, a: Analysis): { analysis: Analysis; applied: number; strippedText: boolean; strippedPaths: boolean } {
  const r = redactAnalysis(a, { scrub: true, stripText: !ctx.opts.includeText })
  return { analysis: r.analysis, applied: r.report.applied, strippedText: r.report.strippedText, strippedPaths: r.report.strippedPaths }
}

interface AggJob {
  key: string
  done: number
  total: number
  result?: Aggregate
  computing: boolean
  fingerprint: string
  computedAt: number
  lastAccessed: number
}

interface AggTask {
  job: AggJob
  scope: 'repo' | 'global'
  cwd: string | undefined
  fingerprint: string
}

export const MAX_REPO_CWD_BYTES = 4_096
export const MAX_AGGREGATE_JOBS = 16
export const MAX_AGGREGATE_CONCURRENCY = 2

/** Any discovered row mutation must invalidate cached aggregate results. */
export function aggregateRegistryFingerprint(rows: readonly SessionSummaryRow[]): string {
  return rows
    .map((row) => JSON.stringify([row.source, row.id, row.path, row.mtimeMs, row.sizeBytes, row.cwd ?? '']))
    .sort()
    .join('\n')
}

/** repo/global aggregates over the registry's cache-backed analyses; 202 {progress} while computing. */
class AggregateRunner {
  private jobs = new Map<string, AggJob>()
  private queue: AggTask[] = []
  private active = 0
  private cwdCache: { fingerprint: string; aliases: Map<string, string | null> } | undefined
  private cwdRefresh: { fingerprint: string; promise: Promise<Map<string, string | null>> } | undefined
  constructor(private ctx: ServeContext) {}

  private fingerprint(rows = this.ctx.registry.list()): string {
    return aggregateRegistryFingerprint(rows)
  }

  private evictIdleJob(): boolean {
    let oldest: AggJob | undefined
    for (const candidate of this.jobs.values()) {
      if (candidate.computing) continue
      if (!oldest || candidate.lastAccessed < oldest.lastAccessed) oldest = candidate
    }
    if (!oldest) return false
    this.jobs.delete(oldest.key)
    return true
  }

  private getOrCreateJob(key: string): AggJob | undefined {
    const existing = this.jobs.get(key)
    if (existing) {
      existing.lastAccessed = Date.now()
      return existing
    }
    while (this.jobs.size >= MAX_AGGREGATE_JOBS) {
      if (!this.evictIdleJob()) return undefined
    }
    const created: AggJob = { key, done: 0, total: 0, computing: false, fingerprint: '', computedAt: 0, lastAccessed: Date.now() }
    this.jobs.set(key, created)
    return created
  }

  private schedule(job: AggJob, scope: 'repo' | 'global', cwd: string | undefined, fingerprint: string): void {
    job.computing = true
    this.queue.push({ job, scope, cwd, fingerprint })
    this.pump()
  }

  private pump(): void {
    while (this.active < MAX_AGGREGATE_CONCURRENCY && this.queue.length) {
      const task = this.queue.shift()!
      this.active++
      void this.compute(task.job, task.scope, task.cwd, task.fingerprint)
        .catch(() => {})
        .finally(() => {
          task.job.computing = false
          this.active--
          this.pump()
        })
    }
  }

  /** The raw cwd of each workspace that the registry knows, by its raw, row and scrubbed forms. The store reads share it. */
  async aliasesForDiscoveredCwds(): Promise<Map<string, string | null>> {
    const rows = this.ctx.registry.list()
    const fingerprint = this.fingerprint(rows)
    if (this.cwdCache?.fingerprint === fingerprint) return this.cwdCache.aliases
    if (this.cwdRefresh?.fingerprint === fingerprint) return this.cwdRefresh.promise

    const promise = (async (): Promise<Map<string, string | null>> => {
      const aliases = new Map<string, string | null>()
      const add = (alias: string, raw: string): void => {
        if (!alias) return
        const prior = aliases.get(alias)
        aliases.set(alias, prior === undefined || prior === raw ? raw : null)
      }
      for (const row of rows) {
        const analysis = await this.ctx.registry.analysis(row.id)
        const raw = analysis?.session.cwd
        if (!raw) continue
        add(raw, raw)
        if (row.cwd) add(row.cwd, raw)
        add(redactValue(raw, { scrub: true }), raw)
      }
      this.cwdCache = { fingerprint, aliases }
      return aliases
    })()
    this.cwdRefresh = { fingerprint, promise }
    try {
      return await promise
    } finally {
      if (this.cwdRefresh?.promise === promise) this.cwdRefresh = undefined
    }
  }

  async handleRepo(res: ServerResponse, requestedCwd: string | undefined): Promise<void> {
    if (!requestedCwd) return json(res, 400, { error: 'repo cwd is required' })
    if (Buffer.byteLength(requestedCwd, 'utf8') > MAX_REPO_CWD_BYTES) return json(res, 400, { error: 'repo cwd is too long' })
    const cwd = (await this.aliasesForDiscoveredCwds()).get(requestedCwd)
    if (!cwd) return json(res, 404, { error: 'unknown repo cwd' })
    return this.handle(res, 'repo', cwd)
  }

  async handle(res: ServerResponse, scope: 'repo' | 'global', cwd: string | undefined): Promise<void> {
    const key = scope + '|' + (cwd ?? '')
    const job = this.getOrCreateJob(key)
    if (!job) return json(res, 503, { error: 'aggregate capacity reached' })
    const fp = this.fingerprint()
    if (!job.computing && (!job.result || (job.fingerprint !== fp && Date.now() - job.computedAt > 30_000))) {
      this.schedule(job, scope, cwd, fp)
    }
    if (job.result) return json(res, 200, job.result)
    return json(res, 202, { progress: { done: job.done, total: job.total } })
  }

  private async compute(job: AggJob, scope: 'repo' | 'global', cwd: string | undefined, fp: string): Promise<void> {
    const rows = this.ctx.registry.list()
    job.total = rows.length
    job.done = 0
    const analyses: Analysis[] = []
    for (const row of rows) {
      const a = await this.ctx.registry.analysis(row.id)
      job.done++
      if (!a) continue
      if (scope === 'repo' && cwd && a.session.cwd !== cwd) continue
      analyses.push(a)
    }
    const label = scope === 'repo' ? `repo ${cwd ?? this.ctx.opts.cwd ?? ''}`.trim() : 'global'
    // The aggregate is computed from raw analyses, so redact it before it can leave the process.
    job.result = redactValue(aggregate(analyses, label, this.ctx.now()), { scrub: true, stripText: !this.ctx.opts.includeText })
    job.fingerprint = fp
    job.computedAt = Date.now()
  }
}

/**
 * GET /api/harness: what the config declares vs what the registry's sessions did. Lazy (never on
 * boot), one job, fingerprinted on the registry like the aggregates; 202 {progress} while the
 * crosswalk computes. Reuses registry.analysis() (no re-scan) and, like every aggregate, passes
 * the result through redactValue before it can leave the process. `runHarness` (the CLI verb) is
 * deliberately not reused: it re-lists and re-analyzes every session.
 */
class HarnessRunner {
  private result: HarnessReport | undefined
  private fingerprint = ''
  private computedAt = 0
  private computing = false
  private done = 0
  private total = 0
  constructor(private ctx: ServeContext) {}

  async handle(res: ServerResponse): Promise<void> {
    const fp = aggregateRegistryFingerprint(this.ctx.registry.list())
    if (!this.computing && (!this.result || (this.fingerprint !== fp && Date.now() - this.computedAt > 30_000))) {
      this.computing = true
      void this.compute(fp)
        .catch(() => {})
        .finally(() => {
          this.computing = false
        })
    }
    if (this.result) return json(res, 200, this.result)
    return json(res, 202, { progress: { done: this.done, total: this.total } })
  }

  private async compute(fp: string): Promise<void> {
    const rows = this.ctx.registry.list()
    this.total = rows.length
    this.done = 0
    const analyses: Analysis[] = []
    let unreadable = 0
    for (const row of rows) {
      const a = await this.ctx.registry.analysis(row.id)
      this.done++
      if (a) analyses.push(a)
      else unreadable++
    }
    const home = homedir()
    // Declare the scope the registry actually holds. The registry is restricted to one project only when
    // serve was started with --cwd (registry.discoverOpts passes it to listSessions); otherwise every
    // session under the scanned roots feeds the crosswalk, which is global scope no matter how many roots
    // there are. Labelling that as `repo <cwd>` would count a skill used in any other repo as "fired" here
    // and hand out a `--scope repo` command that reproduces different numbers than the screen shows.
    const repoCwd = this.ctx.opts.cwd
    const cwd = repoCwd ?? process.cwd()
    const roots = this.ctx.opts.roots ?? [this.ctx.opts.configDir ?? defaultConfigDir()]
    const now = this.ctx.now()
    // the same declared side the CLI verb reads: managed settings, and every project entry under global scope
    const instructionWords = new Set<string>()
    const inventory = await collectInventory({ cwd, roots, home, managedDirs: managedSettingsDirs(), allProjects: !repoCwd, memoryIndexPaths: loadedMemoryIndexPaths(analyses), instructionWords })
    const report = buildHarnessReport(inventory, analyses, aggregate(analyses, repoCwd ? `repo ${repoCwd}` : 'global', now), {
      instructionWords,
      // a prompt preview is transcript text: the same --include-text gate as every other serve payload
      ...(this.ctx.opts.includeText ? { includeText: true } : {}),
      version: this.ctx.opts.version,
      now,
      scope: { cwd, roots, global: !repoCwd, limit: rows.length, sessionsUnreadable: unreadable, home },
      // the registry rows already carry what retention measures: path, size and mtime of each transcript
      sessions: rows.map((row) => ({ path: row.path, sizeBytes: row.sizeBytes, mtimeMs: row.mtimeMs })),
    })
    // computed from raw analyses and config paths: scrub before it leaves the process (api.ts discipline)
    this.result = redactValue(report, { scrub: true, home })
    this.fingerprint = fp
    this.computedAt = Date.now()
  }
}

export function coreRoutes(ctx: ServeContext, hub: SseHub): Route[] {
  const aggs = new AggregateRunner(ctx)
  const harness = new HarnessRunner(ctx)
  const maxLive = ctx.opts.maxLive ?? DEFAULT_MAX_LIVE
  /** The ids of the rejections that run now, so a second rejection of 1 record waits for no discovery. */
  const rejecting = new Set<string>()

  /**
   * The raw path of a cwd that a store read names: the `--cwd` of serve, raw or scrubbed, or a workspace that the
   * registry knows, by the alias map of `/api/repo` (handleRepo). Else undefined.
   */
  const knownCwd = async (requested: string): Promise<string | undefined> => {
    const serveCwd = ctx.opts.cwd
    if (serveCwd && (requested === serveCwd || requested === redactValue(serveCwd, { scrub: true }))) return serveCwd
    return (await aggs.aliasesForDiscoveredCwds()).get(requested) ?? undefined
  }

  const appData = async (s: string | undefined): Promise<AppData> => {
    const rows = ctx.registry.list()
    const selectedId = s && rows.some((r) => r.id === s) ? s : rows[0]?.id
    const raw = selectedId ? await ctx.registry.analysis(selectedId) : undefined
    const red = raw ? redacted(ctx, raw) : undefined
    return {
      v: APP_DATA_VERSION,
      mode: 'serve',
      version: ctx.opts.version,
      generatedAt: ctx.now(),
      capabilities: capabilitiesOf(ctx),
      selectedId,
      session: red?.analysis,
      sessions: rows,
      aggregates: {},
      suggestions: publicSuggestions(await ctx.store.all()),
      redaction: red ? { applied: red.applied, strippedText: red.strippedText, strippedPaths: red.strippedPaths } : undefined,
    }
  }

  return [
    {
      method: 'GET',
      path: '/',
      handler: async (_m, _req, res) => {
        const html = renderShell({ version: ctx.opts.version, capabilities: capabilitiesOf(ctx), maxLive, feedback: feedbackBootstrap(ctx.opts.version) })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...HTML_ANTI_FRAMING_HEADERS })
        res.end(html)
      },
    },
    {
      method: 'GET',
      path: '/api/app',
      handler: async (m, _req, res) => json(res, 200, await appData(m.query.get('s') ?? undefined)),
    },
    {
      method: 'GET',
      path: '/api/sessions',
      handler: async (_m, _req, res) => json(res, 200, ctx.registry.list()),
    },
    {
      method: 'GET',
      path: '/api/session/:id',
      handler: async (m, _req, res) => {
        const a = await ctx.registry.analysis(m.params['id']!)
        if (!a) return json(res, 404, { error: 'unknown session' })
        json(res, 200, redacted(ctx, a).analysis)
      },
    },
    {
      method: 'GET',
      path: '/api/repo',
      handler: async (m, _req, res) => {
        const values = m.query.getAll('cwd')
        if (values.length > 1) return json(res, 400, { error: 'repo cwd must be singular' })
        return aggs.handleRepo(res, values[0] ?? ctx.opts.cwd)
      },
    },
    {
      method: 'GET',
      path: '/api/global',
      handler: async (_m, _req, res) => aggs.handle(res, 'global', undefined),
    },
    {
      method: 'GET',
      path: '/api/harness',
      handler: async (_m, _req, res) => harness.handle(res),
    },
    {
      method: 'GET',
      path: '/api/suggestions',
      handler: async (_m, _req, res) => json(res, 200, publicSuggestions(await ctx.store.all())),
    },
    {
      method: 'GET',
      path: '/api/queue',
      handler: async (m, _req, res) => storeRead(ctx, res, 'queue', m.query, knownCwd),
    },
    {
      method: 'GET',
      path: '/api/history',
      handler: async (m, _req, res) => storeRead(ctx, res, 'history', m.query, knownCwd),
    },
    {
      method: 'GET',
      path: '/api/lessons',
      handler: async (m, _req, res) => storeRead(ctx, res, 'lessons', m.query, knownCwd),
    },
    {
      method: 'POST',
      path: '/api/suggestions/:id/status',
      handler: async (m, _req, res) => {
        const body = (m.body ?? {}) as { status?: string; reason?: unknown }
        const id = m.params['id']!
        if (!body.status) return json(res, 400, { error: 'status required' })
        // The browser may dismiss a suggestion, but it cannot claim that a skill
        // proposed, applied, or verified anything. Those transitions require the
        // validated local artifact receipts accepted only by `orangu suggest`.
        if (body.status !== 'rejected') return json(res, 400, { error: 'the browser may only set status to rejected' })
        // A reason is 1 of the 5 codes exactly, or none, so no browser text reaches the store or a skill
        // (the CLI rule of `--reason`, rejectReason in src/cli/commands/suggest.ts).
        const reason = body.reason
        const reasonCode = REJECT_REASON_CODES.find((code) => code === reason)
        if (reason !== undefined && !reasonCode) return json(res, 400, { error: `reason must be 1 of ${REJECT_REASON_CODES.join(', ')}` })
        // 1 rejection of a record at a time: a second one while the first runs gets 409 and runs no discovery. The id of
        // the request and the canonical id of the record both hold the record, so a legacy id cannot pass beside it.
        if (rejecting.has(id)) return json(res, 409, { error: REJECT_RUNNING })
        rejecting.add(id)
        const held = [id]
        try {
          const existing = await ctx.store.get(id)
          if (!existing) return json(res, 404, { error: 'unknown suggestion' })
          if (existing.id !== id) {
            if (rejecting.has(existing.id)) return json(res, 409, { error: REJECT_RUNNING })
            rejecting.add(existing.id)
            held.push(existing.id)
          }
          // An illegal move is refused before the workspace discovery, as `--set` refuses it (cmdSet). The store checks it again.
          if (!(TRANSITIONS[existing.status] ?? []).includes('rejected')) return jsonError(res, 400, `illegal transition ${existing.status} → rejected for ${id}`)
          // A record with no proposal workspace keeps the folder of its evidence sessions, when they all agree on 1. The
          // binding reads discovery and the transcript heads, as `--set <id> rejected` does. It never reads the cohort
          // facts cache, and it never throws: a failed read binds nothing, and the rejection goes ahead.
          const workspaceCwd = await rejectWorkspaceCwd(existing, ctx.rejectWorkspace)
          const rec = await ctx.store.transition(id, 'rejected', { ...(reasonCode ? { reasonCode } : {}), ...(workspaceCwd ? { workspaceCwd } : {}) })
          if (ctx.noteSuggestion) ctx.noteSuggestion(rec)
          else ctx.emit({ type: 'suggestion-updated', id: rec.id, status: rec.status })
          json(res, 200, publicSuggestion(rec))
        } catch (e) {
          // A store read or write can name the store path, so the message is scrubbed.
          jsonError(res, 400, e)
        } finally {
          for (const key of held) rejecting.delete(key)
        }
      },
    },
    {
      method: 'GET',
      path: '/events',
      handler: async (_m, req, res) => {
        const lastId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined
        hub.add(res, lastId, { type: 'hello', serverId: String(process.pid), capabilities: capabilitiesOf(ctx) })
      },
    },
  ]
}
