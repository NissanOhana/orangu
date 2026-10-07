/**
 * The human terminal layout of report / analyze / bare orangu / list / repo / global, as pure functions
 * returning lines. Nothing here writes to a stream, so the layout contract and the "no opaque token in
 * the terminal" rule are unit-tested without spawning a process (src/cli/summary.test.ts).
 *
 * Gutter: two spaces, an 8-column label, one space; values start at column 12 and fit
 * `min(caps.columns, 80)`, a line measure and not a content cap. The budget of 69 is exactly what the
 * macOS default report path (/var/folders/xx/<30 chars>/T/orangu-<8 hex>.html) needs. Prose wraps at
 * whole words (wrapWords) and is never cut: a finding title, an improvement, a row value, a hint. Only
 * label cells cut, at their last whole word (truncate): the header title and sub line, the store
 * reason, the list and pick cells and the heaviest-session title. A path or a command a paste must
 * carry whole (the report path, the next and plugin rows, the store fallback) is never cut or wrapped
 * here: below 80 columns the terminal wraps it. Text from a transcript reaches the terminal only through
 * wrapWords or truncate, which strip escapes and control bytes first. ASCII in every aligned cell; the
 * audited glyphs (mark, check, middle dot) appear only in a leading position or inside a trailing
 * value, and swap to ASCII when `caps.unicode` is off. Colour is painted after padding, wrapping and
 * truncation, never before.
 */
import { basename } from 'node:path'
import type { Analysis } from '../model/analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'
import type { SessionRef } from '../discover/discover.js'
import { fmtMs, fmtTokens } from '../analyze/util.js'
import { plural } from '../harness/report.js'
import { outcomeHeadline } from '../report/client/derive.js'
import { PLUGIN_INSTALL } from '../report/client/suggest-rows.js'
import { displayWidth, fileLink, glyphs, padCell, paint, stripAnsi, truncate, wrapValue, wrapWords, type Caps, type Style } from './tty.js'

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

/**
 * Wrap a value at its separators first (` · `, or ` | ` in ASCII), so that a figure stays with its unit,
 * then at whole words inside a part that is still too wide. The line break takes the place of the
 * separator. wrapWords strips escapes and control bytes, so the result is safe to print.
 */
function wrapText(caps: Pick<Caps, 'unicode'>, text: string, width: number): string[] {
  const plain = wrapWords(text, Infinity)[0] ?? ''
  return wrapValue(plain, width, glyphs(caps).sep).flatMap((l) => (displayWidth(l) > width ? wrapWords(l, width) : [l]))
}

export interface RowOptions {
  /** style applied to the value after wrapping */
  style?: Style | Style[]
  /** the value is a path or a command a paste must carry whole: one line, never cut or wrapped (the documented exceptions) */
  raw?: boolean
}

/** `  label     value` as lines: the value wraps under itself at whole words, or stays one line when `raw`. */
export function rows(caps: Caps, label: string, value: string, o: RowOptions = {}): string[] {
  const head = INDENT + padCell(label, LABEL_WIDTH) + ' '
  const parts = o.raw ? [value] : wrapText(caps, value, valueBudget(caps))
  if (!parts.length) parts.push('')
  return parts.map((p, i) => (i ? ' '.repeat(GUTTER) : head) + (o.style ? paint(caps, o.style, p) : p))
}

/** rows() as one string, for a caller that writes one row to a stream. */
export function row(caps: Caps, label: string, value: string, o: RowOptions = {}): string {
  return rows(caps, label, value, o).join('\n')
}

/** Continuation lines under a labelled row (same value column, no label), wrapped at whole words. */
export function continuation(caps: Caps, value: string, style?: Style | Style[]): string[] {
  return wrapText(caps, value, valueBudget(caps)).map((p) => ' '.repeat(GUTTER) + (style ? paint(caps, style, p) : p))
}

/** A free-form line (hint, sentence) wrapped at whole words to the layout width; each line keeps its indent. */
function fit(caps: Caps, line: string, style?: Style | Style[]): string[] {
  const indent = /^ */.exec(line)![0]
  return wrapText(caps, line, layoutWidth(caps) - indent.length).map((p) => (style ? paint(caps, style, indent + p) : indent + p))
}

export function fmtBytes(bytes: number): string {
  return (bytes / 1e6).toFixed(1) + ' MB'
}

/** `  ✓ analyzed 7.2 MB in 1.4s · 3 redactions` (the whole progress report on a non-TTY); wraps, never cuts. */
export function doneLine(caps: Caps, o: { sizeBytes: number; elapsedMs: number; redactions?: number }): string {
  const g = glyphs(caps)
  let s = `analyzed ${fmtBytes(o.sizeBytes)} in ${fmtMs(o.elapsedMs)}`
  if (o.redactions) s += `${g.sep}${plural(o.redactions, 'redaction')}`
  const pad = ' '.repeat(INDENT.length + displayWidth(g.ok) + 1)
  const lead = INDENT + paint(caps, 'good', g.ok) + ' '
  return wrapText(caps, s, layoutWidth(caps) - pad.length).map((p, i) => (i ? pad : lead) + p).join('\n')
}

/** What the analysis says to do next; produced by src/cli/next-step.ts, rendered here. */
export interface NextStep {
  /** the top finding's title (already redacted), absent when the session ran clean */
  finding?: string
  /** the top finding's improvement (rule copy), printed under the title, directly above `next` */
  improvement?: string
  /** the short `claude "/orangu:improve sg_…"` command, or the long form when the store failed */
  next?: string
  /** why the store could not be written (one line); the long form follows on the next row */
  storeNote?: string
}

/**
 * finding / store / next / plugin rows shared by report, analyze and bare orangu. The title and the
 * improvement are prose: they wrap at whole words and are never cut. The improvement follows the title
 * as continuation lines, directly above `next`; only the store row, which explains the long command,
 * comes between them.
 */
export function nextStepLines(caps: Caps, step: NextStep): string[] {
  if (!step.finding) return rows(caps, 'finding', 'none: this session ran clean', { style: 'good' })
  const lines = rows(caps, 'finding', step.finding, { style: 'bold' })
  if (step.improvement) lines.push(...continuation(caps, `Improvement: ${step.improvement}`))
  if (step.storeNote) {
    // the reason is cut, never the promise that the long form follows
    const head = 'unavailable: '
    const tail = ' (full command below)'
    const reason = truncate(step.storeNote, valueBudget(caps) - head.length - tail.length, caps)
    lines.push(row(caps, 'store', head + reason + tail, { style: 'warn', raw: true }))
  }
  // both are paste targets: a cut command is no command, so a narrow terminal wraps them instead
  if (step.next) lines.push(row(caps, 'next', step.next, { raw: true }))
  const [add, install] = PLUGIN_INSTALL.split(' · ')
  lines.push(row(caps, 'plugin', add ?? PLUGIN_INSTALL, { raw: true }))
  if (install) {
    const note = '(once, inside Claude Code)'
    const fits = install.length + 4 + note.length <= valueBudget(caps)
    lines.push(' '.repeat(GUTTER) + install + (fits ? '    ' + paint(caps, 'dim', note) : ''))
  }
  return lines
}

export function betaLine(caps: Caps, context: string): string {
  return row(caps, 'beta', `orangu feedback --context ${context}`, { style: 'dim', raw: true })
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

/**
 * One finding: the leading severity mark, then the title wrapped under itself at whole words, in a column
 * that leaves room for the savings, right-aligned on the first line. No improvement per row: the footer
 * prints the top one.
 */
function findingRows(caps: Caps, ins: Analysis['insights'][number]): string[] {
  const g = glyphs(caps)
  const w = layoutWidth(caps)
  const save = ins.savings?.tokens ? `save ~${fmtTokens(ins.savings.tokens)} tokens` : ins.savings?.ms ? `save ~${fmtMs(ins.savings.ms)}` : ''
  const lead = '    '
  const budget = w - lead.length - 2 - (save ? displayWidth(save) + 2 : 0)
  const [first = '', ...rest] = wrapText(caps, ins.title, budget)
  const mark = paint(caps, ins.severity === 'high' ? 'bad' : ins.severity === 'medium' ? 'warn' : 'dim', g.mark)
  const gap = save ? ' '.repeat(Math.max(2, w - lead.length - 2 - displayWidth(first) - displayWidth(save))) : ''
  return [lead + mark + ' ' + first + gap + paint(caps, 'accent', save), ...rest.map((p) => lead + '  ' + p)]
}

/** stdout block of `orangu analyze`: header, the measured rows, findings, the report hint. */
export function analysisBlock(caps: Caps, a: Analysis, title: string): string[] {
  const s = a.summary
  const sep = glyphs(caps).sep
  const lines = header(caps, title, `${a.session.source}${sep}${a.session.id}`)
  lines.push(...rows(caps, 'quality', qualityLine(a, sep)))
  lines.push(...rows(caps, 'time', `${fmtMs(s.wallMs)} wall${sep}${fmtMs(s.activeMs)} active${sep}${fmtMs(s.humanWaitMs)} waiting`))
  lines.push(...rows(caps, 'tokens', `${fmtTokens(s.totalTokens)}${sep}${(s.cacheHitRatio * 100).toFixed(0)}% cache${sep}${fmtTokens(a.tokens.byKind.output)} output`))
  lines.push(...rows(caps, 'turns', `${s.turns} (${s.humanTurns} human)`))
  lines.push(...rows(caps, 'tools', `${s.toolCalls} calls${sep}${s.toolErrors} errors`))
  if (s.agents) lines.push(...rows(caps, 'agents', `${s.agents} runs${sep}${a.agents.maxConcurrency} max parallel${sep}${fmtTokens(a.tokens.agents)} tokens`))
  lines.push(...rows(caps, 'context', `peak ${fmtTokens(s.contextPeak)}${a.context.contextWindow ? ' of ' + fmtTokens(a.context.contextWindow) : ''}${sep}${plural(s.compactions, 'compaction')}`))
  lines.push('', paint(caps, 'bold', INDENT + 'findings'))
  const bad = a.parse.badLines
  if (!a.insights.length) lines.push(bad ? paint(caps, 'warn', `    no findings, but orangu skipped ${plural(bad, 'unparseable line')}`) : paint(caps, 'good', '    clean: no findings'))
  for (const ins of a.insights.slice(0, 6)) lines.push(...findingRows(caps, ins))
  lines.push('', ...fit(caps, `${INDENT}run 'orangu report ${a.session.id.slice(0, 8)}' for the full visual report`, 'dim'))
  // a transcript that did not parse is not a clean session: say what was skipped
  if (bad && a.insights.length) lines.push(...fit(caps, `${INDENT}warning: orangu skipped ${plural(bad, 'unparseable line')}`, 'warn'))
  if (!a.parse.reconciliation.ok) lines.push(...fit(caps, `${INDENT}warning: token totals reconcile within ${a.parse.reconciliation.matchesWithinPct}%`, 'warn'))
  return lines
}

/** stdout block of bare `orangu`: header, the outcome sentence, the next step, the trailing hint. */
export function briefBlock(caps: Caps, a: Analysis, title: string, step: NextStep, o: { hint: boolean }): string[] {
  const s = a.summary
  const sep = glyphs(caps).sep
  const lines = header(caps, title, `latest${sep}${a.session.id.slice(0, 8)}${sep}${s.turns} turns${sep}${fmtTokens(s.totalTokens)} tokens${sep}${fmtMs(s.activeMs)} active`)
  lines.push(...fit(caps, INDENT + outcomeHeadline(s)), '')
  lines.push(...nextStepLines(caps, step))
  if (o.hint) lines.push('', ...fit(caps, `${INDENT}orangu report for the full picture${sep}orangu --help for every command`, 'dim'))
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
  if (!o.total) lines.push(...fit(caps, `${INDENT}orangu found no sessions. Is Claude Code installed?`, 'dim'), ...fit(caps, `${INDENT}A transcript path also works: orangu report <path.jsonl>`, 'dim'))
  else {
    const sep = glyphs(caps).sep
    lines.push('')
    // the default cap is 40: say so, like pick does, so a JSON-less reader knows the list is cut
    if (refs.length < o.total) lines.push(...fit(caps, `${INDENT}${refs.length} of ${o.total} shown${sep}--limit <n> for more`, 'dim'))
    lines.push(...fit(caps, `${INDENT}orangu report <id>${sep}orangu analyze <id>${sep}orangu harness`, 'dim'))
  }
  return lines
}

/** The one-session marker, said once above the recurring findings instead of before each title. */
const ONE_SESSION_CAPTION = 'In one session: each title shows the figures of one example session.'
/** Columns before a recurring finding's title: the 4-space indent, the 8-column token figure, 2 spaces. */
const AGG_TITLE_COLUMN = 14
/** Columns before a heaviest-session title: the indent, the 9-column token figure, the 8-character id, 2 gaps. */
const AGG_SESSION_COLUMN = 25

/**
 * stdout block of `orangu repo` and `orangu global`, without the closing flag hint (that depends on what
 * the command wrote). The recurring findings say the one-session marker once, as a caption. Each row
 * prints the bounded token figure, the example title wrapped at whole words, the session count, then the
 * improvement as continuation lines (repo and global text has no footer, so each row carries its own).
 * Every value from a transcript (a title, a path, a model id, an error signature) passes through
 * stripAnsi, inside wrapWords and truncate or directly.
 */
export function aggregateBlock(caps: Caps, a: Aggregate): string[] {
  const lines = ['', paint(caps, ['bold', 'accent'], 'orangu') + '  ' + paint(caps, 'bold', stripAnsi(a.scope)), paint(caps, 'dim', `${INDENT}${plural(a.sessionCount, 'session')}`), '']
  const line = (l: string, v: string) => lines.push(INDENT + l.padEnd(20) + v)
  line('total tokens', fmtTokens(a.totals.tokens))
  line('tool calls', `${a.totals.toolCalls} (${a.totals.toolErrors} errors, ${(a.averages.toolErrorRate * 100).toFixed(1)}%)`)
  line('subagent runs', String(a.totals.agents))
  line('PRs / commits', `${a.totals.prs} / ${a.totals.commits}`)
  line('tokens / session', fmtTokens(a.averages.tokensPerSession))
  line('tokens / human turn', fmtTokens(a.averages.tokensPerHumanTurn))
  line('cache hit ratio', (a.averages.cacheHitRatio * 100).toFixed(1) + '%')
  if (a.byModel.length) {
    lines.push('', paint(caps, 'bold', `${INDENT}tokens by model`))
    for (const m of a.byModel.slice(0, 6)) lines.push(`    ${stripAnsi(m.key).padEnd(24)} ${fmtTokens(m.tokens).padStart(9)}  ${plural(m.count, 'session')}`)
  }
  if (a.crossFindings.length) {
    lines.push('', paint(caps, 'bold', `${INDENT}recurring findings (across sessions)`))
    lines.push(...fit(caps, INDENT + ONE_SESSION_CAPTION, 'dim'))
    const pad = ' '.repeat(AGG_TITLE_COLUMN)
    const budget = layoutWidth(caps) - AGG_TITLE_COLUMN
    // The bounded figure (median per session × sessions) so one outlier session cannot inflate the claim.
    for (const f of a.crossFindings.slice(0, 8)) {
      const figure = paint(caps, 'accent', (f.boundedSavingsTokens ? '~' + fmtTokens(f.boundedSavingsTokens) : '–').padStart(8))
      const count = `(${plural(f.sessions, 'session')})`
      const title = wrapText(caps, f.exampleTitle ?? f.title, budget)
      const last = title.at(-1)
      // the count joins the last title line when it fits there, else it takes a line of its own
      const body = last !== undefined && displayWidth(last) + 2 + count.length <= budget ? [...title.slice(0, -1), last + '  ' + paint(caps, 'dim', count)] : [...title, paint(caps, 'dim', count)]
      const improvement = f.improvement ? wrapText(caps, `Improvement: ${f.improvement}`, budget) : []
      ;[...body, ...improvement].forEach((p, i) => lines.push((i ? pad : `    ${figure}  `) + p))
    }
  }
  if (a.recurringErrors.length) {
    lines.push('', paint(caps, 'bold', `${INDENT}recurring tool errors (environment problems)`))
    // Under the default strip every signature is blank, so N identical rows would say nothing: collapse per tool.
    const hidden = new Map<string, { total: number; groups: number; sessions: number }>()
    for (const e of a.recurringErrors) {
      if (e.signature) continue
      const h = hidden.get(e.tool) ?? { total: 0, groups: 0, sessions: 0 }
      h.total += e.total
      h.groups += 1
      h.sessions = Math.max(h.sessions, e.sessions)
      hidden.set(e.tool, h)
    }
    for (const e of a.recurringErrors.filter((e) => e.signature).slice(0, 6)) lines.push(`    ${paint(caps, 'bad', String(e.total).padStart(4))}×  ${stripAnsi(e.tool)}: ${stripAnsi(e.signature)}  ${paint(caps, 'dim', '(' + plural(e.sessions, 'session') + ')')}`)
    for (const [tool, h] of [...hidden].slice(0, 6)) lines.push(`    ${paint(caps, 'bad', String(h.total).padStart(4))}×  ${stripAnsi(tool)}: ${plural(h.groups, 'recurring signature')}, text hidden (add --include-text)  ${paint(caps, 'dim', '(' + plural(h.sessions, 'session') + ')')}`)
  }
  if (a.topReReadFiles.length) {
    lines.push('', paint(caps, 'bold', `${INDENT}most re-read files (context weight)`))
    for (const f of a.topReReadFiles.slice(0, 6)) lines.push(`    ${String(f.totalReads).padStart(4)} reads  ${stripAnsi(f.path)}  ${paint(caps, 'dim', '(' + plural(f.sessions, 'session') + ')')}`)
  }
  lines.push('', paint(caps, 'bold', `${INDENT}heaviest sessions (by tokens)`))
  // the title is a label column (transcript text): cut at its last whole word; the report shows it whole
  const titleBudget = layoutWidth(caps) - AGG_SESSION_COLUMN
  for (const s of a.topSessions.slice(0, 8)) lines.push(`    ${fmtTokens(s.tokens).padStart(9)}  ${stripAnsi(s.id).slice(0, 8)}  ${paint(caps, 'dim', s.title ? truncate(s.title, titleBudget, caps) : '(title hidden, add --include-text)')}`)
  return lines
}

// ---------- orangu pick ----------

/** One choice in `orangu pick`: a session ref plus what the picker learned about it. */
export interface PickRow {
  sessionId: string
  path: string
  projectSlug: string
  /** the project's directory name: the transcript's cwd basename when the head has it, else the slug */
  project: string
  /** head-read title, already redacted; absent when the head had none */
  title?: string
  sizeBytes: number
  mtimeMs: number
  /** Claude Code records a live pid for it, or its transcript changed recently */
  running: boolean
}

export interface PickCounts {
  total: number
  running: number
}

/** `now`, `12m`, `3h`, `9d` (capped at 99d): four columns at most. */
export function fmtAge(mtimeMs: number, now: number): string {
  const s = Math.max(0, now - mtimeMs) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.min(99, Math.floor(s / 86_400))}d`
}

const AGE_WIDTH = 4
const SIZE_WIDTH = 8
const RUNNING = 'running'
const TITLE_MIN = 12

/**
 * One pick row after the lead: id, title, project, age, size, running. Columns yield in order
 * project, size, the running word (the leading mark stays), and the title never drops below 4.
 */
function pickCells(caps: Caps, r: PickRow, now: number, leadWidth: number): string {
  const w = layoutWidth(caps)
  const id = r.sessionId.slice(0, 8)
  let showProject = true
  let showSize = true
  let showRunning = true
  const fixed = (): number => leadWidth + 8 + 2 + (showProject ? 16 : 0) + 2 + AGE_WIDTH + (showSize ? 2 + SIZE_WIDTH : 0) + (showRunning ? 2 + RUNNING.length : 0)
  if (w - fixed() < TITLE_MIN) showProject = false
  if (w - fixed() < TITLE_MIN) showSize = false
  if (w - fixed() < TITLE_MIN) showRunning = false
  const titleWidth = Math.max(4, w - fixed())
  const title = padCell(truncate(r.title ?? '(no title)', titleWidth, caps), titleWidth)
  const cells = [paint(caps, 'accent', id), r.title ? title : paint(caps, 'dim', title)]
  if (showProject) cells.push(paint(caps, 'dim', padCell(truncate(r.project, 14, caps), 14)))
  cells.push(paint(caps, 'dim', padCell(fmtAge(r.mtimeMs, now), AGE_WIDTH, 'r')))
  if (showSize) cells.push(padCell(fmtBytes(r.sizeBytes), SIZE_WIDTH, 'r'))
  if (showRunning) cells.push(r.running ? paint(caps, 'good', RUNNING) : ' '.repeat(RUNNING.length))
  return cells.join('  ')
}

function pickHeader(caps: Caps, shown: number, counts: PickCounts): string {
  const w = layoutWidth(caps)
  const left = paint(caps, ['bold', 'accent'], 'orangu') + '  ' + paint(caps, 'bold', 'choose a session')
  // a list cut by --limit says so ("N of M sessions"), never a bare total above fewer rows
  const total = shown < counts.total ? `${shown} of ${plural(counts.total, 'session')}` : plural(counts.total, 'session')
  const right = `${total}, ${counts.running} running`
  const gap = w - INDENT.length - displayWidth(left) - displayWidth(right)
  // the count is right-aligned when it fits and dropped when it does not; the title never yields
  return INDENT + left + (gap >= 2 ? ' '.repeat(gap) + paint(caps, 'dim', right) : '')
}

/** The interactive frame: header, the visible window with a cursor and running marks, the key hint. */
export function pickFrame(caps: Caps, rows: PickRow[], view: { cursor: number; start: number; size: number }, counts: PickCounts, now: number): string[] {
  const g = glyphs(caps)
  const lines = [pickHeader(caps, rows.length, counts), '']
  const end = Math.min(rows.length, view.start + view.size)
  for (let i = view.start; i < end; i++) {
    const r = rows[i]!
    const cursor = i === view.cursor
    const mark = r.running ? paint(caps, 'good', g.mark) : ' '
    const lead = `${INDENT}${cursor ? paint(caps, 'accent', '>') : ' '} ${mark} `
    lines.push(lead + pickCells(caps, r, now, INDENT.length + 4))
  }
  if (view.start > 0 || end < rows.length) lines.push(paint(caps, 'dim', `${INDENT}    ${g.up}${g.down} ${rows.length - (end - view.start)} more`))
  else lines.push('')
  const keys = caps.unicode ? '↑↓ or j k move · enter opens the report · q quits' : 'up/down or j k move | enter opens the report | q quits'
  const more = rows.length < counts.total ? `${g.sep}--limit <n> for more` : ''
  lines.push(paint(caps, 'dim', truncate(INDENT + keys + more, layoutWidth(caps), caps)))
  return lines
}

/** The non-interactive form: numbered rows and one hint, so a pipe or the Bash tool can act on it. */
export function pickList(caps: Caps, rows: PickRow[], counts: PickCounts, now: number): string[] {
  const g = glyphs(caps)
  const numWidth = String(rows.length).length + 2
  const lines = [pickHeader(caps, rows.length, counts), '']
  rows.forEach((r, i) => {
    const mark = r.running ? paint(caps, 'good', g.mark) : ' '
    const lead = `${INDENT}${padCell(`[${i + 1}]`, numWidth)} ${mark} `
    lines.push(lead + pickCells(caps, r, now, INDENT.length + numWidth + 3))
  })
  const hint = rows.length < counts.total ? `--limit <n> for more${g.sep}interactive on a terminal` : 'the picker is interactive on a terminal'
  lines.push('', paint(caps, 'dim', truncate(`${INDENT}run: orangu report <id>${g.sep}${hint}`, layoutWidth(caps), caps)))
  return lines
}
