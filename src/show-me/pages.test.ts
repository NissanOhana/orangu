/**
 * The slot rules as code: what each slot shows, from which field, and what a missing field does.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NO_CHANGE } from '../analyze/insights.js'
import type { Analysis } from '../model/analysis.js'
import { projectEvidence } from '../suggest/evidence.js'
import { slimAnalysis } from '../suggest/slim.js'
import { escapeHtml, fillTemplate, type Page } from './fill.js'
import { REPORT_HTML, SLIDES_HTML } from './generated/templates.js'
import { aggregatePage, sessionPage } from './pages.js'
import { wordFindings, type Words } from './words.js'

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')
const golden = (name: string): Analysis => JSON.parse(read(`test/golden/${name}.analysis.json`)) as Analysis
const WORDS: Words = { verdict: 'The session ended on a failing test run.', summary: 'The session changed 1 file.', improvementsTitle: 'Two changes for the next session' }
const evidence = () => projectEvidence(JSON.parse(read('test/golden/aggregate.json')), { scope: 'repo' })
type Finding = ReturnType<typeof evidence>['findings'][number]
const slotTexts = (html: string, slot: string): string[] => [...html.matchAll(new RegExp(`data-slot="${slot}"[^>]*>([^<]*)<`, 'g'))].map((m) => m[1]!)
const both = (page: Page): string[] => [fillTemplate(SLIDES_HTML, page), fillTemplate(REPORT_HTML, page)]

describe('show-me session page', () => {
  const a = slimAnalysis(golden('errors-and-interrupts'))
  const top = a.summary.topInsightIds.map((id) => a.insights.find((i) => i.id === id)!).slice(0, 3)

  it('shows the improvement, not the joined recommendation, and the reason from why', () => {
    expect(top.some((i) => i.improvement !== i.recommendation), 'the fixture has a split rule text').toBe(true)
    for (const html of both(sessionPage(a, WORDS))) {
      expect(slotTexts(html, 'f-improvement')).toEqual(top.map((i) => escapeHtml(i.improvement)))
      expect(slotTexts(html, 'f-why')).toEqual(top.filter((i) => i.why !== undefined).map((i) => escapeHtml(i.why!)))
    }
  })

  it('lists each whole improvement, skips a "No change needed." text, and leaves out a missing why', () => {
    const quiet = { ...a.insights[0]!, id: 'quiet', improvement: `${NO_CHANGE} If it recurs, look again.`, why: undefined }
    const page = sessionPage({ ...a, insights: [...a.insights, quiet], summary: { ...a.summary, topInsightIds: ['quiet', ...a.summary.topInsightIds] } }, WORDS)
    const [slides] = both(page)
    const items = slotTexts(slides!, 'i-text')
    // the shown findings first, then the rest in analysis order; the template shows up to 5 (data-max)
    const order = [quiet, top[0]!, top[1]!, ...a.insights.filter((i) => i !== top[0] && i !== top[1])]
    expect(items).toEqual(order.filter((i) => !i.improvement.startsWith(NO_CHANGE)).map((i) => escapeHtml(i.improvement)).slice(0, 5))
    expect(items.some((text) => text.startsWith(NO_CHANGE))).toBe(false)
    // the finding with no why has no why element; the others keep theirs
    expect(slotTexts(slides!, 'f-why')).toHaveLength(top.slice(0, 2).filter((i) => i.why !== undefined).length)
  })

  it('falls back to the recommendation when an older analysis has no improvement', () => {
    const old = a.insights.map((i) => ({ ...i, improvement: undefined as unknown as string }))
    for (const html of both(sessionPage({ ...a, insights: old }, WORDS))) expect(slotTexts(html, 'f-improvement')).toEqual(top.map((i) => escapeHtml(i.recommendation)))
  })

  it('sets data-end on the quality card from how the session ended', () => {
    for (const ending of ['clean', 'failing', 'interrupted', 'unknown'] as const) {
      for (const html of both(sessionPage({ ...a, summary: { ...a.summary, ending } }, WORDS))) expect(html).toContain(`<div class="ax q" data-end="${ending}">`)
    }
  })
})

describe('show-me repo and global pages', () => {
  const e = evidence()
  const top = e.findings.slice(0, 3)

  it('titles each finding with the example title, under the fixed "In one session" label', () => {
    expect(top.every((f) => f.exampleTitle !== undefined && f.finding.title === `In one session: ${f.exampleTitle}`)).toBe(true)
    for (const scope of ['repo', 'global'] as const) {
      for (const html of both(aggregatePage(e, scope, { folder: 'demo', version: '1', words: WORDS }))) {
        expect(slotTexts(html, 'f-title')).toEqual(top.map((f) => escapeHtml(f.exampleTitle!)))
        expect(html.match(/<p class="lb[^"]*" data-if="aggregate">In one session<\/p>/g)).toHaveLength(top.length)
      }
    }
    // a session page has no such label
    for (const html of both(sessionPage(slimAnalysis(golden('errors-and-interrupts')), WORDS))) expect(html).not.toContain('In one session')
  })

  it('falls back to the title, the recommendation and the fixed text when a part is missing, and leaves out a missing why', () => {
    const strip = (f: Finding, keep: 'recommendation' | 'none'): Finding => {
      const { exampleTitle: _t, improvement: _i, why: _w, recommendation, ...rest } = f
      return keep === 'recommendation' && recommendation !== undefined ? { ...rest, recommendation } : rest
    }
    const older = { ...e, findings: [strip(top[0]!, 'recommendation'), strip(top[1]!, 'none'), ...e.findings.slice(2)] }
    for (const html of both(aggregatePage(older, 'repo', { folder: 'demo', version: '1', words: WORDS }))) {
      expect(slotTexts(html, 'f-title').slice(0, 2)).toEqual([escapeHtml(top[0]!.finding.title), escapeHtml(top[1]!.finding.title)])
      expect(slotTexts(html, 'f-improvement').slice(0, 2)).toEqual([escapeHtml(top[0]!.recommendation!), 'No improvement text in this evidence.'])
      expect(slotTexts(html, 'f-why')).toHaveLength(top.length - 2)
    }
  })
})

describe('show-me words', () => {
  it('gives an STE finding on a long verdict, as advice, and none on clean words', () => {
    expect(wordFindings(WORDS)).toEqual([])
    const long = { ...WORDS, verdict: `The session read ${'one more file and '.repeat(8)}then it stopped on a failing test run.` }
    const findings = wordFindings(long)
    expect(findings.map(({ slot, rule }) => `${slot} ${rule}`)).toEqual(['verdict sentence-length'])
    // the checker quotes the start of a long sentence; the render itself keeps every word
    expect(long.verdict.startsWith(findings[0]!.text.replace(/\.\.\.$/, ''))).toBe(true)
    expect(findings[0]!.hint).toBe('43 words: split it (limit 25)')
  })
})
