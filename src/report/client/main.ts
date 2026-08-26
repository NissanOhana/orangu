/**
 * File-mode entry (single-file report): mount the app on the embedded AppData.
 * Serve mode gets its own entry (serve-entry.ts, Wave C) with the remote data source:
 * two bundles from one source so this one provably contains no network API text.
 */
import { mountApp } from './app.js'
import { embeddedSource } from './data.js'

function boot(): void {
  void mountApp(embeddedSource())
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
