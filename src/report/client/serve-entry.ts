/**
 * Serve-mode entry: same app, remote data source (fetch + SSE). Built as CLIENT_JS_SERVE: a second
 * esbuild entry so the single-file report bundle provably contains no network API text.
 */
import { mountApp } from './app.js'
import { remoteBasePath, remoteSource } from './data-remote.js'
import { serveUi } from './serve-ui.js'
import { isFeedbackLocation, mountFeedback, mountFeedbackLauncher } from './feedback-ui.js'

function boot(): void {
  const feedbackAtBoot = isFeedbackLocation()
  if (feedbackAtBoot) mountFeedback()
  else void mountApp(remoteSource(remoteBasePath(location.pathname)), serveUi).then(mountFeedbackLauncher)
  window.addEventListener('hashchange', () => {
    if (isFeedbackLocation() !== feedbackAtBoot) location.reload()
  })
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
