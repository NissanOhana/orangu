import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { BRAND_ICON_ID } from './brand.js'
import { renderReport, renderShell, safeJson } from './render.js'
import { buildCanonicalSession, SessionBuilder } from '../../test/fixtures/session-builder.js'

const CURRENT_BRAND_BYTES = readFileSync(new URL('../../design/brand/mascot-96.png', import.meta.url))
const CURRENT_BRAND_DATA_URI = `data:image/png;base64,${CURRENT_BRAND_BYTES.toString('base64')}`

async function report(extra?: (b: SessionBuilder) => void) {
  const b = buildCanonicalSession()
  if (extra) extra(b)
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  const a = analyzeSession(s, { version: 'test', now: 0 })
  return renderReport(a)
}

describe('renderReport', () => {
  it('produces a self-contained HTML document with inlined CSS and JS', async () => {
    const { html } = await report()
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('id="orangu-data"')
    expect(html).toContain('window.__ORANGU__')
  })

  it('makes NO external network references (CDN, font, image, fetch, link, import)', async () => {
    const { html } = await report()
    // allow file:// paths and the CSP meta; forbid real remote origins and network APIs
    const body = html.slice(html.indexOf('</head>'))
    expect(/https?:\/\/(?!localhost)/.test(body)).toBe(false)
    expect(/<link\b/i.test(html)).toBe(false)
    expect(/<img[^>]+src\s*=\s*["']https?:/i.test(html)).toBe(false)
    expect(/@import/i.test(html)).toBe(false)
    expect(/\bfetch\s*\(/.test(html)).toBe(false)
    expect(/XMLHttpRequest/.test(html)).toBe(false)
    expect(/new\s+WebSocket/.test(html)).toBe(false)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
  })

  it('escapes transcript content so a </script> in a tool result cannot break out', async () => {
    const { html } = await report((b) => {
      b.userPrompt('render this: </script><script>alert(1)</script> and <img src=x onerror=alert(2)>')
      b.toolCall('Bash', { command: 'echo "</script><script>alert(3)</script>"' }, '</script><script>alert(4)</script>')
      b.assistant([{ type: 'text', text: 'done' }])
    })
    const dataStart = html.indexOf('id="orangu-data">') + 'id="orangu-data">'.length
    const dataEnd = html.indexOf('</script>', dataStart)
    const dataBlock = html.slice(dataStart, dataEnd)
    // the data block itself must contain no literal '<' — all escaped to <
    expect(dataBlock.includes('<')).toBe(false)
    expect(dataBlock.includes('\\u003c')).toBe(true)
    // and there must be exactly the structural </script> tags, none injected by data
    expect(html.split('</script>').length).toBe(5) // favicon injector + data block close + 2 script closes + trailing
  })

  it('safeJson escapes angle brackets and line separators', () => {
    const out = safeJson({ a: '</script>', b: 'x' })
    expect(out.includes('</script>')).toBe(false)
    expect(out).toContain('\\u003c')
    expect(out).toContain('\\u003e')
  })

  it('embeds AppData v1 in file mode with the analysis and one session row', async () => {
    const { html } = await report()
    const dataStart = html.indexOf('id="orangu-data">') + 'id="orangu-data">'.length
    const dataEnd = html.indexOf('</script>', dataStart)
    const data = JSON.parse(html.slice(dataStart, dataEnd))
    expect(data.v).toBe('1')
    expect(data.mode).toBe('file')
    expect(data.session.schemaVersion).toBeDefined()
    expect(data.selectedId).toBe(data.session.session.id)
    expect(data.sessions).toHaveLength(1)
    expect(['live', 'idle', 'ended']).toContain(data.sessions[0].badge)
    expect(data.sessions[0].id).toBe(data.session.session.id)
    expect(data.aggregates).toEqual({})
    expect(data.suggestions).toEqual([])
    expect(data.capabilities).toEqual({ live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: true })
    expect(data.illustrative).toBeUndefined()
  })

  it('carries an explicit illustrative marker only when the renderer requests it', async () => {
    const b = buildCanonicalSession()
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    const a = analyzeSession(s, { version: 'sample', now: 0 })
    const { html } = renderReport(a, { illustrative: true })
    const dataStart = html.indexOf('id="orangu-data">') + 'id="orangu-data">'.length
    const data = JSON.parse(html.slice(dataStart, html.indexOf('</script>', dataStart)))
    expect(data.illustrative).toBe(true)
  })

  it('loads no web fonts (policy): no <link>, no fonts.googleapis anywhere', async () => {
    const { html } = await report()
    expect(/<link\b/i.test(html)).toBe(false)
    expect(html.includes('fonts.googleapis')).toBe(false)
    expect(html.includes('fonts.gstatic')).toBe(false)
  })

  it('carries the current brand image for both the favicon and client mascots without network access', async () => {
    const { html } = await report()
    const head = html.slice(0, html.indexOf('</head>'))
    // DOM-injected (no literal <link> tag — the offline gate forbids that text); data: makes no request
    expect(head).toContain('rel="icon"')
    expect(head).toContain(`l.id="${BRAND_ICON_ID}"`)
    expect(head).toContain(CURRENT_BRAND_DATA_URI)
    // One 96px payload serves both the favicon and every client mascot; no duplicate image enters the HTML.
    expect(html.includes('apple-touch-icon')).toBe(false)
    expect(html.split(CURRENT_BRAND_DATA_URI)).toHaveLength(2)
    const b64 = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(head)?.[1] ?? ''
    expect(b64.length).toBeGreaterThan(8 * 1024)
    expect(b64.length).toBeLessThan(40 * 1024)
    expect(CURRENT_BRAND_BYTES.subarray(1, 4).toString()).toBe('PNG')
    expect(CURRENT_BRAND_BYTES.readUInt32BE(16)).toBe(96)
    expect(CURRENT_BRAND_BYTES.readUInt32BE(20)).toBe(96)
  })

  it('redacts secrets in previews by default', async () => {
    const { html, redaction } = await report((b) => {
      b.userPrompt('my key is sk-ant-abc123def456ghi789jkl and email me@example.com')
      b.assistant([{ type: 'text', text: 'ok' }])
    })
    expect(redaction!.applied).toBeGreaterThan(0)
    expect(html.includes('sk-ant-abc123def456ghi789jkl')).toBe(false)
    expect(html.includes('me@example.com')).toBe(false)
  })

  it('builds the <title> from the redacted data, never the raw analysis', async () => {
    const { html } = await report((b) => {
      b.meta('custom-title', { customTitle: 'deploy with sk-ant-abc123def456ghi789jkl' })
      b.userPrompt('hi')
      b.assistant([{ type: 'text', text: 'ok' }])
    })
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ''
    expect(title.includes('sk-ant-abc123def456ghi789jkl')).toBe(false)
  })

  it('can disable redaction', async () => {
    const b = buildCanonicalSession()
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    const a = analyzeSession(s)
    const { redaction } = renderReport(a, { redact: false })
    expect(redaction).toBeUndefined()
  })
})

describe('renderShell (serve app shell)', () => {
  it('has a CSP with connect-src self, the serve bootstrap, and no embedded AppData', () => {
    const html = renderShell({ version: '0.0.0-test', capabilities: { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false }, maxLive: 8, feedback: { version: '0.0.0-test', nodeMajor: '22', osFamily: 'Linux', arch: 'x64', surface: 'localhost' } })
    expect(html).toContain("connect-src 'self'")
    expect(html).toContain('__ORANGU_SERVE__')
    expect(html).toContain('"maxLive":8')
    const boot = JSON.parse(/window\.__ORANGU_SERVE__=(.*?);<\/script>/.exec(html)?.[1] ?? '{}')
    expect(boot.feedback).toEqual({ version: '0.0.0-test', nodeMajor: '22', osFamily: 'Linux', arch: 'x64', surface: 'localhost' })
    expect(html).not.toContain('id="orangu-data"')
    expect(html).not.toContain('fonts.googleapis')
  })

  it('carries the same marked current-brand image as the file report', () => {
    const html = renderShell({ version: '0.0.0-test', capabilities: { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false }, maxLive: 8, feedback: { version: '0.0.0-test', nodeMajor: '22', osFamily: 'Linux', arch: 'x64', surface: 'localhost' } })
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toContain('rel="icon"')
    expect(head).toContain(`l.id="${BRAND_ICON_ID}"`)
    expect(head).toContain(CURRENT_BRAND_DATA_URI)
    expect(html.split(CURRENT_BRAND_DATA_URI)).toHaveLength(2)
    expect(/<link\b/i.test(html)).toBe(false)
  })
})
