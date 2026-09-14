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
    schemaVersion: '2',
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
      hooks: [{ event: 'PreToolUse', configured: false, runs: 5, errors: 1, totalMs: 0, meanMs: 0, status: 'undeclared' }],
      // the row arrays above are capped at 50; these are the counts over the FULL population
      counts: { skills: { used: 1, idle: 84, undeclared: 1 }, agents: { used: 0, idle: 1, undeclared: 0 }, mcpServers: { used: 0, idle: 1, undeclared: 0 }, hooks: { used: 0, idle: 0, undeclared: 1 } },
      models: { seen: [], matchesConfigured: true },
      effort: { seen: [], slashEffortCommands: 0, matchesConfigured: true },
      permissions: { allowRules: 0, denyRules: 0, askRules: 0, promptEvents: 0, promptSessions: 0 },
      claudeMd: [{ file: '~/Code/demo/CLAUDE.md', bytes: 4000, approxTokens: 1000, reads: 12, sessions: 12, approxTokensCarried: 12_000 }],
      injectedListings: [{ type: 'skill_listing', main: { sessions: 12, injections: 12, bytes: 500_000, approxTokens: 125_000 }, subagent: { sessions: 3, injections: 40, bytes: 1_600_000, approxTokens: 400_000 }, approxTokensPerInjection: 10_096, approxTokensPerMainSession: 10_417 }],
    },
    retention: { effectiveDays: 30, isDefault: true, sweepable: { sessions: 12, bytes: 90_000 }, exempt: { sessions: 0, bytes: 0 }, oldestSweepableDays: 9, expiringSoon: { sessions: 0, bytes: 0, windowDays: 7 }, pastCutoff: { sessions: 0, bytes: 0 } },
    notes: ['~/.claude.json was not read, so client-side usage counters are omitted; the crosswalk uses session evidence only'],
    ...over,
  }
}

describe('renderHarness (A8, serve-only)', () => {
  it('leads with the idle-skill count and the heaviest injected listing, in tokens', () => {
    // 84, not 48: the headline counts the full population, not the 50 rows that survived the cap
    expect(harnessLead(report())).toEqual({ title: '84 of 85 skills never fired', sub: 'skill_listing ≈10,417 tokens per session in the main context' })
    renderHarness(ctx(), report())
    expect(markup).toContain('84 of 85 skills never fired')
    expect(markup).toContain('<span class="pill">hook PreToolUse</span>')
    expect(markup).toContain('anywhere in the tree')
    expect(markup).toContain('<span class="pill">idle-0</span>')
    expect(markup).toContain('+36 more')
    expect(markup).toContain('Idle MCP servers')
    expect(markup).toContain('<span class="pill">figma</span>')
    expect(markup).toContain('Agents never dispatched')
    expect(markup).toContain('skill ghost')
    expect(markup).not.toContain('never fired.')
    const allUsed = report({ crosswalk: { ...report().crosswalk, skills: [skill('used-one', 'used')], counts: { ...report().crosswalk.counts, skills: { used: 85, idle: 0, undeclared: 0 } } } })
    renderHarness(ctx(), allUsed)
    expect(markup).toContain('Every one of 85 skills fired.')
    expect(markup).toContain('10,417')
    // the subagent figure names its own population: its sessions are not the main-context sessions
    expect(markup).toContain('<th class="num">Subagent sessions</th>')
    expect(markup).toContain('<td class="num">400,000</td><td class="num">3</td>')
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
    expect(card).toContain('84 of 85 skills never fired')
    expect(card).toContain('skill_listing ≈10,417 tokens per session')
    const none = harnessCardHtml(report({ inventory: { ...report().inventory, claudeMd: [] }, crosswalk: { ...report().crosswalk, skills: [] } }), '#harness')
    expect(none).toContain('no harness config found')
    expect(none).toContain('href="#harness"')
  })

  it('the Overview card has a designed loading state while the report computes and a degraded one when it cannot', () => {
    const loading = harnessCardHtml(undefined, '#harness?s=abc')
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('href="#harness?s=abc"')
    expect(loading).toContain('Comparing what your config declares with what these sessions used…')
    expect(loading).toContain('open the harness view →')
    const failed = harnessCardHtml(null, '#harness?s=abc')
    expect(failed).not.toContain('aria-busy')
    expect(failed).toContain('The harness report could not be computed.')
    expect(failed).toContain('orangu harness prints the reason')
    for (const html of [loading, failed]) expect(html).toMatch(/^<a class="card pad mb16 harness-card"/)
  })
})
