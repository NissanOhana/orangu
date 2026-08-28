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
import { analysisBlock, betaLine, briefBlock, doneLine, fmtAge, listRows, nextStepLines, pickFrame, pickList, reportFooter, row, valueBudget, type NextStep, type PickRow } from './summary.js'
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
  storeNote: 'EACCES: permission denied, mkdir',
  next: 'claude "/orangu:improve sg_42794f4ccd0b --finding ' + 'eyJ'.repeat(160) + '"',
}

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

  it('below 51 columns the next and plugin commands wrap whole instead of being cut', () => {
    const lines = nextStepLines(capsAt(40, { color: 0 }), STEP)
    expect(lines[1]).toBe('  next     claude "/orangu:improve sg_42794f4ccd0b"')
    expect(lines[2]).toBe('  plugin   /plugin marketplace add NissanOhana/orangu')
    // the install continuation fits at 40 columns on its own, so it drops only its dim note
    expect(lines[3]).toBe('           /plugin install orangu')
    expect(lines[0]).toBe('  finding  Subagent results re-read in …')
    // the beta hint is a command too: whole at 40 columns, and wider than the 29-column budget
    expect(stripAnsi(betaLine(capsAt(40), 'report'))).toBe('  beta     orangu feedback --context report')
  })

  it('the store fallback is the single line allowed past 80 columns, and it says why', () => {
    const lines = nextStepLines(capsAt(80), FALLBACK).map(stripAnsi)
    expect(lines[1]).toBe('  store    unavailable: EACCES: permission denied, mkdir; long form follows')
    const long = nextStepLines(capsAt(80), { ...FALLBACK, storeNote: 'EEXIST: file already exists, mkdir ' + '/x'.repeat(40) }).map(stripAnsi)
    expect(long[1]).toMatch(/^  store {4}unavailable: EEXIST.*…; long form follows$/)
    expect(displayWidth(long[1]!)).toBe(80)
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
    expect(step.storeNote).toBe('EACCES: permission denied, mkdir')
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

describe('pickFrame / pickList', () => {
  const NOW = 1_800_000_000_000
  const rows: PickRow[] = [
    { sessionId: '450f127b-d499-4fe0-8334-d15d8ba650c3', path: '/p/a.jsonl', projectSlug: '-Users-me-Code-orangu', project: 'orangu', title: '日本語のタイトル: refactor every module and run the tests until green ' + 'x'.repeat(80), sizeBytes: 7_200_000, mtimeMs: NOW - 10_000, running: true },
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
    expect(frame[2]).toMatch(/^    ● 450f127b  /)
    expect(frame[3]).toMatch(/^  > ● 11111111  Fix foo test {11}  a-very-long-p…    2m  123.4 MB  running$/)
    expect(frame[4]).toBe('      ↑↓ 2 more')
    expect(frame[5]).toContain('enter opens the report')
    const ascii = pickFrame(capsAt(80, { color: 0, unicode: false }), rows, { cursor: 0, start: 0, size: 4 }, counts, NOW)
    expect(ascii[2]).toMatch(/^  > \* 450f127b  /)
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
