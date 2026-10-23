import { describe, expect, it } from 'vitest'
import type { SuggestionViewRecord } from '../../model/app-data.js'
import { SUGGESTION_VERIFICATION_METRICS, type SuggestionProposal } from '../../suggest/types.js'
import { proposalsUi } from './proposals-ui.js'

const ID = 'sg_0000000000d1'
const SESSION = 'session-selected'

function record(proposal: Partial<SuggestionProposal> = {}, over: Partial<SuggestionViewRecord> = {}): SuggestionViewRecord {
  return {
    id: ID,
    v: 2,
    createdAt: 1,
    source: 'skill',
    scope: 'session',
    sessionIds: [SESSION],
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
      ...proposal,
    },
    status: 'proposed',
    statusAt: 1,
    ...over,
  }
}

const nine = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']

// A stored list longer than the visible part keeps every item on the page: the first 6 in the list, the rest
// behind a closed disclosure whose summary says how many show and how many wait. Before, items 7 and up were
// dropped and a "+N more" line offered no way to read them.
describe('proposal block lists: no item is cut in silence', () => {
  it('shows 6 of 9 files in the list and the other 3 behind a closed disclosure that says so', () => {
    const html = proposalsUi.details(record({ files: nine }))
    expect(html).toContain(
      '<div class="sg-pfield"><b>Files.</b><ul><li>f1</li><li>f2</li><li>f3</li><li>f4</li><li>f5</li><li>f6</li></ul>' +
      `<details class="sg-more" id="more-${ID}-files"><summary><span class="chev" aria-hidden="true">▸</span>6 of 9 files show above. Show 3 more.</summary>` +
      '<ul><li>f7</li><li>f8</li><li>f9</li></ul></details></div>',
    )
    expect(html).not.toContain('more</li>')
  })

  it('shows a list of exactly 6 whole, with no disclosure', () => {
    const html = proposalsUi.details(record({ files: nine.filter((file) => Number(file.slice(1)) <= 6) }))
    expect(html).toContain('<div class="sg-pfield"><b>Files.</b><ul><li>f1</li><li>f2</li><li>f3</li><li>f4</li><li>f5</li><li>f6</li></ul></div>')
    expect(html).not.toContain('<details')
  })

  it('counts only the items that it draws, so an empty value does not raise the total', () => {
    const html = proposalsUi.details(record({ files: ['f1', '  ', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] }))
    expect(html).toContain('6 of 7 files show above. Show 1 more.</summary><ul><li>f7</li></ul></details>')
  })

  it('escapes each item behind the disclosure', () => {
    const html = proposalsUi.details(record({ files: [...nine.filter((file) => file !== 'f8'), '<img src=x onerror=alert(1)>'] }))
    expect(html).toContain('<li>&lt;img src=x onerror=alert(1)&gt;</li></ul></details>')
    expect(html).not.toContain('<img')
  })

  it('keys each disclosure by the record id and its list, so the re-render seam opens only that list', () => {
    const metrics = SUGGESTION_VERIFICATION_METRICS.slice(0, 7)
    const html = proposalsUi.details(record(
      {
        files: nine,
        verificationChecks: metrics.map((metric) => ({ metric, comparison: 'decreased' as const })),
        sources: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ kind: 'research' as const, label: `source ${i}`, url: `https://example.test/${i}`, verifiedAt: '2026-08-26' })),
      },
      {
        status: 'verified',
        verificationTrusted: true,
        verificationReceipt: {
          v: 1,
          summary: 'Later-session comparison passed.',
          measuredSessionIds: ['later-session'],
          checks: metrics.map((metric, i) => ({ name: `${metric} decreased`, metric, comparison: 'decreased' as const, before: 8, after: 4, evidence: `evidence ${i + 1}`, ok: true as const })),
          receiptPath: '/tmp/verify.json',
        },
      },
    ))
    const ids = [...html.matchAll(/<details class="sg-more" id="([^"]+)">/g)].map((m) => m[1])
    expect(ids).toEqual([
      `more-${ID}-reviewed-comparisons`,
      `more-${ID}-files`,
      `more-${ID}-sources`,
      `more-${ID}-computed-comparisons`,
    ])
    expect(html).toContain('6 of 7 reviewed comparisons show above. Show 1 more.</summary><ul><li>avgBuildRunsFailed · decreased</li></ul>')
    expect(html).toContain('6 of 7 sources show above. Show 1 more.</summary><ul><li>research · source 7 · https://example.test/7 · 2026-08-26</li></ul>')
    expect(html).toContain('6 of 7 computed comparisons show above. Show 1 more.</summary><ul><li>avgBuildRunsFailed decreased · evidence 7</li></ul>')
  })
})

// Each text field of a stored proposal shows whole. The manifest loader already bounds each field
// (src/suggest/artifacts.ts), so the block has no reason to cut one. Before, each field stopped at 600 characters
// with no mark.
describe('proposal block text: no field is cut in silence', () => {
  const long = (name: string): string => `${name} starts. ${'Each word stays on the page. '.repeat(30)}${name} ends here.`

  it('shows each text field whole, past 600 characters', () => {
    const fields = { title: long('Title'), change: long('Change'), evidence: long('Evidence'), expectedEffect: long('Effect'), risk: long('Risk'), verification: long('Verification') }
    for (const value of Object.values(fields)) expect(value.length).toBeGreaterThan(600)
    const html = proposalsUi.details(record(fields, { application: { v: 1, summary: long('Applied'), files: ['CLAUDE.md'], checks: [{ name: 'tests', ok: true }], receiptPath: '/tmp/applied.json' } }))
    expect(html).toContain(`<div class="sg-ptitle">${fields.title}</div>`)
    expect(html).toContain(`<b>Change.</b> ${fields.change}</div>`)
    expect(html).toContain(`<b>Evidence.</b> ${fields.evidence}</div>`)
    expect(html).toContain(`<b>Expected effect.</b> ${fields.expectedEffect}</div>`)
    expect(html).toContain(`<b>Risk.</b> ${fields.risk}</div>`)
    expect(html).toContain(`<b>Verification.</b> ${fields.verification}</div>`)
    expect(html).toContain(`<b>Applied.</b> ${long('Applied')}</div>`)
  })

  it('shows the whole later-evidence summary of a trusted receipt', () => {
    const html = proposalsUi.details(record({}, {
      status: 'verified',
      verificationTrusted: true,
      verificationReceipt: { v: 1, summary: long('Later'), measuredSessionIds: ['later-session'], checks: [], receiptPath: '/tmp/verify.json' },
    }))
    expect(html).toContain(`<b>Later evidence.</b> ${long('Later')}</div>`)
  })

})

// The home draws the same record in the Queue and on its Findings row: each copy keys its list disclosures apart, and
// a Queue row shows its own next step, so its block carries no apply handoff.
describe('proposal block keys and handoffs', () => {
  it('keys the list disclosures by the key that the caller gives', () => {
    const html = proposalsUi.details(record({ files: nine }), `q-${ID}`, false)
    expect(html).toContain(`<details class="sg-more" id="more-q-${ID}-files">`)
    expect(html).not.toContain(`id="more-${ID}-files"`)
  })

  it('leaves out the apply handoff when the caller asks, and keeps it by default', () => {
    expect(proposalsUi.details(record())).toContain(`claude &quot;/orangu:apply ${ID}&quot;`)
    expect(proposalsUi.details(record(), ID, false)).not.toContain('/orangu:apply')
  })
})

// One word for one thing: the pill names a change class by the label that the home rows, the catalog and the
// screen note use, never by its stored id.
describe('proposal block labels', () => {
  it('names the change class by its label', () => {
    const html = proposalsUi.details(record({ changeClass: 'skill-create' }))
    expect(html).toContain('<span class="pill">Skills to create</span>')
    expect(html).not.toContain('>skill-create<')
  })

  it.each([
    ['regressed', 'regressed'],
    ['unproven', 'not shown beyond chance'],
    ['kept', 'kept after a regression'],
  ] as const)('shows the label of a %s record under the shared status chip', (status, label) => {
    expect(proposalsUi.details(record({}, { status }))).toContain(`<div class="sg-pfield"><b>Status.</b> ${label}</div>`)
  })

  it('shows no status line for a status that the shared chip names', () => {
    for (const status of ['proposed', 'applied', 'verified', 'rejected'] as const) expect(proposalsUi.details(record({}, { status }))).not.toContain('<b>Status.</b>')
  })
})
