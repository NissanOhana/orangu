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
import type { AppData } from '../../model/app-data.js'
import type { Ctx, ServeUi } from './app.js'
import { h } from './dom.js'
import { esc } from './format.js'
import { megaReview } from './mega-review.js'
import { renderGlobal } from './screens/global.js'
import { aggregateEmpty, renderRepo } from './screens/repo.js'

/** The sidebar card names the scope this file covers and how many sessions it read: a file has no session to pick. */
function pickerHtml(d: AppData): string {
  const scope = d.aggregates.repo ? 'repo' : d.aggregates.global ? 'global' : undefined
  const agg = scope ? d.aggregates[scope] : undefined
  const label = scope && agg ? `${scope} · ${agg.sessionCount} session${agg.sessionCount === 1 ? '' : 's'}` : '–'
  return `<div class="sid">${esc(label)}</div>`
}

function aggregateView(ctx: Ctx): HTMLElement {
  return ctx.state.screen === 'global' ? renderGlobal(ctx) : renderRepo(ctx)
}

function harnessView(): HTMLElement {
  return h(`<section>${aggregateEmpty('harness')}</section>`)
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
