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
 */
import type { Analysis } from '../model/analysis.js'
import { findingForRow, planRowForInsight } from '../report/client/suggest-rows.js'
import { redactValue, type RedactOptions } from '../redact/redact.js'
import { kickoffCommands, suggestionIdV2, suggestionKey } from '../suggest/id.js'
import { SuggestionStore } from '../suggest/store.js'
import type { SuggestionStoreLike } from '../suggest/types.js'
import type { NextStep } from './summary.js'

export interface NextStepDeps {
  /** store factory; the default is the user's ~/.orangu store */
  store?: () => SuggestionStoreLike
}

export async function persistNextStep(a: Analysis, redact: RedactOptions | false, deps: NextStepDeps = {}): Promise<NextStep> {
  const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0]
  if (!top) return {}
  const row = planRowForInsight(top, a.session.id)
  const title = redact ? redactValue(row.title, { scrub: redact.scrub, stripPaths: redact.stripPaths }) : row.title
  const finding = findingForRow({ ...row, title }, 'session')
  try {
    const store = deps.store ? deps.store() : new SuggestionStore()
    const { record } = await store.upsertNew(finding, 'report')
    return { finding: title, next: kickoffCommands(record, 'serve').claude }
  } catch (e) {
    const key = suggestionKey(finding, 'report')
    const id = suggestionIdV2(key)
    const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown error'
    return {
      finding: title,
      storeNote: `unavailable: ${reason}; long form follows`,
      next: kickoffCommands({ id, ...finding, sessionIds: key.sessionIds, source: 'report' }, 'file').claude,
    }
  }
}
