/**
 * Serve only: the person words for the statuses that only the improvement loop writes, and for a change class.
 * Only serve-ui.ts and the serve home modules import this file, so the file bundles carry none of it. The shared
 * status chip (chipState and statusChip in screens/suggest.ts) does not change: on a Findings row it shows the
 * stored status word, and the proposal block under it shows the label from here.
 */
import { CHANGE_CLASS_DEFINITIONS } from '../../suggest/change-classes.js'
import type { SuggestionStatus } from '../../suggest/types.js'
import { chipState } from './screens/suggest.js'

/** The 3 statuses of a measured change that the shared chip has no label for. */
export const STATUS_LABELS: Readonly<Partial<Record<SuggestionStatus, string>>> = {
  regressed: 'regressed',
  unproven: 'not shown beyond chance',
  kept: 'kept after a regression',
}

/** The word for a stored status: the label above, else the word of the shared chip. */
export function statusLabel(status: SuggestionStatus): string {
  return STATUS_LABELS[status] ?? chipState(status)
}

/** The label of a change class id, as the catalog names it; the id itself when the catalog does not know it. */
export function changeClassLabel(id: string): string {
  return CHANGE_CLASS_DEFINITIONS.find((definition) => definition.id === id)?.label ?? id
}
