import { describe, expect, it } from 'vitest'
import {
  GITHUB_NEW_ISSUE_URL,
  feedbackComposer,
  renderFeedbackReport,
  type FeedbackDiagnostics,
  type FeedbackDraft,
} from './model.js'

const draft: FeedbackDraft = {
  summary: 'The preview ate my emoji 🤧',
  category: 'bug',
  rant: 'I wanted to rant.\r\nNothing should be dropped.',
  expected: 'Keep 雪 and 🤧 intact.',
  reproduction: 'Open the local form.',
}
const diagnostics: FeedbackDiagnostics = {
  version: '0.5.0',
  nodeMajor: '22',
  osFamily: 'macOS',
  arch: 'arm64',
  context: 'session',
  surface: 'localhost',
}

describe('beta feedback contract', () => {
  it('renders one deterministic, allowlisted report', () => {
    const report = renderFeedbackReport(draft, diagnostics)
    expect(report.title).toBe('[beta feedback] The preview ate my emoji 🤧')
    expect(report.body).toContain('I wanted to rant.\nNothing should be dropped.')
    expect(report.body).toContain('- Area: session')
    expect(report.body).toContain('- Orangu: 0.5.0')
    expect(report.body).not.toContain('session-id')
  })

  it('round-trips the exact Unicode preview through the GitHub composer URL', () => {
    const report = renderFeedbackReport(draft, diagnostics)
    const target = feedbackComposer(report)
    expect(target.kind).toBe('composer')
    if (target.kind !== 'composer') return
    const opened = new URL(target.url)
    expect(opened.origin + opened.pathname).toBe(GITHUB_NEW_ISSUE_URL)
    expect(opened.searchParams.get('title')).toBe(report.title)
    expect(opened.searchParams.get('body')).toBe(report.body)
  })

  it('does not split a supplementary Unicode character at the title boundary', () => {
    const report = renderFeedbackReport({ ...draft, summary: 'a'.repeat(159) + '🤧tail' }, diagnostics)
    expect(report.title).toBe('[beta feedback] ' + 'a'.repeat(159) + '🤧')
    expect(() => encodeURIComponent(report.title)).not.toThrow()
  })

  it('never truncates an oversized report', () => {
    const report = renderFeedbackReport({ ...draft, rant: '🤧'.repeat(8_000) }, diagnostics)
    const target = feedbackComposer(report, 500)
    expect(target.kind).toBe('oversized')
    expect(target.report.body).toBe(report.body)
    expect(target.report.body).toContain('🤧'.repeat(100))
  })

  it('cannot serialize unexpected report, path, environment, or error properties', () => {
    const hostile = {
      ...diagnostics,
      sessionId: 'private-session-id',
      cwd: '/private-workspace/project',
      env: 'SECRET=1',
      error: 'private stack',
    }
    const text = JSON.stringify(renderFeedbackReport(draft, hostile))
    for (const secret of ['private-session-id', '/private-workspace/project', 'SECRET=1', 'private stack']) expect(text).not.toContain(secret)
  })
})
