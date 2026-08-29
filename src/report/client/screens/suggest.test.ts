import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Analysis } from '../../../model/analysis.js'
import type { AppData, SuggestionViewRecord } from '../../../model/app-data.js'
import { suggestionIdV2, suggestionKey } from '../../../suggest/id.js'
import type { Ctx } from '../app.js'
import type { Aggregate } from '../../../analyze/aggregate.js'
import { megaReview } from '../mega-review.js'
import { findingForRow, planRows } from '../suggest-rows.js'
import { renderSuggest } from './suggest.js'

let markup = ''

beforeEach(() => {
  const root = { querySelectorAll: () => [] } as unknown as HTMLElement
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => ({
      content: { firstElementChild: root },
      set innerHTML(value: string) { markup = value },
    }),
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

const analysis = {
  session: { id: 'session-selected', cwd: '~/Code/demo' },
  summary: { totalTokens: 100_000 },
  insights: [{ id: 'ins-1', ruleId: 'reread-files', severity: 'medium', title: 'Re-read files', detail: 'Read twice', recommendation: 'Cache it', savings: { tokens: 25_000, estimated: true } }],
} as unknown as Analysis

function proposalRecord(id: string, over: Partial<SuggestionViewRecord> = {}): SuggestionViewRecord {
  return {
    id,
    v: 2,
    createdAt: 1,
    source: 'skill',
    scope: 'session',
    sessionIds: ['session-selected'],
    ruleId: 'imported-rule',
    title: 'Imported finding',
    evidence: { estimated: true },
    proposal: {
      v: 1,
      title: 'Bounded proposal',
      change: 'Update one instruction',
      effort: 'S',
      proposalPath: '/tmp/proposal.md',
      manifestPath: '/tmp/proposal.json',
      files: ['CLAUDE.md'],
      changeClass: 'instruction',
      workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
    },
    status: 'proposed',
    statusAt: 1,
    ...over,
  }
}

function context(mode: AppData['mode'], suggestions: SuggestionViewRecord[]): Ctx {
  const data: AppData = {
    v: '1', mode, version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: mode === 'serve', kickoffRun: false, exportHtml: true, includeText: false },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions,
  }
  return { data, a: analysis, ds: {} as Ctx['ds'], state: { screen: 'suggest', s: analysis.session.id }, audience: 'dev', go: vi.fn() }
}

describe('renderSuggest proposal UX', () => {
  it('renders a persisted localhost kickoff handoff after an SSE tree replacement', () => {
    const row = planRows('session', analysis, undefined)[0]!
    const id = suggestionIdV2(suggestionKey(findingForRow(row, 'session'), 'report'))
    const record: SuggestionViewRecord = {
      id,
      v: 2,
      createdAt: 1,
      source: 'report',
      scope: 'session',
      sessionIds: [analysis.session.id],
      ruleId: row.ruleId,
      title: row.title,
      insightId: row.insightId,
      evidence: { estimated: true },
      status: 'new',
      statusAt: 1,
    }

    renderSuggest(context('serve', [record]))

    expect(markup).toContain('<div class="sg-handoffs">')
    expect(markup).toContain(`data-copy="claude &quot;/orangu:improve ${id}&quot;"`)
    expect(markup).not.toContain(`data-copy="$orangu-improve ${id}"`)
    expect(markup).not.toContain('<span>Codex</span>')
  })

  it('uses proposal-only draft language and renders every structured field escaped', () => {
    const row = planRows('session', analysis, undefined)[0]!
    const id = suggestionIdV2(suggestionKey(findingForRow(row, 'session'), 'report'))
    const record = proposalRecord(id, {
      source: 'report', ruleId: row.ruleId, insightId: row.insightId,
      proposal: {
        v: 1,
        title: '<img src=x onerror=alert(1)>',
        change: 'Change <script>bad()</script>',
        effort: 'M',
        proposalPath: '/tmp/proposal.md',
        manifestPath: '/tmp/proposal.json',
        changeClass: 'instruction',
        evidence: 'Measured <b>twice</b>',
        expectedEffect: 'Fewer <calls>',
        risk: 'Could break "copy"',
        verification: 'Check next run',
        verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        files: ['CLAUDE.md', '<unsafe>', 'three', 'four', 'five', 'six', 'seven', 'eight'],
        sources: [{ kind: 'research', label: '<source>', url: 'https://example.test/?q=<x>', verifiedAt: '2026-08-26' }],
        workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
      },
      application: { v: 1, summary: 'Applied <once>', files: ['CLAUDE.md'], checks: [{ name: 'unit <test>', command: 'npm test', ok: true }], receiptPath: '/tmp/apply.json' },
    })

    renderSuggest(context('serve', [record]))

    expect(markup).toContain('Copy improve command')
    expect(markup).not.toContain('Draft proposal')
    expect(markup).not.toContain('Run locally')
    expect(markup).toContain('orangu:improve')
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(markup).toContain('Measured &lt;b&gt;twice&lt;/b&gt;')
    expect(markup).toContain('Applied &lt;once&gt;')
    expect(markup).toContain('Reviewed comparisons')
    expect(markup).toContain('avgToolCalls · decreased')
    expect(markup).toContain('+2 more')
    expect(markup).not.toContain('<li>seven</li>')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain(`data-copy="claude &quot;/orangu:apply ${id}&quot;"`)
    expect(markup).not.toContain(`data-copy="$orangu-apply ${id}"`)
    expect(markup).not.toContain('<span>Codex</span>')
    expect(markup).toContain('Copy only. Nothing runs here.')
  })

  it('renders verified as a distinct terminal chip and later-evidence receipt', () => {
    const base = proposalRecord('sg_0000000000ab')
    const record: SuggestionViewRecord = {
      ...base,
      status: 'verified',
      verificationTrust: 'computed-v1',
      verificationTrusted: true,
      proposal: { ...base.proposal!, verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }] },
      application: { v: 1, summary: 'Applied.', files: ['CLAUDE.md'], checks: [{ name: 'tests', ok: true }], receiptPath: '/tmp/applied.json' },
      verificationReceipt: {
        v: 1,
        summary: 'Later-session comparison passed: avgToolCalls decreased.',
        measuredSessionIds: ['later-session'],
        checks: [{ name: 'avgToolCalls decreased', metric: 'avgToolCalls', comparison: 'decreased', before: 8, after: 4, evidence: '<zero>', ok: true }],
        receiptPath: '/tmp/verify.json',
      },
      effect: { before: { avgToolCalls: 8 }, after: { avgToolCalls: 4 }, measuredSessionIds: ['later-session'] },
    }
    renderSuggest(context('serve', [record]))

    expect(markup).toContain('data-status="verified"')
    expect(markup).toContain('verified comparison ✓')
    expect(markup).toContain('Later-session comparison passed')
    expect(markup).toContain('&lt;zero&gt;')
    expect(markup).not.toContain(`/orangu:apply ${record.id}`)
  })

  it('never promotes a legacy persisted verified line to the current trust claim', () => {
    const record = proposalRecord('sg_0000000000bb', {
      status: 'verified',
      verificationReceipt: {
        v: 1,
        summary: 'Unvalidated legacy claim',
        measuredSessionIds: ['later-session'],
        checks: [{ name: 'claimed', metric: 'avgToolCalls', comparison: 'decreased', before: 8, after: 4, evidence: 'claimed', ok: true }],
        receiptPath: '/tmp/legacy.json',
      },
    })
    renderSuggest(context('serve', [record]))
    expect(markup).toContain('data-status="legacy"')
    expect(markup).toContain('legacy unverified')
    expect(markup).toContain('Not verified under the current deterministic contract.')
    expect(markup).not.toContain('Unvalidated legacy claim')
  })

  it('the footer speaks the user-facing vocabulary in every scope and never the internal one', () => {
    const foot = (): string => /<p class="small muted sg-foot">([^<]*)<\/p>/.exec(markup)?.[1] ?? ''
    const expected: Record<'session' | 'repo' | 'global', string> = {
      session: 'Only a later session in the same workspace can verify it.',
      repo: 'Applied means the reviewed files changed; only a later session can verify it.',
      global: 'Global suggestions stay proposals; nothing is applied from here.',
    }
    for (const scope of ['session', 'repo', 'global'] as const) {
      const ctx = context('serve', [])
      if (scope !== 'session') ctx.state.scope = scope
      renderSuggest(ctx)
      const text = foot()
      expect(text, scope).toBe(`The evidence is deterministic; an optional AI skill drafts the proposal. ${expected[scope]}`)
      for (const internal of ['catalog', 'cohort', 'handoff', 'stay deterministic']) expect(text, `${scope} says "${internal}"`).not.toContain(internal)
    }
  })

  it('shows only selected-session, unmapped proposals in the localhost inbox', () => {
    const saved = proposalRecord('sg_0000000000ac')
    const other = proposalRecord('sg_0000000000ad', { sessionIds: ['another-session'], proposal: { title: 'Wrong session', change: 'x', effort: 'S', proposalPath: '/tmp/other.md' } })
    renderSuggest(context('serve', [saved, other]))

    expect(markup).toContain('Saved proposals · 1')
    expect(markup).toContain('Bounded proposal')
    expect(markup).not.toContain('Wrong session')
  })

  it('never renders the persisted-store inbox in a file report', () => {
    renderSuggest(context('file', [proposalRecord('sg_0000000000ae')]))
    expect(markup).not.toContain('Localhost only')
    expect(markup).not.toContain('Saved proposals')
    expect(markup).not.toContain('$orangu-apply')
  })

  // A4: the screen explains its own handoff instead of ending at a bare button.
  it('renders the empty inbox on localhost so the third step has somewhere to point', () => {
    renderSuggest(context('serve', []))
    expect(markup).toContain('Saved proposals · 0')
    expect(markup).toContain('Nothing yet.')
    expect(markup).toContain('The proposal appears below under Saved proposals.')
  })

  it('walks the handoff in three steps with the workspace, and puts the one-time plugin install inside step 2 (M5)', () => {
    renderSuggest(context('file', []))
    expect(markup).toContain('aria-label="Hand off to Claude Code"')
    expect(markup).toContain('Copy improve command')
    expect(markup).toContain('<span>Paste it in Claude Code in <span class="mono">~/Code/demo</span>.</span>')
    expect(markup).toContain('open orangu serve to review it')
    expect(markup).toContain('/plugin marketplace add NissanOhana/orangu')
    expect(markup).toContain('/plugin install orangu')
    expect(markup).toContain('<span class="p" aria-hidden="true">&gt;</span>')
    // the install line sits between step 2's sentence and step 3, as the CLI prints it under the next step
    const step2 = markup.indexOf('Paste it in Claude Code in')
    const install = markup.indexOf('/plugin install orangu')
    const step3 = markup.indexOf('open orangu serve to review it')
    expect(step2).toBeLessThan(install)
    expect(install).toBeLessThan(step3)
    expect(markup).toContain('Needs the plugin once, typed inside Claude Code:')
    expect(markup).not.toContain('First time?')
  })

  it('shows a severity dot and the savings as a share of the session; no taxonomy chips, no "effort –", no queued chip', () => {
    renderSuggest(context('file', []))
    expect(markup).toContain('<span class="sev medium" title="medium"></span>')
    expect(markup).toContain('~25% of this session')
    expect(markup).toContain('title="≈25.0k tokens of the 100k this session measured; estimated by rule reread-files"')
    // the taxonomy no longer leads the screen; it is explanatory copy under the collapsed trailing note
    expect(markup).not.toContain('Measured → matched → proposed')
    expect(markup).toContain('What a proposal can change')
    expect(markup.indexOf('sg-note')).toBeGreaterThan(0)
    expect(markup.indexOf('sigchip')).toBeGreaterThan(markup.indexOf('sg-note'))
    expect(markup).not.toContain('effort –')
    expect(markup).not.toContain('queued')
    // the change class still shows where one exists: on a proposal
    const row = planRows('session', analysis, undefined)[0]!
    const id = suggestionIdV2(suggestionKey(findingForRow(row, 'session'), 'report'))
    renderSuggest(context('serve', [proposalRecord(id, { source: 'report', ruleId: row.ruleId, insightId: row.insightId })]))
    expect(markup).toContain('<span class="pill">instruction</span>')
    expect(markup).toContain('<span class="pill">effort S</span>')
  })

  it('does not offer apply for an unstructured legacy proposal', () => {
    renderSuggest(context('serve', [proposalRecord('sg_0000000000af', {
      proposal: { title: 'Legacy proposal', change: 'Do it', effort: 'S', proposalPath: '/tmp/legacy.md' },
    })]))
    expect(markup).toContain('Legacy proposal')
    expect(markup).not.toContain('/orangu:apply')
    expect(markup).not.toContain('$orangu-apply')
  })
})

/**
 * The scope screens are the whole-harness entry point: the block that runs the review must be the
 * first thing on them (AC21), and the action the user came for is a primary control, not a 12 px
 * outline button (AC23). Both are position/class facts in the rendered markup.
 */
describe('renderSuggest on a repo/global scope', () => {
  const crossFinding = {
    ruleId: 'reread-files',
    title: 'e.g. Read the same file 6 times',
    sessions: 3,
    totalSavingsTokens: 30_000,
    totalSavingsMs: 0,
    boundedSavingsTokens: 24_000,
    boundedSavingsMs: 0,
    axis: 'tokens',
    severity: 'medium',
    exampleSessionIds: ['session-a', 'session-b'],
  }

  function scopeContext(scope: 'repo' | 'global', findings = [crossFinding]): Ctx {
    const agg = {
      schemaVersion: '2', generatedAt: 0, scope, sessionCount: 3,
      sessions: [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }],
      crossFindings: findings,
    } as unknown as Aggregate
    const data: AppData = {
      v: '1', mode: 'file', version: 'test', generatedAt: 0,
      capabilities: { live: false, aggregates: true, kickoffRun: false, exportHtml: true, includeText: false },
      selectedId: undefined, session: undefined, sessions: [], aggregates: { [scope]: agg }, suggestions: [],
    }
    return { data, ds: {} as Ctx['ds'], state: { screen: 'suggest', scope }, audience: 'dev', megaReview, go: vi.fn() }
  }

  it.each(['repo', 'global'] as const)('puts the whole-harness block above the first finding (%s)', (scope) => {
    renderSuggest(scopeContext(scope))
    const block = markup.indexOf('Whole-harness review')
    const firstFinding = markup.indexOf('<details class="finding"')
    expect(block).toBeGreaterThan(-1)
    expect(firstFinding).toBeGreaterThan(-1)
    expect(block).toBeLessThan(firstFinding)
    expect(markup.indexOf('<div class="chiprow">')).toBeLessThan(block)
  })

  it('keeps the block when the scope has no findings, because the review reads config too', () => {
    renderSuggest(scopeContext('repo', []))
    expect(markup).toContain('Whole-harness review')
    expect(markup).toContain('Nothing to improve was found')
    expect(markup.indexOf('Whole-harness review')).toBeLessThan(markup.indexOf('Nothing to improve was found'))
  })

  it('drops the block when the scope has no aggregate: the block would claim a harness it cannot see', () => {
    const ctx = scopeContext('repo')
    ctx.data.aggregates = {}
    renderSuggest(ctx)
    expect(markup).not.toContain('Whole-harness review')
    expect(markup).toContain('This scope needs orangu serve')
  })

  it('makes the per-finding copy control a primary CTA, not a small outline button', () => {
    renderSuggest(scopeContext('repo'))
    expect(markup).toContain('<button type="button" class="btn-primary" data-kick-copy=')
    expect(markup).not.toContain('class="btn-sm" data-kick-copy=')
  })
})
