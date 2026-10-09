/**
 * The `enforcement` section of the harness report: where an instruction or a note did not hold.
 *
 * Every row is a sum over the per-session evidence in `Analysis.instructions` and `Analysis.quality`, plus the
 * memory indexes the collector measured on disk. Pure and deterministic: no clock, no file system; the caller
 * passes in everything, and every array is sorted on a total key before it is capped.
 *
 * Words only, never meaning. A note "matches" a complaint when both use the same content word, and a complaint
 * word is "in the instructions" when an instruction file in scope uses it. The harness skill reads the rows and
 * judges whether a complaint is the same issue as the note.
 */
import type { Analysis, NoteWrite } from '../model/analysis.js'
import { contentWords } from '../analyze/instructions.js'
import {
  HARNESS_ROW_CAP,
  type HarnessComplaintRow,
  type HarnessEnforcement,
  type HarnessMemoryIndexFile,
  type HarnessMemoryLoadRow,
  type HarnessNoteRow,
  type HarnessPromptRef,
  type HarnessRuleRow,
} from './types.js'

export interface EnforcementOptions {
  /** the memory indexes on disk now, as the collector measured them (paths in the same form as the analyses) */
  memoryIndexes?: HarnessMemoryIndexFile[]
  /** the content words of every instruction file and memory note in scope */
  instructionWords?: ReadonlySet<string>
  /** keep the prompt text of each example (`--include-text`); otherwise an example is a session id and a turn */
  includeText?: boolean
  /**
   * The path form of the report (the collector writes `~/…`). Applied to every session-side path before a join,
   * so a memory index the collector measured and one a session loaded are one row.
   */
  norm?: (p: string) => string
}

/** the analyses with every path the joins read in the report's form */
function normed(analyses: Analysis[], norm: (p: string) => string): Analysis[] {
  return analyses.map((a) => {
    const ins = a.instructions
    return {
      ...a,
      session: { ...a.session, ...(a.session.cwd !== undefined ? { cwd: norm(a.session.cwd) } : {}) },
      ...(ins
        ? {
            instructions: {
              loaded: ins.loaded.map((l) => ({ ...l, path: norm(l.path) })),
              rules: ins.rules.map((r) => ({ ...r, path: norm(r.path) })),
              noteWrites: ins.noteWrites.map((w) => ({ ...w, path: norm(w.path) })),
              memoryCuts: ins.memoryCuts.map((c) => ({ ...c, path: norm(c.path) })),
            },
          }
        : {}),
    }
  })
}

const EXAMPLES = 3
/** a complaint word must come back in another session to be a theme */
const THEME_MIN_SESSIONS = 2

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function dirOf(p: string): string {
  const i = p.replace(/\\/g, '/').lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

interface Complaint {
  sessionId: string
  turnIndex: number
  at?: number
  preview: string
}

function complaintsOf(a: Analysis): Complaint[] {
  const startOf = new Map(a.turns.map((t) => [t.index, t.startTs]))
  return a.quality.userCorrections.map((c) => {
    const at = startOf.get(c.turnIndex)
    return { sessionId: a.session.id, turnIndex: c.turnIndex, ...(at !== undefined ? { at } : {}), preview: c.preview }
  })
}

function ref(c: Complaint, includeText: boolean | undefined): HarnessPromptRef {
  return { sessionId: c.sessionId, turnIndex: c.turnIndex, ...(c.at !== undefined ? { at: c.at } : {}), ...(includeText ? { preview: c.preview } : {}) }
}

/**
 * The project a rule file belongs to: a worktree copy of CLAUDE.md (`<repo>/.claude/worktrees/<w>/CLAUDE.md`, or a
 * sibling `<repo>-worktrees/<w>/CLAUDE.md`) is the repository's own file, so its rule is the same rule. The same
 * line in another project's file is another rule.
 */
export function ruleHome(path: string): string {
  const p = path.replace(/\\/g, '/')
  const dir = p.slice(0, Math.max(0, p.lastIndexOf('/')))
  return dir.replace(/\/\.claude\/worktrees\/[^/]+(?=\/|$)/, '').replace(/^(.*\/[^/]+)-worktrees\/[^/]+(?=\/|$)/, (_m, repo: string) => repo).replace(/\/\.worktrees\/[^/]+(?=\/|$)/, '')
}

/** the rules rows: one per project, rule text and target, summed over every session that had it in context */
function ruleRows(analyses: Analysis[]): { rows: HarnessRuleRow[]; inContext: number } {
  interface Acc {
    files: Map<string, number>
    text: string
    target: HarnessRuleRow['target']
    sessions: number
    broken: number
    calls: number
    agentCalls: number
    blocked: number
    examples: string[]
    perSession: Array<{ id: string; calls: number }>
    lastBrokenAt?: number
  }
  const acc = new Map<string, Acc>()
  for (const a of analyses) {
    // Two copies of one rule in one session (a loaded CLAUDE.md and the note the session wrote, or the repo file
    // and a worktree copy) see the SAME calls: the session counts each call once, the largest count of its copies.
    const mine = new Map<string, { calls: number; agentCalls: number; blocked: number; examples: string[] }>()
    for (const r of a.instructions?.rules ?? []) {
      const key = `${ruleHome(r.path)}\u0000${r.target.kind}\u0000${r.target.name}\u0000${r.text}`
      let row = acc.get(key)
      if (!row) {
        row = { files: new Map(), text: r.text, target: { kind: r.target.kind, name: r.target.name }, sessions: 0, broken: 0, calls: 0, agentCalls: 0, blocked: 0, examples: [], perSession: [] }
        acc.set(key, row)
      }
      // a line number from a loaded file beats 0 (an Edit snippet carries no file line)
      if ((row.files.get(r.path) ?? 0) < r.line || !row.files.has(r.path)) row.files.set(r.path, r.line)
      const prior = mine.get(key)
      if (!prior) mine.set(key, { calls: r.calls, agentCalls: r.agentCalls, blocked: r.blocked ?? 0, examples: [...r.examples] })
      else if (r.calls > prior.calls) Object.assign(prior, { calls: r.calls, agentCalls: r.agentCalls, blocked: r.blocked ?? 0, examples: [...r.examples] })
    }
    for (const [key, m] of mine) {
      const row = acc.get(key)!
      row.sessions++
      if (!m.calls) continue
      row.broken++
      row.perSession.push({ id: a.session.id, calls: m.calls })
      if (a.session.startedAt !== undefined && (row.lastBrokenAt === undefined || a.session.startedAt > row.lastBrokenAt)) row.lastBrokenAt = a.session.startedAt
      row.calls += m.calls
      row.agentCalls += m.agentCalls
      row.blocked += m.blocked
      for (const e of m.examples) if (row.examples.length < EXAMPLES && !row.examples.includes(e)) row.examples.push(e)
    }
  }
  const rows: HarnessRuleRow[] = []
  for (const r of acc.values()) {
    if (!r.calls) continue
    // a file with a known line first, then the shortest path: the main checkout, not a worktree copy
    const [file, line] = [...r.files].sort((a, b) => Number(b[1] > 0) - Number(a[1] > 0) || a[0].length - b[0].length || cmp(a[0], b[0]))[0]!
    rows.push({
      file,
      files: r.files.size,
      line,
      text: r.text,
      target: r.target,
      sessionsInContext: r.sessions,
      sessionsBroken: r.broken,
      calls: r.calls,
      agentCalls: r.agentCalls,
      blocked: r.blocked,
      examples: r.examples,
      exampleSessionIds: [...r.perSession].sort((x, y) => y.calls - x.calls || cmp(x.id, y.id)).slice(0, EXAMPLES).map((p) => p.id),
      ...(r.lastBrokenAt !== undefined ? { lastBrokenAt: r.lastBrokenAt } : {}),
    })
  }
  rows.sort((a, b) => b.calls - b.blocked - (a.calls - a.blocked) || b.calls - a.calls || b.sessionsBroken - a.sessionsBroken || cmp(a.file, b.file) || a.line - b.line || cmp(a.target.name, b.target.name))
  return { rows, inContext: acc.size }
}

/** does session `a` work under the same instructions as the note at `path`, written from `writerCwd`? */
function sameProject(a: Analysis, path: string, kind: NoteWrite['kind'], writerCwd: string | undefined): boolean {
  const loaded = a.instructions?.loaded ?? []
  if (kind === 'memory' || kind === 'memory-index') {
    const dir = dirOf(path)
    if (loaded.some((l) => dirOf(l.path) === dir)) return true
  } else if (loaded.some((l) => l.path === path)) return true
  if (writerCwd !== undefined && a.session.cwd === writerCwd) return true
  const root = dirOf(path)
  return kind !== 'memory' && kind !== 'memory-index' && a.session.cwd !== undefined && root !== '' && (a.session.cwd === root || a.session.cwd.startsWith(root + '/'))
}

/** how many turns before a note write a complaint may sit and still be the note's trigger */
const TRIGGER_TURNS = 3
/** a shared word must be rare: in at most this share of the human prompts in scope (or in at most 3) */
const RARE_SHARE = 0.05

/** the number of human prompts that use each content word, so a match can ignore the words of every prompt */
function promptWordCounts(analyses: Analysis[]): { df: Map<string, number>; prompts: number } {
  const df = new Map<string, number>()
  let prompts = 0
  for (const a of analyses) {
    for (const t of a.turns) {
      if (t.kind !== 'human') continue
      prompts++
      for (const w of contentWords(t.promptPreview, { cap: Infinity })) df.set(w, (df.get(w) ?? 0) + 1)
    }
  }
  return { df, prompts }
}

function isFeedbackNote(path: string, noteType: string | undefined): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return noteType === 'feedback' || /^feedback[_-]/i.test(base)
}

function noteRows(analyses: Analysis[], complaints: Map<string, Complaint[]>, includeText: boolean | undefined): { rows: HarnessNoteRow[]; written: number } {
  interface Acc {
    kind: NoteWrite['kind']
    noteType?: string
    writtenAt?: number
    writtenBy: string
    writerCwd?: string
    firstTurn: number
    writes: number
    words: Set<string>
    trigger?: Complaint
  }
  const notes = new Map<string, Acc>()
  for (const a of analyses) {
    const own = complaints.get(a.session.id) ?? []
    for (const w of a.instructions?.noteWrites ?? []) {
      const n = notes.get(w.path)
      const earlier = !n || (w.ts !== undefined && (n.writtenAt === undefined || w.ts < n.writtenAt))
      if (!n) notes.set(w.path, { kind: w.kind, writtenBy: a.session.id, firstTurn: w.turnIndex, writes: 0, words: new Set() })
      const row = notes.get(w.path)!
      if (earlier) {
        // the complaint that led to this write: the last one at or before the write's turn, within TRIGGER_TURNS
        const trigger = [...own].reverse().find((c) => c.turnIndex <= w.turnIndex && c.turnIndex >= w.turnIndex - TRIGGER_TURNS)
        row.writtenBy = a.session.id
        row.firstTurn = w.turnIndex
        if (w.ts !== undefined) row.writtenAt = w.ts
        else delete row.writtenAt
        if (a.session.cwd !== undefined) row.writerCwd = a.session.cwd
        else delete row.writerCwd
        if (trigger) row.trigger = trigger
        else delete row.trigger
      }
      if (w.noteType && !row.noteType) row.noteType = w.noteType
      row.writes++
      for (const word of w.words) row.words.add(word)
    }
  }
  const { df, prompts } = promptWordCounts(analyses)
  const rareCap = Math.max(3, Math.ceil(prompts * RARE_SHARE))
  const rows: HarnessNoteRow[] = []
  for (const [file, n] of notes) {
    if (!isFeedbackNote(file, n.noteType) && !n.trigger) continue
    // what the note is about: its own rare words, and the rare words of the complaint that led to it
    const topic = new Set([...n.words, ...(n.trigger ? contentWords(n.trigger.preview) : [])].filter((w) => (df.get(w) ?? 0) <= rareCap))
    let sessionsAfter = 0
    let after = 0
    const matches: Array<{ c: Complaint; shared: string[] }> = []
    for (const a of analyses) {
      const own = a.session.id === n.writtenBy
      if (!own && !sameProject(a, file, n.kind, n.writerCwd)) continue
      // a later session, or the writer's own turns after the write
      const later = own || (n.writtenAt !== undefined && a.session.startedAt !== undefined && a.session.startedAt > n.writtenAt)
      if (!later) continue
      sessionsAfter++
      for (const c of complaints.get(a.session.id) ?? []) {
        if (own && c.turnIndex <= n.firstTurn) continue
        after++
        // after a trigger (complaint, note, complaint) one rare word links them; a note with no trigger needs two
        const shared = contentWords(c.preview).filter((w) => topic.has(w))
        if (shared.length >= (n.trigger ? 1 : 2)) matches.push({ c, shared })
      }
    }
    matches.sort((x, y) => (x.c.at ?? 0) - (y.c.at ?? 0) || cmp(x.c.sessionId, y.c.sessionId) || x.c.turnIndex - y.c.turnIndex)
    const wordCount = new Map<string, number>()
    for (const m of matches) for (const w of m.shared) wordCount.set(w, (wordCount.get(w) ?? 0) + 1)
    const firstAt = matches[0]?.c.at
    rows.push({
      file,
      kind: n.kind,
      ...(n.noteType ? { noteType: n.noteType } : {}),
      ...(n.trigger ? { trigger: ref(n.trigger, includeText) } : {}),
      ...(n.writtenAt !== undefined ? { writtenAt: n.writtenAt } : {}),
      writtenBy: n.writtenBy,
      writes: n.writes,
      sessionsAfter,
      complaintsAfter: after,
      matchingComplaints: matches.length,
      ...(firstAt !== undefined && n.writtenAt !== undefined ? { firstMatchAfterMs: Math.max(0, firstAt - n.writtenAt) } : {}),
      sharedWords: [...wordCount].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])).map(([w]) => w),
      examples: matches.slice(0, EXAMPLES).map((m) => ref(m.c, includeText)),
    })
  }
  rows.sort((a, b) => b.matchingComplaints - a.matchingComplaints || b.complaintsAfter - a.complaintsAfter || (b.writtenAt ?? 0) - (a.writtenAt ?? 0) || cmp(a.file, b.file))
  return { rows, written: notes.size }
}

function memoryRows(analyses: Analysis[], indexes: HarnessMemoryIndexFile[]): HarnessMemoryLoadRow[] {
  const rows = new Map<string, HarnessMemoryLoadRow>()
  const row = (file: string): HarnessMemoryLoadRow => {
    let r = rows.get(file)
    if (!r) {
      r = { file, sessionsLoaded: 0, sessionsCut: 0, maxLinesCut: 0 }
      rows.set(file, r)
    }
    return r
  }
  for (const m of indexes) Object.assign(row(m.file), { lines: m.lines, bytes: m.bytes, chars: m.chars, linesPastLimit: m.linesPastLimit, ...(m.firstLinePastLimit !== undefined ? { firstLinePastLimit: m.firstLinePastLimit } : {}) })
  for (const a of analyses) {
    const ins = a.instructions
    if (!ins) continue
    for (const l of ins.loaded) if (l.type === 'AutoMem' || /[/\\]memory[/\\]MEMORY\.md$/.test(l.path)) row(l.path).sessionsLoaded++
    const cutHere = new Set<string>()
    for (const c of ins.memoryCuts) {
      const r = row(c.path)
      if (!cutHere.has(c.path)) {
        cutHere.add(c.path)
        r.sessionsCut++
      }
      r.maxLinesCut = Math.max(r.maxLinesCut, c.linesCut ?? 0)
      if (c.ts !== undefined && (r.lastCutAt === undefined || c.ts > r.lastCutAt)) r.lastCutAt = c.ts
    }
  }
  return [...rows.values()].sort((a, b) => b.sessionsCut - a.sessionsCut || (b.linesPastLimit ?? 0) - (a.linesPastLimit ?? 0) || b.sessionsLoaded - a.sessionsLoaded || cmp(a.file, b.file))
}

function complaintRows(all: Complaint[], instructionWords: ReadonlySet<string> | undefined, includeText: boolean | undefined): HarnessComplaintRow[] {
  const acc = new Map<string, { prompts: Complaint[]; sessions: Set<string> }>()
  for (const c of all) {
    for (const w of contentWords(c.preview, { keepComplaintWords: true })) {
      const a = acc.get(w) ?? { prompts: [], sessions: new Set<string>() }
      a.prompts.push(c)
      a.sessions.add(c.sessionId)
      acc.set(w, a)
    }
  }
  const rows: HarnessComplaintRow[] = []
  for (const [word, a] of acc) {
    if (a.sessions.size < THEME_MIN_SESSIONS) continue
    const sorted = [...a.prompts].sort((x, y) => (x.at ?? 0) - (y.at ?? 0) || cmp(x.sessionId, y.sessionId) || x.turnIndex - y.turnIndex)
    const firstAt = sorted.find((c) => c.at !== undefined)?.at
    const lastAt = [...sorted].reverse().find((c) => c.at !== undefined)?.at
    rows.push({
      word,
      prompts: a.prompts.length,
      sessions: a.sessions.size,
      ...(firstAt !== undefined ? { firstAt } : {}),
      ...(lastAt !== undefined ? { lastAt } : {}),
      inInstructions: instructionWords?.has(word) ?? false,
      examples: sorted.slice(-EXAMPLES).reverse().map((c) => ref(c, includeText)),
    })
  }
  return rows.sort((a, b) => b.sessions - a.sessions || b.prompts - a.prompts || cmp(a.word, b.word))
}

/** the only shape of an auto-memory index path: `<config>/projects/<slug>/memory/MEMORY.md` */
export const MEMORY_INDEX_PATH_RE = /[/\\]projects[/\\][^/\\]+[/\\]memory[/\\]MEMORY\.md$/

/** the auto-memory indexes the sessions loaded, as raw paths, so the collector measures each one on disk */
export function loadedMemoryIndexPaths(analyses: Analysis[]): string[] {
  const out = new Set<string>()
  for (const a of analyses) for (const l of a.instructions?.loaded ?? []) if (MEMORY_INDEX_PATH_RE.test(l.path)) out.add(l.path)
  return [...out].sort()
}

/**
 * Without `--include-text` the section carries no text that a person or a model wrote: the rule line goes (the
 * skill reads it from the file at `file:line`), and so do the shared note words and the complaint words. The
 * counts, targets, paths, session ids and turns stay.
 */
function withoutText(e: HarnessEnforcement): HarnessEnforcement {
  return {
    ...e,
    broken: e.broken.map((b) => ({ ...b, text: '' })),
    notes: e.notes.map((n) => ({ ...n, sharedWords: [] })),
    complaints: [],
  }
}

export function buildEnforcement(input: Analysis[], opts: EnforcementOptions = {}): HarnessEnforcement {
  const analyses = opts.norm ? normed(input, opts.norm) : input
  const complaints = new Map<string, Complaint[]>()
  const all: Complaint[] = []
  for (const a of analyses) {
    const cs = complaintsOf(a)
    complaints.set(a.session.id, cs)
    all.push(...cs)
  }
  const { rows: broken, inContext } = ruleRows(analyses)
  const { rows: notes, written } = noteRows(analyses, complaints, opts.includeText)
  const memory = memoryRows(analyses, opts.memoryIndexes ?? [])
  const themes = complaintRows(all, opts.instructionWords, opts.includeText)
  const section: HarnessEnforcement = {
    counts: {
      sessionsWithRecord: analyses.filter((a) => (a.instructions?.loaded.length ?? 0) > 0).length,
      rulesInContext: inContext,
      rulesBroken: broken.length,
      rulesEnforced: broken.filter((b) => b.blocked === b.calls).length,
      notesWritten: written,
      feedbackNotes: notes.length,
      notesFollowedByComplaint: notes.filter((n) => n.matchingComplaints > 0).length,
      complaints: all.length,
      recurringComplaintWords: themes.length,
      memoryIndexesCut: memory.filter((m) => m.sessionsCut > 0 || (m.linesPastLimit ?? 0) > 0).length,
    },
    broken: broken.slice(0, HARNESS_ROW_CAP),
    notes: notes.slice(0, HARNESS_ROW_CAP),
    memory: memory.slice(0, HARNESS_ROW_CAP),
    complaints: themes.slice(0, HARNESS_ROW_CAP),
  }
  return opts.includeText ? section : withoutText(section)
}
