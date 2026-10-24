import { beforeAll, describe, expect, it } from 'vitest'
import type { SuggestionViewRecord } from '../../model/app-data.js'
import { historyFixture } from '../../../test/fixtures/suggestion-history.js'
import { proposalDetails } from './proposals-ui.js'
import type { ChangeRow } from './lesson-types.js'
import { checkSentence, historySection, METRIC_NAMES, summaryLine, type HistoryView } from './history-ui.js'
import { STATUS_LABELS } from './status-labels.js'

/**
 * The Plain sentence of a check: 1 row for each pair of a comparison and a check verdict that a receipt can hold. The
 * app looks the sentence up and never computes it from the numbers.
 */
const SENTENCES: ReadonlyArray<[string, string, string]> = [
  ['decreased', 'improved', 'Tool calls per session went down beyond chance.'],
  ['decreased', 'within-noise', 'Tool calls per session did not go down beyond chance.'],
  ['decreased', 'regressed', 'Tool calls per session went up beyond chance.'],
  ['increased', 'improved', 'Tool calls per session went up beyond chance.'],
  ['increased', 'within-noise', 'Tool calls per session did not go up beyond chance.'],
  ['increased', 'regressed', 'Tool calls per session went down beyond chance.'],
  ['not-increased', 'held', 'Tool calls per session did not go up beyond chance.'],
  ['not-increased', 'regressed', 'Tool calls per session went up beyond chance.'],
  ['not-decreased', 'held', 'Tool calls per session did not go down beyond chance.'],
  ['not-decreased', 'regressed', 'Tool calls per session went down beyond chance.'],
  ['equal', 'held', 'Tool calls per session did not change beyond chance.'],
  ['equal', 'changed', 'Tool calls per session changed beyond chance.'],
]

describe('the History section: the Plain sentence of a check', () => {
  it.each(SENTENCES)('a %s check that is %s reads its sentence from the table', (comparison, verdict, sentence) => {
    expect(checkSentence({ metric: 'avgToolCalls', comparison, verdict })).toBe(sentence)
  })

  it('ends each held guard sentence with "beyond chance."', () => {
    const held = SENTENCES.filter(([, verdict]) => verdict === 'held')
    expect(held).toHaveLength(3)
    for (const [comparison, verdict] of held) expect(checkSentence({ metric: 'avgToolCalls', comparison, verdict })).toMatch(/ beyond chance\.$/)
  })

  it('names each of the 8 metrics in plain words, with a capital letter at the start of the sentence', () => {
    expect(METRIC_NAMES).toEqual({
      avgTotalTokens: 'tokens per session',
      avgToolCalls: 'tool calls per session',
      avgToolErrors: 'tool errors per session',
      avgActiveMs: 'active time per session',
      avgContextPeak: 'context peak',
      avgTestRunsFailed: 'failed test runs',
      avgBuildRunsFailed: 'failed builds',
      avgInterruptions: 'interruptions',
    })
    expect(checkSentence({ metric: 'avgContextPeak', comparison: 'not-increased', verdict: 'held' })).toBe('Context peak did not go up beyond chance.')
  })
})

// The fixture: 1 applied change for each tag, built by the server's own builders. The client reads the server shapes
// through its own types, so the server results must stay assignable to them.
let rows: ChangeRow[]
let records: Map<string, SuggestionViewRecord>
beforeAll(async () => {
  const fixture = await historyFixture()
  rows = fixture.history
  records = new Map(fixture.records.map((record) => [record.id, record]))
})

const VERIFIED = 'sg_0000000000c1'
const LEGACY = 'sg_0000000000c2'
const UNPROVEN = 'sg_0000000000c3'
const REGRESSED = 'sg_0000000000c4'
const KEPT = 'sg_0000000000c5'
const DISMISSED = 'sg_0000000000c6'
const WAITING = 'sg_0000000000c7'

const view = (main: HistoryView['main'], over: Partial<HistoryView> = {}): HistoryView => ({ main, scope: '/w/repo', storeError: false, plain: false, ...over })
const draw = (main: HistoryView['main'], over: Partial<HistoryView> = {}, withRecords = records): string => historySection(view(main, over), { records: withRecords })
const rowOf = (id: string): ChangeRow => rows.find((row) => row.id === id)!

/** The html of 1 row of `html`, from its open tag to the end of its body. */
function rowHtml(html: string, id: string): string {
  const at = html.indexOf(`<details class="saved-proposal" id="h-${id}">`)
  expect(at, `row ${id}`).toBeGreaterThanOrEqual(0)
  return html.slice(at, html.indexOf('</div></details>', at) + 16)
}

describe('the History section: the states', () => {
  it('shows the loading line while the first read runs, with no count and a busy body', () => {
    const html = draw(undefined)
    expect(html).toContain('<details class="card pad mb16 sg-note" id="home-history"><summary><span class="chev" aria-hidden="true">▸</span><b>History</b></summary><div class="mt8" aria-busy="true">')
    expect(html).toContain('<div class="chart-empty">orangu reads the applied changes.</div>')
  })

  it('shows the error state when the read failed, with the hint and the front door, and no command of the store', () => {
    const html = draw(null)
    expect(html).toContain('<b>History</b></summary>')
    expect(html).toContain('<div class="t">orangu could not read the history.</div>')
    expect(html).toContain('<div class="s">Run orangu in a terminal and choose Improvements to see the reason.</div>')
    expect(html).toContain('data-copy="npx orangu"')
    expect(html).not.toContain('orangu suggest')
  })

  it('names the store when each of the 3 store reads failed', () => {
    const html = draw(null, { storeError: true })
    expect(html).toContain('<div class="t">orangu could not read the suggestion store.</div>')
    expect(html).not.toContain('orangu could not read the history.')
  })

  it('shows the empty state when no change was applied', () => {
    const html = draw([])
    expect(html).toContain('<b>History</b> · no applied change yet</summary>')
    expect(html).toContain('<div class="t">No change was applied yet.</div>')
    expect(html).toContain('<div class="s">When you run the apply skill, the change shows here with its verdict.</div>')
  })

  it('counts 1 row and many rows in the summary, starts closed, and draws every row with no cap', () => {
    expect(draw([rowOf(WAITING)])).toContain('<b>History</b> · 1 applied change</summary>')
    const html = draw(rows)
    expect(html).toContain('id="home-history"><summary>')
    expect(html).toContain('<b>History</b> · 7 applied changes</summary>')
    expect(html.match(/<details class="saved-proposal" id="h-/g)).toHaveLength(7)
    const many = Array.from({ length: 60 }, (_, i) => ({ ...rowOf(WAITING), id: `sg_${(i + 1).toString(16).padStart(12, '0')}` }))
    expect(draw(many).match(/<details class="saved-proposal" id="h-/g)).toHaveLength(60)
  })

  it('says how many changes have each tag in 1 line, with each count of 0 left out and no ratio', () => {
    expect(summaryLine(rows)).toBe('7 applied changes. 1 verified, 1 legacy unverified, 1 not shown beyond chance, 1 regressed, 1 kept after a regression, 1 dismissed after apply, 1 waiting.')
    expect(summaryLine([rowOf(WAITING)])).toBe('1 applied change. 1 waiting.')
    expect(draw(rows)).toContain(`<p class="sg-sub">${summaryLine(rows)}</p>`)
    expect(draw(rows)).not.toContain('%')
  })
})

describe('the History section: a closed row', () => {
  it.each([
    [VERIFIED, 'g', '<span class="tag good">verified comparison</span>'],
    [LEGACY, 'wr', '<span class="tag neutral">legacy unverified</span>'],
    [UNPROVEN, 'r', '<span class="tag neutral">not shown beyond chance · within noise</span>'],
    [REGRESSED, 'b', '<span class="tag bad">regressed</span>'],
    [KEPT, 'w', '<span class="tag neutral">kept after a regression</span>'],
    [DISMISSED, 'r', '<span class="tag neutral">dismissed after apply</span>'],
    [WAITING, 'r', '<span class="tag neutral">waiting for sessions</span>'],
  ])('%s shows its dot, its title, then its tag and its applied date', (id, dot, tag) => {
    const html = rowHtml(draw(rows), id)
    expect(html).toContain(`<span class="bdot ${dot}" aria-hidden="true"></span><span class="grow"><b>${rowOf(id).title}</b><span class="q-meta small muted">${tag} applied 2026-10-01</span></span></summary>`)
  })

  it('shows the form of a change not shown beyond chance only in Detailed', () => {
    expect(rowHtml(draw(rows, { plain: true }), UNPROVEN)).toContain('<span class="tag neutral">not shown beyond chance</span>')
    const guard = { ...rowOf(UNPROVEN), verdict: 'no-directional-check' }
    expect(draw([guard])).toContain('not shown beyond chance · every guard held</span>')
    expect(draw([{ ...guard, verdict: 'not-enough-sessions' }])).toContain('not shown beyond chance · not enough sessions</span>')
  })

  it('uses the serve labels of the measured statuses', () => {
    expect(STATUS_LABELS.unproven).toBe('not shown beyond chance')
    expect(STATUS_LABELS.kept).toBe('kept after a regression')
    expect(STATUS_LABELS.regressed).toBe('regressed')
  })

  it('shows the newest application first', () => {
    const older = { ...rowOf(WAITING), id: 'sg_0000000000a1', appliedAt: Date.parse('2026-09-01T00:00:00.000Z') }
    const newer = { ...rowOf(WAITING), id: 'sg_0000000000a2', appliedAt: Date.parse('2026-10-20T00:00:00.000Z') }
    const html = draw([older, newer])
    expect(html.indexOf('id="h-sg_0000000000a2"')).toBeLessThan(html.indexOf('id="h-sg_0000000000a1"'))
    expect(html).toContain('applied 2026-10-20</span>')
  })

  it('puts no control inside a summary', () => {
    const html = draw(rows)
    for (const summary of html.match(/<summary[^>]*>.*?<\/summary>/g) ?? []) expect(summary).not.toMatch(/<(button|a|input)\b/)
  })
})

describe('the History section: an open row', () => {
  it('shows an applied row with no decided date and no verdict, as waiting for sessions', () => {
    const html = rowHtml(draw(rows), WAITING)
    expect(html).toContain('waiting for sessions')
    expect(html).not.toContain('Decided.')
    expect(html).not.toContain('<b>Sessions.</b>')
    expect(html).not.toContain('<b>Checks.</b>')
  })

  it('shows the decided date, the id, the scope, the class, the workspace and the files of a closed row, in that order', () => {
    const html = rowHtml(draw(rows), DISMISSED)
    const parts = ['<b>Decided.</b> 2026-10-01', `<b>Id.</b> <span class="mono">${DISMISSED}</span>`, '<b>Scope.</b> repo · Instruction files · /w/repo', '<b>Files.</b> 1 file changed<ul><li class="mono">CLAUDE.md</li></ul>', '<b>Reason.</b> The cause is somewhere else']
    const at = parts.map((part) => html.indexOf(part))
    expect(at.every((n) => n >= 0), parts.filter((_, i) => at[i]! < 0).join(' | ')).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('has no copy control and names no command', () => {
    const html = draw(rows)
    expect(html).not.toContain('data-copy')
    expect(html).not.toContain('class="cmd"')
    expect(html).not.toContain('orangu suggest')
    expect(html).not.toContain('--effect')
  })

  it('shows the measured session counts, with no "up to"', () => {
    const html = rowHtml(draw(rows), UNPROVEN)
    expect(html).toContain('<b>Sessions.</b> 3 earlier and 10 later sessions.')
    expect(draw(rows)).not.toMatch(/up to/i)
  })

  it('shows the check means of the read in Detailed: the check, both means, both p-values and the check verdict', () => {
    const html = rowHtml(draw(rows), VERIFIED)
    expect(html).toContain('<th scope="col">Check</th><th scope="col" class="num">Before</th><th scope="col" class="num">After</th><th scope="col" class="num">p lower</th><th scope="col" class="num">p higher</th><th scope="col">Verdict</th>')
    expect(html).toContain('<td class="mono">avgToolCalls decreased</td><td class="num">11</td><td class="num">2</td><td class="num">0.05</td><td class="num">1</td><td>improved</td>')
    const earlier = { ...rowOf(VERIFIED), checks: [{ ...rowOf(VERIFIED).checks[0]!, pLower: null, pHigher: null }] }
    expect(draw([earlier])).toContain('<td class="num">2</td><td class="num">–</td><td class="num">–</td>')
  })

  it('shows 1 Plain sentence for each check in Plain language, and no p-value', () => {
    const html = draw(rows, { plain: true })
    expect(rowHtml(html, VERIFIED)).toContain('<b>Checks.</b><ul><li>Tool calls per session went down beyond chance.</li></ul>')
    expect(rowHtml(html, UNPROVEN)).toContain('<li>Tool calls per session did not go down beyond chance.</li>')
    expect(rowHtml(html, REGRESSED)).toContain('<li>Tool calls per session went up beyond chance.</li>')
    expect(html).not.toMatch(/p lower|p higher/)
  })

  it('shows the stored receipt lines word for word, only on a verified row with a trusted receipt, and only in Detailed', () => {
    const record = records.get(VERIFIED)!
    const receipt = record.verificationReceipt!
    const html = rowHtml(draw(rows), VERIFIED)
    expect(html).toContain(`<b>Stored summary.</b> <code>${receipt.summary}</code>`)
    for (const check of receipt.checks) expect(html).toContain(`<li><code>${check.evidence}</code></li>`)
    expect(draw(rows, { plain: true })).not.toContain('Stored summary.')
    // a receipt on a record of another status, or one that the trust policy does not accept, shows no stored line
    const elsewhere = new Map(records)
    elsewhere.set(KEPT, { ...records.get(KEPT)!, verificationReceipt: receipt, verificationTrusted: true })
    elsewhere.set(LEGACY, { ...records.get(LEGACY)!, verificationReceipt: receipt })
    const others = draw(rows, {}, elsewhere)
    expect(others.match(/Stored summary\./g)).toHaveLength(1)
    expect(rowHtml(others, KEPT)).not.toContain('Stored')
    expect(rowHtml(others, LEGACY)).not.toContain('Stored')
  })

  it('shows the legacy line of the stored proposal block on a verified row that the trust policy does not accept', () => {
    const line = '<div class="sg-pfield"><b>Legacy state.</b> Not verified under the current deterministic contract.</div>'
    expect(proposalDetails({ ...records.get(LEGACY)!, proposal: records.get(VERIFIED)!.proposal })).toContain(line)
    expect(rowHtml(draw(rows), LEGACY)).toContain(line)
    expect(rowHtml(draw(rows), VERIFIED)).not.toContain('Legacy state.')
  })

  it('shows the other changes of the measured window with their ids', () => {
    const two = draw([{ ...rowOf(UNPROVEN), confoundedBy: ['sg_0000000000f1', 'sg_0000000000f2'] }])
    expect(two).toContain('2 other changes landed in the same window. Their effects are measured together.<ul><li class="mono">sg_0000000000f1</li><li class="mono">sg_0000000000f2</li></ul>')
    const one = draw([{ ...rowOf(UNPROVEN), confoundedBy: ['sg_0000000000f1'] }])
    expect(one).toContain('1 other change landed in the same window. Its effect is measured together.')
    expect(draw(rows)).not.toContain('landed in the same window')
  })

  it('never shows the leaning hint of the queue', () => {
    for (const plain of [false, true]) expect(draw(rows, { plain })).not.toMatch(/leaning/i)
  })
})

describe('the History section: every workspace', () => {
  const other = (id: string, cwd: string | undefined, scope: ChangeRow['scope'] = 'repo'): [ChangeRow, SuggestionViewRecord] => {
    const record = { ...records.get(WAITING)!, id, scope, proposal: { ...records.get(WAITING)!.proposal!, workspace: cwd === undefined ? undefined : { cwd, device: '1', inode: '2' } } } as SuggestionViewRecord
    return [{ ...rowOf(WAITING), id, scope, title: `Change ${id}` }, record]
  }
  const extras = () => [other('sg_0000000000e1', '~/code/billing'), other('sg_0000000000e2', undefined), other('sg_0000000000e3', undefined, 'global')]
  const withExtra = () => new Map([...records, ...extras().map(([row, record]) => [row.id, record] as const)])
  const allRows = () => [...rows, ...extras().map(([row]) => row)]

  it('closes the disclosure at first and reads it on its first open only', () => {
    const html = draw(rows)
    expect(html).toContain('<details class="sg-note mt8" id="home-all-history"><summary><span class="chev" aria-hidden="true">▸</span>All workspaces</summary><div class="mt8" aria-busy="true"><div class="chart-empty">orangu reads the applied changes.</div>')
  })

  it('shows each other workspace by its folder and its path, then the rows with no workspace, then the global rows, and none of this workspace', () => {
    const html = draw(rows, { all: allRows() }, withExtra())
    const disclosure = html.slice(html.indexOf('id="home-all-history"'))
    expect(disclosure).toContain('<div class="card-title" style="margin:2px 0">billing</div><div class="small muted mb16">~/code/billing</div><div class="q-rows mb16"><details class="saved-proposal" id="h-sg_0000000000e1">')
    expect(disclosure).toContain('<div class="card-title">No workspace</div><div class="q-rows mb16"><details class="saved-proposal" id="h-sg_0000000000e2">')
    expect(disclosure).toContain('<div class="card-head">Global proposals and lessons</div><div class="q-rows"><details class="saved-proposal" id="h-sg_0000000000e3">')
    expect(disclosure.indexOf('h-sg_0000000000e1')).toBeLessThan(disclosure.indexOf('h-sg_0000000000e2'))
    expect(disclosure.indexOf('h-sg_0000000000e2')).toBeLessThan(disclosure.indexOf('h-sg_0000000000e3'))
    expect(disclosure.match(/id="h-sg_0000000000c/g)).toBeNull()
  })

  it('says when no other workspace has an applied change, and shows the error state when the read failed', () => {
    expect(draw(rows, { all: rows })).toContain('<div class="chart-empty">No other workspace has an applied change.</div>')
    const failed = draw(rows, { all: null })
    expect(failed.slice(failed.indexOf('id="home-all-history"'))).toContain('<div class="t">orangu could not read the history.</div>')
  })

  it('shows each workspace in turn with no disclosure when the read is of every workspace', () => {
    const html = draw(allRows(), { scope: 'all' }, withExtra())
    expect(html).not.toContain('home-all-history')
    expect(html).toContain('<div class="card-title" style="margin:2px 0">repo</div><div class="small muted mb16">/w/repo</div>')
    expect(html).toContain('<div class="card-title" style="margin:2px 0">billing</div>')
    expect(html).toContain('<b>History</b> · 10 applied changes</summary>')
  })
})

// A stored string can hold markup. Each place draws it as text: 1 marker for each place, so a missing esc() names its
// place.
describe('the History section: each stored string is text', () => {
  const VERIFIED_ROW = () => rowOf(VERIFIED)
  const check = () => VERIFIED_ROW().checks[0]!
  it.each<[string, () => ChangeRow, boolean, string]>([
    ['the title', () => ({ ...VERIFIED_ROW(), title: '<x-title>' }), false, '<b>&lt;x-title&gt;</b>'],
    ['the id', () => ({ ...VERIFIED_ROW(), id: '<x-id>' }), false, 'id="h-&lt;x-id&gt;"'],
    ['an unknown status', () => ({ ...VERIFIED_ROW(), status: '<x-status>' as ChangeRow['status'] }), false, '<span class="tag neutral">&lt;x-status&gt;</span>'],
    ['an unknown change class in the scope line', () => ({ ...VERIFIED_ROW(), changeClass: '<x-class>' }), false, '<b>Scope.</b> repo · &lt;x-class&gt; · /w/repo'],
    ['a file', () => ({ ...VERIFIED_ROW(), files: ['<x-file>'] }), false, '<li class="mono">&lt;x-file&gt;</li>'],
    ['the metric of a check', () => ({ ...VERIFIED_ROW(), checks: [{ ...check(), metric: '<x-metric>' as never }] }), false, '<td class="mono">&lt;x-metric&gt; decreased</td>'],
    ['the comparison of a check', () => ({ ...VERIFIED_ROW(), checks: [{ ...check(), comparison: '<x-cmp>' as never }] }), false, 'avgToolCalls &lt;x-cmp&gt;</td>'],
    ['the verdict of a check', () => ({ ...VERIFIED_ROW(), checks: [{ ...check(), verdict: '<x-verdict>' }] }), false, '<td>&lt;x-verdict&gt;</td>'],
    ['a mean of a check', () => ({ ...VERIFIED_ROW(), checks: [{ ...check(), before: '<x-mean>' as never }] }), false, '<td class="num">&lt;x-mean&gt;</td>'],
    ['the Plain sentence of a check', () => ({ ...VERIFIED_ROW(), checks: [{ ...check(), metric: '<x-plain>' as never }] }), true, '<li>&lt;x-plain&gt; went down beyond chance.</li>'],
    ['an id of another change in the window', () => ({ ...VERIFIED_ROW(), confoundedBy: ['<x-other>'] }), false, '<li class="mono">&lt;x-other&gt;</li>'],
    ['an unknown reason code', () => ({ ...rowOf(DISMISSED), reasonCode: '<x-reason>' }), false, '<b>Reason.</b> &lt;x-reason&gt;</div>'],
  ])('draws %s as text', (_, row, plain, escaped) => {
    const html = draw([row()], { plain })
    expect(html).toContain(escaped)
    expect(html).not.toMatch(/<x-/)
  })

  it.each<[string, (record: SuggestionViewRecord) => SuggestionViewRecord, string]>([
    ['the workspace of the stored record', (r) => ({ ...r, proposal: { ...r.proposal!, workspace: { cwd: '/w/<x-ws>', device: '1', inode: '2' } } }), '<b>Scope.</b> repo · Instruction files · /w/&lt;x-ws&gt;</div>'],
    ['the stored summary', (r) => ({ ...r, verificationReceipt: { ...r.verificationReceipt!, summary: '<x-summary>' } }), '<code>&lt;x-summary&gt;</code>'],
    [
      'a stored evidence line',
      (r) => ({ ...r, verificationReceipt: { ...r.verificationReceipt!, checks: r.verificationReceipt!.checks.map((c) => ({ ...c, evidence: '<x-evidence>' })) } as typeof r.verificationReceipt }),
      '<li><code>&lt;x-evidence&gt;</code></li>',
    ],
  ])('draws %s as text', (_, change, escaped) => {
    const html = draw([rowOf(VERIFIED)], {}, new Map([[VERIFIED, change(records.get(VERIFIED)!)]]))
    expect(html).toContain(escaped)
    expect(html).not.toMatch(/<x-/)
  })

  it('draws the folder and the path of a workspace head as text', () => {
    const record = { ...records.get(VERIFIED)!, proposal: { ...records.get(VERIFIED)!.proposal!, workspace: { cwd: '/w/<x-path>/<x-folder>', device: '1', inode: '2' } } }
    const html = draw([rowOf(VERIFIED)], { scope: 'all' }, new Map([[VERIFIED, record]]))
    expect(html).toContain('<div class="card-title" style="margin:2px 0">&lt;x-folder&gt;</div>')
    expect(html).toContain('<div class="small muted mb16">/w/&lt;x-path&gt;/&lt;x-folder&gt;</div>')
    expect(html).not.toMatch(/<x-/)
  })
})
