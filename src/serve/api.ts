/**
 * Core serve routes. Loopback JSON API + the app shell + SSE.
 * Never transcript text unless --include-text; everything leaving the process is redacted with the
 * same policy (scrub on, text stripped unless --include-text): Analyses here, session rows at their
 * construction point (registry.rowFor, which covers /api/sessions, /api/app and the SSE frames), and
 * Aggregates below before they are served. Kickoff and export routes live in routes-extra.ts.
 */
import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { aggregate, type Aggregate } from '../analyze/aggregate.js'
import { defaultConfigDir } from '../discover/discover.js'
import { collectInventory } from '../harness/collect.js'
import { buildHarnessReport } from '../harness/report.js'
import type { HarnessReport } from '../harness/types.js'
import type { Analysis } from '../model/analysis.js'
import { APP_DATA_VERSION, type AppCapabilities, type AppData, type SessionSummaryRow, type SuggestionViewRecord } from '../model/app-data.js'
import { redactAnalysis, redactValue } from '../redact/redact.js'
import { renderShell } from '../report/render.js'
import { feedbackBootstrap } from '../feedback/diagnostics.js'
import type { SuggestionRecord } from '../suggest/types.js'
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

  private async aliasesForDiscoveredCwds(): Promise<Map<string, string | null>> {
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
    const cwd = this.ctx.opts.cwd ?? process.cwd()
    const roots = this.ctx.opts.roots ?? [this.ctx.opts.configDir ?? defaultConfigDir()]
    const now = this.ctx.now()
    const inventory = await collectInventory({ cwd, roots, home })
    const report = buildHarnessReport(inventory, analyses, aggregate(analyses, 'serve', now), {
      version: this.ctx.opts.version,
      now,
      scope: { cwd, roots, global: !!this.ctx.opts.roots, limit: rows.length, sessionsUnreadable: unreadable, home },
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
      method: 'POST',
      path: '/api/suggestions/:id/status',
      handler: async (m, _req, res) => {
        const body = (m.body ?? {}) as { status?: string }
        const id = m.params['id']!
        if (!body.status) return json(res, 400, { error: 'status required' })
        // The browser may dismiss a suggestion, but it cannot claim that a skill
        // proposed, applied, or verified anything. Those transitions require the
        // validated local artifact receipts accepted only by `orangu suggest`.
        if (body.status !== 'rejected') return json(res, 400, { error: 'the browser may only set status to rejected' })
        const existing = await ctx.store.get(id)
        if (!existing) return json(res, 404, { error: 'unknown suggestion' })
        try {
          const rec = await ctx.store.transition(id, body.status as never)
          if (ctx.noteSuggestion) ctx.noteSuggestion(rec)
          else ctx.emit({ type: 'suggestion-updated', id: rec.id, status: rec.status })
          json(res, 200, publicSuggestion(rec))
        } catch (e) {
          json(res, 400, { error: String(e instanceof Error ? e.message : e) })
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
