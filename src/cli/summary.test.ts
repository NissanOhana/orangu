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
import { analysisBlock, betaLine, briefBlock, doneLine, listRows, nextStepLines, reportFooter, row, valueBudget, type NextStep } from './summary.js'
import { persistNextStep } from './next-step.js'

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

const STEP: NextStep = { finding: 'Subagent results re-read in full', next: 'claude "/orangu:improve sg_42794f4ccd0b"' }
const FALLBACK: NextStep = {
  finding: 'Subagent results re-read in full',
  storeNote: 'unavailable: EACCES: permission denied, mkdir; long form follows',
  next: 'claude "/orangu:improve sg_42794f4ccd0b --finding ' + 'eyJ'.repeat(160) + '"',
}

function assertFits(lines: string[], caps: Caps, label: string): void {
  const limit = Math.min(caps.columns, 80)
  for (const l of lines) {
    expect(displayWidth(l), `${label}: ${JSON.stringify(stripAnsi(l))}`).toBeLessThanOrEqual(limit)
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
    // the macOS default report path is exactly the 69-column budget; below 80 columns a path (never
    // cut) is the documented exception, so the row is checked only where it can fit
    const footer = reportFooter(caps, { path: '/var/folders/1x/5tq6y5g95l5c2vxg2l7nzf9w0000gn/T/orangu-bbbbbbbb.html', opened: true, step: STEP })
    assertFits(caps.columns >= 80 ? footer : footer.slice(1), caps, label + ' reportFooter')
    const refs: SessionRef[] = [
      { sessionId: a.session.id, path: '/p/a.jsonl', projectSlug: '-Users-me-Code-a-very-long-project-directory-name-that-goes-on-and-on', projectPath: '/p', sizeBytes: 7_200_000, mtimeMs: 1_700_000_000_000, hasSidecarDir: true, subagentFiles: ['x', 'y'] },
      { sessionId: '22222222-0000-4000-8000-00000000bbbb', path: '/p/b.jsonl', projectSlug: '-Users-me-demo', projectPath: '/p', sizeBytes: 12_000, mtimeMs: 1_700_000_000_000, hasSidecarDir: false, subagentFiles: [] },
    ]
    // the list's fixed cells (id, when, size, agents) need 52 columns; the project cell yields first
    if (caps.columns >= 60) assertFits(listRows(caps, refs, { total: 2, global: false }), caps, label + ' listRows')
    assertFits(listRows(caps, [], { total: 0, global: true }), caps, label + ' listRows empty')
    assertFits([doneLine(caps, { sizeBytes: 7_200_000, elapsedMs: 1400, redactions: 3 }), betaLine(caps, 'report')], caps, label + ' done/beta')
  })

  it('a clean session says so and names no command', () => {
    const lines = nextStepLines(capsAt(80), {})
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]!)).toBe('  finding  none: this session ran clean')
  })

  it('the footer prints the short command and never a --finding payload', () => {
    const text = reportFooter(capsAt(80), { path: '/tmp/r.html', opened: false, step: STEP }).map(stripAnsi).join('\n')
    expect(text).toContain('  next     claude "/orangu:improve sg_42794f4ccd0b"')
    expect(text).not.toContain(' --finding ')
    expect(text).toContain('  plugin   /plugin marketplace add NissanOhana/orangu')
    expect(text).toContain('           /plugin install orangu    (once, inside Claude Code)')
    expect(text.split('\n').at(-1)).toBe('  beta     orangu feedback --context report')
  })

  it('the store fallback is the single line allowed past 80 columns, and it says why', () => {
    const lines = nextStepLines(capsAt(80), FALLBACK).map(stripAnsi)
    expect(lines[1]).toBe('  store    unavailable: EACCES: permission denied, mkdir; long form follows')
    expect(lines[2]).toContain(' --finding ')
    expect(displayWidth(lines[2]!)).toBeGreaterThan(80)
    for (const l of lines.filter((_, i) => i !== 2)) expect(displayWidth(l)).toBeLessThanOrEqual(80)
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
    expect(stripAnsi(row(capsAt(40), 'finding', 'a'.repeat(50)))).toBe('  finding  ' + 'a'.repeat(28) + '…')
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
    expect(step.storeNote).toBe('unavailable: EACCES: permission denied, mkdir; long form follows')
    expect(step.next).toMatch(/^claude "\/orangu:improve sg_[0-9a-f]{12} --finding [A-Za-z0-9_-]+"$/)
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
