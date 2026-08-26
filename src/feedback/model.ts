/**
 * Browser-safe beta-feedback contract. This module deliberately accepts only an
 * explicit draft and a small diagnostic allowlist; it has no access to reports,
 * sessions, paths, environment variables, or network APIs.
 */
export const FEEDBACK_CONTEXTS = ['session', 'repo', 'global', 'report', 'app'] as const
export type FeedbackContext = (typeof FEEDBACK_CONTEXTS)[number]

export const FEEDBACK_CATEGORIES = ['bug', 'confusing', 'missing', 'slow', 'delight', 'other'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

export interface FeedbackDraft {
  summary: string
  category: FeedbackCategory
  rant: string
  expected: string
  reproduction: string
}

export interface FeedbackDiagnostics {
  version: string
  nodeMajor: string
  osFamily: 'macOS' | 'Windows' | 'Linux' | 'other'
  arch: 'arm64' | 'x64' | 'other'
  context: FeedbackContext
  surface: 'localhost'
}

export interface FeedbackReport {
  title: string
  body: string
}

export const GITHUB_NEW_ISSUE_URL = 'https://github.com/NissanOhana/orangu/issues/new'
/** Conservative ceiling below common browser/proxy request-line limits. */
const MAX_FEEDBACK_COMPOSER_URL_LENGTH = 7_500

export type FeedbackComposer =
  | { kind: 'composer'; url: string; encodedLength: number; report: FeedbackReport }
  | { kind: 'oversized'; blankUrl: string; encodedLength: number; report: FeedbackReport }

export function isFeedbackContext(value: unknown): value is FeedbackContext {
  return typeof value === 'string' && (FEEDBACK_CONTEXTS as readonly string[]).includes(value)
}

export function emptyFeedbackDraft(): FeedbackDraft {
  return { summary: '', category: 'bug', rant: '', expected: '', reproduction: '' }
}

function clean(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

function section(title: string, value: string): string {
  const text = clean(value)
  return `## ${title}\n\n${text || '_Not provided._'}`
}

export function renderFeedbackReport(draft: FeedbackDraft, diagnostics: FeedbackDiagnostics): FeedbackReport {
  const summary = clean(draft.summary).replace(/\s+/g, ' ')
  const fallback = `${draft.category} · ${diagnostics.context}`
  // Slice Unicode code points rather than UTF-16 code units so the boundary can never
  // split an emoji (or another supplementary character) into an invalid title.
  const title = `[beta feedback] ${[...(summary || fallback)].slice(0, 160).join('')}`
  const body = [
    section('Experience', draft.rant),
    section('What I expected', draft.expected),
    section('How to reproduce', draft.reproduction),
    '## Context\n\n' + `- Area: ${diagnostics.context}\n- Category: ${draft.category}`,
    '## Diagnostics (reviewed)\n\n' +
      `- Orangu: ${diagnostics.version}\n- Node: ${diagnostics.nodeMajor}\n- OS: ${diagnostics.osFamily}\n- Architecture: ${diagnostics.arch}\n- Surface: ${diagnostics.surface}`,
  ].join('\n\n')
  return { title, body }
}

export function feedbackComposer(report: FeedbackReport, maxLength = MAX_FEEDBACK_COMPOSER_URL_LENGTH): FeedbackComposer {
  const query = new URLSearchParams({ title: report.title, body: report.body }).toString()
  const url = `${GITHUB_NEW_ISSUE_URL}?${query}`
  const encodedLength = url.length
  if (encodedLength > maxLength) return { kind: 'oversized', blankUrl: GITHUB_NEW_ISSUE_URL, encodedLength, report }
  return { kind: 'composer', url, encodedLength, report }
}
