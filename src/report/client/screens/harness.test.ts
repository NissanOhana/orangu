import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessReport } from '../../../harness/types.js'
import type { AppData } from '../../../model/app-data.js'
import type { Ctx } from '../app.js'
import { harnessCardHtml, harnessLead, renderHarness } from './harness.js'

let markup = ''

beforeEach(() => {
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => ({
      content: { firstElementChild: {} as HTMLElement },
      set innerHTML(value: string) { markup = value },
    }),
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

function ctx(): Ctx {
  const data = { v: '1', mode: 'serve', version: 'test', generatedAt: 0, capabilities: { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false }, sessions: [], aggregates: {}, suggestions: [] } as unknown as AppData
  return { data, ds: {} as Ctx['ds'], state: { screen: 'harness' }, audience: 'dev', go: vi.fn() }
}

const skill = (name: string, status: 'used' | 'idle' | 'undeclared') => ({ name, installed: status !== 'undeclared', invocations: status === 'used' ? 3 : 0, sessions: status === 'used' ? 2 : 0, viaTool: 0, viaCommand: 0, status })

function report(over: Partial<HarnessReport> = {}): HarnessReport {
  return {
    schemaVersion: '1',
    generator: { name: 'orangu', version: 'test', generatedAt: 0 },
    scope: { cwd: '~/Code/demo', roots: ['~/.claude'], global: false, limit: 200, sessionsScanned: 12, sessionsUnreadable: 0 },
    inventory: {
      claudeMd: [{ scope: 'repo', file: '~/Code/demo/CLAUDE.md', bytes: 4000, approxTokens: 1000, lines: 40, headings: 4 }],
      settings: [], skills: [], agents: [], plugins: [], mcpServers: [],
      totals: { filesRead: 3, bytesRead: 9000, claudeMdBytes: 4000, claudeMdApproxTokens: 1000, skills: 85, agents: 2, plugins: 1, mcpServers: 3, hookCommands: 0 },
      unreadable: [],
    },
    crosswalk: {
      window: {},
      skills: [skill('used-one', 'used'), ...Array.from({ length: 48 }, (_, i) => skill(`idle-${i}`, 'idle')), skill('ghost', 'undeclared')],
      mcpServers: [{ name: 'figma', configured: true, toolCalls: 0, distinctTools: 0, sessions: 0, status: 'idle' }],
      agents: [{ name: 'reviewer', defined: true, dispatches: 0, sessions: 0, models: [], status: 'idle' }],
      hooks: [],
      models: { seen: [], matchesConfigured: true },
      effort: { seen: [], slashEffortCommands: 0, matchesConfigured: true },
      permissions: { allowRules: 0, denyRules: 0, askRules: 0, promptEvents: 0, promptSessions: 0 },
      claudeMd: [{ file: '~/Code/demo/CLAUDE.md', bytes: 4000, approxTokens: 1000, reads: 12, sessions: 12, approxTokensCarried: 12_000 }],
      injectedListings: [{ type: 'skill_listing', sessions: 12, bytes: 500_000, approxTokens: 125_784, approxTokensPerSession: 10_482 }],
    },
    notes: ['~/.claude.json was not read, so client-side usage counters are omitted; the crosswalk uses session evidence only'],
    ...over,
  }
}

describe('renderHarness (A8, serve-only)', () => {
  it('leads with the idle-skill count and the heaviest injected listing, in tokens', () => {
    expect(harnessLead(report())).toEqual({ title: '48 of 85 skills never fired', sub: 'skill_listing ≈10,482 tokens per session, every session' })
    renderHarness(ctx(), report())
    expect(markup).toContain('48 of 85 skills never fired')
    expect(markup).toContain('<span class="pill">idle-0</span>')
    expect(markup).toContain('+36 more')
    expect(markup).toContain('Idle MCP servers')
    expect(markup).toContain('<span class="pill">figma</span>')
    expect(markup).toContain('Agents never dispatched')
    expect(markup).toContain('skill ghost')
    expect(markup).not.toContain('never fired.')
    const allUsed = report({ crosswalk: { ...report().crosswalk, skills: [skill('used-one', 'used')] } })
    renderHarness(ctx(), allUsed)
    expect(markup).toContain('Every one of 85 skills fired.')
    expect(markup).toContain('10,482')
    // the listings table scrolls inside its own container at 390 px (tools/repo/agents do the same)
    expect(markup).toContain('<div class="scroll-x"><table class="grid">')
    expect(markup).toContain('</table></div>')
    expect(markup).toContain('claude &quot;/orangu:harness --scope repo&quot;')
    expect(markup).toContain('usage counters are omitted')
    expect(markup).not.toMatch(/\$\d|USD|dollar|price|cost/i)
  })

  it('renders the designed empty state when the inventory declares nothing, and a degraded state without a report', () => {
    const empty = report({ inventory: { ...report().inventory, claudeMd: [], totals: { ...report().inventory.totals, skills: 0 } } })
    renderHarness(ctx(), empty)
    expect(markup).toContain('No harness config found under the scanned roots.')
    expect(markup).toContain('~/.claude')
    renderHarness(ctx(), null)
    expect(markup).toContain('could not be computed')
    expect(markup).toContain('data-copy="orangu harness"')
  })

  it('the Overview card is one honest line linking to #harness on the current session', () => {
    const card = harnessCardHtml(report(), '#harness?s=abc&audience=plain')
    expect(card).toContain('href="#harness?s=abc&amp;audience=plain"')
    expect(card).toContain('48 of 85 skills never fired')
    expect(card).toContain('skill_listing ≈10,482 tokens per session')
    const none = harnessCardHtml(report({ inventory: { ...report().inventory, claudeMd: [] }, crosswalk: { ...report().crosswalk, skills: [] } }), '#harness')
    expect(none).toContain('no harness config found')
    expect(none).toContain('href="#harness"')
  })
})
