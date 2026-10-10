// A fake machine for the plugin tests of orangu god: the host commands, the files and the engine calls that the
// pane makes, answered by hooks beneath the plugin (the store in memory too), and each call recorded. Every value is synthetic: the home
// folder is /tmp/god-home and the repos live under /tmp/god-test. A machine with no cmux answers no cmux call, so ps
// does not run; a machine with a cmux answers its tree, ps in UTC, the jump calls and the screen of each tab.
// A peer message goes to a session.send hook that records it and says it was delivered.
// screenOf draws a pane tree as text lines, the way the terminal paints it: a plain Button with a hotkey shows
// `<key>: <label>`, the columns of a row Box sit side by side, each padded to its width.
import type { On } from 'claude-code'

export const HOME = '/tmp/god-home'
export const SELF_ID = 'god-self-session'
export const SURFACES = ['terminal', 'desktop'] as const
/** The plugin name and the pane id, as the engine knows them. */
export const PLUGIN = 'orangu-god'
export const PANE = 'god'

/** 1 live session of the fake machine. A test changes its fields, and the next tick reads them. */
export type FakeSession = {
  pid: number
  sessionId: string
  cwd: string
  name: string
  status: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  statusUpdatedAt: number
  /** the transcript lines; absent when the session has no transcript file */
  transcript?: string[]
  transcriptMtimeMs?: number
  /** the mtime of the registry file: a test moves it when it changes the session */
  fileMtimeMs: number
}

/**
 * The cmux of the fake machine: the tab of each session PID by the UUIDs of its workspace and surface, the screen of
 * each surface, and the calls that exit 1. The tree gives each node its UUID as `id` and a short ref by its place.
 */
export type FakeCmux = {
  tabs: Record<number, { tty: string; workspaceRef: string; surfaceRef: string; title: string }>
  /** the text that `read-screen` gives for each surface UUID */
  screens?: Record<string, string>
  /** the cmux subcommands that exit 1 */
  failing?: string[]
  /** a wait before a cmux subcommand answers, as a slow cmux: a test passes the sleep of its mock clock */
  delay?: (verb: string) => Promise<void> | undefined
}

export type Machine = {
  sessions: FakeSession[]
  /** absent: cmux is not on the machine */
  cmux?: FakeCmux
  /** the values that the engine store holds before the session starts */
  store?: Record<string, unknown>
  /** the git answer of each cwd: the git dir, the common dir and the top level */
  repos: Record<string, readonly [string, string, string]>
  /** the first opens of the pane that the engine does not place, as in a terminal under 144 columns */
  unplacedOpens?: number
  /** the session id of the god session; a /clear gives it a new one with no session.start */
  selfId?: string
  /** what the first `$.session.id()` answers, when the id changed after it (a /clear after the first read) */
  selfIdAtStart?: string
  /** the value of the `theme` row of the /config menu; absent, the menu has no theme row */
  theme?: string
}

/** What the plugin asked the machine and the engine for. */
export type Calls = {
  runs: Array<{ argv: readonly string[]; init?: { timeoutMs?: number; env?: Record<string, string>; cwd?: string } }>
  files: string[]
  boardWrites: number
  storeSets: Array<[string, unknown]>
  statuses: Array<string | undefined>
  opens: Array<{ id: string; title?: string; columns?: number; rows?: number }>
  /** the tools that the plugin registered, as it gave them */
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }>
  /** the peer messages that the plugin sent, each as its address and its text */
  peers: Array<{ to: string; text: string }>
}

/** The folder name of a cwd under the projects folder, as Claude Code writes it. */
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9-]/g, '-')
export const transcriptPath = (session: Pick<FakeSession, 'cwd' | 'sessionId'>): string => `${HOME}/.claude/projects/${slug(session.cwd)}/${session.sessionId}.jsonl`
const registryPath = (pid: number): string => `${HOME}/.claude/sessions/${pid}.json`

const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function registryText(session: FakeSession): string {
  const { pid, sessionId, cwd, name, status, waitingFor, statusUpdatedAt } = session
  return JSON.stringify({ pid, sessionId, cwd, name, kind: 'interactive', status, ...(status === 'waiting' && waitingFor ? { waitingFor } : {}), statusUpdatedAt, startedAt: statusUpdatedAt })
}

const fileOf = (machine: Machine, path: string): FakeSession | undefined =>
  machine.sessions.find((session) => session.transcript !== undefined && transcriptPath(session) === path)

/** Installs the machine beneath the plugin. The god session itself is in the agents list, so the board must leave it out. */
export function installMachine(on: On, machine: Machine): Calls {
  const calls: Calls = { runs: [], files: [], boardWrites: 0, storeSets: [], statuses: [], opens: [], tools: [], peers: [] }
  const content = (session: FakeSession): string => `${(session.transcript ?? []).join('\n')}\n`

  on('process.run', async (_$, e) => {
    calls.runs.push({ argv: [...e.argv], ...(e.init === undefined ? {} : { init: { ...e.init } }) })
    const [command, ...rest] = e.argv
    if (command === 'claude') {
      const self = { pid: 9000, cwd: HOME, kind: 'interactive', startedAt: 0, sessionId: machine.selfId ?? SELF_ID, name: 'god', status: 'busy', waitingFor: null }
      const rows = machine.sessions.map(({ pid, cwd, sessionId, name, status, waitingFor, statusUpdatedAt }) => ({ pid, cwd, kind: 'interactive', startedAt: statusUpdatedAt, sessionId, name, status, waitingFor: waitingFor ?? null }))
      return ran(JSON.stringify([self, ...rows]))
    }
    if (command === 'cmux' && machine.cmux) {
      await machine.cmux.delay?.(rest[0] ?? '')
      return cmuxRun(machine.cmux, rest)
    }
    if (command === 'ps' && machine.cmux) {
      const pids = (rest[3] ?? '').split(',').map(Number)
      const rows = pids.flatMap((pid) => (machine.cmux!.tabs[pid] ? [`${pid} ${machine.cmux!.tabs[pid]!.tty}  Fri Oct  9 08:00:00 2026`] : [`${pid} ??       Fri Oct  9 08:00:00 2026`]))
      return ran(`${rows.join('\n')}\n`)
    }
    if (command === 'git') {
      const lines = machine.repos[e.init?.cwd ?? '']
      return lines ? ran(`${lines.join('\n')}\n`) : ran('', 128)
    }
    if (command === 'stat') {
      const paths = rest.slice(2).filter((path) => fileOf(machine, path) !== undefined)
      return ran(paths.map((path, index) => `${7000 + index} ${path}`).join('\n'))
    }
    if (command === 'tail' || command === 'head') {
      const session = fileOf(machine, rest[2] ?? '')
      if (!session) return ran('', 1)
      const text = content(session)
      const count = Number((rest[1] ?? '').replace('+', ''))
      return ran(command === 'tail' ? text.slice(count - 1) : text.slice(0, count))
    }
    return { deny: `the fake machine has no ${command}` }
  })

  on('fs.list', (_$, e) => {
    calls.files.push(`list ${e.path}`)
    if (e.path !== `${HOME}/.claude/sessions`) return { deny: 'no such folder' }
    return { value: machine.sessions.map((session) => ({ name: `${session.pid}.json`, kind: 'file' as const, size: registryText(session).length, mtimeMs: session.fileMtimeMs, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    calls.files.push(`read ${e.path}`)
    const session = machine.sessions.find((one) => registryPath(one.pid) === e.path)
    return session ? { value: registryText(session) } : { deny: 'no such file' }
  })
  on('fs.stat', (_$, e) => {
    calls.files.push(`stat ${e.path}`)
    if (machine.sessions.some((session) => session.cwd === e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    const session = fileOf(machine, e.path)
    if (!session) return { deny: 'no such file' }
    return { value: { kind: 'file' as const, size: content(session).length, mtimeMs: session.transcriptMtimeMs ?? 0, isLink: false } }
  })

  let idReads = 0
  on('session.id', () => ({ value: idReads++ === 0 && machine.selfIdAtStart !== undefined ? machine.selfIdAtStart : (machine.selfId ?? SELF_ID) }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('config.list', () => {
    if (machine.theme === undefined) return { value: [] }
    const row = { key: 'theme', label: 'Theme', kind: 'choice' as const, value: machine.theme, provider: { plugin: 'core', tier: 'core' as const }, isLocked: false }
    return { value: [row] }
  })
  on('ui.open', (_$, e) => {
    calls.opens.push({ id: e.id, ...(e.title === undefined ? {} : { title: e.title }), ...(e.columns === undefined ? {} : { columns: e.columns }), ...(e.rows === undefined ? {} : { rows: e.rows }) })
    const isPlaced = calls.opens.length > (machine.unplacedOpens ?? 0)
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is too narrow' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('tool.register', (_$, e) => {
    calls.tools.push({ ...e })
    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })
  on('ui.focus', () => ({}))
  on('session.send', (_$, e) => {
    calls.peers.push({ to: String(e.to), text: e.text })
    return { isDelivered: true as const }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    calls.statuses.push(e.text)
    return { value: undefined }
  })
  on('state.set', (_$, e, next) => {
    if (e.plugin === PLUGIN && e.key === 'board') calls.boardWrites += 1
    return next(e)
  })
  // the store in memory, as the engine keeps the store of a plugin, with each write recorded
  const store = new Map<string, unknown>(Object.entries(machine.store ?? {}))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    calls.storeSets.push([e.key, e.value])
    store.set(e.key, JSON.parse(JSON.stringify(e.value)) as unknown)
    return { value: undefined }
  })
  return calls
}

/** The value after a flag of an argv. */
const flagValue = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

/** What the fake cmux gives: its methods, its tree of the session tabs, the screen of a surface, and 0 for a jump. */
function cmuxRun(cmux: FakeCmux, argv: readonly string[]) {
  const [verb = ''] = argv
  if (cmux.failing?.includes(verb)) return ran('', 1)
  if (verb === 'capabilities') return ran(JSON.stringify({ methods: ['system.tree', 'surface.read_text'] }))
  if (verb === 'tree') {
    const tabs = Object.values(cmux.tabs)
    const workspaces = [...new Set(tabs.map((tab) => tab.workspaceRef))].map((id, index) => ({
      ref: `workspace:${index + 1}`,
      id,
      title: `space ${index + 1}`,
      panes: [{ ref: 'pane:1', surfaces: tabs.filter((tab) => tab.workspaceRef === id).map((tab) => ({ ref: `surface:${tabs.indexOf(tab) + 1}`, id: tab.surfaceRef, tty: tab.tty, title: tab.title })) }],
    }))
    return ran(JSON.stringify({ windows: [{ ref: 'window:1', workspaces }] }))
  }
  if (verb === 'read-screen') return ran(cmux.screens?.[flagValue(argv, '--surface') ?? ''] ?? '')
  return ran('')
}

/** The Pane props of a pane of `columns` by `rows` body cells that holds the keys. */
export function paneProps(columns: number, rows: number) {
  return { title: 'orangu god', isFocused: true, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: rows }, view: {} }
}

// ---------- transcripts ----------

const at = (ms: number): string => new Date(ms).toISOString()

/** A human prompt. */
export const prompt = (text: string, ms: number): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: at(ms) })

/** An open AskUserQuestion call with 1 single-select question. */
export const question = (id: string, text: string, labels: readonly string[], ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(ms),
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: text, header: 'Pick', multiSelect: false, options: labels.map((label) => ({ label, description: label })) }] } }],
    },
  })

/** An open Bash call, with the description that its permission dialog shows. */
export const bash = (id: string, command: string, description: string, ms: number): string =>
  JSON.stringify({ type: 'assistant', timestamp: at(ms), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description } }] } })

/** The result of a call: the answer of a question or the outcome of a tool. */
export const toolResult = (id: string, text: string, ms: number): string =>
  JSON.stringify({ type: 'user', timestamp: at(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

/** An open Edit call. */
export const edit = (id: string, path: string, ms: number): string =>
  JSON.stringify({ type: 'assistant', timestamp: at(ms), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] } })

/** A reply and the end of the turn; with `inputTokens`, the reply carries that usage. */
export const reply = (text: string, ms: number, inputTokens?: number): string[] => [
  JSON.stringify({ type: 'assistant', timestamp: at(ms), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], ...(inputTokens === undefined ? {} : { usage: { input_tokens: inputTokens } }) } }),
  JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(ms) }),
]

/** `count` whole turns, 1 min apart and the last 1 min before `ms`: each a prompt, a reply and the end of the turn. */
export const turns = (count: number, ms: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const at = ms - (count - index) * 60_000
    return [prompt(`Run step ${index + 1} of the plan.`, at), ...reply(`Step ${index + 1} is done.`, at + 30_000)]
  }).flat()

/** An API error at the end of the transcript. */
export const apiError = (text: string, ms: number): string => JSON.stringify({ type: 'system', subtype: 'api_error', error: { message: text }, timestamp: at(ms) })

// ---------- what the pane shows ----------

type Node = string | { type: string; props?: Record<string, unknown>; children?: readonly unknown[] }

const isElement = (node: unknown): node is Exclude<Node, string> => typeof node === 'object' && node !== null && typeof (node as { type?: unknown }).type === 'string'

/** The text of an inline element: a Text and its nested Texts, or a Button as the terminal paints it. */
function inline(node: unknown): string {
  if (typeof node === 'string') return node
  if (!isElement(node)) return ''
  if (node.type === 'Button') {
    const props = node.props ?? {}
    const held = (node.children ?? []).map(inline).join('')
    const label = held === '' ? String(props['label'] ?? '') : held
    return typeof props['hotkey'] === 'string' ? `${props['hotkey']}: ${label}` : label
  }
  return (node.children ?? []).map(inline).join('')
}

const padTo = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - [...text].length))

/** The lines of 1 element: a column Box stacks its children, a row Box joins its children side by side. */
function linesOf(node: unknown): string[] {
  if (!isElement(node) || node.type !== 'Box') return [inline(node)]
  const children = node.children ?? []
  if (node.props?.['flexDirection'] !== 'row') return children.flatMap(linesOf)
  if (!children.every((child) => isElement(child) && child.type === 'Box')) return [children.map(inline).join('')]
  const columns = children.map((child) => ({ lines: linesOf(child), width: Number((child as { props?: Record<string, unknown> }).props?.['width'] ?? 0) }))
  const height = Math.max(0, ...columns.map((column) => column.lines.length))
  return Array.from({ length: height }, (_, row) => columns.map((column) => padTo(column.lines[row] ?? '', column.width)).join('').trimEnd())
}

/** The pane as text lines, as the terminal paints the tree. */
export function screenOf(tree: unknown): string[] {
  return linesOf(tree)
}
