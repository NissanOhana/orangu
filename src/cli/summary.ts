/**
 * The human terminal layout of report / analyze / bare orangu / list, as pure functions returning
 * lines. Nothing here writes to a stream, so the 80-column contract and the "no opaque token in the
 * terminal" rule are unit-tested without spawning a process (src/cli/summary.test.ts).
 *
 * Gutter: two spaces, an 8-column label, one space; values start at column 12 and are truncated to
 * fit `min(caps.columns, 80)`. The budget of 69 is exactly what the macOS default report path
 * (/var/folders/xx/<30 chars>/T/orangu-<8 hex>.html) needs, and a path is never cut. ASCII in every aligned cell; the audited glyphs (mark, check, middle
 * dot) appear only in a leading position or inside a trailing value, and swap to ASCII when
 * `caps.unicode` is off. Colour is painted after padding and truncation, never before.
 */
import { basename } from 'node:path'
import type { Analysis } from '../model/analysis.js'
import type { SessionRef } from '../discover/discover.js'
import { fmtMs, fmtTokens } from '../analyze/util.js'
import { plural } from '../harness/report.js'
import { outcomeHeadline } from '../report/client/derive.js'
import { PLUGIN_INSTALL } from '../report/client/suggest-rows.js'
import { displayWidth, fileLink, glyphs, padCell, paint, truncate, type Caps, type Style } from './tty.js'

/** Readable measure: wider terminals still get an 80-column layout. */
export const LAYOUT_MAX = 80
const INDENT = '  '
const LABEL_WIDTH = 8
const GUTTER = INDENT.length + LABEL_WIDTH + 1

export function layoutWidth(caps: Pick<Caps, 'columns'>): number {
  return Math.min(caps.columns, LAYOUT_MAX)
}

/** Columns available to a value on a labelled row. */
export function valueBudget(caps: Pick<Caps, 'columns'>): number {
  return layoutWidth(caps) - GUTTER
}

export interface RowOptions {
  /** style applied to the value after truncation */
  style?: Style | Style[]
  /** the value is a command a paste must carry whole: never truncated (the one documented exception) */
  raw?: boolean
}

/** `  label     value`, the value cut to the budget unless `raw`. */
export function row(caps: Caps, label: string, value: string, o: RowOptions = {}): string {
  const v = o.raw ? value : truncate(value, valueBudget(caps), caps)
  return INDENT + padCell(label, LABEL_WIDTH) + ' ' + (o.style ? paint(caps, o.style, v) : v)
}

/** A continuation line under a labelled row (same value column, no label). */
export function continuation(caps: Caps, value: string, style?: Style | Style[]): string {
  const v = truncate(value, valueBudget(caps), caps)
  return ' '.repeat(GUTTER) + (style ? paint(caps, style, v) : v)
}

/** A free-form line (hint, sentence) cut to the layout width. */
function fit(caps: Caps, line: string): string {
  return truncate(line, layoutWidth(caps), caps)
}

export function fmtBytes(bytes: number): string {
  return (bytes / 1e6).toFixed(1) + ' MB'
}

/** `  ✓ analyzed 7.2 MB in 1.4s · 3 redactions` (the whole progress report on a non-TTY). */
export function doneLine(caps: Caps, o: { sizeBytes: number; elapsedMs: number; redactions?: number }): string {
  const g = glyphs(caps)
  let s = `analyzed ${fmtBytes(o.sizeBytes)} in ${fmtMs(o.elapsedMs)}`
  if (o.redactions) s += `${g.sep}${plural(o.redactions, 'redaction')}`
  return INDENT + paint(caps, 'good', g.ok) + ' ' + truncate(s, layoutWidth(caps) - INDENT.length - displayWidth(g.ok) - 1, caps)
}

/** What the analysis says to do next; produced by src/cli/next-step.ts, rendered here. */
export interface NextStep {
  /** the top finding's title (already redacted), absent when the session ran clean */
  finding?: string
  /** the short `claude "/orangu:improve sg_…"` command, or the long form when the store failed */
  next?: string
  /** why the store could not be written (one line); the long form follows on the next row */
  storeNote?: string
}

/** finding / store / next / plugin rows shared by report, analyze and bare orangu. */
export function nextStepLines(caps: Caps, step: NextStep): string[] {
  if (!step.finding) return [row(caps, 'finding', 'none: this session ran clean', { style: 'good' })]
  const lines = [row(caps, 'finding', step.finding, { style: 'bold' })]
  if (step.storeNote) {
    // the reason is cut, never the promise that the long form follows
    const head = 'unavailable: '
    const tail = '; long form follows'
    const reason = truncate(step.storeNote, valueBudget(caps) - head.length - tail.length, caps)
    lines.push(row(caps, 'store', head + reason + tail, { style: 'warn', raw: true }))
  }
  if (step.next) lines.push(row(caps, 'next', step.next, { raw: Boolean(step.storeNote) }))
  const [add, install] = PLUGIN_INSTALL.split(' · ')
  lines.push(row(caps, 'plugin', add ?? PLUGIN_INSTALL))
  if (install) {
    const note = '(once, inside Claude Code)'
    const fits = install.length + 4 + note.length <= valueBudget(caps)
    lines.push(continuation(caps, install) + (fits ? '    ' + paint(caps, 'dim', note) : ''))
  }
  return lines
}

export function betaLine(caps: Caps, context: string): string {
  return row(caps, 'beta', `orangu feedback --context ${context}`, { style: 'dim' })
}

/** stderr footer of `orangu report`: the path (a link when the terminal can), then the next step. */
export function reportFooter(caps: Caps, o: { path: string; opened: boolean; step: NextStep }): string[] {
  const link = fileLink(o.path, caps)
  // the link is painted by the terminal; only a plain path takes the accent so both stay readable
  const value = link === o.path ? paint(caps, 'accent', o.path) : link
  // a cut path is no path at all: printed whole, and the "(opened)" note only when it still fits
  const note = o.opened && displayWidth(o.path) + 10 <= valueBudget(caps) ? paint(caps, 'dim', '  (opened)') : ''
  const lines = [INDENT + padCell('report', LABEL_WIDTH) + ' ' + value + note]
  return [...lines, ...nextStepLines(caps, o.step), betaLine(caps, 'report')]
}

function header(caps: Caps, title: string, sub: string): string[] {
  const w = layoutWidth(caps)
  return [
    '',
    paint(caps, ['bold', 'accent'], 'orangu') + '  ' + paint(caps, 'bold', truncate(title, w - 8, caps)),
    '        ' + paint(caps, 'dim', truncate(sub, w - 8, caps)),
    '',
  ]
}

function qualityLine(a: Analysis, sep: string): string {
  const o = a.summary.outcomes
  const bits: string[] = []
  if (o.prLinks.length) bits.push(`${o.prLinks.length} PR`)
  if (o.gitCommits) bits.push(`${o.gitCommits} commits`)
  if (o.testRuns) bits.push(`${o.testRuns} test runs${o.testRunsFailed ? ' (' + o.testRunsFailed + ' failed)' : ''}`)
  if (o.filesEdited + o.filesWritten) bits.push(`${o.filesEdited + o.filesWritten} files changed`)
  return bits.join(sep) || 'no commits/PRs/tests detected'
}

/** One findings row: leading severity mark, title cut to leave room for the right-aligned savings. */
function findingRow(caps: Caps, ins: Analysis['insights'][number]): string {
  const g = glyphs(caps)
  const w = layoutWidth(caps)
  const save = ins.savings?.tokens ? `save ~${fmtTokens(ins.savings.tokens)} tokens` : ins.savings?.ms ? `save ~${fmtMs(ins.savings.ms)}` : ''
  const lead = '    '
  const budget = w - lead.length - 2 - (save ? displayWidth(save) + 2 : 0)
  const title = truncate(ins.title, budget, caps)
  const mark = paint(caps, ins.severity === 'high' ? 'bad' : ins.severity === 'medium' ? 'warn' : 'dim', g.mark)
  const gap = save ? ' '.repeat(Math.max(2, w - lead.length - 2 - displayWidth(title) - displayWidth(save))) : ''
  return lead + mark + ' ' + title + gap + paint(caps, 'accent', save)
}

/** stdout block of `orangu analyze`: header, the measured rows, findings, the report hint. */
export function analysisBlock(caps: Caps, a: Analysis, title: string): string[] {
  const s = a.summary
  const sep = glyphs(caps).sep
  const lines = header(caps, title, `${a.session.source}${sep}${a.session.id}`)
  lines.push(row(caps, 'quality', qualityLine(a, sep)))
  lines.push(row(caps, 'time', `${fmtMs(s.wallMs)} wall${sep}${fmtMs(s.activeMs)} active${sep}${fmtMs(s.humanWaitMs)} waiting`))
  lines.push(row(caps, 'tokens', `${fmtTokens(s.totalTokens)}${sep}${(s.cacheHitRatio * 100).toFixed(0)}% cache${sep}${fmtTokens(a.tokens.byKind.output)} output`))
  lines.push(row(caps, 'turns', `${s.turns} (${s.humanTurns} human)`))
  lines.push(row(caps, 'tools', `${s.toolCalls} calls${sep}${s.toolErrors} errors`))
  if (s.agents) lines.push(row(caps, 'agents', `${s.agents} runs${sep}${a.agents.maxConcurrency} max parallel${sep}${fmtTokens(a.tokens.agents)} tokens`))
  lines.push(row(caps, 'context', `peak ${fmtTokens(s.contextPeak)}${a.context.contextWindow ? ' of ' + fmtTokens(a.context.contextWindow) : ''}${sep}${plural(s.compactions, 'compaction')}`))
  lines.push('', paint(caps, 'bold', INDENT + 'findings'))
  if (!a.insights.length) lines.push(paint(caps, 'good', '    clean: no findings'))
  for (const ins of a.insights.slice(0, 6)) lines.push(findingRow(caps, ins))
  lines.push('', paint(caps, 'dim', fit(caps, `${INDENT}run 'orangu report ${a.session.id.slice(0, 8)}' for the full visual report`)))
  if (!a.parse.reconciliation.ok) lines.push(paint(caps, 'warn', fit(caps, `${INDENT}warning: token totals reconcile within ${a.parse.reconciliation.matchesWithinPct}%`)))
  return lines
}

/** stdout block of bare `orangu`: header, the outcome sentence, the next step, the trailing hint. */
export function briefBlock(caps: Caps, a: Analysis, title: string, step: NextStep, o: { hint: boolean }): string[] {
  const s = a.summary
  const sep = glyphs(caps).sep
  const lines = header(caps, title, `latest${sep}${a.session.id.slice(0, 8)}${sep}${s.turns} turns${sep}${fmtTokens(s.totalTokens)} tokens${sep}${fmtMs(s.activeMs)} active`)
  lines.push(fit(caps, INDENT + outcomeHeadline(s)), '')
  lines.push(...nextStepLines(caps, step))
  if (o.hint) lines.push('', paint(caps, 'dim', fit(caps, `${INDENT}orangu report for the full picture${sep}orangu --help for every command`)))
  return lines
}

/** `orangu list` rows: id, when, size, agents, project; every cell ASCII and width-aligned. */
export function listRows(caps: Caps, refs: SessionRef[], o: { total: number; global: boolean }): string[] {
  const w = layoutWidth(caps)
  const lines = ['', paint(caps, 'bold', `${plural(o.total, 'session')}${o.global ? ' (all roots)' : ''}`), '']
  for (const s of refs) {
    const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
    const size = padCell(fmtBytes(s.sizeBytes), 8, 'r')
    const agents = padCell(s.hasSidecarDir ? `agents ${s.subagentFiles.length}` : '', 10)
    const lead = `${INDENT}${s.sessionId.slice(0, 8)}  ${when}  ${size}  ${agents}  `
    const project = truncate(basename(s.projectSlug), Math.max(8, w - displayWidth(lead)), caps)
    lines.push(`${INDENT}${paint(caps, 'accent', s.sessionId.slice(0, 8))}  ${paint(caps, 'dim', when)}  ${size}  ${paint(caps, 'dim', agents)}  ${project}`)
  }
  if (!o.total) lines.push(paint(caps, 'dim', fit(caps, `${INDENT}No sessions found. Is Claude Code installed?`)), paint(caps, 'dim', fit(caps, `${INDENT}A transcript path also works: orangu report <path.jsonl>`)))
  else lines.push('', paint(caps, 'dim', fit(caps, `${INDENT}orangu report <id>${glyphs(caps).sep}orangu analyze <id>${glyphs(caps).sep}orangu harness`)))
  return lines
}
