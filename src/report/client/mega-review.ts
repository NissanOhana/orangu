/**
 * The whole-harness review block: one card, three steps, one primary copy control. Shared by
 * serve-ui.ts and agg-ui.ts and reaching the screen only through the injected Ctx.megaReview seam
 * (app.ts), so screens/suggest.ts never imports it and its bytes stay out of the byte-pinned
 * file-mode bundle. A session report has no aggregate and so can never render it.
 *
 * Every string here is a literal: the block interpolates no repo name, no path and no scope label,
 * only the word `repo` or `global` and the fixed command, so a redacted aggregate renders it
 * identically. The .cmd bar stays beside the button because it is the fallback when the clipboard
 * is unavailable: the command must remain visible and selectable.
 */
import { commandBlock, pasteLine } from './components/command.js'
import { esc } from './format.js'
import { harnessCommand } from './suggest-rows.js'

const REVIEW_ONLY = 'Global scope is for review only. Claude applies nothing.'

export function megaReview(scope: 'repo' | 'global'): string {
  const command = harnessCommand(scope)
  const repo = scope === 'repo'
  const title = repo ? 'Improve the harness of this repository with one command.' : 'Review every harness on this machine with one command.'
  const sub = 'Claude Code reads the evidence. It ranks a plan of changes to your instructions, skills, hooks, agents and scripts. Then it waits for your approval.' + (repo ? '' : ` ${REVIEW_ONLY}`)
  const plan = repo ? 'Review the ranked plan. Approve the items that you want. Claude applies them.' : `Review the ranked plan. ${REVIEW_ONLY}`
  return `<div class="card pad mb16"><div class="eyebrow">Whole-harness review</div><div class="herotitle">${title}</div><div class="sg-sub">${sub}</div><ol class="steps" aria-label="Run the whole-harness review">
<li><div><button type="button" class="btn-primary" data-copy="${esc(command)}" aria-live="polite">Copy the whole-harness command</button><div class="sg-cmd">${commandBlock(command)}</div></div></li>
<li><span>${pasteLine(undefined, repo)}</span></li>
<li><span>${plan}</span></li>
</ol><p class="small muted sg-foot">This button only copies text. Claude asks before it reads a large input.</p></div>`
}
