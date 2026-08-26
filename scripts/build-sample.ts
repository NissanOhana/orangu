/**
 * Builds `site/sample.html` — the public sample report linked from the landing page.
 *
 * The session it renders is SYNTHETIC: it is composed here with the same fixture builder the tests
 * use, so no real transcript, path, prompt or secret can ever reach the published site. The rules
 * that fire on it are the real shipped rules; the numbers are the real arithmetic over made-up input.
 *
 * Deterministic: fixed ids (`resetIds`) + a fixed clock, so the file changes only when the report
 * code changes, never merely because it was rebuilt.
 *
 *   npx tsx scripts/build-sample.ts        (npm run build:sample)
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SessionBuilder, resetIds } from '../test/fixtures/session-builder.js'
import { parseClaudeCodeSession } from '../src/adapters/claude-code/parse.js'
import { analyzeSession } from '../src/analyze/analyze.js'
import { renderReport } from '../src/report/render.js'

/** 2026-03-02T09:00:00Z — a fixed "now" so the rendered bytes are stable across rebuilds. */
const NOW = Date.parse('2026-03-02T12:40:00.000Z')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SRC = '/workspace/checkout-api'

/** A believable feature session: read → plan → fan out → build → verify, with the usual waste. */
function buildSampleSession(): SessionBuilder {
  const b = new SessionBuilder({
    sessionId: '5a91c73e-0000-4000-8000-00000000d0c5',
    startAt: '2026-03-02T09:00:00.000Z',
    cwd: SRC,
  })
  b.meta('mode', { mode: 'normal' })
  b.meta('permission-mode', { permissionMode: 'default' })
  b.meta('custom-title', { customTitle: 'Add rate limiting to the checkout API' })
  b.attachmentHook('SessionStart:startup', 'SessionStart')

  // ── turn 1: orient ────────────────────────────────────────────────────────────
  b.userPrompt('Add rate limiting to the checkout API. Follow the middleware pattern we already use.')
  b.tick(1_400)
  b.assistant([{ type: 'thinking', thinking: 'Read the existing middleware first.' }, { type: 'text', text: 'Reading the middleware layer.' }], {
    usage: { input_tokens: 6, cache_creation_input_tokens: 28_400, cache_read_input_tokens: 0, output_tokens: 96 },
  })
  for (const f of ['middleware/auth.ts', 'middleware/index.ts', 'routes/checkout.ts']) {
    b.tick(180)
    b.toolCall('Read', { file_path: `${SRC}/src/${f}` }, `1\t// ${f}\n2\texport default handler\n`, {
      durationMs: 90,
      usage: { input_tokens: 8, cache_read_input_tokens: 28_400, output_tokens: 48 },
    })
  }
  // an unscoped grep: the classic oversized result that rides along for the rest of the session
  b.tick(240)
  b.toolCall('Grep', { pattern: 'rateLimit', path: SRC }, 'x'.repeat(148_000), {
    durationMs: 2_100,
    usage: { input_tokens: 10, cache_read_input_tokens: 30_100, output_tokens: 60 },
  })
  b.turnDuration(9_800, 6)

  // ── turn 2: fan out ───────────────────────────────────────────────────────────
  b.tick(2_600)
  b.userPrompt('Look at how the other services do it before you write anything.')
  b.tick(900)
  b.assistant([{ type: 'text', text: 'Fanning out three readers over the neighbouring services.' }], {
    usage: { input_tokens: 12, cache_read_input_tokens: 46_800, output_tokens: 180 },
  })
  for (let i = 0; i < 3; i++) {
    const agentId = `smp${i}00000000000`.slice(0, 16)
    b.toolCall(
      'Agent',
      { description: `survey service ${i}`, prompt: `How does service ${i} rate-limit?`, subagent_type: 'general-purpose' },
      `service ${i}: token bucket in middleware`,
      {
        durationMs: 21_000 + i * 1_500,
        usage: { input_tokens: 9, cache_read_input_tokens: 47_000 + i, output_tokens: 70 },
        toolUseResult: { status: 'completed', agentId, content: [{ type: 'text', text: `service ${i}` }], totalDurationMs: 21_000, totalTokens: 41_000 + i * 900, totalToolUseCount: 4 },
      },
    )
    b.sidechain(agentId)
    b.tick(150)
    b.userPrompt(`How does service ${i} rate-limit?`)
    b.tick(600)
    b.assistant([{ type: 'text', text: 'Reading the service.' }], { model: 'claude-sonnet-5', usage: { input_tokens: 700, cache_read_input_tokens: 18_400, output_tokens: 55 } })
    b.toolCall('Read', { file_path: `${SRC}/../svc-${i}/src/middleware/limit.ts` }, 'token bucket, 60 rpm', {
      durationMs: 110,
      usage: { input_tokens: 720, cache_read_input_tokens: 18_900, output_tokens: 40 },
    })
    b.assistant([{ type: 'text', text: `service ${i}: token bucket, 60 rpm` }], { model: 'claude-sonnet-5', usage: { input_tokens: 760, cache_read_input_tokens: 19_100, output_tokens: 48 } })
    b.sidechain('', false)
  }
  b.turnDuration(64_000, 9)

  // ── turn 3: build, with the re-reads and the repeated verify loop ──────────────
  b.tick(3_100)
  b.userPrompt('Good. Implement it with the token bucket, 120 rpm, and wire it into checkout only.')
  b.tick(1_100)
  b.assistant([{ type: 'text', text: 'Writing the middleware and wiring it in.' }], {
    usage: { input_tokens: 14, cache_read_input_tokens: 71_200, output_tokens: 240 },
  })
  b.toolCall('Write', { file_path: `${SRC}/src/middleware/rate-limit.ts`, content: 'export const rateLimit = () => {}\n'.repeat(240) }, 'File created', {
    durationMs: 160,
    usage: { input_tokens: 16, cache_read_input_tokens: 72_000, output_tokens: 5_200 },
  })
  // the same three files, read again in the same context — the re-read tax
  for (const f of ['middleware/index.ts', 'routes/checkout.ts', 'middleware/auth.ts']) {
    b.tick(120)
    b.toolCall('Read', { file_path: `${SRC}/src/${f}` }, `1\t// ${f}\n2\texport default handler\n`, {
      durationMs: 85,
      usage: { input_tokens: 9, cache_read_input_tokens: 74_500, output_tokens: 44 },
    })
  }
  // one more look at the index before editing it — the third read of the same file in one context
  b.tick(130)
  b.toolCall('Read', { file_path: `${SRC}/src/middleware/index.ts` }, '1\t// middleware/index.ts\n2\texport default handler\n', {
    durationMs: 80,
    usage: { input_tokens: 9, cache_read_input_tokens: 75_400, output_tokens: 44 },
  })
  b.toolCall('Edit', { file_path: `${SRC}/src/middleware/index.ts`, old_string: 'export { auth }', new_string: 'export { auth }\nexport { rateLimit }' }, 'The file has been updated.', {
    durationMs: 95,
    usage: { input_tokens: 11, cache_read_input_tokens: 76_100, output_tokens: 120 },
  })
  // the verify loop: the same command, four times, with a failure in the middle
  for (let i = 0; i < 4; i++) {
    b.tick(400)
    b.toolCall('Bash', { command: 'npm test -- checkout' }, i === 1 ? 'FAIL src/checkout.test.ts (1 failed)' : 'PASS 42 tests', {
      durationMs: 32_000,
      isError: i === 1,
      usage: { input_tokens: 12, cache_read_input_tokens: 78_000 + i * 400, output_tokens: 90 },
    })
    if (i === 1) {
      b.toolCall('Edit', { file_path: `${SRC}/src/middleware/rate-limit.ts`, old_string: 'window = 60', new_string: 'window = 120' }, 'The file has been updated.', {
        durationMs: 88,
        usage: { input_tokens: 10, cache_read_input_tokens: 79_000, output_tokens: 110 },
      })
    }
  }
  b.assistant([{ type: 'text', text: 'Tests pass. Rate limiting is wired into the checkout route only.' }], {
    usage: { input_tokens: 18, cache_read_input_tokens: 84_600, output_tokens: 210 },
  })
  b.turnDuration(186_000, 14)
  b.stopHookSummary([{ command: 'npm run lint', durationMs: 2_400 }])
  return b
}

async function main(): Promise<void> {
  resetIds()
  const b = buildSampleSession()
  const session = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true, path: '/sample/checkout-api.jsonl' })
  const analysis = analyzeSession(session, { version: 'sample', now: NOW })
  analysis.generator.generatedAt = NOW
  analysis.parse.parseMs = 0
  const { html } = renderReport(analysis, { title: 'orangu · sample report', illustrative: true })
  const out = join(ROOT, 'site/sample.html')
  writeFileSync(out, html)
  const kb = Math.round(html.length / 1024)
  const insights = analysis.insights.map((i) => i.ruleId).join(', ')
  process.stdout.write(`built site/sample.html (${kb} KB) — ${analysis.summary.turns} turns, ${analysis.summary.toolCalls} calls, ${analysis.summary.agents} agents\nrules fired: ${insights}\n`)
}

await main()
