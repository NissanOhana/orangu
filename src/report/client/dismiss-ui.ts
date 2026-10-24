/**
 * Serve only: the Dismiss control of a Queue row, its confirm, and the calls that dismiss an item. Only the Queue
 * section (queue-ui.ts) and the home frame (home-ui.ts) import this file, so the file bundles carry none of it.
 *
 * A dismissed record allows no move, so the row asks first, inside the row and not in a modal. The person picks 1 of
 * the 5 reason codes of src/suggest/reason-codes.ts. The confirm has no text field, so no text of the person reaches
 * the store or a skill. A folded item dismisses each of its records, newest first, with the same code, and it stops at
 * the first call that fails. Only a record that comes back as dismissed counts, so a failed call never reads as done.
 *
 * The home frame keeps the open confirm in memory and each render draws it again from that state. The ids of its
 * controls keep the id that the row had when the confirm opened, so focus finds them after a read moves the row.
 */
import { REJECT_REASON_CODES, REJECT_REASON_LABELS, type RejectReasonCode } from '../../suggest/reason-codes.js'
import type { DataSource } from './data.js'
import { esc, num } from './format.js'
import type { QueueGroupKey, QueueRow } from './queue-types.js'

/** The groups whose rows offer Dismiss. A row that verifies or waits offers none. */
export const DISMISS_GROUPS: ReadonlySet<QueueGroupKey> = new Set(['regressed', 'apply', 'review', 'running'])

/** The open confirm. */
export interface DismissState {
  /** the id of the row when the confirm opened: the ids of the confirm controls are made from it */
  key: string
  /** the ids that Dismiss sends, newest first. After a stop, only the ids that did not change */
  ids: string[]
  /** the checked reason: always 1 of the fixed codes */
  reason?: RejectReasonCode
  /** the calls run */
  busy: boolean
  /** every call passed: the row leaves the queue with the next read */
  done: boolean
  /** the status line under the buttons, or '' */
  line: string
}

/** The open confirm when it belongs to `row`: the row holds 1 of its ids. */
export function confirmOf(row: QueueRow, confirm: DismissState | undefined): DismissState | undefined {
  return confirm && row.ids.some((id) => confirm.ids.includes(id)) ? confirm : undefined
}

/** The confirm box: the warning, the reason options, the 2 buttons and the status line. */
function confirmBox(key: string, c: DismissState): string {
  const options = REJECT_REASON_CODES.map(
    (code) => `<label><input type="radio" name="qd-${key}" id="qd-${key}-${code}" value="${code}" data-q-reason${c.reason === code ? ' checked' : ''}>${esc(REJECT_REASON_LABELS[code])}</label>`,
  ).join('')
  const off = !c.reason || c.busy || c.done
  return [
    `<div class="sg-proposal dismiss" id="qd-${key}" role="group" aria-labelledby="qd-${key}-title">`,
    `<div id="qd-${key}-title">Dismiss this item? You cannot undo it. Dismiss does not undo a change in your files.</div>`,
    c.ids.length > 1 ? `<div class="mt8">This dismisses ${num(c.ids.length)} records of this finding.</div>` : '',
    // while the calls run, the reason stays the one that they send
    `<fieldset${c.busy ? ' disabled' : ''}><legend>Pick the reason. The next proposal reads it.</legend>${options}</fieldset>`,
    `<div class="pill-row"><button type="button" class="btn-sm" id="qd-${key}-go" data-q-confirm aria-disabled="${off}"${c.busy ? ' aria-busy="true"' : ''}>Dismiss</button>`,
    `<button type="button" class="btn-sm" id="qd-${key}-cancel" data-q-cancel${c.busy || c.done ? ' aria-disabled="true"' : ''}>Cancel</button></div>`,
    c.line ? `<p class="small mt8">${esc(c.line)}</p>` : '',
    '</div>',
  ].join('')
}

/**
 * The Dismiss part of a row: its button, and the confirm under it when it is open on this row. The part has its own
 * id, so the home frame can draw it again in place, with no render of the app.
 */
export function dismissPart(row: QueueRow, confirm: DismissState | undefined): string {
  if (!DISMISS_GROUPS.has(row.group)) return ''
  const open = confirmOf(row, confirm)
  const key = esc(open?.key ?? row.id)
  const button = `<button type="button" class="btn-sm" id="qd-${key}-open" data-q-dismiss="${esc(row.id)}" aria-expanded="${!!open}" aria-controls="qd-${key}"${open ? ' hidden' : ''}>Dismiss</button>`
  return `<div id="qx-${key}"><div class="kickrow">${button}</div>${open ? confirmBox(key, open) : ''}</div>`
}

/** The status line after the calls: `done` of `total` records changed. */
export function dismissLine(done: number, total: number): string {
  if (!done) return 'orangu could not dismiss the item. Nothing changed.'
  if (done < total) return `orangu dismissed ${num(done)} of ${num(total)} records. Then it stopped. The rest did not change.`
  return total > 1 ? `orangu dismissed ${num(total)} records of this finding.` : 'orangu dismissed the item.'
}

/** Dismiss each id in turn, newest first, with the same code. Stop at the first call that fails, and give the count that changed. */
export async function dismissIds(ds: Pick<DataSource, 'setStatus'>, ids: readonly string[], reason: RejectReasonCode): Promise<number> {
  let done = 0
  for (const id of ids) {
    let status: string | undefined
    try {
      status = (await ds.setStatus(id, 'rejected', reason))?.status
    } catch {
      status = undefined
    }
    if (status !== 'rejected') break
    done++
  }
  return done
}
