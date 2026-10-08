import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { buildCanonicalSession, SessionBuilder } from '../../test/fixtures/session-builder.js'
import type { Analysis } from '../model/analysis.js'
import type { SessionRef } from '../discover/discover.js'
import { SuggestionStore } from '../suggest/store.js'
import { MACHINE_CAPS, displayWidth, stripAnsi, type Caps } from './tty.js'
import { aggregateBlock, aggregateOffer, analysisBlock, betaLine, briefBlock, doneLine, fmtAge, listRows, nextStepLines, pickFrame, pickList, reportFooter, row, rows, valueBudget, type NextStep, type PickRow } from './summary.js'
import { persistNextStep } from './next-step.js'
import { aggregate } from '../analyze/aggregate.js'
import { outcomeHeadline } from '../report/client/derive.js'

async function analyzed(b: SessionBuilder): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}

/** a session whose insights exist and whose titles are long enough to need truncation */
function heavyBuilder(): SessionBuilder {
  const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', startAt: '2026-08-14T09:00:00.000Z' })
  b.userPrompt('日本語のタイトル: refactor every module and run the tests until green, please, and then do it all again for the docs ' + 'x'.repeat(60))
  b.tick(1000)
  for (let t = 0; t < 12; t++) {
    b.toolCall('Read', { file_path: '/repo/src/very/long/path/to/the/same/file/that/keeps/being/read/again/and/again.ts' }, 'contents '.repeat(400), { durationMs: 300 })
    b.tick(200)
  }
  b.assistant([{ type: 'text', text: 'done' }], { usage: { input_tokens: 8, cache_read_input_tokens: 90_000, output_tokens: 30 } })
  return b
}

const OPAQUE = /[A-Za-z0-9_-]{80,}/

function capsAt(columns: number, over: Partial<Caps> = {}): Caps {
  return { tty: true, color: 2, animate: true, hyperlinks: true, columns, unicode: true, ...over }
}

const VARIANTS: Array<[string, Caps]> = [
  ['80 cols colour', capsAt(80)],
  ['80 cols ascii', capsAt(80, { unicode: false, color: 0, hyperlinks: false })],
  ['40 cols colour', capsAt(40)],
  ['40 cols ascii', capsAt(40, { unicode: false, color: 0 })],
  ['200 cols', capsAt(200)],
  ['machine', MACHINE_CAPS],
]

const IMPROVEMENT = 'Read each file once in a context. Keep notes on what it holds. To find a part of it again, use Grep with line ranges.'
const STEP: NextStep = { finding: 'Subagent results re-read in full', improvement: IMPROVEMENT, next: 'claude "/orangu:improve sg_0f0f0f0f0f0f"' }
const FALLBACK: NextStep = {
  finding: 'Subagent results re-read in full',
  improvement: IMPROVEMENT,
  storeNote: 'EACCES: permission denied, mkdir',
  next: 'claude "/orangu:improve sg_0f0f0f0f0f0f --finding ' + 'eyJ'.repeat(160) + '"',
}
/** the value column of a labelled row: 2-space indent, 8-column label, 1 space */
const GUTTER = ' '.repeat(11)
const HOSTILE = 'Fix \x1b]52;c;SGVsbG8=\x07the \x1b[2Jtitle'
const ESCAPE_BYTES = /[\x1b\x07\x80-\x9f]/

/** rows a paste must carry whole (the paths, the next, plugin and beta commands) wrap below 80 columns */
const RAW_ROWS = /^ {2}(report|next|plugin|written|beta) {2,}\S/

function assertFits(lines: string[], caps: Caps, label: string): void {
  const limit = Math.min(caps.columns, 80)
  for (const l of lines) {
    if (!(caps.columns < 80 && RAW_ROWS.test(stripAnsi(l)))) expect(displayWidth(l), `${label}: ${JSON.stringify(stripAnsi(l))}`).toBeLessThanOrEqual(limit)
    expect(stripAnsi(l), `${label} carries an opaque token`).not.toMatch(OPAQUE)
    expect(l).not.toContain('\r')
  }
}

describe('summary renderers fit the layout', () => {
  it.each(VARIANTS)('analysisBlock, briefBlock, reportFooter, listRows at %s', async (label, caps) => {
    const a = await analyzed(heavyBuilder())
    expect(a.insights.length).toBeGreaterThan(0)
    const title = a.session.title || a.session.id
    assertFits(analysisBlock(caps, a, title), caps, label + ' analysisBlock')
    assertFits(briefBlock(caps, a, title, STEP, { hint: true }), caps, label + ' briefBlock')
    // the macOS default report path is exactly the 69-column budget; below 80 columns the path and
    // the two commands (never cut) are the documented exceptions, which assertFits skips there
    const footer = reportFooter(caps, { path: '/var/folders/1x/5tq6y5g95l5c2vxg2l7nzf9w0000gn/T/orangu-bbbbbbbb.html', opened: true, step: STEP })
    assertFits(footer, caps, label + ' reportFooter')
    const refs: SessionRef[] = [
      { sessionId: a.session.id, path: '/p/a.jsonl', projectSlug: '-Users-me-Code-a-very-long-project-directory-name-that-goes-on-and-on', projectPath: '/p', sizeBytes: 7_200_000, mtimeMs: 1_700_000_000_000, hasSidecarDir: true, subagentFiles: ['x', 'y'] },
      { sessionId: '22222222-0000-4000-8000-00000000bbbb', path: '/p/b.jsonl', projectSlug: '-Users-me-demo', projectPath: '/p', sizeBytes: 12_000, mtimeMs: 1_700_000_000_000, hasSidecarDir: false, subagentFiles: [] },
    ]
    // the list's fixed cells (id, when, size, agents) need 52 columns; the project cell yields first
    if (caps.columns >= 60) assertFits(listRows(caps, refs, { total: 2, global: false }), caps, label + ' listRows')
    assertFits(listRows(caps, [], { total: 0, global: true }), caps, label + ' listRows empty')
    assertFits([...doneLine(caps, { sizeBytes: 7_200_000, elapsedMs: 1400, redactions: 3 }).split('\n'), betaLine(caps, 'report')], caps, label + ' done/beta')
  })

  it('a clean session says so and names no command', () => {
    const lines = nextStepLines(capsAt(80), {})
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]!)).toBe('  finding  none: this session ran clean')
  })

  it('the footer prints the short command and never a --finding payload', () => {
    const text = reportFooter(capsAt(80), { path: '/tmp/r.html', opened: false, step: STEP }).map(stripAnsi).join('\n')
    expect(text).toContain('  next     claude "/orangu:improve sg_0f0f0f0f0f0f"')
    expect(text).not.toContain(' --finding ')
    expect(text).toContain('  plugin   /plugin marketplace add NissanOhana/orangu')
    expect(text).toContain('           /plugin install orangu    (once, inside Claude Code)')
    expect(text.split('\n').at(-1)).toBe('  beta     orangu feedback --context report')
  })

  it('below 51 columns the next and plugin commands wrap whole instead of being cut', () => {
    const lines = nextStepLines(capsAt(40, { color: 0 }), STEP)
    const next = lines.findIndex((l) => l.startsWith('  next     '))
    expect(lines[next]).toBe('  next     claude "/orangu:improve sg_0f0f0f0f0f0f"')
    expect(lines[next + 1]).toBe('  plugin   /plugin marketplace add NissanOhana/orangu')
    // the install continuation fits at 40 columns on its own, so it drops only its dim note
    expect(lines[next + 2]).toBe('           /plugin install orangu')
    // the finding title wraps under itself at the 29-column budget: no word is cut, no ellipsis
    expect(lines.slice(0, 2)).toEqual(['  finding  Subagent results re-read in', GUTTER + 'full'])
    // the beta hint is a command too: whole at 40 columns, and wider than the 29-column budget
    expect(stripAnsi(betaLine(capsAt(40), 'report'))).toBe('  beta     orangu feedback --context report')
  })

  it('the finding row prints the whole title and no ellipsis, at every width', () => {
    const title = '3 files re-read within one context (12 redundant reads, 3.92M tokens)'
    for (const [label, caps] of VARIANTS) {
      const lines = nextStepLines(caps, { ...STEP, finding: title }).map(stripAnsi)
      const improvement = lines.findIndex((l) => l.startsWith(GUTTER + 'Improvement: '))
      const titleLines = lines.slice(0, improvement)
      expect(titleLines[0], label).toMatch(/^ {2}finding {2}\S/)
      for (const l of titleLines.slice(1)) expect(l, label).toMatch(/^ {11}\S/)
      expect(titleLines.map((l) => l.slice(11)).join(' '), label).toBe(title)
      expect(titleLines.join('\n'), label).not.toMatch(/…|\.\.\./)
    }
  })

  it('prints the improvement as continuation lines directly above the next row', () => {
    for (const [label, caps] of VARIANTS) {
      const lines = nextStepLines(caps, STEP).map(stripAnsi)
      const next = lines.findIndex((l) => l.startsWith('  next     '))
      const first = lines.findIndex((l) => l.startsWith(GUTTER + 'Improvement: '))
      expect(first, label).toBeGreaterThan(0)
      // every line from the first Improvement line up to the next row is one continuation of it
      const block = lines.slice(first, next)
      for (const l of block) expect(l, label).toMatch(/^ {11}\S/)
      expect(block.map((l) => l.slice(11)).join(' '), label).toBe('Improvement: ' + IMPROVEMENT)
      expect(lines[next - 1], label).toBe(block.at(-1))
    }
    // without an improvement, the next row follows the title directly
    const bare = nextStepLines(capsAt(80, { color: 0 }), { finding: 'Short title', next: STEP.next })
    expect(bare.slice(0, 2)).toEqual(['  finding  Short title', '  next     claude "/orangu:improve sg_0f0f0f0f0f0f"'])
  })

  it('wraps a title and an improvement at whole words only, so a separator glyph inside them is never dropped', async () => {
    // the probe: in ASCII the separator is " | ", and a title that holds it used to lose it at the line break
    const title = "Agent type 'build | lint' is the most used · subagent type in this session"
    const improvement = "Split the 'build | lint' agent · into one agent per step, and run each one alone."
    const a = await analyzed(heavyBuilder())
    const { savings: _savings, ...first } = a.insights[0]!
    const one: Analysis = { ...a, insights: [{ ...first, title }] }
    for (const caps of [capsAt(40, { unicode: false, color: 0 }), capsAt(40, { color: 0 })]) {
      const label = caps.unicode ? 'unicode' : 'ascii'
      const lines = nextStepLines(caps, { finding: title, improvement, next: STEP.next })
      const imp = lines.findIndex((l) => l.startsWith(GUTTER + 'Improvement: '))
      const next = lines.findIndex((l) => l.startsWith('  next     '))
      expect(lines.slice(0, imp).map((l) => l.slice(11)).join(' '), label).toBe(title)
      expect(lines.slice(imp, next).map((l) => l.slice(11)).join(' '), label).toBe('Improvement: ' + improvement)
      // the analyze findings list
      const block = analysisBlock(caps, one, 'T')
      const head = block.findIndex((l) => /^ {4}(●|\*) /.test(l))
      const titleLines = [block[head]!.slice(6)]
      for (let i = head + 1; block[i]; i++) titleLines.push(block[i]!.slice(6))
      expect(titleLines.join(' '), label).toBe(title)
    }
  })

  it('strips escapes from a transcript title before the finding row prints it', () => {
    const lines = nextStepLines(capsAt(40, { color: 0 }), { ...STEP, finding: HOSTILE })
    for (const l of lines) expect(l).not.toMatch(ESCAPE_BYTES)
    expect(lines[0]).toBe('  finding  Fix the title')
  })

  it('keeps the header title on one line when the session title holds a newline or a tab', async () => {
    const a = await analyzed(heavyBuilder())
    for (const lines of [analysisBlock(capsAt(80, { color: 0 }), a, 'first\nsecond\tthird'), briefBlock(capsAt(80, { color: 0 }), a, 'first\nsecond\tthird', STEP, { hint: false })]) {
      expect(lines[1]).toBe('orangu  first second third')
      for (const l of lines) expect(l).not.toMatch(/[\n\r\t]/)
    }
  })

  it('the store fallback is the single line allowed past 80 columns, and it says why', () => {
    const lines = nextStepLines(capsAt(80), FALLBACK).map(stripAnsi)
    const store = lines.findIndex((l) => l.startsWith('  store    '))
    const next = lines.findIndex((l) => l.startsWith('  next     '))
    // the store row explains the long command, so it stays directly above it; the improvement stays under the title
    expect(next).toBe(store + 1)
    expect(lines[1]).toBe(GUTTER + 'Improvement: Read each file once in a context. Keep notes on what it')
    expect(lines.slice(1, store).map((l) => l.slice(11)).join(' ')).toBe('Improvement: ' + IMPROVEMENT)
    expect(lines[store]).toBe('  store    unavailable: EACCES: permission denied, mkdir (full command below)')
    const long = nextStepLines(capsAt(80), { ...FALLBACK, storeNote: 'EEXIST: file already exists, mkdir ' + '/x'.repeat(40) }).map(stripAnsi)
    const longStore = long.find((l) => l.startsWith('  store    '))!
    // the reason is a label cell: cut at its last whole word, before the promise that the long form follows
    expect(longStore).toBe('  store    unavailable: EEXIST: file already exists, mkdir… (full command below)')
    expect(displayWidth(longStore)).toBeLessThanOrEqual(80)
    expect(lines[next]).toContain(' --finding ')
    expect(displayWidth(lines[next]!)).toBeGreaterThan(80)
    for (const l of lines.filter((_, i) => i !== next)) expect(displayWidth(l)).toBeLessThanOrEqual(80)
  })

  it('report path: OSC 8 link when the terminal can, plain path otherwise, same visible text', () => {
    const linked = reportFooter(capsAt(80), { path: '/tmp/a b.html', opened: false, step: STEP })[0]!
    expect(linked).toContain('\x1b]8;;file://')
    expect(stripAnsi(linked)).toBe('  report   /tmp/a b.html')
    const plain = reportFooter(capsAt(80, { hyperlinks: false, color: 0 }), { path: '/tmp/a b.html', opened: true, step: STEP })[0]!
    expect(plain).toBe('  report   /tmp/a b.html  (opened)')
    // a path is never cut; the note yields first, then the line may run past the budget
    const long = '/var/folders/xy/' + 'z'.repeat(60) + '/orangu-aaaaaaaa.html'
    const whole = reportFooter(capsAt(80, { hyperlinks: false, color: 0 }), { path: long, opened: true, step: STEP })[0]!
    expect(whole).toBe('  report   ' + long)
  })

  it('values start at column 13 and the budget follows the narrower of the terminal and 80', () => {
    expect(row(MACHINE_CAPS, 'next', 'x')).toBe('  next     x')
    expect(valueBudget(capsAt(80))).toBe(69)
    expect(valueBudget(capsAt(40))).toBe(29)
    expect(valueBudget(capsAt(300))).toBe(69)
    // a value wider than the budget wraps under itself; a word wider than the line breaks at the width
    expect(rows(capsAt(40), 'finding', 'a'.repeat(50)).map(stripAnsi)).toEqual(['  finding  ' + 'a'.repeat(29), GUTTER + 'a'.repeat(21)])
    // a value that orangu joined with its separator breaks at the separators first, so a figure stays with its unit
    const quality = '1 PR · 12 commits · 30 test runs (3 failed) · 25 files changed'
    expect(rows(capsAt(40, { color: 0 }), 'quality', quality, { joined: true })).toEqual([
      '  quality  1 PR · 12 commits',
      GUTTER + '30 test runs (3 failed)',
      GUTTER + '25 files changed',
    ])
    // a part still wider than the budget then wraps at whole words, and the next part starts its own line
    expect(rows(capsAt(40, { color: 0 }), 'note', 'one two three four five six seven eight · nine', { joined: true })).toEqual([
      '  note     one two three four five six',
      GUTTER + 'seven eight',
      GUTTER + 'nine',
    ])
    // any other value is prose: it wraps at whole words alone and keeps every separator glyph
    expect(rows(capsAt(40, { color: 0 }), 'quality', quality).map((l) => l.slice(11)).join(' ')).toBe(quality)
    // row() is the same lines joined, for a caller that writes one string to a stream
    expect(row(capsAt(40, { color: 0 }), 'finding', 'a'.repeat(50))).toBe('  finding  ' + 'a'.repeat(29) + '\n' + GUTTER + 'a'.repeat(21))
  })

  it('free lines wrap whole: the outcome sentence, the hints and the done line keep every word at 40 columns', async () => {
    const a = await analyzed(heavyBuilder())
    const caps = capsAt(40, { color: 0 })
    const brief = briefBlock(caps, a, 'T', STEP, { hint: true })
    const headline = outcomeHeadline(a.summary)
    const at = brief.findIndex((l) => l.startsWith('  ' + headline.split(' ')[0]))
    const sentence: string[] = []
    for (let i = at; brief[i]; i++) sentence.push(brief[i]!)
    expect(sentence.map((l) => l.slice(2)).join(' ')).toBe(headline)
    // the header above is a label cell and may still cut; nothing from the sentence down does
    expect(brief.slice(at).join('\n')).not.toContain('…')
    // the trailing hint follows the last blank line, wrapped whole at the indent
    const hint = brief.slice(brief.lastIndexOf('') + 1)
    for (const l of hint) expect(l).toMatch(/^ {2}\S/)
    // the line break takes the place of the separator
    expect(hint.map((l) => l.trim()).join(' · ')).toBe('orangu report for the full picture · orangu --help for every command')
    const done = doneLine(caps, { sizeBytes: 999_900_000, elapsedMs: 3_599_000, redactions: 99_999 }).split('\n')
    expect(done.length).toBeGreaterThan(1)
    for (const l of done) expect(displayWidth(l)).toBeLessThanOrEqual(40)
    expect(done.join(' ')).not.toContain('…')
    expect(done[0]).toMatch(/^ {2}✓ analyzed 999\.9 MB in \S+/)
    for (const l of done.slice(1)) expect(l).toMatch(/^ {4}\S/)
    expect(done.map((l) => l.trim()).join(' · ')).toMatch(/^✓ analyzed 999\.9 MB in .+ · 99999 redactions$/)
  })

  it('the analyze findings list wraps each title under itself, savings on its first line, and no improvement', async () => {
    const a = await analyzed(heavyBuilder())
    const title = '3 files re-read within one context (12 redundant reads, 3.92M tokens) in the same long session'
    const one: Analysis = { ...a, insights: [{ ...a.insights[0]!, title, severity: 'high', savings: { tokens: 3_920_000, estimated: true } }] }
    for (const [label, caps] of VARIANTS) {
      const lines = analysisBlock(caps, one, 'T').map(stripAnsi)
      const head = lines.findIndex((l) => /^ {4}(●|\*) /.test(l))
      expect(lines[head], label).toMatch(/\S {2,}save ~3\.92M tokens$/)
      const rest: string[] = []
      for (let i = head + 1; lines[i]; i++) rest.push(lines[i]!)
      for (const l of rest) expect(l, label).toMatch(/^ {6}\S/)
      const firstText = lines[head]!.slice(6).replace(/ {2,}save ~3\.92M tokens$/, '')
      expect([firstText, ...rest.map((l) => l.slice(6))].join(' '), label).toBe(title)
      expect(lines.join('\n'), label).not.toContain('Improvement')
      expect(lines.slice(head, head + 1 + rest.length).join('\n'), label).not.toMatch(/…|\.\.\./)
      assertFits(analysisBlock(caps, one, 'T'), caps, label)
    }
  })

  it('glyphs swap to ASCII when unicode is off', () => {
    expect(doneLine(capsAt(80, { color: 0, unicode: false }), { sizeBytes: 7_200_000, elapsedMs: 1400, redactions: 1 })).toBe('  ok analyzed 7.2 MB in 1.4s | 1 redaction')
    expect(doneLine(capsAt(80, { color: 0 }), { sizeBytes: 7_200_000, elapsedMs: 1400 })).toBe('  ✓ analyzed 7.2 MB in 1.4s')
  })

  it('the analysis block reads the same numbers as before, without the wide warning glyph', async () => {
    const a = await analyzed(buildCanonicalSession())
    const text = analysisBlock(capsAt(80, { color: 0 }), a, 'Title').join('\n')
    expect(text).toContain('  quality  ')
    expect(text).toContain('  tokens   ')
    expect(text).toContain('  context  peak ')
    expect(text).toContain("  run 'orangu report aaaaaaaa' for the full visual report")
    expect(text).not.toContain('⚠')
  })

  it('list rows print agents as a word, never the chain glyph', () => {
    const ref: SessionRef = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', path: '/p', projectSlug: '-Users-me-demo', projectPath: '/p', sizeBytes: 100_000, mtimeMs: 0, hasSidecarDir: true, subagentFiles: ['a'] }
    const text = listRows(capsAt(80, { color: 0 }), [ref], { total: 1, global: false }).join('\n')
    expect(text).toContain('  aaaaaaaa  1970-01-01 00:00    0.1 MB  agents 1    -Users-me-demo')
    expect(text).not.toContain('⛓')
  })
})

describe('persistNextStep', () => {
  it('persists the top finding once and returns the short command; a second run appends nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-next-step-'))
    const a = await analyzed(heavyBuilder())
    const store = () => new SuggestionStore({ home })
    const first = await persistNextStep(a, { scrub: true, stripText: true }, { store })
    expect(first.finding).toBeTruthy()
    // the footer's Improvement line is the top insight's own improvement, read from the Insight
    const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0]!
    expect(top.improvement).toBeTruthy()
    expect(first.improvement).toBe(top.improvement)
    expect(first.storeNote).toBeUndefined()
    expect(first.next).toMatch(/^claude "\/orangu:improve sg_[0-9a-f]{12}"$/)
    const second = await persistNextStep(a, { scrub: true, stripText: true }, { store })
    expect(second).toEqual(first)
    const lines = (await readFile(join(home, 'suggestions.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]!) as { id: string; title: string; sessionIds: string[] }
    expect(first.next).toContain(rec.id)
    expect(rec.title).toBe(first.finding)
    expect(rec.sessionIds).toEqual([a.session.id])
  })

  it('falls back to the long form, with the reason, when the store throws', async () => {
    const a = await analyzed(heavyBuilder())
    const step = await persistNextStep(a, false, {
      store: () => ({ upsertNew: async () => { throw new Error('EACCES: permission denied, mkdir\nmore') } }) as never,
    })
    expect(step.storeNote).toBe('EACCES: permission denied, mkdir')
    expect(step.next).toMatch(/^claude "\/orangu:improve sg_[0-9a-f]{12} --finding [A-Za-z0-9_-]+"$/)
    const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0]!
    expect(step.improvement).toBe(top.improvement)
  })

  it('a clean session yields no finding and touches no store', async () => {
    const b = new SessionBuilder({ sessionId: 'cccccccc-0000-4000-8000-000000000003', startAt: '2026-08-14T09:00:00.000Z' })
    b.userPrompt('hi')
    b.assistant([{ type: 'text', text: 'hello' }], { usage: { input_tokens: 2, output_tokens: 2 } })
    const a = await analyzed(b)
    if (a.insights.length) return // the rule set may flag even this; nothing to assert then
    let touched = false
    const step = await persistNextStep(a, false, { store: () => ((touched = true), new SuggestionStore({ home: '/nonexistent' })) })
    expect(step).toEqual({})
    expect(touched).toBe(false)
  })
})

describe('aggregateBlock', () => {
  const CAPTION = 'Each title shows the figures of one example session.'
  const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`
  async function sample() {
    const one = await analyzed(heavyBuilder())
    const two = await analyzed(new SessionBuilder({ sessionId: 'dddddddd-0000-4000-8000-000000000004', startAt: '2026-08-15T09:00:00.000Z' }).userPrompt('a second session').tick(10).assistant([{ type: 'text', text: 'ok' }], { usage: { input_tokens: 4, output_tokens: 4 } }))
    return aggregate([one, two], 'repo demo', 0)
  }
  /** the lines between a section heading and the next blank line, without escapes */
  function sectionBlock(lines: string[], heading: string): string[] {
    const at = lines.findIndex((l) => stripAnsi(l) === '  ' + heading)
    expect(at, heading).toBeGreaterThan(0)
    const block: string[] = []
    for (let i = at + 1; lines[i]; i++) block.push(stripAnsi(lines[i]!))
    return block
  }
  /** the lines between the recurring findings heading and the next blank line */
  function findingsBlock(lines: string[]): string[] {
    return sectionBlock(lines, 'recurring findings (across sessions)')
  }
  /** each row of a section as its lines: a line that matches `head` starts a row, the lines under it continue it */
  function rowGroups(block: string[], head: RegExp): string[][] {
    const groups: string[][] = []
    for (const l of block) {
      if (head.test(l)) groups.push([l])
      else groups.at(-1)?.push(l)
    }
    return groups
  }

  it('says once, as a caption, that each title shows one example session, and prints the example title, the count and the improvement per row', async () => {
    const a = await sample()
    expect(a.crossFindings.length).toBeGreaterThan(0)
    const HEAD = /^ {4} *(~\S+|–) {2}\S/
    for (const [label, caps] of VARIANTS) {
      const lines = aggregateBlock(caps, a)
      const block = findingsBlock(lines)
      // one caption for the whole list, the same sentence as the report, wrapped at whole words
      const caption = block.slice(0, block.findIndex((l) => HEAD.test(l)))
      for (const l of caption) expect(l, label).toMatch(/^ {2}\S/)
      expect(caption.map((l) => l.trim()).join(' '), label).toBe(CAPTION)
      expect(lines.map(stripAnsi).filter((l) => l.includes('Each title')), label).toHaveLength(1)
      // no title carries the per-title marker any more
      expect(lines.map(stripAnsi).filter((l) => l.includes('In one session')), label).toHaveLength(0)
      const rows = block.slice(caption.length)
      const heads = rows.map((l, i) => (HEAD.test(l) ? i : -1)).filter((i) => i >= 0)
      expect(heads, label).toHaveLength(Math.min(8, a.crossFindings.length))
      heads.forEach((h, n) => {
        const f = a.crossFindings[n]!
        const end = heads[n + 1] ?? rows.length
        const text = rows.slice(h, end).map((l) => l.slice(14))
        for (const l of rows.slice(h + 1, end)) expect(l, label).toMatch(/^ {14}\S/)
        const improvement = text.findIndex((l) => l.startsWith('Improvement: '))
        // the example title wraps whole, then the count: on the last title line when it fits, else on its own
        const titleAndCount = text.slice(0, improvement).join(' ').replace(/ {2}\(/, ' (')
        expect(titleAndCount, label).toBe(`${f.exampleTitle} (${sessions(f.sessions)})`)
        expect(text.slice(improvement).join(' '), label).toBe('Improvement: ' + f.improvement)
      })
      for (const l of block) expect(displayWidth(l), `${label}: ${l}`).toBeLessThanOrEqual(Math.min(caps.columns, 80))
    }
  })

  it('the closing flag hint wraps at whole words, and drops --open once the report is written', () => {
    const text = 'add --open for the HTML report, --json for the full machine-readable aggregate'
    // at 80 columns it is exactly one line, as before
    expect(aggregateOffer(capsAt(80, { color: 0 }), false)).toEqual(['', '  ' + text])
    const narrow = aggregateOffer(capsAt(60, { color: 0 }), false)
    expect(narrow.length).toBeGreaterThan(2)
    for (const l of narrow.slice(1)) {
      expect(l).toMatch(/^ {2}\S/)
      expect(displayWidth(l)).toBeLessThanOrEqual(60)
    }
    expect(narrow.slice(1).map((l) => l.trim()).join(' ')).toBe(text)
    expect(aggregateOffer(capsAt(80, { color: 0 }), true)).toEqual(['', '  add --json for the full machine-readable aggregate'])
  })

  it('wraps the example title and the improvement at whole words only, so a separator glyph inside them is never dropped', async () => {
    const a = await sample()
    const f = a.crossFindings[0]!
    const title = "Agent type 'build | lint' is the most used · subagent type in this session"
    const improvement = "Split the 'build | lint' agent · into one agent per step, and run each one alone."
    const one = { ...a, crossFindings: [{ ...f, exampleTitle: title, improvement }] }
    for (const caps of [capsAt(40, { unicode: false, color: 0 }), capsAt(40, { color: 0 })]) {
      const label = caps.unicode ? 'unicode' : 'ascii'
      const block = findingsBlock(aggregateBlock(caps, one))
      const head = block.findIndex((l) => /^ {4} *(~\S+|–) {2}\S/.test(l))
      const text = block.slice(head).map((l) => l.slice(14))
      const imp = text.findIndex((l) => l.startsWith('Improvement: '))
      expect(text.slice(0, imp).join(' ').replace(/ {2}\(/, ' ('), label).toBe(`${title} (${sessions(f.sessions)})`)
      expect(text.slice(imp).join(' '), label).toBe('Improvement: ' + improvement)
    }
  })

  it('falls back to the marked title when the example title is empty, as the report does', async () => {
    const a = await sample()
    const f = a.crossFindings[0]!
    const block = findingsBlock(aggregateBlock(capsAt(80, { color: 0 }), { ...a, crossFindings: [{ ...f, exampleTitle: '' }] }))
    expect(block.slice(1).map((l) => l.slice(14)).join(' ')).toContain(f.title)
  })

  it('falls back to the marked title when an older aggregate has no example title, and skips an absent improvement', async () => {
    const a = await sample()
    const f = a.crossFindings[0]!
    const { exampleTitle: _e, improvement: _i, ...older } = f
    const lines = aggregateBlock(capsAt(80, { color: 0 }), { ...a, crossFindings: [older] })
    const block = findingsBlock(lines)
    expect(block.slice(1).map((l) => l.slice(14)).join(' ')).toContain(f.title)
    expect(block.join('\n')).not.toContain('Improvement:')
  })

  it('cuts the heaviest-session title at a whole word, and strips escapes from every transcript value', async () => {
    const a = await sample()
    const long = 'refactor every module and run the tests until green and then do it all again for the docs'
    const hostile = {
      ...a,
      scope: 'repo \x1b[2Jdemo',
      crossFindings: [{ ...a.crossFindings[0]!, exampleTitle: HOSTILE }],
      topSessions: [{ ...a.topSessions[0]!, title: long }, { ...a.topSessions[0]!, title: HOSTILE }],
      topReReadFiles: [{ path: '/repo/\x1b]52;c;SGVsbG8=\x07a.ts\n  forged line', sessions: 2, totalReads: 9 }],
      recurringErrors: [{ signature: 'boom \x1b[2J\r\n', tool: 'Bash\x07\t', sessions: 2, total: 4 }],
      byModel: [{ key: 'model\x1b[31m\n', count: 1, tokens: 10 }],
    }
    for (const [label, caps] of VARIANTS) {
      const lines = aggregateBlock(caps, hostile)
      // a newline or a tab from the input never starts a line of its own
      for (const l of lines) expect(l, `${label}: ${JSON.stringify(l)}`).not.toMatch(/[\n\r\t]/)
      // with colour off, orangu writes no escape at all, so any escape byte would be the transcript's own
      if (caps.color === 0) for (const l of lines) expect(l, `${label}: ${JSON.stringify(l)}`).not.toMatch(ESCAPE_BYTES)
      for (const l of lines) expect(l, `${label}: no OSC, no BEL, no screen clear`).not.toMatch(/\x1b\]|\x07|\x1b\[2J/)
      const heavy = lines.map(stripAnsi).filter((l) => /^ {4} *\S+ {2}[0-9a-f]{8} {2}/.test(l))
      expect(heavy, label).toHaveLength(2)
      expect(heavy[0], label).toMatch(/ (refactor|every|module|and|run|the|tests|until|green|then|do|it|all|again|for|docs)(…|\.\.\.)$/)
      expect(displayWidth(heavy[0]!), label).toBeLessThanOrEqual(Math.min(caps.columns, 80))
      expect(heavy[1], label).toMatch(/ {2}Fix the title$/)
    }
  })

  // An error signature is lowercased, holds <path> and <n> in place of paths and numbers, and is cut at 80
  // characters upstream (src/analyze/tools.ts errorSignature): this one is 80 characters, as on a real machine.
  const SIGNATURE = 'error: command failed with exit code <n>: npm err! missing script "verify" in <p'
  // 53 columns: it fits the room beside the figure at 80 columns (64), but not with its count; at 60 columns (44) it does not fit
  const MID_PATH = 'docs/runs/2026-10-06-ste-showme-suggest/IMPL-NOTES.md'
  // wider than the room beside the figure at every width
  const LONG_PATH = 'docs/runs/2026-10-07-minimal-content/a-folder-with-a-long-name-for-this-test/IMPL-NOTES.md'
  const ERROR_HEAD = /^ {4} *\d+× {2}\S/
  const READ_HEAD = /^ {4} *\d+ reads {2}\S/

  it.each([60, 80, 120])('fits the recurring tool-error and re-read rows to the layout at %i columns: the text wraps under its value column, and a path stays whole', async (columns) => {
    const a = await sample()
    const caps = capsAt(columns)
    const width = Math.min(columns, 80)
    const recurringErrors = [
      { tool: 'mcp__playwright__browser_take_screenshot', signature: SIGNATURE, sessions: 4, total: 11 },
      // a 5-digit total widens the row head, so the value column moves with it
      { tool: 'Bash', signature: SIGNATURE, sessions: 12, total: 12345 },
      // blank signatures (the default strip) collapse into one row per tool
      { tool: 'mcp__playwright__browser_navigate', signature: '', sessions: 3, total: 9 },
      { tool: 'WebSearch', signature: '', sessions: 2, total: 2 },
    ]
    const topReReadFiles = [
      { path: '.claude/PROJECT.md', sessions: 1, totalReads: 70 },
      { path: MID_PATH, sessions: 1, totalReads: 66 },
      { path: LONG_PATH, sessions: 3, totalReads: 9 },
    ]
    const lines = aggregateBlock(caps, { ...a, recurringErrors, topReReadFiles }).map(stripAnsi)

    // no line passes the layout width, except a re-read row whose value is its path alone, wider than the room there
    for (const l of lines) {
      if (displayWidth(l) <= width) continue
      const row = /^( {4} *\d+ reads {2})(\S+)$/.exec(l)
      expect(row, `${columns} columns: ${JSON.stringify(l)} passes ${width}`).not.toBeNull()
      expect(displayWidth(row![2]!), l).toBeGreaterThan(width - row![1]!.length)
    }

    // each error row: its text wraps at whole words under the value column, then the count, and nothing is dropped
    const errors = rowGroups(sectionBlock(lines, 'recurring tool errors (environment problems)'), ERROR_HEAD)
    const expected = [
      `mcp__playwright__browser_take_screenshot: ${SIGNATURE} (4 sessions)`,
      `Bash: ${SIGNATURE} (12 sessions)`,
      'mcp__playwright__browser_navigate: 1 recurring signature, text hidden (add --include-text) (3 sessions)',
      'WebSearch: 1 recurring signature, text hidden (add --include-text) (2 sessions)',
    ]
    expect(errors.map((g) => g[0]!.replace(/^ *(\d+)×.*$/, '$1'))).toEqual(['11', '12345', '9', '2'])
    errors.forEach((group, n) => {
      const column = group[0]!.indexOf('×') + 3
      for (const l of group.slice(1)) expect(l, `${columns}: ${l}`).toMatch(new RegExp(`^ {${column}}\\S`))
      expect(group.map((l) => l.slice(column)).join(' ').replace(/ {2}\(/, ' ('), `${columns} columns`).toBe(expected[n])
    })
    // an 80-character signature never fits one line beside its head, so these rows prove the wrap
    expect(errors[0]!.length, `${columns} columns`).toBeGreaterThan(1)
    expect(errors[1]!.length, `${columns} columns`).toBeGreaterThan(1)

    // each re-read row: the path whole on the row's first line, the count beside it when it fits there, else under it
    const reads = rowGroups(sectionBlock(lines, 'most re-read files (context weight)'), READ_HEAD)
    expect(reads).toHaveLength(topReReadFiles.length)
    reads.forEach((group, n) => {
      const f = topReReadFiles[n]!
      const count = `(${sessions(f.sessions)})`
      const head = `    ${String(f.totalReads).padStart(4)} reads  `
      const room = width - head.length
      if (f.path.length + 2 + count.length <= room) expect(group, `${columns}: ${f.path}`).toEqual([head + f.path + '  ' + count])
      else expect(group, `${columns}: ${f.path}`).toEqual([head + f.path, ' '.repeat(head.length) + count])
    })
  })
})

describe('pickFrame / pickList', () => {
  const NOW = 1_800_000_000_000
  const rows: PickRow[] = [
    { sessionId: '4f1c7e00-0000-4000-8000-00000000f1c7', path: '/p/a.jsonl', projectSlug: '-Users-me-Code-orangu', project: 'orangu', title: '日本語のタイトル: refactor every module and run the tests until green ' + 'x'.repeat(80), sizeBytes: 7_200_000, mtimeMs: NOW - 10_000, running: true },
    { sessionId: '11111111-0000-4000-8000-00000000aaaa', path: '/p/b.jsonl', projectSlug: '-Users-me-Code-a-very-long-project-directory-name', project: 'a-very-long-project-directory-name', title: 'Fix foo test', sizeBytes: 123_400_000, mtimeMs: NOW - 2 * 60_000, running: true },
    { sessionId: '22222222-0000-4000-8000-00000000bbbb', path: '/p/c.jsonl', projectSlug: '-Users-me-Code-demo', project: 'demo', sizeBytes: 0, mtimeMs: NOW - 10 * 60_000, running: false },
    { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', path: '/p/d.jsonl', projectSlug: '-Users-me-Code-demo', project: 'demo', title: 'old', sizeBytes: 900, mtimeMs: NOW - 400 * 86_400_000, running: false },
  ]
  const counts = { total: 4, running: 2 }
  const cut = { total: 25, running: 25 }
  it('every line fits the layout at every width, with and without unicode and colour', () => {
    for (const [label, caps] of VARIANTS) {
      assertFits(pickFrame(caps, rows, { cursor: 1, start: 0, size: 4 }, counts, NOW), caps, `pickFrame ${label}`)
      assertFits(pickFrame(caps, rows, { cursor: 3, start: 2, size: 2 }, counts, NOW), caps, `pickFrame window ${label}`)
      assertFits(pickList(caps, rows, counts, NOW), caps, `pickList ${label}`)
      assertFits(pickFrame(caps, rows, { cursor: 0, start: 0, size: 4 }, cut, NOW), caps, `pickFrame cut ${label}`)
      assertFits(pickList(caps, rows, cut, NOW), caps, `pickList cut ${label}`)
    }
  })
  it('a list cut by --limit says "N of M sessions" and points at --limit in both forms', () => {
    const caps = capsAt(80, { color: 0 })
    const frame = pickFrame(caps, rows, { cursor: 0, start: 0, size: 4 }, cut, NOW)
    expect(frame[0]).toMatch(/^  orangu  choose a session +4 of 25 sessions, 25 running$/)
    expect(frame.at(-1)).toBe('  ↑↓ or j k move · enter opens the report · q quits · --limit <n> for more')
    const ascii = pickFrame(capsAt(80, { color: 0, unicode: false }), rows, { cursor: 0, start: 0, size: 4 }, cut, NOW)
    expect(ascii.at(-1)).toBe('  up/down or j k move | enter opens the report | q quits | --limit <n> for more')
    const list = pickList(caps, rows, cut, NOW)
    expect(list[0]).toMatch(/4 of 25 sessions, 25 running$/)
    expect(list.at(-1)).toBe('  run: orangu report <id> · --limit <n> for more · interactive on a terminal')
    // the whole list shown: a plain total and no --limit hint
    expect(pickList(caps, rows, counts, NOW).at(-1)).toBe('  run: orangu report <id> · the picker is interactive on a terminal')
    expect(pickFrame(caps, rows, { cursor: 0, start: 0, size: 4 }, counts, NOW).at(-1)).not.toContain('--limit')
  })
  it('marks the cursor and the running rows, right-aligns age and size, and shows the window remainder', () => {
    const caps = capsAt(80, { color: 0 })
    const frame = pickFrame(caps, rows, { cursor: 1, start: 0, size: 2 }, counts, NOW)
    expect(frame[0]).toMatch(/^  orangu  choose a session +4 sessions, 2 running$/)
    expect(frame[2]).toMatch(/^    ● 4f1c7e00  /)
    expect(frame[3]).toMatch(/^  > ● 11111111  Fix foo test {11}  a-very-long-p…    2m  123.4 MB  running$/)
    expect(frame[4]).toBe('      ↑↓ 2 more')
    expect(frame[5]).toContain('enter opens the report')
    const ascii = pickFrame(capsAt(80, { color: 0, unicode: false }), rows, { cursor: 0, start: 0, size: 4 }, counts, NOW)
    expect(ascii[2]).toMatch(/^  > \* 4f1c7e00  /)
    expect(ascii[4]).toMatch(/^      22222222  \(no title\) {13}  demo {10}   10m    0.0 MB {9}$/)
    expect(ascii[7]).toContain('up/down or j k move | enter')
  })
  it('numbers the list, pads the numbers, and ends with the run hint', () => {
    const caps = capsAt(80, { color: 0 })
    const many = Array.from({ length: 12 }, (_, i) => ({ ...rows[i % 4]!, sessionId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000` }))
    const list = pickList(caps, many, { total: 12, running: 2 }, NOW)
    expect(list[2]).toMatch(/^  \[1\]  ● 00000000  /)
    expect(list[13]).toMatch(/^  \[12\]   00000011  /)
    expect(list[list.length - 1]).toBe('  run: orangu report <id> · the picker is interactive on a terminal')
    assertFits(list, caps, 'pickList 12')
  })
  it('fmtAge is at most four columns', () => {
    expect(fmtAge(NOW, NOW)).toBe('now')
    expect(fmtAge(NOW - 59_000, NOW)).toBe('now')
    expect(fmtAge(NOW - 61_000, NOW)).toBe('1m')
    expect(fmtAge(NOW - 3_600_000 * 23, NOW)).toBe('23h')
    expect(fmtAge(NOW - 86_400_000 * 400, NOW)).toBe('99d')
  })
})
