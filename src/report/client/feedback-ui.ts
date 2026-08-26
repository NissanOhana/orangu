/** Serve-only beta feedback form. This file is reachable only from serve-entry.ts. */
import { esc } from './format.js'
import { h } from './dom.js'
import {
  FEEDBACK_CATEGORIES,
  emptyFeedbackDraft,
  feedbackComposer,
  isFeedbackContext,
  renderFeedbackReport,
  type FeedbackComposer,
  type FeedbackContext,
  type FeedbackDraft,
  type FeedbackReport,
} from '../../feedback/model.js'

interface FeedbackUiState {
  context: FeedbackContext
  draft: FeedbackDraft
  preview?: FeedbackReport
  reviewed: boolean
}

let state: FeedbackUiState = { context: 'app', draft: emptyFeedbackDraft(), reviewed: false }

function requestedContext(): FeedbackContext {
  const match = /(?:[?&])context=([^&]+)/.exec(location.hash)
  let raw = 'app'
  try {
    if (match?.[1]) raw = decodeURIComponent(match[1])
  } catch {
    /* malformed hash context falls back to app */
  }
  return isFeedbackContext(raw) ? raw : 'app'
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function copyText(value: string, button: HTMLButtonElement): void {
  const done = (): void => {
    const old = button.textContent
    button.textContent = 'copied'
    setTimeout(() => (button.textContent = old), 1_200)
  }
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(value).then(done, done)
  else {
    const area = document.createElement('textarea')
    area.value = value
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
    } catch {
      /* The complete report remains visible for manual copying. */
    }
    area.remove()
    done()
  }
}

function feedbackView(): HTMLElement {
  const context = requestedContext()
  if (state.context !== context) state = { context, draft: emptyFeedbackDraft(), reviewed: false }
  const boot = window.__ORANGU_SERVE__?.feedback
  const diagnostics = {
    version: boot?.version ?? window.__ORANGU_SERVE__?.version ?? 'unknown',
    nodeMajor: boot?.nodeMajor ?? 'unknown',
    osFamily: boot?.osFamily ?? ('other' as const),
    arch: boot?.arch ?? ('other' as const),
    surface: 'localhost' as const,
    context,
  }
  const categoryOptions = FEEDBACK_CATEGORIES.map(
    (category) => `<option value="${category}"${state.draft.category === category ? ' selected' : ''}>${category}</option>`,
  ).join('')
  const el = h(`<section class="feedback">
    <div class="banner info"><b>Private until you choose otherwise.</b>&nbsp; Nothing from a session or report is attached. Opening the reviewed composer sends only the preview below to GitHub.</div>
    <div class="card pad mb16">
      <div class="card-title">Rant about the beta</div>
      <p class="narrative">Be blunt. What was confusing, broken, slow, or unexpectedly good?</p>
      <div class="feedback-grid">
        <label>Short summary<input id="fb-summary" maxlength="240" value="${esc(state.draft.summary)}" placeholder="What should we fix first?"></label>
        <label>Category<select id="fb-category">${categoryOptions}</select></label>
      </div>
      <label>Your experience<textarea id="fb-rant" rows="7" placeholder="Rant here…">${esc(state.draft.rant)}</textarea></label>
      <label>What did you expect?<textarea id="fb-expected" rows="3">${esc(state.draft.expected)}</textarea></label>
      <label>How can we reproduce it? <span class="muted">optional</span><textarea id="fb-reproduction" rows="3">${esc(state.draft.reproduction)}</textarea></label>
      <button type="button" class="btn" id="fb-preview">Review exact report</button>
    </div>
    <div class="card pad mb16" id="fb-review">
      <div class="card-title">Exact GitHub prefill</div>
      <p class="small muted" id="fb-review-status">Review the title, body, and generic diagnostics before anything can leave localhost.</p>
      <div class="eyebrow">Title</div><pre class="feedback-preview" id="fb-title-preview"></pre>
      <div class="eyebrow">Body</div><pre class="feedback-preview" id="fb-body-preview"></pre>
      <label class="feedback-check"><input type="checkbox" id="fb-reviewed"> I reviewed this exact report and want to send its prefill to GitHub.</label>
      <button type="button" class="btn" id="fb-send">Send reviewed prefill to GitHub</button>
      <div id="fb-fallback"></div>
    </div>
  </section>`)

  const summary = el.querySelector<HTMLInputElement>('#fb-summary')!
  const category = el.querySelector<HTMLSelectElement>('#fb-category')!
  const rant = el.querySelector<HTMLTextAreaElement>('#fb-rant')!
  const expected = el.querySelector<HTMLTextAreaElement>('#fb-expected')!
  const reproduction = el.querySelector<HTMLTextAreaElement>('#fb-reproduction')!
  const reviewed = el.querySelector<HTMLInputElement>('#fb-reviewed')!
  const send = el.querySelector<HTMLButtonElement>('#fb-send')!
  const titlePreview = el.querySelector<HTMLElement>('#fb-title-preview')!
  const bodyPreview = el.querySelector<HTMLElement>('#fb-body-preview')!
  const status = el.querySelector<HTMLElement>('#fb-review-status')!
  const fallback = el.querySelector<HTMLElement>('#fb-fallback')!

  const readDraft = (): FeedbackDraft => ({
    summary: summary.value,
    category: FEEDBACK_CATEGORIES.includes(category.value as FeedbackDraft['category']) ? (category.value as FeedbackDraft['category']) : 'other',
    rant: rant.value,
    expected: expected.value,
    reproduction: reproduction.value,
  })
  const invalidate = (): void => {
    state.draft = readDraft()
    state.preview = undefined
    state.reviewed = false
    reviewed.checked = false
    reviewed.disabled = true
    send.disabled = true
    titlePreview.textContent = ''
    bodyPreview.textContent = ''
    fallback.replaceChildren()
    status.textContent = 'Draft changed. Review the exact report again.'
  }
  for (const input of [summary, category, rant, expected, reproduction]) input.addEventListener('input', invalidate)
  category.addEventListener('change', invalidate)

  const paint = (): FeedbackComposer | undefined => {
    const report = state.preview
    titlePreview.textContent = report?.title ?? ''
    bodyPreview.textContent = report?.body ?? ''
    reviewed.disabled = !report
    reviewed.checked = Boolean(report && state.reviewed)
    send.disabled = !report || !state.reviewed
    fallback.replaceChildren()
    if (!report) return undefined
    const target = feedbackComposer(report)
    status.textContent =
      target.kind === 'composer'
        ? `The encoded prefill is ${target.encodedLength.toLocaleString()} characters. Opening it sends this title and body to GitHub.`
        : `The complete prefill is ${target.encodedLength.toLocaleString()} characters; too large for a reliable URL. Nothing was dropped.`
    if (target.kind === 'oversized' && state.reviewed) {
      send.disabled = true
      const complete = `${report.title}\n\n${report.body}`
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.className = 'btn-sm'
      copy.textContent = 'Copy complete report'
      copy.addEventListener('click', () => copyText(complete, copy))
      const blank = document.createElement('button')
      blank.type = 'button'
      blank.className = 'btn-sm'
      blank.textContent = 'Open blank GitHub issue'
      blank.addEventListener('click', () => openExternal(target.blankUrl))
      fallback.append(copy, blank)
    }
    return target
  }

  el.querySelector<HTMLButtonElement>('#fb-preview')!.addEventListener('click', () => {
    state.draft = readDraft()
    state.preview = renderFeedbackReport(state.draft, diagnostics)
    state.reviewed = false
    paint()
  })
  reviewed.addEventListener('change', () => {
    state.reviewed = Boolean(state.preview && reviewed.checked)
    paint()
  })
  send.addEventListener('click', () => {
    if (!state.reviewed || !state.preview) return
    const target = feedbackComposer(state.preview)
    if (target.kind === 'composer') openExternal(target.url)
  })
  paint()
  return el
}

export function isFeedbackLocation(): boolean {
  return /^#feedback(?:[?]|$)/.test(location.hash)
}

export function mountFeedback(): void {
  const app = document.getElementById('app')
  if (!app) return
  app.className = 'app feedback-root'
  app.replaceChildren()
  const shell = h(`<main class="feedback-shell"><header class="page-head"><div><h1>Beta feedback</h1><div class="sub">rant locally · review exactly what will be shared</div></div><a class="btn" href="#overview">Back to Orangu</a></header></main>`)
  shell.appendChild(feedbackView())
  app.appendChild(shell)
  document.title = 'orangu · beta feedback'
}

export function mountFeedbackLauncher(): void {
  if (document.getElementById('feedback-launch')) return
  const link = document.createElement('a')
  link.id = 'feedback-launch'
  link.className = 'feedback-launch'
  link.href = '#feedback?context=app'
  link.textContent = 'Beta feedback'
  link.setAttribute('aria-label', 'Open beta feedback')
  document.body.appendChild(link)
}
