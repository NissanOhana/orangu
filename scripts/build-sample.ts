/**
 * Builds the two public samples linked from the landing page:
 *
 *   site/sample.html       one session, plus the repository and machine-wide aggregates beside it, so
 *                          every scope of the app (this session / repo / global) has evidence to show
 *   site/sample-repo.html  seven sessions in the same repository, as `orangu repo --html` writes it
 *
 * Every session is SYNTHETIC: composed here with the fixture builder the tests use, so no real
 * transcript, path, prompt or secret can ever reach the published site. The rules that fire are the
 * real shipped rules; the numbers are the real arithmetic over made-up input.
 *
 * Deterministic: fixed ids (`resetIds`) + a fixed clock, so the files change only when the report
 * code changes, never merely because they were rebuilt.
 *
 *   npx tsx scripts/build-sample.ts        (npm run build:sample)
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SessionBuilder, resetIds, type Usage } from '../test/fixtures/session-builder.js'
import { parseClaudeCodeSession } from '../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../src/analyze/analyze.js'
import { aggregate } from '../src/analyze/aggregate.js'
import { prepareAggregateForOutput } from '../src/cli/json-out.js'
import { renderAggregateReport, renderReport } from '../src/report/render.js'
import type { Analysis } from '../src/model/analysis.js'

/** A fixed "now" so the rendered bytes are stable across rebuilds. */
const NOW = Date.parse('2026-03-02T10:20:00.000Z')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = 'https://nissanohana.github.io/orangu/'

const SRC = '/workspace/checkout-api'
const BASELINE = 28_400

/** one line of a fake file listing, repeated to a byte size */
const filler = (bytes: number, line = 'export const handler = (req, res) => next()\n'): string => line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)

const MCP_ROSTER = [
  ...['get_issue', 'list_issues', 'create_issue', 'update_issue', 'list_projects', 'list_teams', 'add_comment', 'search'].map((t) => `mcp__linear__${t}`),
  ...['navigate', 'click', 'type', 'snapshot', 'screenshot', 'evaluate', 'wait_for', 'press_key', 'hover', 'drag', 'select_option', 'fill_form', 'tabs', 'close', 'resize', 'console', 'network', 'upload', 'handle_dialog', 'run_code', 'find', 'back'].map((t) => `mcp__playwright__browser_${t}`),
  ...['list_pages', 'new_page', 'select_page', 'close_page', 'navigate_page', 'click', 'fill', 'hover', 'drag', 'press_key', 'type_text', 'take_screenshot', 'take_snapshot', 'evaluate_script', 'list_console_messages', 'list_network_requests', 'get_network_request', 'emulate', 'resize_page', 'performance_start_trace', 'performance_stop_trace', 'lighthouse_audit', 'wait_for', 'handle_dialog', 'upload_file', 'take_heapsnapshot'].map((t) => `mcp__chrome-devtools__${t}`),
]
const SKILL_ROSTER = ['review-pr', 'deploy-check', 'db-migrate', 'brainstorming', 'systematic-debugging', 'test-driven-development', 'orangu:analyze', 'orangu:improve', 'orangu:apply', 'orangu:harness', 'orangu:feedback']

/**
 * Wraps SessionBuilder with the bookkeeping a believable transcript needs: a context that grows with
 * every tool result (cache write on the next request, cache read on all later ones), model latency
 * before each call, per-turn durations, and the Stop hooks the repository runs after every turn.
 */
class Story {
  readonly b: SessionBuilder
  private ctx: number
  private pending = 0
  private turnStart = 0
  private turnMessages = 0
  private hookMs: Array<{ command: string; durationMs: number }>
  constructor(o: { sessionId: string; startAt: string; title: string; cwd?: string; baseline?: number; hooks?: Array<{ command: string; durationMs: number }> }) {
    this.b = new SessionBuilder({ sessionId: o.sessionId, startAt: o.startAt, cwd: o.cwd ?? SRC, gitBranch: 'main', version: '2.1.231' })
    this.ctx = 0
    this.pending = o.baseline ?? BASELINE
    this.hookMs = o.hooks ?? [
      { command: 'npm run lint', durationMs: 4_100 },
      { command: 'node scripts/assert-contracts.mjs', durationMs: 7_900 },
    ]
    this.b.meta('mode', { mode: 'normal' })
    this.b.meta('permission-mode', { permissionMode: 'default' })
    this.b.meta('custom-title', { customTitle: o.title })
    this.b.attachmentHook('SessionStart:startup', 'SessionStart', 'OK')
    this.b.attachment('skill_listing', { names: SKILL_ROSTER, skillCount: SKILL_ROSTER.length, isInitial: true })
    this.b.attachment('deferred_tools_delta', { addedNames: MCP_ROSTER, readdedNames: [] })
  }
  /** the usage of the next request: everything pending is written to cache, everything before is read back */
  private usage(out: number, extra: Partial<Usage> = {}): Partial<Usage> {
    // the default 5-minute cache tier: turns in this session come faster than that, so nothing churns
    const u: Partial<Usage> = { input_tokens: 4 + Math.round(out / 40), cache_read_input_tokens: this.ctx, cache_creation_input_tokens: this.pending, cache_creation: { ephemeral_5m_input_tokens: this.pending, ephemeral_1h_input_tokens: 0 }, output_tokens: out, ...extra }
    this.ctx += this.pending + out
    this.pending = 0
    this.turnMessages++
    return u
  }
  private carry(bytes: number): void {
    this.pending += Math.round(bytes / 4)
  }
  human(text: string, gapMs: number): this {
    this.b.tick(gapMs)
    this.b.userPrompt(text)
    this.turnStart = Date.parse(this.b.now())
    this.turnMessages = 1
    this.carry(text.length)
    return this
  }
  say(text: string, out = 120, thinking?: string): this {
    this.b.tick(900 + out * 8)
    const blocks: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = []
    if (thinking) blocks.push({ type: 'thinking', thinking })
    blocks.push({ type: 'text', text })
    this.b.assistant(blocks, { usage: this.usage(out) })
    this.carry(text.length)
    return this
  }
  call(
    name: string,
    input: Record<string, unknown>,
    result: string,
    o: { ms?: number; out?: number; isError?: boolean; toolUseResult?: unknown; text?: string; thinking?: string; thinkingTokens?: number; skill?: string; mcp?: string } = {},
  ): this {
    const out = o.out ?? 60
    this.b.tick(1_400 + out * 6)
    const usage = this.usage(out, o.thinkingTokens ? { output_tokens_details: { thinking_tokens: o.thinkingTokens } } : {})
    this.b.toolCall(name, input, result, {
      durationMs: o.ms ?? 120,
      isError: o.isError,
      usage,
      toolUseResult: o.toolUseResult,
      text: o.text,
      thinking: o.thinking,
      attribution: o.skill ? { skill: o.skill } : o.mcp ? { mcpServer: o.mcp, mcpTool: name } : undefined,
    })
    this.carry(result.length + JSON.stringify(input).length)
    return this
  }
  read(path: string, bytes: number, o: { thinking?: string; thinkingTokens?: number; skill?: string; ms?: number; truncated?: boolean } = {}): this {
    const content = filler(bytes)
    const file = { filePath: `${SRC}/${path}`, content, numLines: content.split('\n').length, startLine: 1, totalLines: o.truncated ? 4_120 : content.split('\n').length, ...(o.truncated ? { truncatedByTokenCap: true } : {}) }
    if (o.truncated) this.b.attachment('read_truncation_notice', { filePath: file.filePath })
    return this.call('Read', { file_path: file.filePath }, content, { ms: o.ms ?? 90, out: o.thinkingTokens ? o.thinkingTokens + 70 : 48, toolUseResult: { type: 'text', file }, ...o })
  }
  grep(pattern: string, bytes: number, path = SRC): this {
    return this.call('Grep', { pattern, path }, filler(bytes, `${SRC}/src/routes/checkout.ts:41:  // ${pattern}\n`), { ms: 1_600 + Math.round(bytes / 200), out: 58 })
  }
  bash(command: string, result: string, o: { ms?: number; isError?: boolean; out?: number } = {}): this {
    return this.call('Bash', { command }, result, { ms: o.ms ?? 800, isError: o.isError, out: o.out ?? 70 })
  }
  edit(path: string, oldString: string, newString: string): this {
    return this.call('Edit', { file_path: `${SRC}/${path}`, old_string: oldString, new_string: newString }, 'The file has been updated.', { ms: 95, out: 40 + Math.round(newString.length / 4) })
  }
  write(path: string, content: string): this {
    return this.call('Write', { file_path: `${SRC}/${path}`, content }, 'File created successfully.', { ms: 140, out: Math.round(content.length / 3.6) })
  }
  /** a Stop hook summary and the turn_duration record Claude Code writes when the assistant stops */
  end(): this {
    this.b.stopHookSummary(this.hookMs)
    this.b.tick(this.hookMs.reduce((a, h) => a + h.durationMs, 0))
    this.b.turnDuration(Date.parse(this.b.now()) - this.turnStart, this.turnMessages)
    return this
  }
  /** a subagent: the parent's Agent call, then the child's own records on the sidechain */
  agent(o: { id: string; type: string; model: string; description: string; prompt: string; reads: string[]; answer: string; ms: number; readBytes?: number }): this {
    const agentTokens = o.reads.length * (18_400 + 900) + 24_000
    this.call(
      'Agent',
      { description: o.description, prompt: o.prompt, subagent_type: o.type },
      o.answer,
      { ms: o.ms, out: 110, toolUseResult: { status: 'completed', agentId: o.id, content: [{ type: 'text', text: o.answer }], totalDurationMs: o.ms, totalTokens: agentTokens, totalToolUseCount: o.reads.length } },
    )
    const b = this.b
    b.sidechain(o.id)
    b.tick(120)
    b.userPrompt(o.prompt)
    let ctx = 17_800
    b.tick(700)
    b.assistant([{ type: 'text', text: `Reading ${o.reads.length} files.` }], { model: o.model, usage: { input_tokens: 620, cache_read_input_tokens: ctx, output_tokens: 42 } })
    for (const f of o.reads) {
      b.tick(140)
      ctx += 640
      b.toolCall('Read', { file_path: f }, filler(o.readBytes ?? 2_400), { durationMs: 95, model: o.model, usage: { input_tokens: 11, cache_read_input_tokens: ctx, cache_creation_input_tokens: 610, output_tokens: 38 } })
    }
    b.tick(1_300)
    b.assistant([{ type: 'text', text: o.answer }], { model: o.model, usage: { input_tokens: 14, cache_read_input_tokens: ctx + 640, output_tokens: 160 } })
    b.sidechain('', false)
    this.turnMessages += 2 + o.reads.length
    return this
  }
  /** auto-compaction: Claude Code replaces the context with a summary; the next request starts from it */
  compact(summary: string): this {
    this.b.tick(6_500)
    this.b.compactSummary(summary)
    this.ctx = 0
    this.pending = BASELINE + Math.round(summary.length / 4)
    return this
  }
}

/** shared step: the tests that only pass once Redis is up (the repository's recurring environment error) */
const REDIS_ERR = 'FAIL test/integration/checkout.int.test.ts\n  Error: connect ECONNREFUSED 127.0.0.1:6379\n      at TCPConnectWrap.afterConnect'

/**
 * The published session: a believable feature run, read -> survey -> decide -> build -> correct ->
 * verify -> review -> ship, with the waste a real afternoon carries and a green ending.
 */
function buildFeatureSession(): SessionBuilder {
  const s = new Story({ sessionId: '5a91c73e-0000-4000-8000-00000000d0c5', startAt: '2026-03-02T09:00:00.000Z', title: 'Add rate limiting to the checkout API' })

  // turn 0: orient. The ticket through MCP, the middleware layer one file at a time, one unscoped grep.
  s.human('Add rate limiting to the checkout API (CHK-812). Follow the middleware pattern we already use, and keep it to the checkout routes.', 0)
  s.call('mcp__linear__get_issue', { id: 'CHK-812' }, 'CHK-812 · Rate limit checkout · P1 · Acceptance: 120 requests per minute per API key on /checkout/*, 429 with Retry-After, no change to the auth chain.', { ms: 1_240, out: 64, mcp: 'linear' })
  s.say('Reading the middleware layer before touching anything.', 90, 'The ticket names a per-key limit. Check how the existing middleware is registered before deciding where the limiter goes.')
  for (const f of ['src/middleware/auth.ts', 'src/middleware/index.ts', 'src/routes/checkout.ts', 'src/lib/redis.ts']) s.read(f, 2_100 + f.length * 20)
  s.grep('rateLimit|rate_limit|RateLimit', 214_000)
  s.say('The middleware chain is auth -> validate -> handler, registered in src/middleware/index.ts. There is a shared Redis client in src/lib/redis.ts and no limiter anywhere yet. Plan: a token-bucket middleware backed by that client, wired into the checkout router only.', 260)
  s.end()

  // turn 1: survey the neighbours, one agent after another
  s.human('Look at how the other services do it before you write anything.', 150_000)
  s.say('Surveying the three neighbouring services.', 60)
  s.agent({ id: 'smp0000000000000', type: 'general-purpose', model: 'claude-sonnet-5', description: 'survey svc-orders', prompt: 'How does svc-orders rate-limit its public routes? Name the file, the algorithm and the limits.', reads: ['limit.ts', 'index.ts', 'redis.ts', 'routes/orders.ts', 'routes/refunds.ts', 'config.ts', 'errors.ts', 'metrics.ts', 'test/limit.test.ts', 'test/orders.test.ts', 'README.md', 'package.json'].map((f) => `${SRC}/../svc-orders/src/${f}`), answer: 'svc-orders: token bucket in src/middleware/limit.ts, 60 rpm per key, Redis INCR with a 60 s TTL, 429 + Retry-After.', ms: 41_000 })
  s.agent({ id: 'smp1000000000000', type: 'general-purpose', model: 'claude-sonnet-5', description: 'survey svc-catalog', prompt: 'How does svc-catalog rate-limit its public routes?', reads: ['limit.ts', 'index.ts', 'routes/search.ts'].map((f) => `${SRC}/../svc-catalog/src/${f}`), answer: 'svc-catalog: sliding window in memory, 300 rpm, no Redis; resets on deploy.', ms: 19_500 })
  s.agent({ id: 'smp2000000000000', type: 'general-purpose', model: 'claude-sonnet-5', description: 'survey svc-payments', prompt: 'How does svc-payments rate-limit its public routes?', reads: ['limit.ts', 'index.ts', 'routes/capture.ts', 'lib/redis.ts'].map((f) => `${SRC}/../svc-payments/src/${f}`), answer: 'svc-payments: token bucket, 120 rpm per key, Redis, shared client from lib/redis.ts. Closest to our layout.', ms: 22_800 })
  s.say('Two of three use a Redis token bucket keyed by API key; svc-payments is the closest match to our layout. One open decision: Redis-backed (survives deploys, shared across replicas) or in-memory (simpler, per replica).', 300)
  s.call('AskUserQuestion', { questions: [{ question: 'Back the token bucket with the shared Redis client, or keep it in memory per replica?', header: 'Storage', options: [{ label: 'Redis (Recommended)', description: 'shared across replicas, survives deploys' }, { label: 'In memory', description: 'simplest, resets per replica' }] }] }, 'Redis. Reuse the client in src/lib/redis.ts. 120 rpm per API key, checkout routes only.', { ms: 14 * 60_000 + 12_000, out: 210 })
  s.say('Redis it is. Writing the middleware and wiring it into the checkout router.', 80)
  s.write('src/middleware/rate-limit.ts', filler(3_300, "export const rateLimit = (opts: { rpm: number }) => async (req, res, next) => { /* token bucket over redis */ }\n"))
  for (const f of ['src/middleware/index.ts', 'src/routes/checkout.ts', 'src/middleware/auth.ts']) s.read(f, 2_100 + f.length * 20)
  s.read('src/middleware/index.ts', 2_700)
  s.edit('src/middleware/index.ts', "export { auth } from './auth'", "export { auth } from './auth'\nexport { rateLimit } from './rate-limit'")
  s.edit('src/routes/checkout.ts', 'router.use(auth)', 'router.use(auth)\nrouter.use(rateLimit({ rpm: 120 }))')
  for (let i = 0; i < 4; i++) {
    s.bash('npm test -- checkout', i === 1 ? 'FAIL src/middleware/rate-limit.test.ts\n  expected 429, received 200 (window = 60)\n1 failed, 41 passed' : 'PASS 42 tests', { ms: 32_000 + i * 900, isError: i === 1, out: 74 })
    if (i === 1) s.edit('src/middleware/rate-limit.ts', 'window = 60', 'window = 120')
  }
  s.read('test/checkout.test.ts', 2_600)
  s.write('test/checkout.test.ts', filler(2_450, "it('returns 429 after 120 requests in a minute', async () => { /* ... */ })\n"))
  s.say('Rate limiting is wired into the checkout router at 120 rpm per API key and the checkout suite passes (42 tests).', 180)
  s.end()

  // turn 2: the correction, and the same test command again
  s.human('No, keep the limiter out of the auth chain: it has to run before auth so unauthenticated bursts are cut too.', 210_000)
  s.say('Moving the limiter ahead of auth in the checkout router.', 70)
  s.read('src/routes/checkout.ts', 2_500)
  s.edit('src/routes/checkout.ts', 'router.use(auth)\nrouter.use(rateLimit({ rpm: 120 }))', 'router.use(rateLimit({ rpm: 120 }))\nrouter.use(auth)')
  s.read('src/middleware/rate-limit.ts', 3_300)
  s.write('src/middleware/rate-limit.ts', filler(3_100, "export const rateLimit = (opts: { rpm: number; keyFrom: (req) => string }) => async (req, res, next) => { /* token bucket over redis */ }\n"))
  s.bash('npm test -- checkout', 'PASS 42 tests', { ms: 33_400, out: 66 })
  s.say('The limiter now keys on the API key header before auth runs; anonymous bursts get the 429 too.', 140)
  s.end()

  // auto-compaction: the context crossed the threshold on the way into the integration suite
  s.compact('Summary of the session so far. Task: rate limit /checkout at 120 rpm per API key, Redis-backed token bucket, limiter runs before auth. Files: src/middleware/rate-limit.ts (new), src/middleware/index.ts, src/routes/checkout.ts, test/checkout.test.ts. Unit suite green (42). Open: integration suite not yet run.')

  // turn 3: the integration suite, an environment error, and a capped read
  s.human('Still failing on CI: the integration suite times out. Fix it.', 240_000)
  s.say('Running the integration suite locally to see the failure.', 60)
  s.bash('npx vitest run test/integration', REDIS_ERR, { ms: 48_000, isError: true, out: 80 })
  s.read('vendor/ioredis/built/index.d.ts', 100_000, { ms: 260, truncated: true })
  s.read('src/lib/redis.ts', 2_300, { thinking: 'The CI job has no Redis service. The suite should start one, or the limiter should fail open when the client is not connected. Reading the client setup to see which is cheaper.', thinkingTokens: 3_400 })
  s.edit('src/lib/redis.ts', 'lazyConnect: false', 'lazyConnect: true, maxRetriesPerRequest: 1')
  s.edit('src/middleware/rate-limit.ts', 'const bucket = await take(key)', "const bucket = redis.status === 'ready' ? await take(key) : { allowed: true }")
  s.bash('npx vitest run test/integration', REDIS_ERR, { ms: 47_200, isError: true, out: 72 })
  s.say('The client is fine; the CI job has no Redis service at all. Adding one to the workflow and keeping fail-open as the safety net.', 150)
  s.edit('.github/workflows/ci.yml', 'services: {}', 'services:\n  redis:\n    image: redis:7\n    ports: [6379:6379]')
  s.bash('npx vitest run test/integration', 'PASS 18 integration tests (redis: connected)', { ms: 46_100, out: 70 })
  s.say('Integration suite is green with a Redis service in CI; the limiter fails open if Redis is ever unreachable in production.', 150)
  s.end()

  // turn 4: the repository's review skill reads the whole diff surface
  s.human('<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>', 95_000)
  s.say('Running the review checklist over every file the change touches.', 80)
  s.read('.claude/skills/review-pr/CHECKLIST.md', 18_600, { skill: 'review-pr' })
  for (const f of ['src/middleware/rate-limit.ts', 'src/middleware/index.ts', 'src/routes/checkout.ts', 'src/lib/redis.ts', 'test/checkout.test.ts', 'test/integration/checkout.int.test.ts', '.github/workflows/ci.yml', 'docs/api/checkout.md', 'src/middleware/auth.ts', 'src/config.ts', 'src/app.ts', 'src/errors.ts'])
    s.read(f, 6_400 + f.length * 60, { skill: 'review-pr' })
  s.call('Bash', { command: 'git diff main --stat' }, filler(1_900, ' src/middleware/rate-limit.ts | 74 ++++\n'), { ms: 640, out: 60, skill: 'review-pr' })
  s.call('Bash', { command: 'npm run typecheck' }, '', { ms: 9_800, out: 60, skill: 'review-pr' })
  s.call('Bash', { command: 'npm run lint' }, '', { ms: 4_300, out: 56, skill: 'review-pr' })
  s.say('Review: the limiter is keyed correctly, fails open, and is covered by unit and integration tests. One nit: docs/api/checkout.md does not mention the 429 yet.', 240)
  s.edit('docs/api/checkout.md', '## Errors', '## Errors\n\n`429 Too Many Requests` with `Retry-After` once a key exceeds 120 requests per minute.')
  s.end()

  // turn 5: ship
  s.human('Ship it: commit and open the PR.', 120_000)
  s.bash('npm test', 'PASS 214 tests', { ms: 41_000, out: 66 })
  s.bash('git add -A && git commit -m "feat(checkout): rate limit checkout routes at 120 rpm per API key"', '[main 7c1e2f9] feat(checkout): rate limit checkout routes at 120 rpm per API key\n 7 files changed, 168 insertions(+), 4 deletions(-)', { ms: 620, out: 90 })
  s.bash('gh pr create --fill', 'Creating pull request for feat/checkout-rate-limit into main\n#418', { ms: 3_900, out: 60 })
  s.b.meta('pr-link', { prNumber: 418 })
  s.say('PR #418 is open: Redis-backed token bucket at 120 rpm per API key on the checkout routes, running before auth, failing open, with unit and integration coverage and a Redis service in CI.', 220)
  s.end()
  return s.b
}

/** The rest of the repository's month: six sibling sessions that share its habits, its files and its one environment error. */
function buildSiblingSessions(): SessionBuilder[] {
  const out: SessionBuilder[] = []
  const sid = (n: number) => `c0ffee${n}0-0000-4000-8000-0000000000${n}${n}`

  {
    // a debugging session that never got past the Redis error and ended red
    const s = new Story({ sessionId: sid(1), startAt: '2026-02-10T14:05:00.000Z', title: 'Fix the flaky checkout integration test' })
    s.human('The checkout integration test is flaky on CI. Find out why.', 0)
    s.say('Reproducing locally first.', 60)
    for (let i = 0; i < 3; i++) s.bash('npx vitest run test/integration', REDIS_ERR, { ms: 46_000 + i * 700, isError: true })
    s.say('Refused outright, not slow. Looking at what the suite expects to be running.', 90)
    for (const f of ['test/integration/checkout.int.test.ts', 'test/integration/setup.ts', 'src/lib/redis.ts', 'src/config.ts', '.github/workflows/ci.yml', 'docker-compose.yml', 'package.json', 'vitest.config.ts', 'src/middleware/index.ts']) s.read(f, 2_300 + f.length * 40)
    s.grep('6379|REDIS_URL', 38_000)
    s.bash('docker compose ps', 'NAME   IMAGE   STATUS\n(no containers)', { ms: 1_900 })
    s.bash('cat .env.example', 'REDIS_URL=redis://127.0.0.1:6379\nPORT=3000', { ms: 60 })
    s.bash('git log --oneline -8 -- .github/workflows/ci.yml', filler(700, '3f2a1c0 ci: drop the services block (unused)\n'), { ms: 420 })
    s.edit('test/integration/checkout.int.test.ts', 'timeout: 5000', 'timeout: 30000')
    s.bash('npx vitest run test/integration', REDIS_ERR, { ms: 47_800, isError: true })
    s.say('Raising the timeout does not help; the connection is refused outright. This needs a Redis service on the CI runner, which is outside this repository.', 160)
    s.end()
    out.push(s.b)
  }
  {
    // a refactor that rewrote whole files and re-read the same index over and over
    const s = new Story({ sessionId: sid(2), startAt: '2026-02-12T09:30:00.000Z', title: 'Migrate cart totals to the Amount type' })
    s.human('Migrate every cart total in src/cart to the Amount type from src/lib/amount.ts.', 0)
    s.grep('total', 168_000, `${SRC}/src`)
    for (const f of ['src/cart/totals.ts', 'src/cart/discounts.ts', 'src/cart/tax.ts', 'src/middleware/index.ts', 'src/lib/amount.ts']) s.read(f, 2_900)
    s.say('Twelve call sites across three files. Rewriting each file.', 120)
    for (const f of ['src/cart/totals.ts', 'src/cart/discounts.ts', 'src/cart/tax.ts']) {
      s.read(f, 2_900)
      s.write(f, filler(3_050, "export const total = (lines: Line[]): Amount => lines.reduce((a, l) => a.add(l.amount), Amount.zero())\n"))
    }
    s.read('src/middleware/index.ts', 2_700)
    s.bash('npm test -- cart', 'FAIL src/cart/tax.test.ts\n  expected Amount, received number\n3 failed, 58 passed', { ms: 29_000, isError: true })
    s.edit('src/cart/tax.ts', 'return rate * subtotal', 'return subtotal.multiply(rate)')
    s.bash('npm test -- cart', 'PASS 61 tests', { ms: 28_400 })
    s.end()
    s.human('Now the same for src/orders.', 380_000)
    s.grep('total', 171_000, `${SRC}/src/orders`)
    for (const f of ['src/orders/summary.ts', 'src/orders/invoice.ts', 'src/middleware/index.ts']) s.read(f, 2_800)
    for (const f of ['src/orders/summary.ts', 'src/orders/invoice.ts']) {
      s.read(f, 2_800)
      s.write(f, filler(2_900, "export const summary = (o: Order): Amount => total(o.lines).add(o.shipping)\n"))
    }
    s.bash('npm test -- orders', 'PASS 40 tests', { ms: 27_900 })
    s.bash('git add -A && git commit -m "refactor(cart): Amount type for every total"', '[main 1b9d0aa] refactor(cart): Amount type for every total', { ms: 540 })
    s.end()
    out.push(s.b)
  }
  {
    // an investigation that fanned out and carried three oversized results
    const s = new Story({ sessionId: sid(3), startAt: '2026-02-17T16:40:00.000Z', title: 'Investigate p95 latency on POST /checkout/confirm' })
    s.human('p95 on POST /checkout/confirm went from 180 ms to 900 ms after Tuesday. Find the cause.', 0)
    s.bash('git log --since=2026-02-10 --stat', filler(96_000, 'commit 3f2a\n src/checkout/confirm.ts | 40 +++\n'), { ms: 1_100 })
    s.grep('confirm', 152_000, `${SRC}/src`)
    s.say('Three suspects. Checking each in parallel would be faster, but reading them in order.', 120)
    s.agent({ id: 'lat0000000000000', type: 'Explore', model: 'claude-sonnet-5', description: 'inspect confirm handler', prompt: 'What changed in src/checkout/confirm.ts since Feb 10 and which calls are awaited serially?', reads: ['confirm.ts', 'validate.ts', 'inventory.ts', 'quotes.ts'].map((f) => `${SRC}/src/checkout/${f}`), answer: 'confirm.ts now awaits inventory.reserve and quotes.get serially; both were parallel before 3f2a.', ms: 24_000 })
    s.agent({ id: 'lat1000000000000', type: 'Explore', model: 'claude-sonnet-5', description: 'inspect inventory client', prompt: 'Does src/checkout/inventory.ts retry or time out?', reads: ['inventory.ts', 'http.ts'].map((f) => `${SRC}/src/checkout/${f}`), answer: 'inventory.reserve retries 3 times with a 200 ms backoff; no timeout.', ms: 16_000 })
    s.agent({ id: 'lat2000000000000', type: 'Explore', model: 'claude-sonnet-5', description: 'inspect quote client', prompt: 'Does src/checkout/quotes.ts cache quotes?', reads: ['quotes.ts', 'cache.ts'].map((f) => `${SRC}/src/checkout/${f}`), answer: 'quotes.get lost its 30 s cache in 3f2a.', ms: 15_500 })
    s.say('Cause: commit 3f2a serialised two awaits and dropped the quote cache. Restoring both.', 160)
    s.read('src/checkout/confirm.ts', 3_900)
    s.edit('src/checkout/confirm.ts', 'const stock = await reserve(cart)\nconst quote = await getQuote(cart)', 'const [stock, quote] = await Promise.all([reserve(cart), getQuote(cart)])')
    s.edit('src/checkout/quotes.ts', 'return fetchQuote(cart)', 'return cached(cart.hash, 30_000, () => fetchQuote(cart))')
    s.bash('npm test -- checkout', 'PASS 42 tests', { ms: 31_000 })
    s.bash('npx vitest run test/integration', REDIS_ERR, { ms: 46_500, isError: true })
    s.bash('npx vitest run test/integration', 'PASS 18 integration tests (redis: connected)', { ms: 45_800 })
    s.bash('git add -A && git commit -m "perf(checkout): parallel reserve+quote, restore the quote cache"', '[main 9e0c4d1] perf(checkout): parallel reserve+quote, restore the quote cache', { ms: 560 })
    s.end()
    out.push(s.b)
  }
  {
    // dependency bump: the same command shape over and over
    const s = new Story({ sessionId: sid(4), startAt: '2026-02-19T11:10:00.000Z', title: 'Bump dependencies and fix the typecheck' })
    s.human('Bump every minor dependency and make typecheck pass.', 0)
    s.bash('npm outdated', filler(6_200, 'zod  3.22.4  3.23.8  3.23.8\n'), { ms: 4_100 })
    for (const p of ['zod', 'ioredis', 'pino', 'fastify', 'vitest', 'typescript', 'esbuild', 'tsx']) s.bash(`npm install ${p}@latest`, `added 1 package, changed 1 package in 4s`, { ms: 4_200 })
    s.bash('npm run typecheck', 'src/cart/tax.ts(14,9): error TS2322\nsrc/orders/invoice.ts(31,5): error TS2322\n2 errors', { ms: 12_400, isError: true })
    s.read('src/cart/tax.ts', 2_600)
    s.edit('src/cart/tax.ts', 'z.number()', 'z.coerce.number()')
    s.read('src/orders/invoice.ts', 2_800)
    s.edit('src/orders/invoice.ts', 'z.number()', 'z.coerce.number()')
    s.bash('npm run typecheck', '', { ms: 12_100 })
    s.bash('npm test', 'PASS 214 tests', { ms: 40_200 })
    s.bash('git add -A && git commit -m "chore(deps): bump minors, coerce numeric schema inputs"', '[main 4a77e01] chore(deps): bump minors', { ms: 520 })
    s.end()
    out.push(s.b)
  }
  {
    // a short writing session: cheap, clean, done
    const s = new Story({ sessionId: sid(5), startAt: '2026-02-24T15:00:00.000Z', title: 'Write the ADR for idempotency keys' })
    s.human('Write an ADR for idempotency keys on POST /checkout/confirm. Follow docs/adr/0007 as the template.', 0)
    s.read('docs/adr/0007-retry-policy.md', 3_600)
    s.read('src/checkout/confirm.ts', 3_900)
    s.write('docs/adr/0012-idempotency-keys.md', filler(4_800, '## Decision\n\nClients send Idempotency-Key; the server stores the first response for 24 h and replays it.\n'))
    s.say('ADR 0012 written in the 0007 shape: context, decision, consequences, and the rollout note.', 140)
    s.end()
    s.human('Add a section on key expiry and what happens on a hash mismatch.', 260_000)
    s.edit('docs/adr/0012-idempotency-keys.md', '## Consequences', '## Key expiry and mismatches\n\nKeys expire after 24 h. A reused key with a different request hash returns 422.\n\n## Consequences')
    s.bash('git add -A && git commit -m "docs(adr): 0012 idempotency keys"', '[main d2c91f0] docs(adr): 0012 idempotency keys', { ms: 480 })
    s.end()
    out.push(s.b)
  }
  {
    // webhook retries: two corrections, then green
    const s = new Story({ sessionId: sid(6), startAt: '2026-02-26T10:15:00.000Z', title: 'Add retries to the payment webhook handler' })
    s.human('Add exponential retries to the payment webhook handler in src/webhooks/payment.ts. Max 5 attempts.', 0)
    s.read('src/webhooks/payment.ts', 3_100)
    s.read('src/middleware/index.ts', 2_700)
    s.read('src/lib/redis.ts', 2_300)
    s.write('src/webhooks/retry.ts', filler(2_900, 'export const withRetry = (fn, attempts = 5) => async (...a) => { /* backoff 2^n * 200 ms */ }\n'))
    s.edit('src/webhooks/payment.ts', 'export const handler = async', 'export const handler = withRetry(async')
    s.bash('npm test -- webhooks', 'PASS 23 tests', { ms: 26_000 })
    s.say('Retries wrap the handler with 5 attempts and exponential backoff.', 120)
    s.end()
    s.human('No, retry only on 5xx and network errors. A 4xx must not be retried.', 190_000)
    s.read('src/webhooks/retry.ts', 2_900)
    s.write('src/webhooks/retry.ts', filler(3_000, 'export const withRetry = (fn, attempts = 5, retryable = (e) => e.status >= 500) => async (...a) => { /* ... */ }\n'))
    s.bash('npm test -- webhooks', 'FAIL src/webhooks/retry.test.ts\n  4xx was retried\n1 failed, 22 passed', { ms: 26_800, isError: true })
    s.edit('src/webhooks/retry.ts', 'e.status >= 500', "e.status >= 500 || e.code === 'ECONNRESET'")
    s.bash('npm test -- webhooks', 'PASS 23 tests', { ms: 25_900 })
    s.end()
    s.human("That's not it either: the backoff must be jittered or every replica retries in lockstep.", 170_000)
    s.edit('src/webhooks/retry.ts', 'const wait = 200 * 2 ** n', 'const wait = 200 * 2 ** n * (0.5 + Math.random())')
    s.bash('npm test -- webhooks', 'PASS 23 tests', { ms: 26_300 })
    s.bash('git add -A && git commit -m "feat(webhooks): jittered retries on 5xx and network errors"', '[main e51a9b2] feat(webhooks): jittered retries', { ms: 530 })
    s.end()
    out.push(s.b)
  }
  return out
}

/** Four sessions in the neighbouring repositories: the machine-wide scope shows more than one project. */
function buildOtherProjectSessions(): SessionBuilder[] {
  const out: SessionBuilder[] = []
  {
    const cwd = '/workspace/storefront-web'
    const s = new Story({ sessionId: 'a11ce000-0000-4000-8000-0000000000a1', startAt: '2026-02-11T13:20:00.000Z', title: 'Fix the cart badge count after checkout', cwd })
    s.human('The cart badge still shows the old count after a successful checkout. Fix it.', 0)
    s.grep('cartCount|badge', 61_000, `${cwd}/src`)
    for (const f of ['src/components/CartBadge.tsx', 'src/store/cart.ts', 'src/pages/checkout/success.tsx']) s.read(f, 3_100)
    s.edit('src/pages/checkout/success.tsx', 'router.push(\'/\')', 'cart.reset()\nrouter.push(\'/\')')
    s.bash('npx vitest run src/store', 'PASS 31 tests', { ms: 18_000 })
    s.bash('npm run typecheck', '', { ms: 14_200 })
    s.bash('git add -A && git commit -m "fix(cart): reset the badge after a successful checkout"', '[main 71ad0c3] fix(cart): reset the badge', { ms: 510 })
    s.end()
    out.push(s.b)
  }
  {
    const cwd = '/workspace/storefront-web'
    const s = new Story({ sessionId: 'a11ce000-0000-4000-8000-0000000000a2', startAt: '2026-02-20T09:05:00.000Z', title: 'Add the order history page', cwd })
    s.human('Add an order history page at /account/orders. Reuse the table component from /account/invoices.', 0)
    for (const f of ['src/pages/account/invoices.tsx', 'src/components/Table.tsx', 'src/api/orders.ts', 'src/pages/account/index.tsx']) s.read(f, 3_400)
    s.write('src/pages/account/orders.tsx', filler(4_600, 'export default function Orders() { return <Table rows={useOrders()} columns={columns} /> }\n'))
    s.write('src/pages/account/orders.test.tsx', filler(2_200, "it('lists the orders newest first', async () => { /* ... */ })\n"))
    s.bash('npx vitest run src/pages/account', 'FAIL src/pages/account/orders.test.tsx\n  expected 3 rows, received 0\n1 failed, 12 passed', { ms: 21_000, isError: true })
    s.read('src/api/orders.ts', 3_400)
    s.edit('src/pages/account/orders.tsx', 'useOrders()', 'useOrders({ limit: 50 })')
    s.bash('npx vitest run src/pages/account', 'PASS 13 tests', { ms: 20_400 })
    s.say('The page lists the last 50 orders in the invoices table layout.', 120)
    s.end()
    s.human('Also add a filter by status.', 300_000)
    s.read('src/pages/account/orders.tsx', 4_600)
    s.write('src/pages/account/orders.tsx', filler(4_900, 'export default function Orders() { const [status, setStatus] = useState<Status | undefined>(); return <Table rows={useOrders({ limit: 50, status })} columns={columns} /> }\n'))
    s.bash('npx vitest run src/pages/account', 'PASS 13 tests', { ms: 20_900 })
    s.bash('git add -A && git commit -m "feat(account): order history with a status filter"', '[main 9c02e4b] feat(account): order history', { ms: 520 })
    s.end()
    out.push(s.b)
  }
  {
    const cwd = '/workspace/platform-infra'
    const s = new Story({ sessionId: 'a11ce000-0000-4000-8000-0000000000a3', startAt: '2026-02-16T17:45:00.000Z', title: 'Why does the staging deploy take 25 minutes?', cwd })
    s.human('The staging deploy went from 8 to 25 minutes this week. Find out why.', 0)
    s.bash('gh run list --workflow deploy-staging.yml --limit 20 --json databaseId,conclusion,updatedAt', filler(5_800, '{"databaseId":1,"conclusion":"success","updatedAt":"2026-02-16T10:00:00Z"}\n'), { ms: 2_400 })
    for (let i = 0; i < 6; i++) s.bash(`gh run view 3321${i} --log`, filler(88_000, `deploy\tbuild image\t2026-02-16T10:0${i}:00Z step ${i}\n`), { ms: 6_200 + i * 300 })
    s.say('Every run since Tuesday spends 17 minutes in "build image": the layer cache is cold on every run.', 160)
    s.read('.github/workflows/deploy-staging.yml', 4_200)
    s.read('Dockerfile', 1_900)
    s.edit('.github/workflows/deploy-staging.yml', 'cache-from: type=gha', 'cache-from: type=gha,scope=staging\n          cache-to: type=gha,mode=max,scope=staging')
    s.bash('git add -A && git commit -m "ci(deploy): scope the image layer cache so it is warm across runs"', '[main 5e1f7aa] ci(deploy): scope the image layer cache', { ms: 480 })
    s.end()
    out.push(s.b)
  }
  {
    const cwd = '/workspace/platform-infra'
    const s = new Story({ sessionId: 'a11ce000-0000-4000-8000-0000000000a4', startAt: '2026-02-27T08:30:00.000Z', title: 'Rotate the staging database credentials', cwd })
    s.human('Rotate the staging database credentials and update every consumer. Do not touch production.', 0)
    s.grep('STAGING_DB_URL|staging-db', 47_000, cwd)
    for (const f of ['terraform/staging/db.tf', 'terraform/staging/secrets.tf', 'k8s/staging/api.yaml', 'k8s/staging/worker.yaml', 'docs/runbooks/rotate-db.md']) s.read(f, 2_600)
    s.call('AskUserQuestion', { questions: [{ question: 'Rotate in place (brief downtime) or dual-write with a second user for a day?', header: 'Rotation', options: [{ label: 'Dual user (Recommended)', description: 'no downtime, cleanup tomorrow' }, { label: 'In place', description: 'one restart, done today' }] }] }, 'Dual user.', { ms: 9 * 60_000 + 40_000, out: 180 })
    s.edit('terraform/staging/db.tf', 'resource "postgresql_role" "api"', 'resource "postgresql_role" "api_v2"')
    s.edit('terraform/staging/secrets.tf', 'staging_db_url_v1', 'staging_db_url_v2')
    s.bash('terraform -chdir=terraform/staging plan -out staging.plan', filler(24_000, 'Plan: 3 to add, 2 to change, 0 to destroy.\n'), { ms: 38_000 })
    s.bash('terraform -chdir=terraform/staging apply staging.plan', 'Apply complete! Resources: 3 added, 2 changed, 0 destroyed.', { ms: 71_000 })
    for (const f of ['k8s/staging/api.yaml', 'k8s/staging/worker.yaml']) s.edit(f, 'staging-db-url-v1', 'staging-db-url-v2')
    s.bash('kubectl -n staging rollout restart deploy/api deploy/worker && kubectl -n staging rollout status deploy/api', 'deployment "api" successfully rolled out', { ms: 64_000 })
    s.bash('git add -A && git commit -m "ops(staging): rotate the database credentials (dual user)"', '[main 0bb31de] ops(staging): rotate the database credentials', { ms: 500 })
    s.end()
    out.push(s.b)
  }
  return out
}

async function analyze(b: SessionBuilder, path: string): Promise<Analysis> {
  const session = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true, path })
  const analysis = analyzeSession(session, { version: 'sample', now: NOW })
  analysis.generator.generatedAt = NOW
  analysis.parse.parseMs = 0
  return analysis
}

/**
 * The published files only: swap the renderer's `noindex` for an indexable head with a description
 * and link-unfurl metadata, and add the no-script line. A user's own report keeps `noindex` and no
 * such metadata: it is opened by its author in a browser they control.
 */
function publish(html: string, o: { description: string; ogTitle: string; url: string; crossLink: { href: string; screen: string; label: string } }): string {
  const robots = '<meta name="robots" content="noindex"/>'
  const mount = '<div id="app" class="app"></div>'
  const close = html.lastIndexOf('</body>')
  if (!html.includes(robots) || !html.includes(mount) || close < 0) throw new Error('build-sample: report head, mount point or body end not found')
  const head = [
    '<meta name="robots" content="index,follow"/>',
    `<meta name="description" content="${o.description}"/>`,
    '<meta property="og:type" content="website"/>',
    '<meta property="og:site_name" content="orangu"/>',
    `<meta property="og:title" content="${o.ogTitle}"/>`,
    `<meta property="og:description" content="${o.description}"/>`,
    `<meta property="og:url" content="${o.url}"/>`,
    `<meta property="og:image" content="${SITE}assets/og.png"/>`,
    '<meta name="twitter:card" content="summary_large_image"/>',
    `<meta name="twitter:image" content="${SITE}assets/og.png"/>`,
  ].join('\n')
  // The one link between the two sample files lives outside the app mount (the client rerenders the
  // mount and ships no sample-specific bytes). The hash is the report's only carrier of theme and
  // audience, so the link copies both from the current hash on load and on every hash change.
  const xlink =
    `<a class="sample-xlink" id="sample-xlink" href="${o.crossLink.href}#${o.crossLink.screen}">${o.crossLink.label}</a>` +
    '<style>.sample-xlink{position:fixed;right:18px;bottom:18px;z-index:30;padding:9px 14px;border-radius:999px;background:var(--ink1);color:var(--bg);font:600 13px/1.2 var(--sans);text-decoration:none;box-shadow:0 6px 20px color-mix(in srgb,var(--ink1) 22%,transparent)}.sample-xlink:hover{background:var(--accent-ink)}@media (max-width:640px){.sample-xlink{right:12px;bottom:12px;padding:8px 12px;font-size:12px}}</style>' +
    `<script>(function(){var a=document.getElementById('sample-xlink');if(!a)return;var base='${o.crossLink.href}#${o.crossLink.screen}';function sync(){var h=location.hash,q=[],m;if((m=/[?&]audience=([^&]+)/.exec(h)))q.push('audience='+m[1]);if((m=/[?&]theme=([^&]+)/.exec(h)))q.push('theme='+m[1]);a.href=base+(q.length?'?'+q.join('&'):'')}sync();addEventListener('hashchange',sync)})()</script>`
  const withHead = html.slice(0, close) + xlink + html.slice(close)
  return withHead
    .replace(robots, head)
    .replace(mount, `${mount}<noscript><p style="max-width:640px;margin:48px auto;padding:0 24px;font-family:system-ui,sans-serif">This sample report is rendered by a script that ships inside this one file. Nothing is fetched from anywhere. Enable JavaScript for this page to read it.</p></noscript>`)
}

async function main(): Promise<void> {
  resetIds()
  const feature = await analyze(buildFeatureSession(), '/sample/checkout-api/feature.jsonl')
  const siblings: Analysis[] = []
  for (const [i, b] of buildSiblingSessions().entries()) siblings.push(await analyze(b, `/sample/checkout-api/session-${i + 1}.jsonl`))

  const others: Analysis[] = []
  for (const [i, b] of buildOtherProjectSessions().entries()) others.push(await analyze(b, `/sample/other/session-${i + 1}.jsonl`))

  const all = [feature, ...siblings].sort((a, b) => (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0))
  const agg = prepareAggregateForOutput(aggregate(all, 'repo checkout-api', NOW), { 'include-text': true })
  const everything = [...all, ...others].sort((a, b) => (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0))
  const globalAgg = prepareAggregateForOutput(aggregate(everything, 'global (1 root)', NOW), { 'include-text': true })

  // The session sample carries both aggregates beside the session: every scope chip on Suggestions and
  // both across-session screens have evidence, the way a serve session does, without a server.
  const session = renderReport(feature, { title: 'orangu · sample report: one Claude Code session', illustrative: true, aggregates: { repo: agg, global: globalAgg } })
  const sessionHtml = publish(session.html, {
    description: 'A synthetic Claude Code session, analysed by orangu: every tool call, subagent, test run, token and minute, and the ranked findings with a concrete fix for each.',
    ogTitle: 'orangu sample report: one Claude Code session, step by step',
    url: `${SITE}sample.html`,
    crossLink: { href: 'sample-repo.html', screen: 'repo', label: 'See the repository as its own file →' },
  })
  writeFileSync(join(ROOT, 'site/sample.html'), sessionHtml)

  const repo = renderAggregateReport(agg, { scope: 'repo', scopeLabel: agg.scope, includeText: true, illustrative: true, title: 'orangu · sample repository report: seven sessions' })
  const repoHtml = publish(repo.html, {
    description: 'Seven synthetic Claude Code sessions in one repository, aggregated by orangu: the findings that recur, the files read again and again, the one environment error every session hits.',
    ogTitle: 'orangu sample: recurring patterns across a repository',
    url: `${SITE}sample-repo.html`,
    crossLink: { href: 'sample.html', screen: 'overview', label: 'See one session step by step →' },
  })
  writeFileSync(join(ROOT, 'site/sample-repo.html'), repoHtml)

  if (process.env['SAMPLE_DEBUG']) {
    const turns = feature.turns.map((t) => `#${t.index} ${t.kind} ${Math.round(t.totalTokens / 1000)}k ${Math.round((t.durationMs ?? 0) / 1000)}s`).join(' | ')
    process.stderr.write(`turns: ${turns}\nsummary: ${JSON.stringify({ wallMs: feature.summary.wallMs, activeMs: feature.summary.activeMs, humanWaitMs: feature.summary.humanWaitMs, total: feature.summary.totalTokens, peak: feature.summary.contextPeak, outcomes: feature.summary.outcomes })}\n`)
    for (const i of feature.insights) process.stderr.write(`  ${i.severity.padEnd(6)} ${i.ruleId.padEnd(24)} ${i.title}${i.savings ? ` [save ${JSON.stringify(i.savings)}]` : ''}\n`)
  }
  const kb = (s: string) => Math.round(s.length / 1024)
  const fired = feature.insights.map((i) => `${i.ruleId}(${i.severity})`).join(', ')
  process.stdout.write(`built site/sample.html (${kb(sessionHtml)} KB) — ${feature.summary.turns} turns, ${feature.summary.toolCalls} calls, ${feature.summary.agents} agents, ${feature.summary.compactions} compaction\nrules fired: ${fired}\n`)
  process.stdout.write(`built site/sample-repo.html (${kb(repoHtml)} KB) — ${agg.sessionCount} sessions, ${agg.crossFindings.length} cross findings, ${agg.recurringErrors.length} recurring errors, ${agg.topReReadFiles.length} re-read files\n`)
  process.stdout.write(`embedded in sample.html: repo ${agg.sessionCount} sessions · global ${globalAgg.sessionCount} sessions across ${globalAgg.byProject.length} projects, ${globalAgg.crossFindings.length} cross findings\n`)
}

await main()
