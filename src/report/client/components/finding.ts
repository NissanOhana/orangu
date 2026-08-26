/**
 * The shared Finding component: <details> with severity dot, title, mono save, rule pill;
 * body = detail + recommendation box + "Show N turns →". Plain audience hides the rule pill and maps
 * vocabulary. The app wires [data-turns] buttons to the timeline.
 */
import type { Insight } from '../../../model/analysis.js'
import { esc, ms, tok } from '../format.js'
import { plainSentence, type Audience } from '../strings.js'

export function savingsText(s: Insight['savings']): string {
  if (!s) return ''
  const est = s.estimated ? '~' : ''
  if (s.tokens) return `save ${est}${tok(s.tokens)} tokens`
  if (s.ms) return `save ${est}${ms(s.ms)}`
  return ''
}

export function findingHtml(ins: Insight, audience: Audience): string {
  const save = savingsText(ins.savings)
  const pill = audience === 'plain' ? '' : `<span class="pill">${esc(ins.ruleId)}</span>`
  const turnsBtn =
    ins.turnIndexes.length && audience !== 'plain'
      ? `<div style="margin-top:10px"><button class="btn-sm" data-turns="${esc(ins.turnIndexes.join(','))}">Show ${ins.turnIndexes.length} turn${ins.turnIndexes.length > 1 ? 's' : ''} →</button></div>`
      : ''
  return `<details class="finding">
    <summary><span class="chev" aria-hidden="true">▸</span><span class="sev ${esc(ins.severity)}" title="${esc(ins.severity)}"></span><b>${esc(plainSentence(ins.title, audience))}</b>${save ? `<span class="fsave">${esc(save)}</span>` : ''}${pill}</summary>
    <div class="fbody">
      <p>${esc(plainSentence(ins.detail, audience))}</p>
      <div class="rec">${esc(plainSentence(ins.recommendation, audience))}</div>
      ${turnsBtn}
    </div>
  </details>`
}
