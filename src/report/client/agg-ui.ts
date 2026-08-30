/**
 * The aggregate file report's UI seam: the same ServeUi shape serve-ui.ts fills, with every remote
 * capability answered from the file. A saved aggregate carries its data inside the document, so
 * nothing is ever fetched: ensureAggregate and ensureHarness are always false, and aggScreen (the
 * "Analysing sessions…" placeholder) is therefore unreachable. The harness report is computed by the
 * server and has no file form, so #harness shows the designed empty state rather than a blank screen.
 *
 * It is its own module, built as its own esbuild entry, so it never imports serve-ui.ts: that module
 * carries fetch/EventSource by design and its text may not enter a document that has to pass the
 * offline gate.
 */
import type { AppData, SessionSummaryRow } from '../../model/app-data.js'
import type { Ctx, ServeUi } from './app.js'
import { h } from './dom.js'
import { esc } from './format.js'
import { megaReview } from './mega-review.js'
import { fileScope, shortId } from './nav.js'
import { renderGlobal } from './screens/global.js'
import { aggregateEmpty, renderRepo } from './screens/repo.js'

/**
 * The sidebar card names the scope this file covers and how many sessions it read: a file about a
 * scope has no session to pick. The label is the aggregate's own scope string (`repo <project>` /
 * `global`), already redacted by the CLI, so the card says which repository the numbers came from.
 * A file that carries a session beside its aggregates (the published sample) keeps the session card
 * the session bundle draws, so the same file reads the same in both shells.
 */
function pickerHtml(d: AppData, row: SessionSummaryRow | undefined): string {
  const scope = fileScope(d)
  if (!scope) return `<div class="sid">${row ? esc(shortId(row.id)) + ' · ' + esc(row.projectSlug || row.source) : '–'}</div>`
  const agg = d.aggregates[scope]
  return `<div class="sid">${agg ? esc(`${agg.scope} · ${agg.sessionCount} sessions`) : '–'}</div>`
}

function aggregateView(ctx: Ctx): HTMLElement {
  return ctx.state.screen === 'global' ? renderGlobal(ctx) : renderRepo(ctx)
}

function harnessView(ctx: Ctx): HTMLElement {
  return h(`<section>${aggregateEmpty('harness', ctx.data)}</section>`)
}

/** Unreachable: aggLoading is false on every screen because neither ensure* ever kicks a fetch. */
function aggScreen(): HTMLElement {
  return h('<section></section>')
}

export const aggUi: ServeUi = {
  pickerHtml,
  wirePicker: () => {},
  ensureAggregate: () => false,
  aggScreen,
  aggregateView,
  megaReview,
  ensureHarness: () => false,
  invalidateHarness: () => {},
  harnessView,
  harnessCard: () => '',
}
