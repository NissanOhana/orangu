/**
 * The offline gate (scripts/assert-offline.mjs) must go red for external references anywhere
 * in the document — including the <head> — and for a loosened CSP, not just a missing one.
 * The evil variants are built here from a real rendered report, never committed.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderReport } from '../src/report/render.js'
import { goldenAnalysis, GOLDEN_FIXTURES } from './fixtures/corpus.js'

const SCRIPT = join(process.cwd(), 'scripts', 'assert-offline.mjs')

function gate(html: string, name: string): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orangu-offline-'))
  const file = join(dir, name)
  writeFileSync(file, html)
  const r = spawnSync('node', [SCRIPT, '--file', file], { encoding: 'utf8' })
  return { status: r.status ?? -1, out: r.stdout + r.stderr }
}

let html = ''
beforeAll(async () => {
  const a = await goldenAnalysis(GOLDEN_FIXTURES[0]!)
  html = renderReport(a).html
})

describe('assert-offline gate', () => {
  it('passes a clean rendered report', () => {
    const r = gate(html, 'clean.html')
    expect(r.out).toContain('offline OK')
    expect(r.status).toBe(0)
  })

  it('fails on a font <link> injected into the <head>', () => {
    const evil = html.replace('</head>', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X"/></head>')
    expect(gate(evil, 'evil-link.html').status).not.toBe(0)
  })

  it('fails on a <script src> injected into the <head>', () => {
    const evil = html.replace('</head>', '<script src="https://evil.example.com/x.js"></script></head>')
    expect(gate(evil, 'evil-script.html').status).not.toBe(0)
  })

  it('fails when the CSP is loosened (default-src still present but style-src allows a remote origin)', () => {
    const loosened = html.replace(
      "style-src 'unsafe-inline'",
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
    )
    expect(loosened).not.toBe(html)
    expect(gate(loosened, 'loose-csp.html').status).not.toBe(0)
  })

  it('passes the published samples\' own link-unfurl metadata (the site origin only) and fails a foreign og:image', () => {
    const own = html.replace('</head>', '<meta property="og:image" content="https://nissanohana.github.io/orangu/assets/og.png"/></head>')
    expect(gate(own, 'own-unfurl.html').status).toBe(0)
    const foreign = html.replace('</head>', '<meta property="og:image" content="https://cdn.example.com/og.png"/></head>')
    expect(gate(foreign, 'foreign-unfurl.html').status).not.toBe(0)
    const link = html.replace('</head>', '<link rel="canonical" href="https://nissanohana.github.io/orangu/sample.html"/></head>')
    expect(gate(link, 'own-link.html').status).not.toBe(0)
  })

  it('still passes when inert user text (the <title>) mentions a URL', () => {
    const titled = html.replace(/<title>[^<]*<\/title>/, '<title>fix https://example.com bug</title>')
    expect(titled).not.toBe(html)
    expect(gate(titled, 'titled.html').status).toBe(0)
  })

  // The show-me files pin their one script by hash instead of 'unsafe-inline'. The gate accepts that form only
  // when every inline script matches a pinned hash, and only with the rest of the policy unchanged.
  describe('a CSP that pins its scripts by hash', () => {
    const script = 'document.title="pinned"'
    const hash = createHash('sha256').update(script, 'utf8').digest('base64')
    const page = (scriptSrc: string, body = `<script>${script}</script>`): string =>
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"/><title>t</title></head><body>${body}</body></html>`

    it('passes when each inline script matches a pinned hash', () => {
      const r = gate(page(`'sha256-${hash}'`), 'pinned.html')
      expect(r.out).toContain('offline OK')
      expect(r.status).toBe(0)
    })

    it('fails when an inline script is not pinned', () => {
      expect(gate(page(`'sha256-${hash}'`, `<script>${script}</script><script>alert(1)</script>`), 'unpinned.html').status).not.toBe(0)
    })

    it('fails when the hash form also allows inline script or another origin', () => {
      expect(gate(page(`'sha256-${hash}' 'unsafe-inline'`), 'both.html').status).not.toBe(0)
      expect(gate(page(`'sha256-${hash}' https://cdn.example.com`), 'origin.html').status).not.toBe(0)
    })
  })
})
