/**
 * Offline gate as a unit test: the same regex list as scripts/assert-offline.mjs over the
 * rendered fixture body MINUS the embedded #orangu-data block (data may legitimately carry https:// PR links),
 * plus a scan of the raw client JS: the file-mode bundle must contain no network API text at all.
 */
import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { renderReport } from './render.js'
import { CLIENT_JS, CLIENT_JS_SERVE } from './generated/client-bundle.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'

const CHECKS: Array<[RegExp, string]> = [
  [/https?:\/\/(?!localhost|127\.0\.0\.1)/, 'external http(s) URL'],
  [/<link\b/i, '<link> tag'],
  [/<img[^>]+src\s*=\s*["']https?:/i, 'remote image'],
  [/@import\s+url/i, '@import url'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/new\s+WebSocket/, 'WebSocket'],
  [/<iframe/i, 'iframe'],
]

async function renderedHtml(): Promise<string> {
  const b = buildCanonicalSession()
  b.userPrompt('see the PR at https://github.com/example/repo/pull/1')
  b.assistant([{ type: 'text', text: 'done' }])
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  const a = analyzeSession(s, { version: 'test', now: 0 })
  return renderReport(a).html
}

function stripDataBlock(html: string): string {
  const start = html.indexOf('<script type="application/json" id="orangu-data">')
  const end = html.indexOf('</script>', start)
  return html.slice(0, start) + html.slice(end)
}

describe('offline report', () => {
  it('body (minus the data block) matches none of the assert-offline regexes', async () => {
    const html = await renderedHtml()
    const body = stripDataBlock(html).slice(html.indexOf('</head>'))
    for (const [re, label] of CHECKS) {
      const m = body.match(re)
      expect(m, `${label}: ${m?.[0]?.slice(0, 60)}`).toBeNull()
    }
    expect(html).toContain("default-src 'none'")
  })

  it('raw client JS contains no network API text (two-bundle rule, the design)', () => {
    expect(CLIENT_JS.length).toBeGreaterThan(0)
    expect(/\bfetch\s*\(/.test(CLIENT_JS), 'fetch(').toBe(false)
    expect(/EventSource/.test(CLIENT_JS), 'EventSource').toBe(false)
    expect(/XMLHttpRequest/.test(CLIENT_JS), 'XMLHttpRequest').toBe(false)
    expect(/new\s+WebSocket/.test(CLIENT_JS), 'WebSocket').toBe(false)
    expect(CLIENT_JS).not.toContain('github.com/NissanOhana/orangu/issues/new')
    expect(CLIENT_JS_SERVE).toContain('github.com/NissanOhana/orangu/issues/new')
  })

  it('client JS never says "finished" (possibly-live honesty) and stays inside its size ratchet', () => {
    expect(CLIENT_JS.includes('finished'), 'the string "finished"').toBe(false)
    // Budget history: design B2 budgeted 60 KB for 7 screens; the shipped client renders 10 and landed at 68 KB
    // after a shrink pass; 2026-08-27 Track 0 raised the cap to 72 KB to pay for four honesty fixes (B-tier token
    // formatting, the redaction placeholder note, the watch-gated Live banner, the outcome headline). Track A (A1)
    // removes the 6-tile KPI grid, the 10 signal chips and 5 of the "Follow the evidence" cards and MUST bring this
    // back under 70 KB; the cap may only go DOWN from there.
    expect(CLIENT_JS.length).toBeLessThanOrEqual(72 * 1024)
    expect(CLIENT_JS.length).toBe(73246)
  })
})
