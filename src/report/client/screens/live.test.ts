import { describe, expect, it, vi } from 'vitest'
import type { AppData, SessionSummaryRow } from '../../../model/app-data.js'
import type { Ctx } from '../app.js'
import { bannerFor, liveStateFor } from './live.js'

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
      expect(banner).not.toContain('Watching via orangu watch')
      expect(banner).not.toContain('in progress')
      expect(bannerFor('file', row(), undefined)).toContain('Watching via orangu watch')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
