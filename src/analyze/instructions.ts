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
/** where a "do not" clause ends: a sentence end, a dash, a semicolon, or a turn to what to do instead */
const CLAUSE_END_RE = /[.!?](?=\s|$)|;|\s[\u2014\u2013-]\s|,\s*(?:use|run|prefer|call|but)\b|\s(?:instead|but|unless|except)\b/i
/** "use X instead of Y", "use X rather than Y", "use X, not Y", "prefer X over Y": Y follows the connector */
const INSTEAD_RE = /\b(?:instead of|rather than)\s+/gi
const NOT_RE = /(?:,\s*|\s)not\s+/gi
const OVER_RE = /\bprefer\b[^.;]*?\bover\s+/gi

const SPAN = '\u0000'
const COMMAND_RE = /^[a-z][a-z0-9.+-]*(?::[a-z0-9:._-]+)?(?:\s+\S+)*$/
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
 * Every line of an instruction text that reads as a "do not" rule naming something a call can match.
 * `mcpServers` holds the lower-case server names the session knows, so "not playwright" can name a server.
 */
export function extractRules(text: string, mcpServers: ReadonlySet<string> = new Set()): ExtractedRule[] {
  const out: ExtractedRule[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/[’‘]/g, "'")
    if (!raw.includes('`') && !/never|not|avoid|stop|instead|rather|prefer/i.test(raw)) continue
    const spans: string[] = []
    // a code span becomes a placeholder, then markdown emphasis goes, so "bare.** Both" ends its sentence
    const masked = raw
      .replace(/`([^`]+)`/g, (_m, inner: string) => ` ${SPAN}${spans.push(inner) - 1}${SPAN} `)
      .replace(/\*{1,3}|(?<![A-Za-z0-9])_{1,3}|_{1,3}(?![A-Za-z0-9])/g, '')
    const targets: RuleTarget[] = []
    const add = (ts: RuleTarget[]) => {
      for (const t of ts) if (!targets.some((x) => sameTarget(x, t))) targets.push(t)
    }
    for (const m of masked.matchAll(NEGATIVE_RE)) {
      const after = masked.slice(m.index! + m[0].length)
      const end = CLAUSE_END_RE.exec(after)
      add(targetsIn(end ? after.slice(0, end.index) : after, spans, mcpServers))
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

/** split a shell command into the segments a rule can start: on &&, ||, ;, | and new lines */
export function commandSegments(cmd: string): string[] {
  return cmd
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
  for (const seg of segs) {
    if (t.kind === 'command') {
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
    'note notes memory index file files line lines code task tasks work session sessions agent agents claude ' +
    'please stop still again broken working fixed wrong'
  ).split(/\s+/),
)

/** distinct content words of a text (4+ letters, lower case, no stop words), in order of first use */
export function contentWords(text: string, cap = NOTE_WORD_CAP): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z'-]{3,}/g)) {
    const w = m[0].replace(/['-]+$/, '')
    if (w.length < 4 || STOP_WORDS.has(w) || seen.has(w)) continue
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
  const over: MemoryCut['over'] = /lines and/.test(size) ? 'both' : /\blines \(limit/.test(size) ? 'lines' : 'bytes'
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
    if (!loaded.some((l) => l.path === f.path)) loaded.push({ path: f.path, type: f.type, bytes: utf8Bytes(f.content), lines: f.content.split('\n').length })
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
    noteWrites.push({ path, kind, turnIndex: c.turnIndex, ...(c.startTs !== undefined ? { ts: c.startTs } : {}), ...(c.agentId ? { agentId: c.agentId } : {}), words: contentWords(text) })
    // a note the session wrote is in its context from the write on, whether or not Claude Code loads the file
    if (!c.agentId) sources.push({ path, source: 'written', text, ...(c.startTs !== undefined ? { since: c.startTs } : {}) })
  }

  const servers = mcpServersOf(s)
  const segsByCall = s.toolCalls.map((c) => (c.name === 'Bash' ? commandSegments(bashCommand(c)) : []))
  const rules: InstructionRule[] = []
  for (const src of sources) {
    for (const r of extractRules(src.text, servers)) {
      for (const target of r.targets) {
        const prior = rules.find((x) => x.path === src.path && x.text === r.text && sameTarget(x.target, target))
        // the earliest sighting decides when the rule entered the context
        if (prior && (prior.since === undefined || src.since === undefined || prior.since <= src.since)) continue
        let calls = 0
        let agentCalls = 0
        let firstCallTurnIndex: number | undefined
        const examples: string[] = []
        for (let k = 0; k < s.toolCalls.length; k++) {
          const c = s.toolCalls[k]!
          if (src.since !== undefined && (c.startTs === undefined || c.startTs < src.since)) continue
          const hit = callMatches(c, target, segsByCall[k])
          if (!hit) continue
          calls++
          if (c.agentId) agentCalls++
          if (firstCallTurnIndex === undefined) firstCallTurnIndex = c.turnIndex
          if (examples.length < 3 && !examples.includes(hit)) examples.push(hit)
        }
        const row: InstructionRule = {
          path: src.path,
          source: src.source,
          line: r.line,
          text: r.text,
          target,
          calls,
          agentCalls,
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
