import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppData, SessionSummaryRow } from '../../../model/app-data.js'
import type { Ctx } from '../app.js'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import { bannerFor, liveStateFor, renderLive } from './live.js'

function row(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return { id: 'abc12345-6789', projectSlug: 'demo', path: '/tmp/abc.jsonl', source: 'claude-code', sizeBytes: 1, mtimeMs: 0, badge: 'live', ageMs: 1000, possiblyLive: true, ...over }
}
function ctx(capabilities: Partial<AppData['capabilities']> = {}, mode: AppData['mode'] = 'file'): Ctx {
  const data = {
    v: '1', mode, version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: false, ...capabilities },
    sessions: [row()], aggregates: {}, suggestions: [],
  } as AppData
  return { data, ds: {} as Ctx['ds'], state: { screen: 'live' }, audience: 'dev', go: vi.fn() } as unknown as Ctx
}

describe('liveStateFor in file mode', () => {
  it('is a snapshot unless watch generated the file', () => {
    vi.stubGlobal('document', { getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }) })
    try {
      expect(liveStateFor(ctx(), row(), undefined)).toBe('snapshot')
      expect(liveStateFor(ctx({ watch: true }), row(), undefined)).toBe('file')
      const banner = bannerFor('snapshot', row(), undefined)
      expect(banner).toContain('does not update')
      expect(banner).not.toContain('Watching with orangu watch')
      expect(banner).not.toContain('in progress')
      expect(bannerFor('file', row(), undefined)).toContain('Watching with orangu watch')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// The Live screen never read the audience: a Plain reader saw "Cache hits", "Context window" and
// "compactions", three words the Plain map translates everywhere else.
describe('renderLive in the reader audience', () => {
  let markup = ''
  afterEach(() => {
    markup = ''
    vi.unstubAllGlobals()
  })

  async function render(audience: Ctx['audience']): Promise<string> {
    vi.stubGlobal('location', { hash: '' })
    vi.stubGlobal('document', {
      getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
      createElement: () => ({
        content: { firstElementChild: { querySelector: () => null } },
        set innerHTML(value: string) {
          markup = value
        },
      }),
    })
    const a = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }), { version: 'test', now: 0 })
    const c = ctx({ watch: true })
    renderLive({ ...c, a, audience, state: { screen: 'live', ...(audience === 'plain' ? { audience } : {}) } })
    return markup
  }

  it('keeps the Detailed words in Detailed', async () => {
    const html = await render('dev')
    expect(html).toContain('<div class="label">Cache hits</div>')
    expect(html).toContain('<span>Context window</span>')
    expect(html).toMatch(/\d+ compactions? so far/)
  })

  it('maps the cache, context window and compaction words in Plain', async () => {
    const html = await render('plain')
    expect(html).toContain('<div class="label">Reused context</div>')
    expect(html).toContain('<span>Working memory</span>')
    expect(html).toMatch(/\d+ memory refresh(?:es)? so far/)
    for (const word of ['Cache hits', 'Context window', 'compaction']) expect(html, word).not.toContain(word)
  })
})
