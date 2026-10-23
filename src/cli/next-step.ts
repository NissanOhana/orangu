/**
 * The next step after a session was analyzed: persist the top finding as a suggestion record through
 * the same store `orangu suggest --finding` writes, so the terminal can print the SHORT
 * `claude "/orangu:improve sg_…"` command instead of a base64 payload. The id is the one the HTML
 * report computes for the same finding (suggestionKey -> suggestionIdV2), and the title is not part
 * of that key, so redacting it before persisting cannot move the id.
 *
 * When the store cannot be written (read-only home, lock timeout, identity rejection), the long
 * `--finding` form is returned with the reason, so the user still gets a runnable command and knows
 * why it is long. Callers persist only when they print the footer: --json and --quiet stay
 * side-effect free.
 *
 * The step also carries the count of the `due` row: the open items of the current folder that 1 step can close now,
 * from the queue read of `orangu suggest --queue` at a byte budget of 0 B. A clean session gets it too. The bare
 * dashboard counts the same queue through `queueCounts`.
 */
import type { Analysis } from '../model/analysis.js'
import { findingForRow, planRowForInsight } from '../report/client/suggest-rows.js'
import { redactValue, type RedactOptions } from '../redact/redact.js'
import { CohortFactsCache } from '../suggest/cohort-cache.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../suggest/id.js'
import type { QueueCounts } from '../suggest/queue.js'
import { createQueueReadDeps, readQueue, type QueueReadDeps, type QueueReadStore } from '../suggest/queue-read.js'
import { SuggestionStore } from '../suggest/store.js'
import type { SuggestionStoreLike } from '../suggest/types.js'
import { VERSION } from '../version.js'
import type { NextStep } from './summary.js'

export interface NextStepDeps {
  /** store factory; the default is the user's ~/.orangu store */
  store?: () => SuggestionStoreLike
  /** the count of the `due` row (`footerDue` on this machine); without it the step has no count */
  due?: () => Promise<number>
}

/** The reads of a queue count: the store, and the read deps at a clock and a byte budget. A test injects both. */
export interface QueueCountReads {
  store: QueueReadStore
  deps(options: { now: number; budgetBytes: number }): QueueReadDeps
}

/** The reads of this machine: the user's store, the cohort facts cache (none with `--no-cache`) and every Claude root. */
export function machineQueueReads(options: { cache: boolean }): QueueCountReads {
  return {
    store: new SuggestionStore(),
    deps: (read) => createQueueReadDeps({ ...read, cache: options.cache ? new CohortFactsCache({ version: VERSION }) : null }),
  }
}

/** The counts of the queue of 1 folder at a byte budget: the read of `orangu suggest --queue --cwd <dir>`. */
export async function queueCounts(cwd: string, now: number, budgetBytes: number, reads: QueueCountReads): Promise<QueueCounts> {
  return (await readQueue(reads.store, { cwd }, reads.deps({ now, budgetBytes }))).counts
}

/**
 * The transcript bytes that the footer count may parse on a cache miss: none. At the bound of 1 queue read, a cold
 * footer added many seconds to `orangu report` in a folder with applied records. So the footer counts only the checks
 * that the cohort facts cache holds, and an item with no cache entry is not due yet. The printout of the IMPROVE
 * choice, `orangu suggest --queue` and `/orangu:improve` run the full check and fill the cache.
 */
export const FOOTER_QUEUE_BYTES = 0

/** The count of the `due` row: the due items of the queue of the current folder. */
export async function footerDue(reads: QueueCountReads, options: { cwd?: string; now?: number } = {}): Promise<number> {
  return (await queueCounts(options.cwd ?? process.cwd(), options.now ?? Date.now(), FOOTER_QUEUE_BYTES, reads)).due
}

/** The due count of the step, or undefined: none is due, no count was asked for, or the store cannot be read. */
async function dueCount(deps: NextStepDeps): Promise<number | undefined> {
  if (!deps.due) return undefined
  try {
    const due = await deps.due()
    return Number.isInteger(due) && due > 0 ? due : undefined
  } catch {
    return undefined
  }
}

export async function persistNextStep(a: Analysis, redact: RedactOptions | false, deps: NextStepDeps = {}): Promise<NextStep> {
  // every footer gets the due count, a clean session too, so it comes before the early return
  const due = await dueCount(deps)
  const counted: NextStep = due !== undefined ? { due } : {}
  const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0]
  if (!top) return counted
  const row = planRowForInsight(top, a.session.id)
  const title = redact ? redactValue(row.title, { scrub: redact.scrub, stripPaths: redact.stripPaths }) : row.title
  const finding = findingForRow({ ...row, title }, 'session')
  // read from the Insight itself, not the plan row: the improvement is fixed rule copy, so it needs no redaction
  const improvement = top.improvement
  try {
    const store = deps.store ? deps.store() : new SuggestionStore()
    const { record } = await store.upsertNew(finding, 'report')
    return { finding: title, improvement, next: kickoffCommands(record, 'serve').claude, ...counted }
  } catch (e) {
    const key = suggestionKey(finding, 'report')
    const id = suggestionIdV2(key)
    const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown error'
    return {
      finding: title,
      improvement,
      storeNote: reason,
      next: kickoffCommands({ id, ...finding, sessionIds: key.sessionIds, source: 'report' }, 'file').claude,
      ...counted,
    }
  }
}
