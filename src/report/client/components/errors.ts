/** One honest row per tool for error groups whose text the redactor stripped: never N identical notices. */
import type { HiddenErrors } from '../derive.js'
import { esc, plural } from '../format.js'

export function hiddenErrorRow(r: HiddenErrors, includeText: boolean, style = ''): string {
  const why = includeText ? 'No error text was recorded.' : 'Redaction hides the text. Run the command again with <span class="mono">--include-text</span>.'
  return `<div class="rrow"${style ? ` style="${style}"` : ''}><span class="grow"><b>${esc(r.tool)}</b> · ${plural(r.total, 'error')} across ${plural(r.signatures, 'recurring signature')}</span>${r.sessions ? `<span class="mono small muted">${r.sessions}+ sessions</span>` : ''}<span class="small muted">${why}</span></div>`
}
