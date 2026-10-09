/**
 * What the instruction files said, crossed with what the session did.
 *
 * A rule in CLAUDE.md or in memory is one line among many in the context, so the agent can miss it. This module
 * finds the "do not" rules that name something a call can match (a shell command, a long flag, a built-in tool,
 * an MCP server) and counts the calls that broke them AFTER the rule entered the main context: from the
 * `instructions` attachment that loaded it, or from the Write or Edit call that wrote it in this session. It
 * also records the note writes themselves and Claude Code's own warning that it did not load all of MEMORY.md.
 *
 * Pure and deterministic: no clock, no file system, no network. Words only, never meaning: the rule grammar is
 * a fixed set of phrases, and a rule that carries a condition ("when", "for", "through") still counts every
 * matching call. The harness skill reads the rule text and judges the condition.
 */
import type { InstructionFile, Session, ToolCall } from '../model/session.js'
import type { InstructionRule, InstructionsAnalysis, MemoryCut, NoteKind, NoteWrite, RuleTargetKind } from '../model/analysis.js'

export interface RuleTarget {
  kind: RuleTargetKind
  name: string
}

export interface ExtractedRule {
  line: number
  text: string
  targets: RuleTarget[]
}

/** built-in tools that a rule can name in a code span; the file and shell core (Bash, Read, Edit, ...) is left out, a rule about it is a condition */
const TOOL_TARGETS = new Set([
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'Skill', 'Workflow', 'AskUserQuestion', 'SendMessage', 'Monitor',
  'CronCreate', 'ScheduleWakeup', 'ToolSearch', 'EnterPlanMode', 'NotebookEdit', 'Artifact',
])
/** the built-in tools that a rule can name WITHOUT a code span: names no English sentence uses by chance */
const BARE_TOOL_TARGETS = new Set(['WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'SendMessage', 'CronCreate', 'ScheduleWakeup', 'ToolSearch', 'EnterPlanMode', 'NotebookEdit'])

/** the runners a command target may follow: `db:push` matches `npm run db:push`, `tsc` matches `npx tsc` */
const RUNNERS = ['npx ', 'npm run ', 'npm exec ', 'pnpm run ', 'pnpm exec ', 'pnpm dlx ', 'pnpm ', 'yarn run ', 'yarn dlx ', 'yarn ', 'bunx ', 'bun run ', 'bun x ']

const NEGATIVE_RE = /\b(?:never|do not|don't|dont|must not|mustn't|should not|shouldn't|stop)\s+(?:ever\s+)?(?:use|using|run|running|call|calling|invoke|invoking|execute|executing)\b|\bavoid(?:ing)?\b/gi
/** "never call `x`" is about code (a function, a method), so it names a tool or a server, never a shell command */
const CODE_VERB_RE = /\b(?:call|calling|invoke|invoking)$/i
/** where a "do not" clause ends: a sentence end, a dash, a semicolon, or a turn to what to do instead */
/**
 * Where a "do not" clause ends: a sentence end, a dash, a semicolon, a turn to what to do instead, or a condition.
 * "Never run `git commit` without `npm run verify` first": after "without" comes what the rule ASKS for, so it is
 * never a target. "for" does not end a clause ("Do not use for: `drizzle-kit push`").
 */
const CLAUSE_END_RE = /[.!?](?=\s|$)|;|\s[\u2014\u2013-]\s|,\s*(?:use|run|prefer|call|but)\b|\s(?:instead|but|unless|except|without|before|after|while|until|when|whenever|if|then|first|so|because|always)\b/i
/** "use X instead of Y", "use X rather than Y", "use X, not Y", "prefer X over Y": Y follows the connector */
const INSTEAD_RE = /\b(?:instead of|rather than)\s+/gi
const NOT_RE = /(?:,\s*|\s)not\s+/gi
const OVER_RE = /\bprefer\b[^.;]*?\bover\s+/gi

const SPAN = '\u0000'
/** a program word, an optional script name after a colon, and at most 5 more plain words */
const COMMAND_RE = /^[a-z][a-z0-9.+-]*(?::[a-z0-9:._-]+)?(?:\s+[^\s*`]+){0,5}$/
const FLAG_RE = /^--[a-z][a-z0-9-]*$/

/** a code span's text as a target, or null when it names nothing a call can match */
function spanTarget(raw: string, mcpServers: ReadonlySet<string>): RuleTarget | null {
  const span = raw.trim().replace(/\s+/g, ' ').replace(/\s*(?:\*|\.\.\.|…)$/, '').trim()
  if (!span) return null
  const mcp = /^mcp__([a-z0-9_-]+?)(?:__.*)?$/i.exec(span)
  if (mcp) return { kind: 'mcp-server', name: mcp[1]!.toLowerCase() }
  if (mcpServers.has(span.toLowerCase())) return { kind: 'mcp-server', name: span.toLowerCase() }
  if (TOOL_TARGETS.has(span)) return { kind: 'tool', name: span }
  if (FLAG_RE.test(span)) return { kind: 'flag', name: span }
  if (COMMAND_RE.test(span) && !span.includes('/')) return { kind: 'command', name: span }
  return null
}

/** a plain word as a target: only an MCP server name or a distinctive tool name */
function wordTarget(word: string, mcpServers: ReadonlySet<string>): RuleTarget | null {
  const w = word.replace(/[^A-Za-z0-9_-]/g, '')
  if (!w) return null
  if (mcpServers.has(w.toLowerCase())) return { kind: 'mcp-server', name: w.toLowerCase() }
  if (BARE_TOOL_TARGETS.has(w)) return { kind: 'tool', name: w }
  return null
}

/** the targets in one window of the masked line: each code span, and each plain word that names a server or tool */
function targetsIn(window: string, spans: string[], mcpServers: ReadonlySet<string>): RuleTarget[] {
  const out: RuleTarget[] = []
  for (const tok of window.split(/\s+/)) {
    const m = new RegExp(`${SPAN}(\\d+)${SPAN}`).exec(tok)
    const t = m ? spanTarget(spans[Number(m[1])]!, mcpServers) : wordTarget(tok, mcpServers)
    if (t) out.push(t)
  }
  return out
}

/** the first target within the next 4 words of a connector, or none */
function firstTargetAfter(rest: string, spans: string[], mcpServers: ReadonlySet<string>): RuleTarget[] {
  const head = rest.split(/\s+/).slice(0, 4)
  for (const tok of head) {
    const t = targetsIn(tok, spans, mcpServers)
    if (t.length) return [t[0]!]
    if (CLAUSE_END_RE.test(` ${tok} `)) break
  }
  return []
}

function sameTarget(a: RuleTarget, b: RuleTarget): boolean {
  return a.kind === b.kind && a.name === b.name
}

/**
 * Each markdown code span becomes a placeholder, and then markdown emphasis goes, so "bare.** Both" ends its
 * sentence. A span opens with a run of N backticks and closes at the next run of exactly N (CommonMark), so
 * `` sql`x` `` is one span. An unclosed run stays as text.
 */
export function maskCodeSpans(line: string): { masked: string; spans: string[] } {
  const spans: string[] = []
  let masked = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      masked += line[i]
      i++
      continue
    }
    let n = 0
    while (line[i + n] === '`') n++
    let close = -1
    for (let j = i + n; j < line.length; j++) {
      if (line[j] !== '`') continue
      let m = 0
      while (line[j + m] === '`') m++
      if (m === n) {
        close = j
        break
      }
      j += m - 1
    }
    if (close < 0) {
      masked += line.slice(i, i + n)
      i += n
      continue
    }
    const inner = line.slice(i + n, close)
    masked += ` ${SPAN}${spans.push(inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner) - 1}${SPAN} `
    i = close + n
  }
  return { masked: masked.replace(/\*{1,3}|(?<![A-Za-z0-9])_{1,3}|_{1,3}(?![A-Za-z0-9])/g, ''), spans }
}

/**
 * Every line of an instruction text that reads as a "do not" rule naming something a call can match.
 * `mcpServers` holds the lower-case server names the session knows, so "not playwright" can name a server.
 */
export function extractRules(text: string, mcpServers: ReadonlySet<string> = new Set()): ExtractedRule[] {
  const out: ExtractedRule[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/[’‘]/g, "'")
    if (!raw.includes('`') && !/never|not|avoid|stop|instead|rather|prefer/i.test(raw)) continue
    const { masked, spans } = maskCodeSpans(raw)
    const targets: RuleTarget[] = []
    const add = (ts: RuleTarget[]) => {
      for (const t of ts) if (!targets.some((x) => sameTarget(x, t))) targets.push(t)
    }
    for (const m of masked.matchAll(NEGATIVE_RE)) {
      const after = masked.slice(m.index! + m[0].length)
      const end = CLAUSE_END_RE.exec(after)
      const found = targetsIn(end ? after.slice(0, end.index) : after, spans, mcpServers)
      add(CODE_VERB_RE.test(m[0]) ? found.filter((t) => t.kind === 'tool' || t.kind === 'mcp-server') : found)
    }
    for (const re of [INSTEAD_RE, OVER_RE]) {
      for (const m of masked.matchAll(re)) add(firstTargetAfter(masked.slice(m.index! + m[0].length), spans, mcpServers))
    }
    // "not Y" names Y only after a choice verb in the same sentence: "use `pnpm`, not `npm`", never "this is not `x`"
    for (const m of masked.matchAll(NOT_RE)) {
      const before = masked.slice(0, m.index!)
      const sentence = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('; ')) + 1)
      if (!/\b(?:use|prefer|run|call)\b/i.test(sentence)) continue
      if (/\b(?:do|does|did|must|should|could|would|can|will)\s*$/i.test(before)) continue
      add(firstTargetAfter(masked.slice(m.index! + m[0].length), spans, mcpServers))
    }
    if (targets.length) out.push({ line: i + 1, text: raw.trim(), targets })
  }
  return out
}

/**
 * A heredoc: the opener keeps the rest of its line (`cat <<EOF > f && next build` still runs `next build`), and the
 * body, empty or not, goes up to the terminator line.
 */
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)/g

/** a `#` comment runs to the end of its line, unless it sits in quotes; an apostrophe in a comment opens no quote */
function dropComments(s: string): string {
  let out = ''
  let quote: string | null = null
  let comment = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (comment) {
      if (ch === '\n') {
        comment = false
        out += ch
      }
      continue
    }
    if (quote) {
      out += ch
      if (ch === '\\' && quote === '"' && i + 1 < s.length) out += s[++i]
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]!))) {
      comment = true
      continue
    }
    out += ch
  }
  return out
}

/**
 * Split a shell command into the segments a rule can start: on &&, ||, ;, | and new lines. A heredoc body and a
 * quoted string are data, not commands ("git commit -m \"... npx tsc --noEmit passes\""), so they go first.
 */
export function commandSegments(cmd: string): string[] {
  return dropComments(cmd.replace(HEREDOC_RE, (_m, _quote: string, _tag: string, rest: string) => ' ' + rest))
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().replace(/^[({]\s*/, '').replace(/\s+/g, ' '))
    .filter(Boolean)
}

function boundaryAt(seg: string, at: number): boolean {
  const c = seg[at]
  return c === undefined || /[\s)}'"]/.test(c)
}

/**
 * The runner and the target when a segment breaks a command rule, or null. The segment must START with the target, or with
 * one runner and then the target. An env assignment in front (`NODE_OPTIONS=... next build`) is not a match, so a
 * rule that says "never run `next build` bare" holds when the command carries what the rule asks for.
 */
export function matchCommand(seg: string, target: string): string | null {
  const starts = [0]
  for (const r of RUNNERS) if (seg.startsWith(r)) starts.push(r.length)
  // the match is the runner (a fixed word) and the target (the rule's own text): nothing the transcript wrote
  for (const at of starts) if (seg.startsWith(target, at) && boundaryAt(seg, at + target.length)) return seg.slice(0, at + target.length)
  return null
}

/**
 * A PreToolUse hook or a permission rule stopped the call: the check held where the line in the file did not.
 * Claude Code writes "PreToolUse:Bash hook error: <the hook's message>" for a hook that exits 2, "Hook
 * PreToolUse:Bash denied this tool" for a hook's JSON deny, and "Permission to use <tool> ... has been denied" or
 * "Agent type '<x>' has been denied by permission rule" for a deny rule. Each is anchored at the start of the
 * result, so a command whose own output says "blocked by the hook" is not a block.
 */
const BLOCKED_RE = /^(?:PreToolUse(?::\S+)? hook error\b|Hook PreToolUse(?::\S+)? denied this tool|(?:Permission to use \S+|Agent type '[^']*')[\s\S]*?has been denied)/i
export function wasBlocked(c: ToolCall): boolean {
  return c.isError && BLOCKED_RE.test(c.resultPreview ?? c.errorHint ?? '')
}

/** a segment that only sets variables: `export A=1`, `export A=1 B=2`, `A=1` */
const ENV_ONLY_RE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*$/

function bashCommand(c: ToolCall): string {
  const i = c.input as Record<string, unknown> | undefined
  return typeof i?.['command'] === 'string' ? (i['command'] as string) : ''
}

/**
 * The matching text of a call for a target, or null when the call does not break it. `segs` is the call's
 * command split once by `commandSegments`, so a session with many rules splits each command one time.
 */
export function callMatches(c: ToolCall, t: RuleTarget, segs: readonly string[] = c.name === 'Bash' ? commandSegments(bashCommand(c)) : []): string | null {
  if (t.kind === 'tool') return c.name === t.name ? c.name : null
  // server names keep their case in a tool name (`mcp__claude_ai_Claude_Docs__…`), and a rule may not
  if (t.kind === 'mcp-server') return c.name.toLowerCase().startsWith(`mcp__${t.name}__`) ? c.name : null
  if (c.name !== 'Bash') return null
  let envSet = false
  for (const seg of segs) {
    // `export X=1; next build` sets the environment like `X=1 next build`, and neither is a bare run
    if (ENV_ONLY_RE.test(seg)) {
      envSet = true
      continue
    }
    if (t.kind === 'command') {
      if (envSet) continue
      const hit = matchCommand(seg, t.name)
      if (hit) return hit
    } else if (seg.split(' ').some((w) => w === t.name || w.startsWith(t.name + '='))) {
      // the program's own name and the flag, so a path or an argument never leaves the session
      const program = seg.split(' ')[0]!.replace(/^.*\//, '')
      return /^[a-z][a-z0-9.+-]*$/.test(program) ? `${program} ${t.name}` : t.name
    }
  }
  return null
}

const NOTE_WORD_CAP = 40
const STOP_WORDS = new Set(
  (
    'about above after again against also always another anything because been before being below between both cannot ' +
    'could does doing done down during each either else even every first from further have having here hers itself ' +
    'last later like many might more most much must need needs never next none often once only other ought ours over own ' +
    'same should since some such than that their theirs them then there these they this those through under until upon ' +
    'want were what when where whether which while whom whose will with within without would your yours yourself ' +
    'make makes made sure true false into onto when then thing things everything something nothing anyone every ' +
    // markdown and memory frontmatter keys, and the words every note uses
    'name description metadata type node_type originsessionid modified project feedback reference user apply rule rules ' +
    'note notes memory index file files line lines code task tasks work session sessions agent agents claude please ' +
    // words of any request, not of a topic
    'full text open opened close closed start started want need needs show give tell look looks good well part time ' +
    'today problem issue item items current status left real simple plain sure okay done keep kept take took'
  ).split(/\s+/),
)
/** the words of a complaint itself: a note and a complaint that share only these share nothing */
const COMPLAINT_WORDS = new Set(['stop', 'still', 'again', 'broken', 'working', 'fixed', 'wrong', 'dont', 'told', 'already', 'forgot', 'missed', 'ignored', 'skipped'])

/**
 * Distinct content words of a text (4+ letters, lower case, no stop words), in order of first use. The words of a
 * complaint ("broken", "still") are left out unless `keepComplaintWords`: a theme count wants them, a match between a
 * note and a complaint does not.
 */
export function contentWords(text: string, opts: { cap?: number; keepComplaintWords?: boolean } = {}): string[] {
  const cap = opts.cap ?? NOTE_WORD_CAP
  const out: string[] = []
  const seen = new Set<string>()
  // a URL or a path is an address, not a topic ("https", "users")
  const prose = text.toLowerCase().replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, ' ').replace(/(?:~|\.{1,2})?(?:\/[\w.@~-]+){2,}\/?/g, ' ')
  for (const m of prose.matchAll(/[a-z][a-z'-]{3,}/g)) {
    const w = m[0].replace(/['-]+$/, '')
    // a contraction ("doesn't", "you're") is a function word, never a topic
    if (w.length < 4 || w.includes("'") || STOP_WORDS.has(w) || seen.has(w) || (!opts.keepComplaintWords && COMPLAINT_WORDS.has(w))) continue
    seen.add(w)
    out.push(w)
    if (out.length >= cap) break
  }
  return out
}

/** which instruction or memory file a path is, or undefined */
export function noteKindOf(path: string): NoteKind | undefined {
  const p = path.replace(/\\/g, '/')
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/\/projects\/[^/]+\/memory\/[^/]+\.md$/.test(p)) return base === 'MEMORY.md' ? 'memory-index' : 'memory'
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') return 'claude-md'
  if (base === 'AGENTS.md') return 'agents-md'
  if (/\/\.claude\/rules\/.+\.md$/.test(p)) return 'rules'
  return undefined
}

/** the `type:` of a memory note's frontmatter (`feedback`, `user`, `project`, `reference`), or undefined */
export function noteTypeOf(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const m = fm ? /^\s*type:\s*["']?([a-z][a-z-]*)/m.exec(fm[1]!) : null
  return m ? m[1] : undefined
}

function writtenText(c: ToolCall): { path?: string; text: string } {
  const i = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>
  const path = typeof i['file_path'] === 'string' ? (i['file_path'] as string) : undefined
  if (typeof i['content'] === 'string') return { path, text: i['content'] as string }
  if (typeof i['new_string'] === 'string') return { path, text: i['new_string'] as string }
  if (Array.isArray(i['edits'])) {
    return { path, text: (i['edits'] as unknown[]).map((e) => (e && typeof e === 'object' && typeof (e as Record<string, unknown>)['new_string'] === 'string' ? ((e as Record<string, unknown>)['new_string'] as string) : '')).join('\n') }
  }
  return { path, text: '' }
}

const MEMORY_WARNING_RE = /MEMORY\.md is (.+?)\. Only part of it was loaded: (.+?)\. Keep index entries/
/** Claude Code's own load warning for an auto-memory index, parsed into numbers (`docs`: 200 lines or 25KB) */
export function parseMemoryWarning(content: string): Omit<MemoryCut, 'path' | 'ts'> | null {
  const m = MEMORY_WARNING_RE.exec(content)
  if (!m) return null
  const size = m[1]!
  const over: MemoryCut['over'] = /lines and/.test(size) ? 'both' : /\blines \(limit/.test(size) ? 'lines' : 'chars'
  const lines = /(\d+) of (\d+) lines were cut off, starting at line (\d+)/.exec(m[2]!)
  if (lines) return { over, totalLines: Number(lines[2]), linesCut: Number(lines[1]), firstCutLine: Number(lines[3]) }
  if (/everything after the first \d+ characters of line 1 was cut off/.test(m[2]!)) return { over, firstCutLine: 1 }
  return null
}

function mcpServersOf(s: Session): Set<string> {
  const out = new Set<string>()
  const add = (name: string) => {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)
    if (m) out.add(m[1]!.toLowerCase())
  }
  for (const c of s.toolCalls) add(c.name)
  for (const n of s.meta.deferredToolNames ?? []) add(n)
  return out
}

interface RuleSource {
  path: string
  source: 'loaded' | 'written'
  text: string
  /** false for an Edit snippet, whose line numbers are not the file's */
  wholeFile?: boolean
  since?: number
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function analyzeInstructions(s: Session): InstructionsAnalysis {
  const files: InstructionFile[] = s.meta.instructionFiles ?? []
  const loaded: InstructionsAnalysis['loaded'] = []
  const memoryCuts: MemoryCut[] = []
  const cutSeen = new Set<string>()
  for (const f of files) {
    // the loaded text, without the warning Claude Code appends to a cut index
    const text = f.content.replace(/\n*> WARNING: MEMORY\.md is [\s\S]*$/, '')
    if (!loaded.some((l) => l.path === f.path)) loaded.push({ path: f.path, type: f.type, bytes: utf8Bytes(text), lines: text.split('\n').length })
    const cut = parseMemoryWarning(f.content)
    if (cut) {
      const key = `${f.path}|${cut.over}|${cut.totalLines}|${cut.linesCut}|${cut.firstCutLine}`
      if (!cutSeen.has(key)) {
        cutSeen.add(key)
        memoryCuts.push({ path: f.path, ...(f.ts !== undefined ? { ts: f.ts } : {}), ...cut })
      }
    }
  }

  const noteWrites: NoteWrite[] = []
  const sources: RuleSource[] = files.map((f) => ({ path: f.path, source: 'loaded' as const, text: f.content, ...(f.ts !== undefined ? { since: f.ts } : {}) }))
  for (const c of s.toolCalls) {
    if (c.category !== 'edit' && c.category !== 'write' && c.name !== 'Write' && c.name !== 'Edit' && c.name !== 'MultiEdit') continue
    const { path, text } = writtenText(c)
    const kind = path ? noteKindOf(path) : undefined
    if (!path || !kind) continue
    const noteType = noteTypeOf(text)
    noteWrites.push({ path, kind, turnIndex: c.turnIndex, ...(c.startTs !== undefined ? { ts: c.startTs } : {}), ...(c.agentId ? { agentId: c.agentId } : {}), ...(noteType ? { noteType } : {}), words: contentWords(text) })
    // a note the session wrote is in its context from the write on, whether or not Claude Code loads the file;
    // an Edit gives a snippet, so its line numbers are not the file's (line 0 = unknown)
    if (!c.agentId) sources.push({ path, source: 'written', text, wholeFile: c.name === 'Write', ...(c.startTs !== undefined ? { since: c.startTs } : {}) })
  }

  // nothing to check in a session that loaded no instruction file and wrote no note: the common case stays O(calls)
  if (!sources.length) return { loaded, rules: [], noteWrites, memoryCuts }
  const servers = mcpServersOf(s)
  // each command is split once, and only when a rule asks for it
  const segsCache: Array<string[] | undefined> = new Array(s.toolCalls.length)
  const segsOf = (k: number): string[] => (segsCache[k] ??= s.toolCalls[k]!.name === 'Bash' ? commandSegments(bashCommand(s.toolCalls[k]!)) : [])
  const rules: InstructionRule[] = []
  for (const src of sources) {
    for (const r of extractRules(src.text, servers)) {
      for (const target of r.targets) {
        const prior = rules.find((x) => x.path === src.path && x.text === r.text && sameTarget(x.target, target))
        // the earliest sighting decides when the rule entered the context
        if (prior && (prior.since === undefined || src.since === undefined || prior.since <= src.since)) continue
        let calls = 0
        let agentCalls = 0
        let blocked = 0
        let firstCallTurnIndex: number | undefined
        const examples: string[] = []
        for (let k = 0; k < s.toolCalls.length; k++) {
          const c = s.toolCalls[k]!
          if (src.since !== undefined && (c.startTs === undefined || c.startTs < src.since)) continue
          const hit = callMatches(c, target, target.kind === 'command' || target.kind === 'flag' ? segsOf(k) : [])
          if (!hit) continue
          calls++
          if (c.agentId) agentCalls++
          if (wasBlocked(c)) blocked++
          if (firstCallTurnIndex === undefined) firstCallTurnIndex = c.turnIndex
          if (examples.length < 3 && !examples.includes(hit)) examples.push(hit)
        }
        const row: InstructionRule = {
          path: src.path,
          source: src.source,
          line: src.wholeFile === false ? 0 : r.line,
          text: r.text,
          target,
          calls,
          agentCalls,
          blocked,
          examples,
          ...(src.since !== undefined ? { since: src.since } : {}),
          ...(firstCallTurnIndex !== undefined ? { firstCallTurnIndex } : {}),
        }
        if (prior) rules[rules.indexOf(prior)] = row
        else rules.push(row)
      }
    }
  }
  return { loaded, rules, noteWrites, memoryCuts }
}
