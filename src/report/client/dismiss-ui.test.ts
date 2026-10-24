import { describe, expect, it, vi } from 'vitest'
import { REJECT_REASON_CODES, REJECT_REASON_LABELS } from '../../suggest/reason-codes.js'
import { confirmOf, dismissIds, dismissLine, dismissPart, type DismissState } from './dismiss-ui.js'
import type { QueueGroupKey, QueueRow } from './queue-types.js'

const ID = 'sg_00000000a001'
const NEWEST = 'sg_00000000e003'
const MIDDLE = 'sg_00000000e002'
const OLDEST = 'sg_00000000e001'

function row(group: QueueGroupKey, over: Partial<QueueRow> = {}): QueueRow {
  return { group, id: ID, ids: [ID], status: 'proposed', scope: 'repo', title: 'Keep the context small', workspace: '~/code/checkout-api', lastMoveAt: 0, earlier: [], earlierCount: 0, next: 'x', ...over }
}

const state = (over: Partial<DismissState> = {}): DismissState => ({ key: ID, ids: [ID], busy: false, done: false, line: '', ...over })

/** The confirm box of a part, from its start to the end of the part. */
const box = (html: string): string => html.slice(html.indexOf('<div class="sg-proposal dismiss"'))

describe('the Dismiss part of a row', () => {
  it.each(['regressed', 'apply', 'review', 'running'] as const)('a %s row offers Dismiss, closed, as a button that names the confirm it opens', (group) => {
    expect(dismissPart(row(group), undefined)).toBe(
      `<div id="qx-${ID}"><div class="kickrow"><button type="button" class="btn-sm" id="qd-${ID}-open" data-q-dismiss="${ID}" aria-expanded="false" aria-controls="qd-${ID}">Dismiss</button></div></div>`,
    )
  })

  it.each(['verdict', 'wait'] as const)('a %s row offers no Dismiss', (group) => {
    expect(dismissPart(row(group), undefined)).toBe('')
  })

  it('draws no confirm on a row that holds none of the ids of the open confirm', () => {
    expect(dismissPart(row('apply'), state({ key: OLDEST, ids: [OLDEST] }))).not.toContain('class="sg-proposal dismiss"')
  })
})

describe('the Dismiss confirm', () => {
  it('open with no reason: the row button hides, the box is a group named by its first line, and its Dismiss is off', () => {
    const html = dismissPart(row('apply'), state())
    expect(html).toContain(`<button type="button" class="btn-sm" id="qd-${ID}-open" data-q-dismiss="${ID}" aria-expanded="true" aria-controls="qd-${ID}" hidden>Dismiss</button>`)
    expect(box(html)).toContain(`<div class="sg-proposal dismiss" id="qd-${ID}" role="group" aria-labelledby="qd-${ID}-title"><div id="qd-${ID}-title">Dismiss this item? You cannot undo it. Dismiss does not undo a change in your files.</div>`)
    expect(html).toContain(`<button type="button" class="btn-sm" id="qd-${ID}-go" data-q-confirm aria-disabled="true">Dismiss</button>`)
    expect(html).toContain(`<button type="button" class="btn-sm" id="qd-${ID}-cancel" data-q-cancel>Cancel</button>`)
    expect(html).not.toContain('checked')
    expect(html).not.toContain('This dismisses')
    expect(html).not.toContain('<p class="small mt8">')
  })

  it('offers the 5 reason codes as radio options in 1 fieldset, in the order of the codes, with their labels, and no text field', () => {
    const html = box(dismissPart(row('review'), state()))
    expect(html).toContain('<fieldset><legend>Pick the reason. The next proposal reads it.</legend>')
    const options = [...html.matchAll(/<label><input type="radio" name="qd-[^"]+" id="qd-[^"]+" value="([^"]+)" data-q-reason>([^<]+)<\/label>/g)].map((m) => [m[1], m[2]])
    expect(options).toEqual(REJECT_REASON_CODES.map((code) => [code, REJECT_REASON_LABELS[code]]))
    expect(html.match(/<input /g)).toHaveLength(5)
    expect(html).not.toMatch(/type="text"|<textarea/)
  })

  it('says how many records a folded item dismisses', () => {
    const html = dismissPart(row('review', { id: NEWEST, ids: [NEWEST, MIDDLE, OLDEST] }), state({ key: NEWEST, ids: [NEWEST, MIDDLE, OLDEST] }))
    expect(html).toContain(`Dismiss does not undo a change in your files.</div><div class="mt8">This dismisses 3 records of this finding.</div><fieldset>`)
  })

  it('a picked reason: its option is checked, and Dismiss is on', () => {
    const html = dismissPart(row('apply'), state({ reason: 'wrong-cause' }))
    expect(html).toContain(`id="qd-${ID}-wrong-cause" value="wrong-cause" data-q-reason checked>`)
    expect(html.match(/ checked>/g)).toHaveLength(1)
    expect(html).toContain(`id="qd-${ID}-go" data-q-confirm aria-disabled="false">Dismiss</button>`)
  })

  it('dismissing: the reasons, Dismiss and Cancel are off, Dismiss is busy, and the line says what orangu does', () => {
    const html = dismissPart(row('apply'), state({ reason: 'other', busy: true, line: 'orangu dismisses the item.' }))
    expect(html).toContain('<fieldset disabled><legend>')
    expect(dismissPart(row('apply'), state({ reason: 'other' }))).toContain('<fieldset><legend>')
    expect(html).toContain(`id="qd-${ID}-go" data-q-confirm aria-disabled="true" aria-busy="true">Dismiss</button>`)
    expect(html).toContain(`id="qd-${ID}-cancel" data-q-cancel aria-disabled="true">Cancel</button>`)
    expect(html).toContain('</div><p class="small mt8">orangu dismisses the item.</p></div></div>')
  })

  it('done: both buttons stay off until the row leaves the queue', () => {
    const html = dismissPart(row('apply'), state({ reason: 'other', done: true, line: 'orangu dismissed the item.' }))
    expect(html).toContain(`data-q-confirm aria-disabled="true">Dismiss</button>`)
    expect(html).toContain(`data-q-cancel aria-disabled="true">Cancel</button>`)
    expect(html).toContain('<p class="small mt8">orangu dismissed the item.</p>')
  })

  it('keeps the ids of its controls and opens its row when a read moves the folded item to its next record', () => {
    // the newest record is dismissed, so the next read names the item by the record after it
    const open = state({ key: NEWEST, ids: [MIDDLE, OLDEST], reason: 'other', line: 'orangu dismissed 1 of 3 records. Then it stopped. The rest did not change.' })
    const moved = row('review', { id: MIDDLE, ids: [MIDDLE, OLDEST] })
    expect(confirmOf(moved, open)).toBe(open)
    const html = dismissPart(moved, open)
    expect(html.startsWith(`<div id="qx-${NEWEST}">`)).toBe(true)
    expect(html).toContain(`data-q-dismiss="${MIDDLE}"`)
    expect(html).toContain(`id="qd-${NEWEST}-other" value="other" data-q-reason checked>`)
    expect(html).toContain('This dismisses 2 records of this finding.')
  })

  it('draws the id of a row as text in every attribute', () => {
    const html = dismissPart(row('apply', { id: '"><img src=x>', ids: ['"><img src=x>'] }), state({ key: '"><img src=x>', ids: ['"><img src=x>'] }))
    expect(html).not.toContain('<img')
    expect(html).toContain('id="qd-&quot;&gt;&lt;img src=x&gt;-open"')
  })
})

describe('the Dismiss lines', () => {
  it.each([
    [1, 1, 'orangu dismissed the item.'],
    [3, 3, 'orangu dismissed 3 records of this finding.'],
    [0, 1, 'orangu could not dismiss the item. Nothing changed.'],
    [0, 3, 'orangu could not dismiss the item. Nothing changed.'],
    [1, 3, 'orangu dismissed 1 of 3 records. Then it stopped. The rest did not change.'],
    [2, 3, 'orangu dismissed 2 of 3 records. Then it stopped. The rest did not change.'],
  ])('%i of %i records: %s', (done, total, line) => {
    expect(dismissLine(done, total)).toBe(line)
  })
})

describe('the Dismiss calls', () => {
  it('sends 1 call for each id, newest first, each with the same code, and counts the records that changed', async () => {
    const setStatus = vi.fn(async (id: string) => ({ id, status: 'rejected' }) as never)
    expect(await dismissIds({ setStatus }, [NEWEST, MIDDLE, OLDEST], 'too-much-effort')).toBe(3)
    expect(setStatus.mock.calls).toEqual([NEWEST, MIDDLE, OLDEST].map((id) => [id, 'rejected', 'too-much-effort']))
  })

  it('stops at the first call that fails, and sends no call after it', async () => {
    const setStatus = vi.fn(async (id: string) => (id === MIDDLE ? null : ({ id, status: 'rejected' } as never)))
    expect(await dismissIds({ setStatus }, [NEWEST, MIDDLE, OLDEST], 'other')).toBe(1)
    expect(setStatus.mock.calls.map(([id]) => id)).toEqual([NEWEST, MIDDLE])
  })

  it('counts a call that throws, or that gives a record the store does not hold as dismissed, as a failed call', async () => {
    const thrown = vi.fn(async () => {
      throw new Error('loopback connection closed')
    })
    expect(await dismissIds({ setStatus: thrown }, [NEWEST, MIDDLE], 'other')).toBe(0)
    expect(thrown).toHaveBeenCalledTimes(1)
    const other = vi.fn(async (id: string) => ({ id, status: 'proposed' }) as never)
    expect(await dismissIds({ setStatus: other }, [NEWEST], 'other')).toBe(0)
  })
})
