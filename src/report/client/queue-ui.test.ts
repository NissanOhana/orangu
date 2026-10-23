import { describe, expect, it } from 'vitest'
import type { SuggestionViewRecord } from '../../model/app-data.js'
import { COHORT_MAX, COHORT_MIN } from '../../suggest/cohort-stats.js'
import { emptyQueueFixture, queueFixture } from '../../../test/fixtures/suggestion-queue.js'
import { proposalOf, recordOf } from '../../../test/fixtures/suggestion-records.js'
import { proposalsUi } from './proposals-ui.js'
import type { QueueGroupKey, QueueRead, QueueRow } from './queue-types.js'
import { day, queueSection, rowCopy, type QueueContext, type QueueView } from './queue-ui.js'
import { STATUS_LABELS, changeClassLabel, statusLabel } from './status-labels.js'

const GROUPS = ['verdict', 'regressed', 'apply', 'review', 'running', 'wait'] as const

// The client reads the server shape through its own types: the server queue (the fixture is a buildQueue result) must
// stay assignable to them. No client file names the queue module, this test included (src/suggest/queue.test.ts).
const asRead = (queue: ReturnType<typeof queueFixture>): QueueRead => queue

/** The fixture queue with the first item of each group only, and the counts of that queue. */
function oneEach(): QueueRead {
  const full = asRead(queueFixture())
  const groups = Object.fromEntries(GROUPS.map((g) => [g, full.groups[g].slice(0, 1)])) as QueueRead['groups']
  const counts = { ...full.counts, verdict: 1, regressed: 1, apply: 1, review: 1, running: 1, wait: 1, due: 1, open: 6 }
  return { ...full, groups, counts }
}

const ID = 'sg_00000000a001'
const OTHER = 'sg_00000000a002'
const AT = Date.parse('2026-10-09T12:00:00.000Z')

/** 1 queue item of `group`; `over` sets the case. */
function item(group: QueueGroupKey, over: Partial<QueueRow> = {}): QueueRow {
  return { group, id: ID, ids: [ID], status: 'applied', scope: 'repo', title: 'Run the type check before each commit', workspace: '~/code/checkout-api', lastMoveAt: AT, earlier: [], earlierCount: 0, next: null, ...over }
}

/** A read of 1 workspace that holds `items`, with the counts of the read. */
function readOf(items: QueueRow[], scope = '~/code/checkout-api'): QueueRead {
  const groups = Object.fromEntries(GROUPS.map((g) => [g, items.filter((row) => row.group === g)])) as QueueRead['groups']
  const counts = Object.fromEntries(GROUPS.map((g) => [g, groups[g].length])) as QueueRead['counts']
  return { v: 1, scope, now: AT, groups, counts: { ...counts, due: groups.verdict.length, open: items.length }, globalOpen: 0 }
}

const view = (main: QueueView['main'], over: Partial<QueueView> = {}): QueueView => ({ main, stale: false, refreshFailed: false, closed: new Set(), ...over })
const context = (over: Partial<QueueContext> = {}): QueueContext => ({ records: new Map(), storeEmpty: false, megaButton: false, ...over })
const verify = (id = ID) => `claude "/orangu:improve --verify ${id}"`

/** The open part of the first row of `html`, from its body to its end. */
const rowBody = (html: string, id = ID): string => {
  const at = html.indexOf(`id="q-${id}"`)
  return html.slice(html.indexOf('<div class="saved-proposal-body">', at), html.indexOf('</details>', html.indexOf('<p class="rec">', at)) + 10)
}

describe('the Queue section: the groups', () => {
  it('draws 1 card for each of the 6 groups, in the order a person works them, and 1 Due tag on the first', () => {
    const html = queueSection(view(oneEach()), context())
    const cards = [...html.matchAll(/<details class="card mb16" id="q-0-(\w+)"/g)].map((m) => m[1])
    expect(cards).toEqual([...GROUPS])
    expect(html.match(/<span class="tag good">Due<\/span>/g)).toHaveLength(1)
    const first = html.indexOf('id="q-0-verdict"')
    const second = html.indexOf('id="q-0-regressed"')
    const due = html.indexOf('<span class="tag good">Due</span>')
    expect(due).toBeGreaterThan(first)
    expect(due).toBeLessThan(second)
  })

  it('opens the section and each group at first, with the labels, the dots and the counts of the read', () => {
    const html = queueSection(view(oneEach()), context())
    expect(html).toContain('<details class="card pad mb16 sg-note" id="home-queue" open><summary><span class="chev" aria-hidden="true">▸</span><b>Queue</b> · 1 due · 6 open</summary>')
    for (const [key, label, dot] of [
      ['verdict', 'Ready to verify', 'g'],
      ['regressed', 'Regressed: keep it or dismiss it', 'b'],
      ['apply', 'Ready to apply', 'p'],
      ['review', 'To review', 'h'],
      ['running', 'Running', 'w'],
      ['wait', 'Waiting for sessions', 'r'],
    ])
      expect(html).toContain(`<details class="card mb16" id="q-0-${key}" open><summary class="card-head"><span class="chev" aria-hidden="true">▸</span><span class="bdot ${dot}" aria-hidden="true"></span>${label}<span class="pill">1</span>`)
  })

  it('leaves out an empty group, and the due count when nothing is due', () => {
    const html = queueSection(view(readOf([item('review', { status: 'new', next: 'x' })])), context())
    expect(html.match(/id="q-0-/g)).toHaveLength(1)
    expect(html).toContain('<b>Queue</b> · 1 open</summary>')
  })

  it('starts a group of more than 50 rows closed, still with its count, and draws every row', () => {
    const rows = Array.from({ length: 51 }, (_, i) => item('wait', { id: `sg_${(i + 1).toString(16).padStart(12, '0')}`, ids: [] }))
    const html = queueSection(view(readOf(rows)), context())
    expect(html).toContain('<details class="card mb16" id="q-0-wait"><summary class="card-head">')
    expect(html).toContain('<span class="pill">51</span>')
    expect(html.match(/<details class="saved-proposal"/g)).toHaveLength(51)
  })

  it('renders a disclosure that the person closed once with no open mark', () => {
    const closed = new Set(['home-queue', 'q-0-verdict'])
    const html = queueSection(view(oneEach(), { closed }), context())
    expect(html).toContain('id="home-queue"><summary>')
    expect(html).toContain('id="q-0-verdict"><summary')
    expect(html).toContain('id="q-0-regressed" open>')
  })

  it('puts no control inside a summary', () => {
    const html = queueSection(view(oneEach(), { stale: true }), context({ megaButton: true }))
    for (const summary of html.match(/<summary[^>]*>.*?<\/summary>/g) ?? []) expect(summary).not.toMatch(/<(button|a|input)\b/)
  })
})

describe('the Queue section: a closed row', () => {
  it('shows the whole title, escaped, and a line with the id, the scope, the folder, the class, the effort and the date', () => {
    const record = { ...recordOf(ID), proposal: { ...proposalOf(), effort: 'M' } } as SuggestionViewRecord
    const html = queueSection(view(readOf([item('apply', { status: 'proposed', title: '<img src=x> and a long title that wraps', changeClass: 'skill-create', next: 'x' })])), context({ records: new Map([[ID, record]]) }))
    expect(html).toContain('<b>&lt;img src=x&gt; and a long title that wraps</b>')
    expect(html).not.toContain('<img')
    expect(html).toContain(`<span class="q-meta small muted">${ID} · repo · checkout-api · Skills to create · effort M · 2026-10-09</span>`)
  })

  it('counts the folded records and says when a finding has no class yet', () => {
    const html = queueSection(view(readOf([item('review', { status: 'new', ids: [ID, OTHER, 'sg_00000000a003'], next: 'x' })])), context())
    expect(html).toContain(`${ID} · 3 records · repo · checkout-api · no class yet · 2026-10-09</span>`)
  })

  it('holds the 15-character id and a date on each closed row of the fixture queue', () => {
    const html = queueSection(view(asRead(queueFixture())), context())
    const lines = [...html.matchAll(/<span class="q-meta small muted">([^<]*)<\/span>/g)].map((m) => m[1]!)
    expect(lines.length).toBeGreaterThan(5)
    for (const line of lines) {
      expect(line).toMatch(/^sg_[0-9a-f]{12} · /)
      expect(line).toMatch(/ · \d{4}-\d{2}-\d{2}$/)
    }
  })

  // A stored folder name or reason can hold markup. Each place draws it as text: 1 marker for each place, so a
  // missing esc() names its place.
  it('draws the workspace of the open row as text', () => {
    const html = queueSection(view(readOf([item('wait', { workspace: '~/code/<img src=ws>' })])), context())
    expect(html).toContain('<b>Workspace.</b> ~/code/&lt;img src=ws&gt;</div>')
    expect(html).not.toContain('<img src=ws>')
  })

  it('draws an earlier record line as text, with an unknown reason as it is stored', () => {
    const earlier = [{ id: OTHER, status: 'rejected' as const, verdict: null, reasonCode: '<img src=reason>' }]
    const html = queueSection(view(readOf([item('wait', { earlier, earlierCount: 1 })])), context())
    expect(html).toContain(`<li>${OTHER} · dismissed · &lt;img src=reason&gt;</li>`)
    expect(html).not.toContain('<img src=reason>')
  })

  it('draws the folder and the path line of another workspace as text', () => {
    const other = item('apply', { id: OTHER, ids: [OTHER], status: 'proposed', workspace: '~/code/<img src=other>', next: 'x' })
    const html = queueSection(view(readOf([item('wait')]), { all: readOf([other], 'all') }), context())
    expect(html).toContain('<div class="card-title" style="margin:2px 0">&lt;img src=other&gt;</div><div class="small muted mb16">~/code/&lt;img src=other&gt;</div>')
    expect(html).not.toContain('<img src=other>')
  })

  it('formats every date as YYYY-MM-DD in UTC', () => {
    expect(day(Date.parse('2026-10-02T23:59:00.000Z'))).toBe('2026-10-02')
  })
})

describe('the Queue section: the next step of a row', () => {
  it('shows each non-null next step, exactly, in 1 command bar and in 1 primary copy control', () => {
    const queue = asRead(queueFixture())
    const html = queueSection(view(queue), context())
    const nexts = GROUPS.flatMap((g) => queue.groups[g]).filter((row) => row.next !== null)
    expect(nexts.length).toBeGreaterThan(3)
    for (const row of nexts) {
      const body = rowBody(html, row.id)
      const copy = row.next!.replace(/"/g, '&quot;')
      expect(body.split(`<button type="button" class="btn-primary mt8" data-copy="${copy}">Copy the command</button>`).length - 1, row.id).toBe(1)
      expect(body.split(`<span class="txt">${copy}</span>`).length - 1, row.id).toBe(1)
      expect(body).toContain('aria-label="copy the next command"')
      expect(body).toContain('<div class="small muted">Copy only. Nothing runs here.</div>')
    }
  })

  it('shows no command bar on a row that waits, or on a global proposal', () => {
    const html = queueSection(view(readOf([item('wait'), item('review', { id: OTHER, ids: [OTHER], status: 'proposed', scope: 'global' })])), context())
    expect(html).not.toContain('class="cmd"')
    expect(html).not.toContain('btn-primary')
    expect(html).toContain('Global proposals are for review only. Claude applies nothing from here.')
  })

  it('names no store command and no effect read', () => {
    const html = queueSection(view(asRead(queueFixture())), context())
    expect(html).not.toContain('orangu suggest')
    expect(html).not.toContain('--effect')
  })

  it('copies the id with its own control, named by what it copies', () => {
    const html = queueSection(view(readOf([item('wait')])), context())
    expect(html).toContain(`<div class="sg-pfield"><b>Id.</b> <span class="mono">${ID}</span> <button type="button" class="btn-sm" data-copy="${ID}" aria-label="copy the id ${ID}">copy id</button></div>`)
  })
})

describe('the Queue section: the row copy of each case', () => {
  it.each([
    ['the first check', item('verdict', { check: 'ran', checkpoint: 'first', verdict: 'verified', final: true, next: verify() }),
      'Ready to verify. At the first check, on 3 later sessions, the comparison passes. Copy the command. Claude checks the change and records the verdict.'],
    ['the complete check', item('verdict', { check: 'ran', checkpoint: 'complete', verdict: 'within-noise', final: true, next: verify() }),
      'Ready to close. The later sessions are complete, so the verdict is final. The verdict: within noise. Copy the command. Claude checks the change and records the verdict.'],
    ['few baseline sessions', item('verdict', { cannotVerify: 'few-baseline-sessions', next: verify() }),
      'Ready to close. This change cannot be verified, because fewer than 3 sessions ran before it. Copy the command. Claude records it as not shown beyond chance.'],
    ['fewer than 3 later sessions', item('wait', { candidates: { baseline: 8, later: 2 } }),
      'Waiting for sessions. Up to 2 later sessions so far. orangu needs 3 on each side.'],
    ['after the first check, not final', item('wait', { check: 'ran', checkpoint: 'first', verdict: 'within-noise', final: false, candidates: { baseline: 8, later: 6 } }),
      'Waiting for the later sessions to complete. At the first check, the verdict was not final. orangu grades again at 10 later sessions, and never between them. Up to 6 later sessions so far.'],
    ['leaning worse', item('wait', { check: 'ran', checkpoint: 'first', verdict: 'regressed', final: false, leaning: 'worse' }),
      '<span class="bdot wr" aria-hidden="true"></span>Leaning worse. At the first check, a check moved beyond chance in a direction that it should not. This is not a final verdict. orangu grades again at 10 later sessions.'],
    ['a deferred check', item('wait', { check: 'deferred' }),
      'orangu did not check this change in this read, because the read reached its byte budget. Count again to check it.'],
    ['no directional check', item('wait', { cannotVerify: 'no-directional-check', check: 'ran', checkpoint: 'first', verdict: 'no-directional-check', final: false }),
      'No check of this change names a direction to improve, so orangu cannot verify it. When the later sessions are complete, this item moves to Ready to verify.'],
    ['a baseline that is gone', item('review', { cannotVerify: 'baseline-gone', next: verify() }),
      'Claude Code deleted the sessions that ran before this change, so orangu cannot verify it. Copy the command, or dismiss the item.'],
    ['a legacy record', item('review', { cannotVerify: 'legacy-record', next: verify() }),
      'An older orangu applied this change and kept no checks, so orangu cannot verify it. Copy the command, or dismiss the item.'],
    ['a later reason', item('review', { cannotVerify: 'some-later-reason', next: verify() }), 'orangu cannot verify this change.'],
    ['regressed', item('regressed', { status: 'regressed', next: verify() }),
      'Regressed. On the complete later sessions, a check moved beyond chance in a direction that it should not. Copy the command. Claude asks you to keep the change or to undo it.'],
    ['a proposal to apply', item('apply', { status: 'proposed', next: `claude "/orangu:apply ${ID}"` }), 'Review the proposal. Then copy the apply command.'],
    ['a finding', item('review', { status: 'new', next: `claude "/orangu:improve ${ID}"` }), 'Copy the command to get one proposal from Claude.'],
    ['a global proposal', item('review', { status: 'proposed', scope: 'global' }), 'Global proposals are for review only. Claude applies nothing from here.'],
    ['a running record', item('running', { status: 'kicked-off', next: `claude "/orangu:improve ${ID}"` }),
      'Started on 2026-10-09. No proposal came back yet. Copy the command again, or dismiss the item.'],
  ] as const)('%s', (_, row, copy) => {
    expect(rowCopy(row, undefined)).toBe(copy)
    expect(queueSection(view(readOf([row])), context())).toContain(`<p class="rec">${copy}</p>`)
  })

  it.each([
    ['verified', 'verified'],
    ['within-noise', 'within noise'],
    ['regressed', 'regressed'],
    ['not-enough-sessions', 'not enough sessions'],
    ['no-directional-check', 'no check names a direction'],
  ])('names the %s verdict of a complete check in words', (verdict, words) => {
    expect(rowCopy(item('verdict', { check: 'ran', checkpoint: 'complete', verdict, final: true }), undefined)).toContain(`The verdict: ${words}.`)
  })

  it('says the 2 checkpoints with the numbers of the server', () => {
    const copy = [
      rowCopy(item('verdict', { check: 'ran', checkpoint: 'first', verdict: 'verified', final: true }), undefined),
      rowCopy(item('wait', { check: 'ran', checkpoint: 'first', verdict: 'within-noise', final: false }), undefined),
      queueSection(view(readOf([item('verdict', { next: verify() })])), context()),
    ].join(' ')
    expect(copy).toContain(`on ${COHORT_MIN} later sessions`)
    expect(copy).toContain(`at ${COHORT_MAX} later sessions`)
    expect(copy).toContain(`orangu grades at ${COHORT_MIN} and at ${COHORT_MAX} later sessions, and never between them. More looks raise the chance of a false win.`)
  })

  it('shows the failure of a finding, and the way to run it again only when a stored error names it', () => {
    const failed = item('review', { status: 'failed', next: `claude "/orangu:improve ${ID}"` })
    const stored = { ...recordOf(ID, { status: 'failed', kickoff: { error: 'the model timed out' } as never }) } as SuggestionViewRecord
    expect(rowCopy(failed, stored)).toBe('Claude could not write the proposal: the model timed out<br>Copy the command to run it again.')
    expect(rowCopy(failed, undefined)).toBe('Claude could not write the proposal. Copy the command. Run it again to see the error.')
  })

  it('says "up to" before each session count of a row that verifies or waits', () => {
    for (const group of ['verdict', 'wait'] as const) {
      const html = queueSection(view(readOf([item(group, { candidates: { baseline: 8, later: 4 }, check: 'ran', checkpoint: 'first', verdict: 'within-noise', final: group === 'verdict', next: group === 'verdict' ? verify() : null })])), context())
      const body = rowBody(html)
      expect(body).toContain('Up to 8 earlier and up to 4 later sessions so far.')
      for (const count of body.matchAll(/(\w+ \w+) (\d+) (?:earlier|later) sessions? so far/g)) expect(count[1]!.toLowerCase(), count[0]).toMatch(/up to$/)
    }
  })

  it('says "Leaning worse" only on a row that waits', () => {
    const leaning = { check: 'ran' as const, checkpoint: 'first' as const, verdict: 'regressed', final: false, leaning: 'worse' as const }
    for (const group of GROUPS) expect(rowCopy(item(group, { ...leaning, status: group === 'wait' ? 'applied' : 'new' }), undefined).includes('Leaning worse'), group).toBe(group === 'wait')
  })

  it('offers Count again on a deferred row, and only there', () => {
    expect(queueSection(view(readOf([item('wait', { check: 'deferred' })])), context())).toContain('</p><button type="button" class="btn-sm" data-q-count>Count again</button>')
    expect(queueSection(view(readOf([item('wait')])), context())).not.toContain('data-q-count')
  })
})

describe('the Queue section: the open row', () => {
  it('lists the folded ids, the workspace and the earlier records with their status words and reasons', () => {
    const row = item('review', {
      status: 'new',
      ids: [ID, OTHER],
      next: 'x',
      earlier: [
        { id: 'sg_00000000b001', status: 'rejected', verdict: null, reasonCode: 'wrong-cause' },
        { id: 'sg_00000000b002', status: 'unproven', verdict: 'within-noise' },
      ],
      earlierCount: 12,
    })
    const body = rowBody(queueSection(view(readOf([row])), context()))
    expect(body).toContain(`<div class="sg-pfield">2 records of this finding:<ul><li class="mono">${ID}</li><li class="mono">${OTHER}</li></ul></div>`)
    expect(body).toContain('<div class="sg-pfield"><b>Workspace.</b> ~/code/checkout-api</div>')
    expect(body).toContain('<li>sg_00000000b001 · dismissed · The cause is somewhere else</li><li>sg_00000000b002 · not shown beyond chance</li>')
    expect(body).toContain('<div>2 of 12 earlier records show here.</div>')
  })

  it('shows the stored proposal under a closed Proposal disclosure, keyed apart and with no apply handoff', () => {
    const record = { ...recordOf(ID, { status: 'proposed', proposal: { ...proposalOf(), files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }) } as SuggestionViewRecord
    const html = queueSection(view(readOf([item('apply', { status: 'proposed', next: `claude "/orangu:apply ${ID}"` })])), context({ records: new Map([[ID, record]]), details: proposalsUi.details }))
    expect(html).toContain(`<details class="why" id="qp-${ID}"><summary><span class="chev" aria-hidden="true">▸</span>Proposal</summary><div class="sg-proposal">`)
    expect(html).toContain(`id="more-q-${ID}-files"`)
    expect(html).not.toContain('aria-label="Apply handoff"')
    expect(html.split(`data-copy="claude &quot;/orangu:apply ${ID}&quot;"`).length - 1).toBe(2)
  })
})

describe('the Queue section: Dismiss', () => {
  it('offers Dismiss in the rows of Regressed, Ready to apply, To review and Running, and in no row of Ready to verify or Waiting', () => {
    const html = queueSection(view(oneEach()), context())
    const starts = GROUPS.map((g) => html.indexOf(`id="q-0-${g}"`))
    GROUPS.forEach((group, i) => {
      const card = html.slice(starts[i], starts[i + 1] ?? html.length)
      expect(card.match(/data-q-dismiss=/g)?.length ?? 0, group).toBe(['regressed', 'apply', 'review', 'running'].includes(group) ? 1 : 0)
    })
  })

  it('draws the open confirm in its row, after the next step, and the row renders open', () => {
    const confirm = { key: ID, ids: [ID], busy: false, done: false, line: '' }
    const html = queueSection(view(readOf([item('apply', { status: 'proposed', next: 'x' })]), { confirm }), context())
    expect(html).toContain(`<details class="saved-proposal" id="q-${ID}" open><summary>`)
    const body = rowBody(html)
    expect(body.indexOf(`<div class="sg-proposal dismiss" id="qd-${ID}"`)).toBeGreaterThan(body.indexOf('<div class="sg-handoffs">'))
    expect(queueSection(view(readOf([item('apply', { status: 'proposed', next: 'x' })])), context())).toContain(`<details class="saved-proposal" id="q-${ID}"><summary>`)
  })
})

describe('the Queue section: the states', () => {
  it('loading: says what orangu counts, and the body is busy', () => {
    const html = queueSection(view(undefined), context())
    expect(html).toContain('<b>Queue</b></summary><div class="mt8" aria-busy="true"><div class="chart-empty">orangu counts the sessions of each applied change.</div>')
  })

  it('error: says that orangu could not compute the queue and where to see the reason', () => {
    const html = queueSection(view(null), context())
    expect(html).toContain('<b>Queue</b></summary>')
    expect(html).toContain('<div class="t">orangu could not compute the queue.</div>')
    expect(html).toContain('<div class="s">Run orangu in a terminal and choose Improvements to see the reason.</div>')
    expect(html).toContain('data-copy="npx orangu"')
    expect(html).not.toContain('orangu suggest')
  })

  it('empty, with no record ever: points at the findings', () => {
    const html = queueSection(view(asRead(emptyQueueFixture())), context({ storeEmpty: true }))
    expect(html).toContain('<b>Queue</b> · nothing open</summary>')
    expect(html).toContain('<div class="t">Your queue is empty.</div>')
    expect(html).toContain('<div class="s">Copy a command under Findings in this scope to get a first proposal.</div>')
  })

  it('empty, with nothing open: points at History', () => {
    const html = queueSection(view(asRead(emptyQueueFixture())), context())
    expect(html).toContain('<div class="t">Nothing waits for you.</div>')
    expect(html).toContain('<div class="s">Each applied change has a verdict. Open History to see them.</div>')
  })

  it('1 record: 1 group with the count 1 and 1 row', () => {
    const html = queueSection(view(readOf([item('wait')])), context())
    expect(html.match(/<details class="card mb16"/g)).toHaveLength(1)
    expect(html).toContain('<span class="pill">1</span>')
    expect(html.match(/<details class="saved-proposal"/g)).toHaveLength(1)
  })

  it('stale: a warning strip with Count again, which never counts by itself', () => {
    const html = queueSection(view(readOf([item('wait')]), { stale: true }), context())
    expect(html).toContain('<div class="banner warn">New sessions ended after this count. Count again to update the queue. <button type="button" class="btn-sm" data-q-count>Count again</button></div>')
  })

  it('count again fails: the last good list stays, and a line says so', () => {
    const html = queueSection(view(readOf([item('wait')]), { refreshFailed: true }), context())
    expect(html).toContain('<p class="small">orangu could not count the queue again. This list is from the last count.</p>')
    expect(html).toContain(`id="q-${ID}"`)
  })

  it('offers the whole-harness card only when it is on the page', () => {
    const button = '<div class="right"><button type="button" class="btn-sm" data-q-mega>Review the whole harness ↓</button></div>'
    expect(queueSection(view(readOf([item('wait')])), context({ megaButton: true }))).toContain(button)
    expect(queueSection(view(readOf([item('wait')])), context())).not.toContain('data-q-mega')
  })
})

describe('the Queue section: every workspace', () => {
  const here = '~/code/checkout-api'
  const all = (): QueueRead => {
    const rows = [
      item('wait', { workspace: here }),
      item('apply', { id: OTHER, ids: [OTHER], status: 'proposed', workspace: '~/code/billing', next: `claude "/orangu:apply ${OTHER}"` }),
      item('review', { id: 'sg_00000000a003', ids: ['sg_00000000a003'], status: 'proposed', scope: 'global', workspace: null }),
      item('review', { id: 'sg_00000000a004', ids: ['sg_00000000a004'], status: 'new', workspace: null, next: 'claude "/orangu:improve sg_00000000a004"' }),
    ]
    return { ...readOf(rows, 'all'), counts: { ...readOf(rows, 'all').counts, open: 7 } }
  }

  it('closes the All workspaces disclosure at first, with no count until its read lands', () => {
    const html = queueSection(view(readOf([item('wait')])), context())
    expect(html).toContain('<details class="sg-note mt8" id="home-all-queue"><summary><span class="chev" aria-hidden="true">▸</span>All workspaces</summary><div class="mt8" aria-busy="true">')
  })

  it('shows each other workspace by its folder and its path, then the global records, and never this workspace again', () => {
    const html = queueSection(view(readOf([item('wait')]), { all: all() }), context())
    const disclosure = html.slice(html.indexOf('id="home-all-queue"'))
    expect(disclosure).toContain('All workspaces · 7 open</summary>')
    expect(disclosure).toContain('<div class="card-title" style="margin:2px 0">billing</div><div class="small muted mb16">~/code/billing</div><details class="card mb16" id="q-1-apply" open>')
    expect(disclosure).toContain('<div class="card-title">No workspace</div><details class="card mb16" id="q-2-review" open>')
    expect(disclosure).toContain('<div class="card-head">Global proposals and lessons</div><div class="pad"><details class="card mb16" id="q-3-review" open>')
    expect(disclosure).not.toContain(`id="q-${ID}"`)
    expect(html.match(new RegExp(`id="q-${ID}"`, 'g'))).toHaveLength(1)
  })

  it('reads every workspace in turn, with no All workspaces disclosure, when serve has no workspace of its own', () => {
    const html = queueSection(view(all()), context())
    expect(html).not.toContain('home-all-queue')
    // the order of the read: the first group that names a workspace places it
    expect(html).toContain('<div class="card-title" style="margin:2px 0">billing</div><div class="small muted mb16">~/code/billing</div><details class="card mb16" id="q-0-apply" open>')
    expect(html).toContain('<div class="card-title" style="margin:2px 0">checkout-api</div><div class="small muted mb16">~/code/checkout-api</div><details class="card mb16" id="q-1-wait" open>')
    expect(html.indexOf('Global proposals and lessons')).toBeGreaterThan(html.indexOf('No workspace'))
  })

  it('shows the error of the read of every workspace in its disclosure', () => {
    expect(queueSection(view(readOf([item('wait')]), { all: null }), context()).slice(0)).toContain('All workspaces</summary><div class="mt8"><div class="card"><div class="empty-hero">')
  })
})

describe('the serve-only status labels', () => {
  it.each([
    ['regressed', 'regressed'],
    ['unproven', 'not shown beyond chance'],
    ['kept', 'kept after a regression'],
  ] as const)('names %s by its label', (status, label) => {
    expect(STATUS_LABELS[status]).toBe(label)
    expect(statusLabel(status)).toBe(label)
  })

  it('names every other status by the word of the shared chip', () => {
    expect(statusLabel('rejected')).toBe('dismissed')
    expect(statusLabel('kicked-off')).toBe('running')
    expect(statusLabel('verified')).toBe('verified')
  })

  it('names a change class by its label, and keeps an id that the catalog does not know', () => {
    expect(changeClassLabel('instruction')).toBe('Instruction files')
    expect(changeClassLabel('a-new-class')).toBe('a-new-class')
  })
})
