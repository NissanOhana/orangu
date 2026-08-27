import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServe, matchRoute, rejectCrossSiteBrowserGet, rejectUntrustedMutation, type ServeDeps, type ServeHandle } from './server.js'
import { aggregateRegistryFingerprint, MAX_AGGREGATE_CONCURRENCY, MAX_AGGREGATE_JOBS, MAX_REPO_CWD_BYTES } from './api.js'
import type { Route, ServeOptions } from './types.js'
import type { Analysis } from '../model/analysis.js'
import type { SessionSummaryRow } from '../model/app-data.js'
import { analyzeSession } from '../analyze/analyze.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { SuggestionStore } from '../suggest/store.js'
import { makeFixtureHome, appendTurn, type FixtureHome } from '../../test/fixtures/home.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'

/** the secret makeFixtureHome plants in the live session's first prompt (= its title) */
const SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKE'
const ARBITRARY_MARKER = 'private-purple-ferret-9073'
/** copy orangu's own rules wrote; the default strip keeps it, the scrubber still runs over it */
const GENERATED = 'rule-authored-copy-4412'
const MARKER_SECRET = 'sk-ant-api03-PRIVATEPURPLEFERRET9073'

const BADGES = new Set(['live', 'idle', 'ended'])

function opts(configDir: string, extra: Partial<ServeOptions> = {}): ServeOptions {
  return { open: false, includeText: false, configDir, noCache: true, version: 'test', ...extra }
}

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
})

async function bootWith(
  extra: Partial<ServeOptions>,
  deps: ServeDeps = {},
  prepare?: (home: FixtureHome) => Promise<void>,
): Promise<{ home: FixtureHome; url: string; storeHome: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orangu-serve-'))
  const home = await makeFixtureHome(dir)
  await prepare?.(home)
  const storeHome = await mkdtemp(join(tmpdir(), 'orangu-store-'))
  srv = await startServe(opts(home.configDir, extra), { quiet: true, store: new SuggestionStore({ home: storeHome }), ...deps })
  return { home, url: srv.url, storeHome }
}

async function boot(): Promise<{ home: FixtureHome; url: string; storeHome: string }> {
  return bootWith({})
}

const FINDING = (sessionIds: string[], ruleId = 'test-rule') => ({ ruleId, title: 'Test finding', scope: 'session', sessionIds, evidence: { estimated: true } })

async function postKickoff(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url + '/api/kickoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

async function getWithHeaders(url: string, headers: Record<string, string>): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.setTimeout(1_000, () => request.destroy(new Error('host rejection did not end the response')))
    request.on('error', reject)
  })
}

async function getWithHost(url: string, host: string): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return getWithHeaders(url, { host })
}

async function syntheticAnalysis(id: string, cwd: string): Promise<Analysis> {
  const builder = new SessionBuilder({ sessionId: id, cwd })
  builder.userPrompt('Run the bounded test').assistant([{ type: 'text', text: 'Done.' }])
  return analyzeSession(await parseClaudeCodeSession({ records: builder.toRecords(), noSidecar: true }), { version: 'test', now: 0 })
}

const analyzeWithPrivateMarker: typeof analyzeSession = (session, options) => {
  const a = analyzeSession(session, options)
  const text = `${ARBITRARY_MARKER} ${MARKER_SECRET}`
  const generated = `${GENERATED} ${MARKER_SECRET}`
  a.session.title = text
  a.session.gitBranches = [text]
  a.summary.narrative = generated
  a.summary.outcomes.prLinks.push({ label: text, url: `https://example.test/${ARBITRARY_MARKER}`, turnIndex: 0 })
  if (a.turns[0]) {
    a.turns[0].commandName = text
    a.turns[0].promptPreview = text
  }
  const call = a.tools.calls.at(-1)
  if (call) {
    call.summary = text
    call.errorHint = text
  }
  a.tools.errorGroups.push({ name: 'Bash', signature: generated, count: 1, sampleTurnIndex: 0, sampleHint: text })
  a.agents.runs.push({
    agentId: 'agent-private-marker',
    name: text,
    agentType: 'code-reviewer',
    description: text,
    spawnDepth: 0,
    messageCount: 0,
    toolCallCount: 0,
    toolErrors: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearchRequests: 0, webFetchRequests: 0 },
    totalTokens: 0,
    status: 'completed',
    teamName: text,
    taskKind: text,
    hasTranscript: false,
  })
  a.agents.byType.push({ agentType: 'code-reviewer', count: 1, tokens: 0, avgDurationMs: 0 })
  a.skills.invocations.push({ name: 'orangu-improve', via: 'command', turnIndex: 0, args: text })
  a.skills.byName.push({ name: 'orangu-improve', count: 1, via: ['command'], turnIndexes: [0] })
  a.hooks.byCommand.push({ command: text, count: 1, totalMs: 0, errors: 0, hookEvent: 'Stop' })
  a.time.longestTurns.push({ turnIndex: 0, durationMs: 1, preview: text })
  a.quality.testRuns.push({ turnIndex: 0, command: text, ok: false })
  a.quality.buildRuns.push({ turnIndex: 0, command: text, ok: false })
  a.quality.gitCommits.push({ turnIndex: 0, ok: true, message: text })
  a.quality.userCorrections.push({ turnIndex: 0, preview: text })
  a.insights.push({
    id: 'private-marker-insight',
    ruleId: 'private-marker-rule',
    severity: 'low',
    axis: 'quality',
    title: generated,
    detail: text,
    recommendation: generated,
    evidence: { command: text, template: text, sample: text },
    turnIndexes: [0],
    personas: ['anyone'],
  })
  a.events.push({ kind: 'other', turnIndex: 0, label: generated, detail: text })
  a.parse.recordCounts[ARBITRARY_MARKER] = 1
  a.parse.unknownRecordTypes[ARBITRARY_MARKER] = 1
  a.parse.unknownBlockTypes[ARBITRARY_MARKER] = 1
  a.parse.attachmentTypes[ARBITRARY_MARKER] = 1
  a.parse.attachmentBytes ??= {}
  a.parse.attachmentBytes[ARBITRARY_MARKER] = 10
  a.parse.systemSubtypes[ARBITRARY_MARKER] = 1
  a.parse.warnings.push({ code: 'private_marker', message: text, count: 1 })
  return a
}

async function getRawPath(url: string, path: string): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  const target = new URL(url)
  const basePath = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: target.hostname, port: target.port, path: basePath + path, headers: { host: target.host } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
  })
}

async function pollUntil<T>(fn: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error('pollUntil timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function runSourceCli(args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', ...args],
      { cwd: process.cwd(), env: { ...process.env, ORANGU_HOME: home } },
      (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
    )
  })
}

describe('orangu serve (in-process e2e)', () => {
  it('listens on 127.0.0.1 and serves the app shell with a connect-src CSP', async () => {
    const { url } = await boot()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/_orangu\/[A-Za-z0-9_-]{43}$/)
    const response = await fetch(url + '/')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const html = await response.text()
    expect(html).toContain("connect-src 'self'")
    expect(html).toContain('<meta name="referrer" content="no-referrer"/>')
    expect(html).toContain('__ORANGU_SERVE__')
    expect(html).not.toContain('orangu-data') // no embedded AppData in the shell
  })

  it('requires the per-process capability before HTML, assets, API, mutations, exports, and SSE', async () => {
    let listCalls = 0
    const registry = {
      list: () => {
        listCalls++
        return []
      },
      analysis: async () => {
        throw new Error('unauthorized request reached registry.analysis')
      },
      pin: () => {},
      start: async () => {},
      stop: async () => {},
    } as unknown as NonNullable<ServeDeps['registry']>
    const { home, url } = await bootWith({}, { registry })
    const authenticated = new URL(url)
    const token = authenticated.pathname.split('/').at(-1)!
    const wrongToken = (token[0] === 'A' ? 'B' : 'A') + token.slice(1)
    const bases = [authenticated.origin, `${authenticated.origin}/_orangu/${wrongToken}`]
    const requests = [
      (base: string) => fetch(base + '/'),
      (base: string) => fetch(base + '/favicon.ico'),
      (base: string) => fetch(base + '/api/sessions'),
      (base: string) => fetch(base + '/api/harness'),
      (base: string) => fetch(base + `/export/${home.liveId}.html`),
      (base: string) => fetch(base + '/events'),
      (base: string) => fetch(base + '/api/kickoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ]
    for (const base of bases) {
      for (const request of requests) {
        const response = await request(base)
        expect(response.status).toBe(403)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(await response.json()).toEqual({ error: 'serve capability required' })
      }
    }
    expect(listCalls).toBe(0)
    expect(srv!.hub.size()).toBe(0)
    expect((await fetch(url + '/api/sessions')).status).toBe(200)
    expect(listCalls).toBe(1)
  })

  it('logs only logical route names, never the capability', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    try {
      const { url } = await bootWith({}, { quiet: false })
      await fetch(url + '/api/sessions')
      await fetch(new URL(url).origin + '/api/sessions')
      const logged = writes.join('')
      expect(logged).toContain('GET /api/sessions 200')
      expect(logged).toContain('GET [unauthorized] 403')
      expect(logged).not.toContain(new URL(url).pathname)
    } finally {
      write.mockRestore()
    }
  })

  it('/api/sessions lists the fixture sessions with live/idle/ended badges', async () => {
    const { home, url } = await boot()
    const rows = (await (await fetch(url + '/api/sessions')).json()) as Array<{ id: string; badge: string; possiblyLive: boolean }>
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) expect(BADGES.has(r.badge)).toBe(true)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(home.liveId)?.badge).toBe('live')
    expect(byId.get(home.endedId)?.badge).toBe('ended')
  })

  it('/api/app returns AppData v1 in serve mode with the selected session', async () => {
    const { home, url } = await boot()
    const app = (await (await fetch(url + `/api/app?s=${home.liveId}`)).json()) as { v: string; mode: string; selectedId: string; session?: { session: { id: string } }; sessions: unknown[] }
    expect(app.v).toBe('1')
    expect(app.mode).toBe('serve')
    expect(app.selectedId).toBe(home.liveId)
    expect(app.session?.session.id).toBe(home.liveId)
    expect(app.sessions.length).toBe(3)
  })

  it('/api/session/:id is redacted (planted secret masked) and 404s on unknown ids', async () => {
    const { home, url } = await boot()
    const r = await fetch(url + '/api/session/' + home.liveId)
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).not.toContain('sk-ant-api03-FAKEFAKEFAKEFAKE')
    expect((await fetch(url + '/api/session/nope')).status).toBe(404)
  })

  // A8: the harness report reaches the app through the same capability-gated, lazy, redacted path
  it('/api/harness answers 202 {progress} then the redacted HarnessReport, never an absolute home path', async () => {
    const { url } = await boot()
    const first = await fetch(url + '/api/harness')
    expect([200, 202]).toContain(first.status)
    if (first.status === 202) expect(((await first.json()) as { progress: unknown }).progress).toBeDefined()
    const report = await pollUntil(async () => {
      const r = await fetch(url + '/api/harness')
      return r.status === 200 ? ((await r.json()) as { schemaVersion: string; scope: { sessionsScanned: number; roots: string[] }; crosswalk: { injectedListings: unknown[] }; notes: string[] }) : undefined
    })
    expect(report.schemaVersion).toBe('1')
    expect(report.scope.sessionsScanned).toBe(3)
    expect(Array.isArray(report.crosswalk.injectedListings)).toBe(true)
    const text = JSON.stringify(report)
    expect(text).not.toContain(homedir())
    expect(text).not.toContain(SECRET)
    expect(text).not.toMatch(/"cost"|"usd"|"price"/i)
  })

  it('/api/repo and /api/global answer 202 {progress} then the Aggregate', async () => {
    const { url } = await boot()
    const fetchAgg = async (path: string): Promise<{ sessionCount: number }> => {
      for (let i = 0; i < 100; i++) {
        const r = await fetch(url + path)
        if (r.status === 200) return (await r.json()) as { sessionCount: number }
        expect(r.status).toBe(202)
        const p = (await r.json()) as { progress: { done: number; total: number } }
        expect(p.progress).toBeDefined()
        await new Promise((r2) => setTimeout(r2, 50))
      }
      throw new Error('aggregate never completed')
    }
    const g = await fetchAgg('/api/global')
    expect(g.sessionCount).toBe(3)
    const repo = await fetchAgg('/api/repo?cwd=' + encodeURIComponent('/Users/test/Code/demo'))
    expect(repo.sessionCount).toBe(3)
  })

  it('rejects unknown, duplicate, and oversized repo cwd values before allocating aggregate jobs', async () => {
    const { url } = await boot()
    expect((await fetch(url + '/api/repo')).status).toBe(400)
    expect((await fetch(url + '/api/repo?cwd=' + encodeURIComponent('x'.repeat(MAX_REPO_CWD_BYTES + 1)))).status).toBe(400)
    expect((await fetch(url + '/api/repo?cwd=a&cwd=b')).status).toBe(400)
    for (let i = 0; i < MAX_AGGREGATE_JOBS * 2; i++) {
      const response = await fetch(url + '/api/repo?cwd=' + encodeURIComponent(`/not/discovered/${i}`))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'unknown repo cwd' })
    }
    const valid = await fetch(url + '/api/repo?cwd=' + encodeURIComponent('/Users/test/Code/demo'))
    expect([200, 202]).toContain(valid.status)
  })

  it('caps aggregate job keys and concurrency, then evicts an idle job for new work', async () => {
    const count = MAX_AGGREGATE_JOBS + 2
    const rows: SessionSummaryRow[] = []
    const analyses = new Map<string, Analysis>()
    for (let i = 0; i < count; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      const cwd = `/workspace/project-${i}`
      rows.push({ id, projectSlug: `project-${i}`, cwd, path: `/sessions/${id}.jsonl`, source: 'claude-code', sizeBytes: 100 + i, mtimeMs: 1_000 + i, badge: 'ended', ageMs: 0, possiblyLive: false })
      analyses.set(id, await syntheticAnalysis(id, cwd))
    }

    let block = false
    let active = 0
    let maxActive = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = {
      list: () => rows,
      analysis: async (id: string) => {
        if (block) {
          active++
          maxActive = Math.max(maxActive, active)
          await gate
          active--
        }
        return analyses.get(id)
      },
      pin: () => {},
      start: async () => {},
      stop: async () => {},
    } as unknown as NonNullable<ServeDeps['registry']>
    const { url } = await bootWith({}, { registry })

    const repoUrl = (cwd: string): string => url + '/api/repo?cwd=' + encodeURIComponent(cwd)
    await pollUntil(async () => {
      const response = await fetch(repoUrl(rows[0]!.cwd!))
      return response.status === 200 ? true : undefined
    })

    block = true
    for (let i = 1; i <= MAX_AGGREGATE_JOBS; i++) {
      const response = await fetch(repoUrl(rows[i]!.cwd!))
      expect(response.status, `job ${i}`).toBe(202)
    }
    expect(maxActive).toBe(MAX_AGGREGATE_CONCURRENCY)
    const saturated = await fetch(repoUrl(rows[MAX_AGGREGATE_JOBS + 1]!.cwd!))
    expect(saturated.status).toBe(503)
    expect(await saturated.json()).toEqual({ error: 'aggregate capacity reached' })

    release()
    const admitted = await pollUntil(async () => {
      const response = await fetch(repoUrl(rows[MAX_AGGREGATE_JOBS + 1]!.cwd!))
      return response.status === 200 || response.status === 202 ? response.status : undefined
    })
    expect([200, 202]).toContain(admitted)
  })

  it('/api/suggestions starts empty; a status POST on an unknown id 404s', async () => {
    const { url } = await boot()
    expect(await (await fetch(url + '/api/suggestions')).json()).toEqual([])
    const r = await fetch(url + '/api/suggestions/sg_nope/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"rejected"}' })
    expect(r.status).toBe(404)
  })

  // Cross-chunk coverage: exercise the kickoff route through the live server.
  it('POST /api/kickoff mode copy creates the record and returns the command without spawning', async () => {
    const { home, url } = await boot()
    const finding = { ruleId: 'test-rule', title: 'Test finding', scope: 'session', sessionIds: [home.liveId], evidence: { estimated: true } }
    const r = await fetch(url + '/api/kickoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finding, mode: 'copy' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { record: { id: string; status: string }; command: string; spawned: boolean }
    expect(body.spawned).toBe(false)
    expect(body.record.status).toBe('new')
    expect(body.command).toContain(`/orangu:improve ${body.record.id}`)
    const list = (await (await fetch(url + '/api/suggestions')).json()) as Array<{ id: string }>
    expect(list.map((s) => s.id)).toContain(body.record.id)
  })

  it('blocks cross-origin and non-JSON mutations before they can create or spawn work', async () => {
    const { home, url } = await bootWith({})
    const body = JSON.stringify({ finding: FINDING([home.liveId]), mode: 'run' })
    for (const headers of [
      { origin: 'https://evil.example', 'content-type': 'text/plain' },
      { origin: 'https://evil.example', 'content-type': 'application/json' },
    ]) {
      const response = await fetch(url + '/api/kickoff', { method: 'POST', headers, body })
      expect(response.status).toBe(403)
    }
    const nonJson = await fetch(url + '/api/kickoff', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
    expect(nonJson.status).toBe(415)
    expect(await (await fetch(url + '/api/suggestions')).json()).toEqual([])
  })

  it('blocks explicit cross-site browser GETs while preserving same-origin and headerless clients', async () => {
    const { url } = await boot()
    const target = url + '/api/global'
    const crossSiteHeaders: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]
    for (const headers of crossSiteHeaders) {
      const response = await getWithHeaders(target, headers)
      expect(response.status).toBe(403)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.body).toBe('{"error":"cross-site browser GET blocked"}')
    }
    const sameOrigin = await getWithHeaders(target, { origin: new URL(url).origin, 'sec-fetch-site': 'same-origin' })
    expect([200, 202]).toContain(sameOrigin.status)
    expect([200, 202]).toContain((await fetch(target)).status)
  })

  it('blocks DNS-rebinding Host headers on every read surface before routing', async () => {
    const { home, url } = await boot()
    const paths = [
      '/',
      `/api/app?s=${home.liveId}`,
      `/api/session/${home.liveId}`,
      '/api/suggestions',
      `/export/${home.liveId}.html`,
      '/events',
    ]
    for (const path of paths) {
      const response = await getWithHost(url + path, 'attacker.example')
      expect(response.status, path).toBe(403)
      expect(response.headers['content-type'], path).toBe('application/json; charset=utf-8')
      expect(response.headers['cache-control'], path).toBe('no-store')
      expect(response.body, path).toBe('{"error":"request host must be loopback"}')
    }
  })

  it('/events greets with hello and delivers session-updated after the transcript grows', async () => {
    const { home, url } = await boot()
    const chunks: string[] = []
    const req = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const r = httpGet(url + '/events', resolve)
      r.on('error', reject)
    })
    req.on('data', (c: Buffer) => chunks.push(c.toString('utf8')))
    const waitFor = async (needle: string, ms = 5_000): Promise<void> => {
      const t0 = Date.now()
      while (!chunks.join('').includes(needle)) {
        if (Date.now() - t0 > ms) throw new Error(`SSE never contained ${needle}\n${chunks.join('')}`)
        await new Promise((r2) => setTimeout(r2, 25))
      }
    }
    await waitFor('event: hello')
    await appendTurn(home.sessions[0]!.path, home.liveId)
    await srv!.registry.pollOnce()
    await srv!.registry.settle()
    await waitFor('event: session-updated')
    const frame = chunks.join('')
    expect(frame).toContain('"id":"' + home.liveId + '"')
    req.destroy()
  })

  it('streams a proposal status appended by a separate CLI store process', async () => {
    const { home, url, storeHome } = await bootWith({}, { suggestionPollMs: 0 })
    const chunks: string[] = []
    const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = httpGet(url + '/events', resolve)
      request.on('error', reject)
    })
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    try {
      await pollUntil(async () => (chunks.join('').includes('event: hello') ? true : undefined))
      const created = await postKickoff(url, { finding: FINDING([home.liveId], 'external-proposal'), mode: 'copy' })
      const id = (created.body.record as { id: string }).id
      const proposalPath = join(storeHome, 'proposals', `${id}.md`)
      await runSourceCli(['suggest', '--set', id, 'kicked-off', '--json'], storeHome)
      await writeFile(proposalPath, '# CLI proposal\n')
      await runSourceCli(['suggest', '--set', id, 'proposed', '--proposal', proposalPath, '--json'], storeHome)
      await srv!.suggestionWatcher.pollOnce()
      await pollUntil(async () => (chunks.join('').includes(`"id":"${id}","status":"proposed"`) ? true : undefined))
      expect(chunks.join('')).toContain('event: suggestion-updated')
    } finally {
      stream.destroy()
    }
  })

  it('unknown routes 404 as JSON', async () => {
    const { url } = await boot()
    const r = await fetch(url + '/api/nope')
    expect(r.status).toBe(404)
  })

  it('returns 400 and stays healthy after a raw request with malformed path encoding', async () => {
    const { url } = await boot()
    const malformed = await getRawPath(url, '/api/session/%E0%A4%A')
    expect(malformed.status).toBe(400)
    expect(malformed.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(malformed.headers['cache-control']).toBe('no-store')
    expect(malformed.body).toBe('{"error":"malformed request path"}')
    expect((await fetch(url + '/api/suggestions')).status).toBe(200)
  })
})

describe('matchRoute', () => {
  const route = (method: 'GET' | 'POST', path: string): Route => ({ method, path, handler: async () => {} })
  it('matches :param segments and literal suffixes', () => {
    const routes = [route('GET', '/'), route('GET', '/api/session/:id'), route('GET', '/export/:id.html'), route('POST', '/api/suggestions/:id/status')]
    expect(matchRoute(routes, 'GET', '/')?.route.path).toBe('/')
    expect(matchRoute(routes, 'GET', '/api/session/abc')?.params).toEqual({ id: 'abc' })
    expect(matchRoute(routes, 'GET', '/export/abc.html')?.params).toEqual({ id: 'abc' })
    expect(matchRoute(routes, 'GET', '/export/abc.json')).toBeUndefined()
    expect(matchRoute(routes, 'POST', '/api/suggestions/sg_1/status')?.params).toEqual({ id: 'sg_1' })
    expect(matchRoute(routes, 'GET', '/api/suggestions/sg_1/status')).toBeUndefined()
  })
})

describe('mutation request boundary', () => {
  it('accepts exact loopback JSON origins and rejects DNS-rebinding hosts', () => {
    expect(rejectUntrustedMutation({ headers: { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:4174', 'content-type': 'application/json; charset=utf-8' } })).toBeUndefined()
    expect(rejectUntrustedMutation({ headers: { host: 'localhost:4174', origin: 'http://localhost:4174', 'content-type': 'application/json' } })).toBeUndefined()
    expect(rejectUntrustedMutation({ headers: { host: 'attacker.example:4174', origin: 'http://attacker.example:4174', 'content-type': 'application/json' } })).toMatchObject({ status: 403 })
  })

  it('rejects only explicit browser cross-site read signals', () => {
    expect(rejectCrossSiteBrowserGet({ headers: { host: '127.0.0.1:4174' } })).toBeUndefined()
    expect(rejectCrossSiteBrowserGet({ headers: { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:4174', 'sec-fetch-site': 'same-origin' } })).toBeUndefined()
    expect(rejectCrossSiteBrowserGet({ headers: { host: '127.0.0.1:4174', 'sec-fetch-site': 'none' } })).toBeUndefined()
    expect(rejectCrossSiteBrowserGet({ headers: { host: '127.0.0.1:4174', origin: 'https://evil.example' } })).toMatchObject({ status: 403 })
    expect(rejectCrossSiteBrowserGet({ headers: { host: '127.0.0.1:4174', 'sec-fetch-site': 'cross-site' } })).toMatchObject({ status: 403 })
  })
})

describe('aggregate registry fingerprint', () => {
  const row = (overrides: Partial<SessionSummaryRow> = {}): SessionSummaryRow => ({
    id: '11111111-0000-4000-8000-00000000aaaa',
    projectSlug: 'demo',
    cwd: '/workspace/demo',
    path: '/sessions/one.jsonl',
    source: 'claude-code',
    sizeBytes: 100,
    mtimeMs: 1_000,
    badge: 'ended',
    ageMs: 0,
    possiblyLive: false,
    ...overrides,
  })

  it('changes for a non-max row mtime, size, source, or path mutation and ignores row order', () => {
    const base = [row(), row({ id: '22222222-0000-4000-8000-00000000bbbb', path: '/sessions/two.jsonl', mtimeMs: 2_000 })]
    const fingerprint = aggregateRegistryFingerprint(base)
    expect(aggregateRegistryFingerprint([...base].reverse())).toBe(fingerprint)
    for (const changed of [
      row({ mtimeMs: 1_001 }),
      row({ sizeBytes: 101 }),
      row({ source: 'cowork' }),
      row({ path: '/sessions/moved.jsonl' }),
    ]) {
      expect(aggregateRegistryFingerprint([changed, base[1]!])).not.toBe(fingerprint)
    }
  })
})

describe('serve redaction: the planted secret never leaves the process', () => {
  it('is absent from /api/sessions, /api/app, /api/repo and /api/global', async () => {
    const { home, url } = await boot()
    await srv!.registry.settle() // make sure the live/idle ticks (which attach titles to rows) are done
    const sessions = await (await fetch(url + '/api/sessions')).text()
    expect(sessions).toContain(home.liveId)
    expect(sessions).not.toContain(SECRET)
    const app = await (await fetch(url + `/api/app?s=${home.liveId}`)).text()
    expect(app).not.toContain(SECRET)
    const fetchAgg = (path: string): Promise<string> =>
      pollUntil(async () => {
        const r = await fetch(url + path)
        return r.status === 200 ? await r.text() : undefined
      })
    expect(await fetchAgg('/api/global')).not.toContain(SECRET)
    expect(await fetchAgg('/api/repo?cwd=' + encodeURIComponent('/Users/test/Code/demo'))).not.toContain(SECRET)
  })

  it('default stripText removes arbitrary transcript strings from rows, Analysis, aggregates, SSE, and export while keeping structural names', async () => {
    const { home, url } = await bootWith({}, { analyze: analyzeWithPrivateMarker })
    await srv!.registry.settle()
    const fetchAgg = (path: string): Promise<string> =>
      pollUntil(async () => {
        const r = await fetch(url + path)
        return r.status === 200 ? await r.text() : undefined
      })

    const chunks: string[] = []
    const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = httpGet(url + '/events', { headers: { 'last-event-id': '0' } }, resolve)
      request.on('error', reject)
    })
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    try {
      const surfaces = [
        await (await fetch(url + '/api/sessions')).text(),
        await (await fetch(url + `/api/app?s=${home.liveId}`)).text(),
        await (await fetch(url + `/api/session/${home.liveId}`)).text(),
        await fetchAgg('/api/repo?cwd=' + encodeURIComponent('/Users/test/Code/demo')),
        await fetchAgg('/api/global'),
        await (await fetch(url + `/export/${home.liveId}.html`)).text(),
      ]
      await pollUntil(async () => (chunks.join('').includes('event: hello') ? true : undefined))
      surfaces.push(chunks.join(''))
      for (const surface of surfaces) {
        expect(surface).not.toContain(ARBITRARY_MARKER)
        expect(surface).not.toContain(MARKER_SECRET)
      }
      // Rule-generated copy (finding titles, the narrative) survives the default strip.
      expect(surfaces[1]).toContain(GENERATED)
      // Tool, skill, and agent-type identifiers are structural UI data, not prose.
      expect(surfaces[1]).toContain('Write')
      expect(surfaces[1]).toContain('orangu-improve')
      expect(surfaces[1]).toContain('code-reviewer')
      const rows = JSON.parse(surfaces[0]!) as Array<{ id: string; title?: string; lastEvent?: { name: string; summary: string } }>
      const live = rows.find((row) => row.id === home.liveId)!
      expect(live.title).toBe('')
      expect(live.lastEvent?.name).toBeTruthy()
      expect(live.lastEvent?.summary).toBe('')
    } finally {
      stream.destroy()
    }
  })

  it('--include-text retains arbitrary transcript strings but still scrubs recognized secrets', async () => {
    const { home, url } = await bootWith({ includeText: true, exportIncludeText: true }, { analyze: analyzeWithPrivateMarker })
    await srv!.registry.settle()
    const fetchAgg = (path: string): Promise<string> =>
      pollUntil(async () => {
        const r = await fetch(url + path)
        return r.status === 200 ? await r.text() : undefined
      })
    const surfaces = [
      await (await fetch(url + '/api/sessions')).text(),
      await (await fetch(url + `/api/app?s=${home.liveId}`)).text(),
      await (await fetch(url + `/api/session/${home.liveId}`)).text(),
      await fetchAgg('/api/repo?cwd=' + encodeURIComponent('/Users/test/Code/demo')),
      await fetchAgg('/api/global'),
      await (await fetch(url + `/export/${home.liveId}.html`)).text(),
    ]
    for (const surface of surfaces) {
      expect(surface).toContain(ARBITRARY_MARKER)
      expect(surface).not.toContain(MARKER_SECRET)
    }
  })

  it('fleet row titles are stripped under default serve because they may be the first user prompt', async () => {
    const { home, url } = await boot()
    await srv!.registry.settle()
    const rows = JSON.parse(await (await fetch(url + '/api/sessions')).text()) as Array<{ id: string; title?: string }>
    const live = rows.find((r) => r.id === home.liveId)
    expect(live?.title ?? '').not.toContain(SECRET) // secret masked
    expect(live?.title).toBe('')
  })

  it('is absent from the SSE frames (session-added replay + session-updated rows)', async () => {
    const { home, url } = await boot()
    const chunks: string[] = []
    const req = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      // Last-Event-ID: 0 replays the whole ring, including the startup session-added frames
      const r = httpGet(url + '/events', { headers: { 'last-event-id': '0' } }, resolve)
      r.on('error', reject)
    })
    req.on('data', (c: Buffer) => chunks.push(c.toString('utf8')))
    try {
      await pollUntil(async () => (chunks.join('').includes('event: hello') ? true : undefined))
      await appendTurn(home.sessions[0]!.path, home.liveId)
      await srv!.registry.pollOnce()
      await srv!.registry.settle()
      await pollUntil(async () => (chunks.join('').includes('event: session-updated') ? true : undefined))
      const stream = chunks.join('')
      expect(stream).toContain('event: session-added')
      expect(stream).toContain('"id":"' + home.liveId + '"')
      expect(stream).not.toContain(SECRET)
    } finally {
      req.destroy()
    }
  })

  it('GET /export/:id.html through the live server is a redacted attachment', async () => {
    const { home, url } = await boot()
    const r = await fetch(url + '/export/' + home.liveId + '.html')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="orangu-${home.liveId}.html"`)
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    const html = await r.text()
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain(SECRET)
  })
})

describe('copy-only model handoff through the live server', () => {
  it('never exposes run capability or spawns a model process', async () => {
    const { home, url } = await bootWith({})
    const app = (await (await fetch(url + `/api/app?s=${home.liveId}`)).json()) as { capabilities: { kickoffRun: boolean } }
    expect(app.capabilities.kickoffRun).toBe(false)

    const { status, body } = await postKickoff(url, { finding: FINDING([home.liveId]), mode: 'run', confirm: true })
    expect(status).toBe(403)
    expect(body.spawned).toBe(false)
    expect(String(body.error)).toContain('automatic model launch is disabled')
    expect(String(body.command)).toContain('/orangu:improve')
    expect((body.record as { status: string }).status).toBe('new')
  })

  it('returns a copy handoff while preserving the real store as new', async () => {
    const { home, url } = await bootWith({})
    const suggestionSecret = 'sk-ant-api03-browsersecret123456'
    const { status, body } = await postKickoff(url, { finding: { ...FINDING([home.liveId]), title: `Finding ${suggestionSecret}` }, mode: 'copy' })
    expect(status).toBe(200)
    expect(JSON.stringify(body)).not.toContain(suggestionSecret)
    expect(body.spawned).toBe(false)
    expect(String(body.command)).toContain('/orangu:improve')
    expect((body.record as { status: string }).status).toBe('new')
    const list = (await (await fetch(url + '/api/suggestions')).json()) as Array<{ id: string; status: string }>
    expect(JSON.stringify(list)).not.toContain(suggestionSecret)
    expect(list.find((record) => record.id === (body.record as { id: string }).id)?.status).toBe('new')
  })
})

describe('suggestion status transitions through the live server', () => {
  it('lets the browser reject but never claim proposed, applied, or verified', async () => {
    const { home, url } = await boot()
    const { body } = await postKickoff(url, { finding: FINDING([home.liveId]), mode: 'copy' })
    const id = (body.record as { id: string }).id
    const claimed = await fetch(url + `/api/suggestions/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"applied"}' })
    expect(claimed.status).toBe(400)
    expect(((await claimed.json()) as { error: string }).error).toMatch(/browser may only/)
    const ok = await fetch(url + `/api/suggestions/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"rejected"}' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { status: string }).status).toBe('rejected')
    const bad = await fetch(url + `/api/suggestions/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"kicked-off"}' })
    expect(bad.status).toBe(400)
    const list = (await (await fetch(url + '/api/suggestions')).json()) as Array<{ id: string; status: string }>
    expect(list.find((s) => s.id === id)?.status).toBe('rejected')
  })
})

describe('registry timer path', () => {
  it('an injected pollMs delivers session-updated with NO manual pollOnce', async () => {
    const { home, url } = await bootWith({}, { pollMs: 50 })
    const chunks: string[] = []
    const req = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const r = httpGet(url + '/events', resolve)
      r.on('error', reject)
    })
    req.on('data', (c: Buffer) => chunks.push(c.toString('utf8')))
    try {
      await pollUntil(async () => (chunks.join('').includes('event: hello') ? true : undefined))
      await appendTurn(home.sessions[0]!.path, home.liveId)
      // no pollOnce()/settle(): only start()'s own timers/watchers may deliver this
      await pollUntil(async () => {
        const stream = chunks.join('')
        return stream.includes('event: session-updated') && stream.includes('"id":"' + home.liveId + '"') ? true : undefined
      }, 8_000)
    } finally {
      req.destroy()
    }
  }, 15_000)
})
