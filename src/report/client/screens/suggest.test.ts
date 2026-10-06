import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Analysis } from '../../../model/analysis.js'
import type { AppData, SuggestionViewRecord } from '../../../model/app-data.js'
import { suggestionIdV2, suggestionKey } from '../../../suggest/id.js'
import type { Ctx } from '../app.js'
import type { Aggregate } from '../../../analyze/aggregate.js'
import { megaReview } from '../mega-review.js'
import { proposalsUi } from '../proposals-ui.js'
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

/** The served app: serve-entry.ts injects serve-ui.ts, whose ServeUi.proposals reaches the screen as Ctx.proposals. */
function serveContext(suggestions: SuggestionViewRecord[]): Ctx {
  return { ...context('serve', suggestions), proposals: proposalsUi }
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

    renderSuggest(serveContext([record]))

    expect(markup).toContain('Copy the Claude Code command')
    expect(markup).not.toContain('Draft proposal')
    expect(markup).not.toContain('Run locally')
    // the status chip stays; the "handled by orangu:improve" row that named the skill left the card
    expect(markup).toContain('data-status="proposed"')
    expect(markup).not.toContain('handled by')
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
    renderSuggest(serveContext([record]))

    expect(markup).toContain('data-status="verified"')
    expect(markup).toContain('verified comparison ✓')
    expect(markup).toContain('Later-session comparison passed')
    expect(markup).toContain('&lt;zero&gt;')
    expect(markup).not.toContain(`/orangu:apply ${record.id}`)
  })

  it('renders a noise-checked cohort receipt with its summary and graded comparisons', () => {
    const base = proposalRecord('sg_0000000000ae')
    const record: SuggestionViewRecord = {
      ...base,
      status: 'verified',
      verificationTrust: 'computed-v2',
      verificationTrusted: true,
      appliedAt: 5,
      proposal: { ...base.proposal!, verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }] },
      application: { v: 1, summary: 'Applied.', files: ['CLAUDE.md'], checks: [{ name: 'tests', ok: true }], receiptPath: '/tmp/applied.json' },
      verificationReceipt: {
        v: 2,
        method: 'cohort-rank-v1',
        alpha: 0.05,
        appliedAt: 5,
        summary: 'Later sessions beat the baseline beyond chance (3 before, 3 after, p ≤ 0.05): avgToolCalls decreased.',
        baselineSessionIds: ['b1', 'b2', 'b3'],
        measuredSessionIds: ['l1', 'l2', 'l3'],
        confoundedBy: [],
        checks: [{
          metric: 'avgToolCalls', comparison: 'decreased', name: 'avgToolCalls decreased', before: 12, after: 8, beforeMedian: 12, afterMedian: 8,
          pLower: 0.05, pHigher: 1, verdict: 'improved', evidence: 'avgToolCalls: 12 → 8 (median 12 → 8; exact rank test p=0.05; improved)', ok: true,
        }],
      },
      effect: { before: { avgToolCalls: 12 }, after: { avgToolCalls: 8 }, measuredSessionIds: ['l1', 'l2', 'l3'] },
    }
    renderSuggest(serveContext([record]))
    expect(markup).toContain('data-status="verified"')
    expect(markup).toContain('verified comparison ✓')
    expect(markup).not.toContain('Not verified under the current deterministic contract.')
    expect(markup).toContain('Later sessions beat the baseline beyond chance (3 before, 3 after, p ≤ 0.05)')
    expect(markup).toContain('exact rank test p=0.05; improved')
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
    renderSuggest(serveContext([record]))
    expect(markup).toContain('data-status="legacy"')
    expect(markup).toContain('legacy unverified')
    expect(markup).toContain('Not verified under the current deterministic contract.')
    expect(markup).not.toContain('Unvalidated legacy claim')
  })

  it('the footer speaks the user-facing vocabulary in every scope and never the internal one', () => {
    const foot = (): string => /<p class="small muted sg-foot">([^<]*)<\/p>/.exec(markup)?.[1] ?? ''
    const expected: Record<'session' | 'repo' | 'global', string> = {
      session: 'Only later sessions in the same workspace can verify it.',
      repo: 'Applied means that the reviewed files changed. Only later sessions can verify it.',
      global: 'Global proposals stay proposals. Claude applies nothing from here.',
    }
    for (const scope of ['session', 'repo', 'global'] as const) {
      const ctx = context('serve', [])
      if (scope !== 'session') ctx.state.scope = scope
      renderSuggest(ctx)
      const text = foot()
      expect(text, scope).toBe(`orangu measures the evidence. Claude writes the proposal only when you run the command. ${expected[scope]}`)
      for (const internal of ['catalog', 'cohort', 'handoff', 'stay deterministic']) expect(text, `${scope} says "${internal}"`).not.toContain(internal)
    }
  })

  it('shows only selected-session, unmapped proposals in the localhost inbox', () => {
    const saved = proposalRecord('sg_0000000000ac')
    const other = proposalRecord('sg_0000000000ad', { sessionIds: ['another-session'], proposal: { title: 'Wrong session', change: 'x', effort: 'S', proposalPath: '/tmp/other.md' } })
    renderSuggest(serveContext([saved, other]))

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

  // The file bundles carry no proposal renderer: the screen draws a stored proposal and the inbox only
  // through Ctx.proposals, which serve alone provides. Same records, with and without the seam.
  it('draws the stored proposal and the inbox only through the serve seam', () => {
    const row = planRows('session', analysis, undefined)[0]!
    const id = suggestionIdV2(suggestionKey(findingForRow(row, 'session'), 'report'))
    const records = [
      proposalRecord(id, { source: 'report', ruleId: row.ruleId, insightId: row.insightId }),
      proposalRecord('sg_0000000000ac', { proposal: { title: 'Saved elsewhere', change: 'x', effort: 'S', proposalPath: '/tmp/saved.md' } }),
    ]
    renderSuggest(context('serve', records))
    expect(markup).not.toContain('sg-proposal')
    expect(markup).not.toContain('sg-inbox')
    renderSuggest(serveContext(records))
    expect(markup).toContain('<div class="sg-proposal">')
    expect(markup).toContain('Saved proposals · 1')
  })

  // A4: the screen explains its own handoff instead of ending at a bare button.
  it('renders the empty inbox on localhost so the third step has somewhere to point', () => {
    renderSuggest(serveContext([]))
    expect(markup).toContain('Saved proposals · 0')
    expect(markup).toContain('This scope has no proposal yet. When /orangu:improve writes one, it shows here.')
    expect(markup).toContain('The proposal shows below, in Saved proposals.')
  })

  // The copied text is `claude "/orangu:improve …"`, a shell command that starts Claude Code, so the
  // paste target is a terminal in the workspace, not a running Claude Code prompt.
  it('walks the handoff in three steps with the workspace, and puts the one-time plugin install inside step 2 (M5)', () => {
    renderSuggest(context('file', []))
    expect(markup).toContain('Copy the Claude Code command')
    expect(markup).toContain('<span>Paste it in a terminal in ~/Code/demo. It starts Claude Code.</span>')
    expect(markup).toContain('Run orangu serve to see it here.')
    expect(markup).toContain('/plugin marketplace add NissanOhana/orangu')
    expect(markup).toContain('/plugin install orangu')
    expect(markup).toContain('<span class="p" aria-hidden="true">&gt;</span>')
    // the install line sits between step 2's sentence and step 3, as the CLI prints it under the next step
    const step2 = markup.indexOf('Paste it in a terminal in')
    const install = markup.indexOf('/plugin install orangu')
    const step3 = markup.indexOf('Run orangu serve to see it here.')
    expect(step2).toBeLessThan(install)
    expect(install).toBeLessThan(step3)
    expect(markup).toContain('First time only, type these 2 lines in Claude Code:')
    expect(markup).not.toContain('Paste it in Claude Code')
  })

  it('shows a severity dot and the savings as a share of the session; no taxonomy chips, no "effort –", no queued chip', () => {
    renderSuggest(context('file', []))
    expect(markup).toContain('<span class="sev medium" title="medium"></span>')
    expect(markup).toContain('~25% of this session')
    expect(markup).toContain('title="Rule reread-files estimated a saving of ≈25.0k of the 100k tokens in this session."')
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
    renderSuggest(serveContext([proposalRecord(id, { source: 'report', ruleId: row.ruleId, insightId: row.insightId })]))
    expect(markup).toContain('<span class="pill">instruction</span>')
    expect(markup).toContain('<span class="pill">effort S</span>')
  })

  it('does not offer apply for an unstructured legacy proposal', () => {
    renderSuggest(serveContext([proposalRecord('sg_0000000000af', {
      proposal: { title: 'Legacy proposal', change: 'Do it', effort: 'S', proposalPath: '/tmp/legacy.md' },
    })]))
    expect(markup).toContain('Legacy proposal')
    expect(markup).not.toContain('/orangu:apply')
    expect(markup).not.toContain('$orangu-apply')
  })
})

/** The markup of the first card, from its opening tag to its own closing tag. */
function firstCard(html: string): string {
  const start = html.indexOf('<details class="finding"')
  return html.slice(start, html.indexOf('</details>', start))
}

/** Everything inside a card's <summary>: what a reader sees while the card is closed. */
function summaryOf(card: string): string {
  return card.slice(card.indexOf('<summary>'), card.indexOf('</summary>'))
}

/**
 * The card names the change before any command, and the way to an AI proposal is explained once, above
 * the cards, not repeated in every card. The copied text is a shell command (`claude "/orangu:improve …"`),
 * so the explainer says to paste it in a terminal, where it starts Claude Code.
 */
describe('renderSuggest: each card leads with its improvement, one explainer says how to get an AI proposal', () => {
  it('puts the improvement in the closed card summary, before the copy button, and keeps no steps in the card', () => {
    renderSuggest(context('file', []))
    const card = firstCard(markup)
    expect(summaryOf(card)).toContain('<span class="rec sg-lead"><b>Improvement:</b> Cache it</span>')
    expect(card.indexOf('sg-lead')).toBeLessThan(card.indexOf('data-kick-copy'))
    expect(card).toContain('data-kick-copy="')
    expect(card).toContain('>Copy the Claude Code command</button>')
    expect(card).not.toContain('<ol class="steps"')
    expect(card).not.toContain('handled by')
    expect(card).not.toContain('<span class="pill">orangu:improve</span>')
    expect(card).not.toContain('<b>Fix.</b>')
  })

  it.each(['file', 'serve'] as const)('renders exactly one explainer, above the first card and outside every card (%s)', (mode) => {
    renderSuggest(mode === 'serve' ? serveContext([]) : context('file', []))
    expect(markup.split('Get an AI proposal').length - 1).toBe(1)
    const at = markup.indexOf('Get an AI proposal')
    const before = markup.slice(0, at)
    expect((before.match(/<details/g) ?? []).length).toBe((before.match(/<\/details>/g) ?? []).length)
    expect(at).toBeLessThan(markup.indexOf('<details class="finding"'))
  })

  it('walks the 3 steps once: the button, the paste in a terminal with 2 install lines, and what Claude writes', () => {
    renderSuggest(context('file', []))
    const box = markup.slice(markup.indexOf('Get an AI proposal'), markup.indexOf('<details class="finding"'))
    // 3 steps; the 4 parts of a proposal are a list inside step 3, so count only the step items
    expect((box.match(/<li><(?:span|div)>/g) ?? []).length).toBe(3)
    expect(box).toContain('Open an improvement. Click <b>Copy the Claude Code command</b>.')
    expect(box).toContain('Paste it in a terminal in ~/Code/demo. It starts Claude Code.')
    expect(box).toContain('First time only, type these 2 lines in Claude Code:')
    // one bar per command: one bar with both commands copied a line that does not run
    expect(box).toContain('data-copy="/plugin marketplace add NissanOhana/orangu"')
    expect(box).toContain('data-copy="/plugin install orangu"')
    expect(box.split('<span class="p" aria-hidden="true">&gt;</span>').length - 1).toBe(2)
    expect(markup).not.toContain('NissanOhana/orangu · /plugin install orangu')
    expect(box).toContain('Claude writes one proposal. It has 4 parts:</span><ul><li>the change</li><li>its effect</li><li>its risk</li><li>how to check it</li></ul>')
    expect(box).toContain('It changes no file in your repository.')
    expect(box).toContain('The proposal is in ~/.orangu/proposals. Run orangu serve to see it here.')
    const paste = box.indexOf('Paste it in a terminal')
    const install = box.indexOf('/plugin install orangu')
    const writes = box.indexOf('Claude writes one proposal')
    expect(paste).toBeLessThan(install)
    expect(install).toBeLessThan(writes)
  })

  // a screen reader announces the list by its heading, and each copy button by what it copies
  it('names the steps list by its heading and gives each install copy button its own name', () => {
    renderSuggest(context('file', []))
    expect(markup).toContain('<div class="eyebrow" id="ai-steps">Get an AI proposal</div><ol class="steps" aria-labelledby="ai-steps">')
    expect(markup).toContain('data-copy="/plugin marketplace add NissanOhana/orangu" aria-label="copy the marketplace command"')
    expect(markup).toContain('data-copy="/plugin install orangu" aria-label="copy the install command"')
  })

  it('says the proposal shows below on localhost, where the Saved proposals list is', () => {
    renderSuggest(serveContext([]))
    expect(markup).toContain('The proposal shows below, in Saved proposals.')
    expect(markup).not.toContain('Run orangu serve to see it here.')
  })

  it('shows no explainer and no note when nothing was found', () => {
    const ctx = context('file', [])
    ctx.a = { ...analysis, insights: [] } as unknown as Analysis
    renderSuggest(ctx)
    expect(markup).toContain('No improvements found')
    expect(markup).toContain('The rules found nothing to change. Look again after your next session.')
    expect(markup).not.toContain('Get an AI proposal')
    expect(markup).not.toContain('What a proposal can change')
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
    title: 'In one session: Read the same file 6 times',
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
    expect(markup).toContain('No improvements found')
    expect(markup.indexOf('Whole-harness review')).toBeLessThan(markup.indexOf('No improvements found'))
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

  // AC16b: the sidebar's Improvements link carries no scope=, so a file with no session would land on
  // the session scope and report "No improvements found" about a session it does not contain.
  it.each(['repo', 'global'] as const)('defaults an unscoped hash to the scope the file is about (%s)', (scope) => {
    const ctx = scopeContext(scope)
    ctx.state = { screen: 'suggest' }
    renderSuggest(ctx)
    expect(markup).toContain('Whole-harness review')
    expect(markup).toContain(scope === 'repo' ? 'These patterns recur across this repository.' : 'These patterns recur across this machine.')
    expect(markup).not.toContain('No improvements found')
  })

  it('keeps the session default for an unscoped hash when the file does have a session', () => {
    const ctx = scopeContext('repo')
    ctx.data.session = analysis
    ctx.data.selectedId = analysis.session.id
    ctx.a = analysis
    ctx.state = { screen: 'suggest', s: analysis.session.id }
    renderSuggest(ctx)
    expect(markup).toContain('Each improvement below comes from the evidence in this session.')
    expect(markup).not.toContain('Whole-harness review')
  })

  // AC22: a chip that cannot lead anywhere must say so, not silently do nothing when clicked. The
  // wording is mode-neutral because serve reaches the same branch: a bootstrapping app with an empty
  // registry has no analysis yet while its sidebar still offers a picker, so "this report has no
  // session" would be false there.
  it('disables the This session chip in a report that carries no session', () => {
    renderSuggest(scopeContext('repo'))
    expect(markup).toContain('<button type="button" class="chip" aria-disabled="true" tabindex="-1" title="no session is selected" data-scope="session">This session</button>')
    expect(markup).not.toContain('this report has no session')
  })

  it('says the same true thing in a served app that has not selected a session yet', () => {
    const ctx = scopeContext('repo')
    ctx.data.mode = 'serve'
    renderSuggest(ctx)
    expect(markup).toContain('title="no session is selected" data-scope="session"')
  })

  it('leaves the This session chip enabled when a session is present', () => {
    renderSuggest(context('file', []))
    expect(markup).toContain('data-scope="session">This session</button>')
    expect(markup).not.toContain('no session is selected')
  })

  it.each(['repo', 'global'] as const)('leads each %s card with the improvement its cross finding carries', (scope) => {
    renderSuggest(scopeContext(scope, [{ ...crossFinding, recommendation: 'Read each file once.' } as typeof crossFinding]))
    const card = firstCard(markup)
    expect(summaryOf(card)).toContain('<span class="rec sg-lead"><b>Improvement:</b> Read each file once.</span>')
    expect(card.indexOf('sg-lead')).toBeLessThan(card.indexOf('data-kick-copy'))
    expect(card).not.toContain('<ol class="steps"')
  })

  it('shows a card without an improvement line for an older aggregate that has no recommendation', () => {
    renderSuggest(scopeContext('repo'))
    expect(firstCard(markup)).not.toContain('sg-lead')
    expect(markup).toContain('Get an AI proposal')
  })

  it.each([
    ['repo', 'Paste it in a terminal in this repository. It starts Claude Code.'],
    ['global', 'Paste it in a terminal. It starts Claude Code.'],
  ] as const)('puts the explainer under the whole-harness block and names where to paste (%s)', (scope, paste) => {
    renderSuggest(scopeContext(scope))
    const block = markup.indexOf('Whole-harness review')
    const explainer = markup.indexOf('Get an AI proposal')
    expect(block).toBeLessThan(explainer)
    expect(explainer).toBeLessThan(markup.indexOf('<details class="finding"'))
    expect(markup.slice(explainer, markup.indexOf('<details class="finding"'))).toContain(paste)
  })

  it.each(['repo', 'global'] as const)('renders exactly one explainer, outside every card, in a served %s scope with the session folder', (scope) => {
    const ctx = scopeContext(scope)
    ctx.data.mode = 'serve'
    ctx.a = analysis
    renderSuggest(ctx)
    expect(markup.split('Get an AI proposal').length - 1).toBe(1)
    const at = markup.indexOf('Get an AI proposal')
    const before = markup.slice(0, at)
    expect((before.match(/<details/g) ?? []).length).toBe((before.match(/<\/details>/g) ?? []).length)
    const first = markup.indexOf('<details class="finding"')
    expect(at).toBeLessThan(first)
    const box = markup.slice(at, first)
    expect(box).toContain('Paste it in a terminal in ~/Code/demo. It starts Claude Code.')
    expect(box).toContain('The proposal shows below, in Saved proposals.')
  })

  it('counts the sessions that show the pattern against the sessions in the scope', () => {
    renderSuggest(scopeContext('repo', [{ ...crossFinding, sessions: 1 }]))
    expect(firstCard(markup)).toContain('This pattern shows in 1 of 3 sessions.')
    expect(markup).not.toContain('Recurs in')
  })

  // A literal #overview?s= link dropped theme= and audience=, so a dark reader turned light on the click.
  it('builds the localhost example-session links through the hash writer, so theme and audience survive', () => {
    const ctx = scopeContext('repo')
    ctx.data.mode = 'serve'
    ctx.state = { screen: 'suggest', scope: 'repo', theme: 'dark', audience: 'plain' }
    renderSuggest(ctx)
    expect(markup).toContain('<a class="exch" href="#overview?s=session-a&amp;audience=plain&amp;theme=dark">session-</a>')
    expect(markup).not.toContain('href="#overview?s=session-a"')
  })
})
