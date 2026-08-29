/**
 * Aggregate-report entry: the same app and the same embedded data source as the session report, with
 * the aggregate UI seam. A third esbuild entry (CLIENT_JS_AGG) so the byte-pinned file-mode bundle
 * never grows the repo/global screens, and so this one never inherits serve-ui.ts's network text.
 */
import { mountApp } from './app.js'
import { aggUi } from './agg-ui.js'
import { embeddedSource } from './data.js'

function boot(): void {
  void mountApp(embeddedSource(), aggUi)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
