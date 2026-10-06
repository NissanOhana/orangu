/**
 * The shared Finding component: <details> with severity dot, title, savings pill (share of the
 * session, basis in the title), rule pill, and the improvement line in the summary; body = detail (when
 * the redactor kept it) + "Show N turns →" + the exact improve command. Plain audience hides the rule
 * pill and maps vocabulary. The app wires [data-turns] buttons to the timeline and [data-copy] to the
 * clipboard.
 */
import type { Insight } from '../../../model/analysis.js'
import { esc, plural } from '../format.js'
import { savingsShare } from '../derive.js'
import { commandBlock, pasteLine } from './command.js'
import { plainSentence, type Audience } from '../strings.js'

export { savingsText } from '../derive.js'

/**
 * The change a finding suggests, as the last row of a card summary, so a reader sees it while the card
 * is closed and before any command. The Improvements cards and the Overview cards share it. '' when a
 * row has none (an aggregate written before cross findings carried a recommendation).
 */
export function improvementLead(text: string | undefined, audience: Audience): string {
  return text ? `<span class="rec sg-lead"><b>Improvement:</b> ${esc(plainSentence(text, audience))}</span>` : ''
}

export interface FindingOpts {
  /** the exact `claude "/orangu:improve …"` handoff for this finding (commandForInsight) */
  command?: string
  /** the session's total tokens, so the savings pill can be a share of it */
  sessionTotalTokens?: number
  /** the hoisted top-finding card: rendered open, with an evidence deep link */
  open?: boolean
  link?: { href: string; label: string }
  /** the top card only: a link to the 3 steps on the Improvements screen (built by the hash writer) */
  how?: string
}

export function findingHtml(ins: Insight, audience: Audience, opts: FindingOpts = {}): string {
  const share = savingsShare(ins.savings, opts.sessionTotalTokens, ins.ruleId)
  const pill = audience === 'plain' ? '' : `<span class="pill">${esc(ins.ruleId)}</span>`
  // the evidence link (top card) replaces the turns button; never both
  const turnsBtn =
    ins.turnIndexes.length && audience !== 'plain' && !opts.link
      ? `<div style="margin-top:10px"><button class="btn-sm" data-turns="${esc(ins.turnIndexes.join(','))}">Show ${plural(ins.turnIndexes.length, 'turn')} →</button></div>`
      : ''
  // Under the default redaction Insight.detail is '' (transcript-derived copy); never render an empty <p>.
  const detail = ins.detail ? `<p>${esc(plainSentence(ins.detail, audience))}</p>` : ''
  const cmd = opts.command
    ? `<div class="fcmd"><div class="eyebrow">Get an AI proposal</div>${commandBlock(opts.command)}<div class="small">${pasteLine()}${opts.how ? ` <a href="${esc(opts.how)}">See the 3 steps →</a>` : ''}</div></div>`
    : ''
  const link = opts.link ? `<div style="margin-top:10px"><a class="btn-sm" href="${esc(opts.link.href)}">${esc(opts.link.label)}</a></div>` : ''
  return `<details class="finding${opts.open ? ' top' : ''}"${opts.open ? ' open' : ''}>
<summary><span class="chev" aria-hidden="true">▸</span><span class="sev ${esc(ins.severity)}" title="${esc(ins.severity)}"></span><b>${esc(plainSentence(ins.title, audience))}</b>${share ? `<span class="fsave" title="${esc(share.title)}">${esc(share.text)}</span>` : ''}${pill}${improvementLead(ins.recommendation, audience)}</summary>
<div class="fbody">
${detail}
${link}${turnsBtn}
${cmd}
</div>
</details>`
}
