/**
 * Serve-mode entry: same app, remote data source (fetch + SSE). Built as CLIENT_JS_SERVE: a second
 * esbuild entry so the single-file report bundle provably contains no network API text.
 */
import { mountApp } from './app.js'
import { remoteSource } from './data-remote.js'
import { serveUi } from './serve-ui.js'

function boot(): void {
  void mountApp(remoteSource(), serveUi)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
