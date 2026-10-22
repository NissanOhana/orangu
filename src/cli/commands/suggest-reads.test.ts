import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { SessionBuilder } from '../../../test/fixtures/session-builder.js'
import { emptyQueueFixture, queueFixture, queueFixtureRecords } from '../../../test/fixtures/suggestion-queue.js'
import { APPLIED_AT, NOW, WORKSPACE, appliedOf, metricsOf, proposalOf, recordOf, sg, uuid } from '../../../test/fixtures/suggestion-records.js'
import { ANALYZER_RULE_IDS } from '../../analyze/rule-ids.js'
import { projectSlug } from '../../discover/discover.js'
import type { CohortDeps, CohortLoad } from '../../suggest/cohort.js'
import { CohortFactsCache } from '../../suggest/cohort-cache.js'
import { LESSONS_MAX_BYTES, type ChangeRow } from '../../suggest/lessons.js'
import { QUEUE_GROUPS, TODO_MAX_BYTES, type QueueItem, type SuggestionQueue } from '../../suggest/queue.js'
import { createQueueReadDeps, type QueueReadDeps } from '../../suggest/queue-read.js'
import { REJECT_REASON_CODES } from '../../suggest/reason-codes.js'
import type { SuggestionRecord, SuggestionWorkspaceIdentity } from '../../suggest/types.js'
import { liveWorkspaceIdentity, storedWorkspaceIdentity } from '../../suggest/workspace-identity.js'
import { VERSION } from '../../version.js'
import { layoutWidth } from '../summary.js'
import { displayWidth } from '../tty.js'
import { cmdSuggest } from './suggest.js'
import { DEFERRED_TEXT, QUEUE_APP_ROW, historyLines, queueLines } from './suggest-reads.js'

let home: string
let out: string[]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['HOME', 'ORANGU_HOME', 'CLAUDE_CONFIG_DIR', 'ORANGU_CLAUDE_ROOTS', 'ORANGU_NO_CACHE']) saved[key] = process.env[key]
  // An empty HOME and an empty Claude root keep the sessions of this machine out of every read.
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'orangu-reads-user-'))
  process.env['CLAUDE_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'orangu-reads-claude-'))
  delete process.env['ORANGU_CLAUDE_ROOTS']
  delete process.env['ORANGU_NO_CACHE']
  home = mkdtempSync(join(tmpdir(), 'orangu-reads-'))
  process.env['ORANGU_HOME'] = home
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

interface FakeSession {
  id: string
  cwd: string
  startedAt: number
  endedAt: number
  toolCalls: number
}

/** Read deps over a fixed session list: the canonical path of a folder is the folder, and WORKSPACE lists uuid(900). */
function readDeps(sessions: FakeSession[] = []): QueueReadDeps & { loads: string[] } {
  const loads: string[] = []
  const cohort: CohortDeps = {
    async listCandidates(cwd) {
      return sessions.filter((s) => s.cwd === cwd).map((s) => ({ sessionId: s.id, path: `/c/${s.id}.jsonl`, mtimeMs: s.endedAt }))
    },
    async loadCandidate(candidate): Promise<CohortLoad> {
      loads.push(candidate.sessionId)
      const s = sessions.find((x) => x.id === candidate.sessionId)!
      return { session: { id: s.id, path: candidate.path, cwd: s.cwd, ranOrangu: false, startedAt: s.startedAt, endedAt: s.endedAt, metrics: metricsOf(s.toolCalls) }, bytesRead: 1_000 }
    },
    async canonicalWorkspace(identity: SuggestionWorkspaceIdentity) {
      return identity.cwd
    },
  }
  return {
    loads,
    now: NOW,
    cohort,
    async canonical(dir) {
      return dir
    },
    async workspaceSessionIds() {
      return [uuid(900)]
    },
  }
}

const storeFile = (): string => join(home, 'suggestions.jsonl')
/** The store file of these records, 1 line each, as the store writes it (0600). */
function seed(records: SuggestionRecord[]): void {
  writeFileSync(storeFile(), records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 })
}

/** stdout of 1 in-process `orangu suggest` call. */
async function run(flags: Record<string, string | boolean>, deps: QueueReadDeps = readDeps()): Promise<string> {
  out = []
  await cmdSuggest([], flags, { read: deps })
  return out.join('')
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** Each key of a JSON value at any depth. */
function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, found)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.add(key)
      keysOf(item, found)
    }
  }
  return found
}

/** 500 open items of WORKSPACE: 300 proposals to apply and 200 started records, each its own item. */
function fiveHundredOpen(): SuggestionRecord[] {
  const rule = (n: number): string => ANALYZER_RULE_IDS[n % ANALYZER_RULE_IDS.length]!
  const records: SuggestionRecord[] = []
  for (let n = 1; n <= 300; n++) records.push(recordOf(sg(n), { ruleId: rule(n), status: 'proposed', statusAt: APPLIED_AT + n, proposal: proposalOf() }))
  for (let n = 301; n <= 500; n++) records.push(recordOf(sg(n), { ruleId: rule(n), status: 'kicked-off', statusAt: APPLIED_AT + n }))
  return records
}

const TODO_ORDER = ['verdict', 'regressed', 'apply', 'review', 'running'] as const
/** The item row of the todo text: 2 spaces, the group, the id, the status and the rule. */
const TODO_ROW = /^ {2}(verdict|regressed|apply|review|running) +(sg_[0-9a-f]{12}) +\S+ +\S+$/

describe('orangu suggest --todo: the cap of 8,192 B on the exact output', () => {
  it('holds 500 open items to 8,192 B in 3 forms, keeps the first items in group order, counts the rest and gives the same bytes twice', async () => {
    seed(fiveHundredOpen())
    const queue = JSON.parse(await run({ queue: true, cwd: WORKSPACE, json: true }))
    const order: string[] = TODO_ORDER.flatMap((group) => queue.groups[group].map((item: { id: string }) => item.id))
    expect(order).toHaveLength(500)

    const kept: Record<string, number> = {}
    for (const [form, flags] of [['--json', { json: true }], ['--json --quiet', { json: true, quiet: true }], ['text', {}]] as const) {
      const output = await run({ todo: true, cwd: WORKSPACE, ...flags })
      expect(await run({ todo: true, cwd: WORKSPACE, ...flags }), `${form}: a second run gives the same bytes`).toBe(output)
      expect(output.endsWith('\n'), form).toBe(true)
      expect(bytes(output), form).toBeLessThanOrEqual(TODO_MAX_BYTES)
      if (form === 'text') {
        const rows = output.split('\n').filter((line) => TODO_ROW.test(line))
        const ids = rows.map((line) => TODO_ROW.exec(line)![2])
        expect(ids, form).toEqual(order.slice(0, ids.length))
        expect(output, form).toContain(`${500 - ids.length} more items do not fit in 8,192 B.`)
        // The slack is less than 1 more row: the cap is measured on these bytes.
        expect(TODO_MAX_BYTES - bytes(output), form).toBeLessThan(Math.max(...rows.map((row) => bytes(row) + 1)))
        kept[form] = ids.length
        continue
      }
      const todo = JSON.parse(output)
      expect(Object.keys(todo), form).toEqual(['v', 'workspace', 'counts', 'maxBytes', 'omitted', 'items'])
      expect(todo.counts, form).toEqual(queue.counts)
      expect(todo.maxBytes, form).toBe(TODO_MAX_BYTES)
      expect(todo.items.map((item: { id: string }) => item.id), form).toEqual(order.slice(0, todo.items.length))
      expect(todo.omitted, form).toBe(500 - todo.items.length)
      const found = keysOf(todo)
      expect(found.has('now') || found.has('title'), `${form}: no now and no title key at any depth`).toBe(false)
      const indent = form === '--json' ? 2 : 0
      expect(TODO_MAX_BYTES - bytes(output), form).toBeLessThan(Math.max(...todo.items.map((item: unknown) => bytes(JSON.stringify(item, null, indent)) + indent + 2)))
      kept[form] = todo.items.length
    }
    // Each form is measured on its own bytes, so the smaller form keeps more items.
    expect(kept['text']!).toBeGreaterThan(kept['--json --quiet']!)
    expect(kept['--json --quiet']!).toBeGreaterThan(kept['--json']!)
  })

  it('takes the groups that have a step, in group order, with no wait item and only the keys of a todo item', async () => {
    seed(queueFixtureRecords())
    // The later sessions equal the frozen baseline: the first checkpoint is within noise, so each applied item waits.
    const queue = JSON.parse(await run({ queue: true, cwd: WORKSPACE, json: true }, readDeps(laterOf([10, 11, 12])))) as SuggestionQueue
    const todo = JSON.parse(await run({ todo: true, cwd: WORKSPACE, json: true }, readDeps(laterOf([10, 11, 12]))))
    expect(queue.groups.wait.length).toBeGreaterThan(0)
    expect(todo.items.map((item: { id: string }) => item.id)).toEqual(TODO_ORDER.flatMap((group) => queue.groups[group].map((item) => item.id)))
    expect(todo.counts).toEqual(queue.counts)
    const keys = new Set(['group', 'id', 'status', 'scope', 'ruleId', 'changeClass', 'cannotVerify'])
    for (const item of todo.items) {
      expect(Object.keys(item).filter((key) => !keys.has(key)), item.id).toEqual([])
      for (const key of ['group', 'id', 'status', 'scope', 'ruleId']) expect(key in item, `${item.id} ${key}`).toBe(true)
    }
  })
})

/** Later sessions of WORKSPACE in start order, 1 for each tool-call value. */
const laterOf = (values: number[]): FakeSession[] =>
  values.map((toolCalls, index) => ({ id: uuid(100 + index), cwd: WORKSPACE, startedAt: APPLIED_AT + 1_000 + index * 1_000, endedAt: APPLIED_AT + 2_000 + index * 1_000, toolCalls }))

/** 1,000 rejected records of WORKSPACE, each a lesson with a reason code, each decided at its own time. */
function thousandLessons(): SuggestionRecord[] {
  return Array.from({ length: 1_000 }, (_, index) =>
    recordOf(sg(index + 1), {
      ruleId: ANALYZER_RULE_IDS[index % ANALYZER_RULE_IDS.length]!,
      status: 'rejected',
      statusAt: APPLIED_AT + index,
      reasonCode: REJECT_REASON_CODES[index % REJECT_REASON_CODES.length]!,
    }),
  )
}

/** The head row of a lesson in the lesson text. */
const LESSON_HEAD = /^ {2}(sg_[0-9a-f]{12}) {2}\[rejected\] {2}decided \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

describe('orangu suggest --lessons: the cap of 16,384 B on the exact output', () => {
  it('holds 1,000 lessons to 16,384 B in 3 forms, keeps the newest, counts the rest, has no now key and gives the same bytes twice', async () => {
    seed(thousandLessons())
    const newestFirst = Array.from({ length: 1_000 }, (_, index) => sg(1_000 - index))
    const kept: Record<string, number> = {}
    for (const [form, flags] of [['--json', { json: true }], ['--json --quiet', { json: true, quiet: true }], ['text', {}]] as const) {
      const output = await run({ lessons: true, cwd: WORKSPACE, ...flags })
      expect(await run({ lessons: true, cwd: WORKSPACE, ...flags }), `${form}: a second run gives the same bytes`).toBe(output)
      expect(output.endsWith('\n'), form).toBe(true)
      expect(bytes(output), form).toBeLessThanOrEqual(LESSONS_MAX_BYTES)
      if (form === 'text') {
        const ids = output.split('\n').flatMap((line) => LESSON_HEAD.exec(line)?.[1] ?? [])
        expect(ids, form).toEqual(newestFirst.slice(0, ids.length))
        expect(output, form).toContain(`  ${1_000 - ids.length} older lessons do not fit in 16,384 B.`)
        kept[form] = ids.length
        continue
      }
      const read = JSON.parse(output)
      expect(Object.keys(read), form).toEqual(['v', 'scope', 'maxBytes', 'omitted', 'lessons'])
      expect(read).toMatchObject({ v: 1, scope: WORKSPACE, maxBytes: LESSONS_MAX_BYTES, omitted: 1_000 - read.lessons.length })
      expect(read.lessons.map((lesson: { id: string }) => lesson.id), form).toEqual(newestFirst.slice(0, read.lessons.length))
      expect(keysOf(read).has('now'), form).toBe(false)
      kept[form] = read.lessons.length
    }
    expect(kept['text']!).toBeGreaterThan(kept['--json --quiet']!)
    expect(kept['--json --quiet']!).toBeGreaterThan(kept['--json']!)
  })

  it('reads 1 workspace by default, every workspace with --all, only the global records with --scope global, and only the rules of --rule', async () => {
    seed([
      recordOf(sg(1), { status: 'rejected', statusAt: APPLIED_AT + 1 }),
      recordOf(sg(2), { status: 'rejected', statusAt: APPLIED_AT + 2, ruleId: 'tool-errors' }),
      recordOf(sg(3), { status: 'rejected', statusAt: APPLIED_AT + 3, scope: 'global' }),
      recordOf(sg(4), { status: 'rejected', statusAt: APPLIED_AT + 4, sessionIds: [uuid(901)], workspaceCwd: '/w/other' }),
    ])
    const ids = async (flags: Record<string, string | boolean>): Promise<string[]> =>
      JSON.parse(await run({ lessons: true, json: true, ...flags })).lessons.map((lesson: { id: string }) => lesson.id)
    expect(await ids({ cwd: WORKSPACE })).toEqual([sg(2), sg(1)])
    // Every workspace, and its global lessons last.
    expect(await ids({ all: true })).toEqual([sg(4), sg(2), sg(1), sg(3)])
    expect(await ids({ scope: 'global' })).toEqual([sg(3)])
    expect(await ids({ cwd: WORKSPACE, rule: 'tool-errors,unknown' })).toEqual([sg(2)])
    // The history takes the same scopes.
    expect(JSON.parse(await run({ history: true, scope: 'global', json: true }))).toEqual([])
  })
})

describe('orangu suggest: the options of each read', () => {
  it('--todo --all exits 1, names --cwd <dir>, and reads nothing', async () => {
    seed(queueFixtureRecords())
    const deps = readDeps(laterOf([1, 2, 3]))
    const before = readFileSync(storeFile())
    await expect(cmdSuggest([], { todo: true, all: true, json: true }, { read: deps })).rejects.toThrow(
      '--todo reads 1 workspace, so it takes no --all. Name the workspace with --cwd <dir>.',
    )
    expect(deps.loads).toEqual([])
    expect(readFileSync(storeFile())).toEqual(before)
  })

  it('refuses 2 scopes, a scope other than global, an option of another read and a status filter outside --list, each before any read', async () => {
    seed(queueFixtureRecords())
    const deps = readDeps(laterOf([1, 2, 3]))
    const refusals: Array<[Record<string, string | boolean>, string]> = [
      [{ queue: true, cwd: WORKSPACE, all: true }, '--cwd and --all name 2 different scopes. Give 1 of them.'],
      [{ lessons: true, scope: 'repo' }, '--scope takes only global here.'],
      [{ history: true, scope: 'global', all: true }, '--scope global reads only the global records, so it takes no --cwd and no --all.'],
      [{ queue: true, rule: 'tool-errors' }, '--rule is not valid with --queue. usage: orangu suggest --queue [--cwd <dir> | --all] [--json]'],
      [{ queue: true, scope: 'global' }, '--scope is not valid with --queue.'],
      [{ todo: true, rule: 'tool-errors' }, '--rule is not valid with --todo. usage: orangu suggest --todo [--cwd <dir>] [--json]'],
      [{ lessons: true, rule: true }, '--rule requires 1 or more rule ids'],
      [{ queue: true, cwd: true }, '--cwd requires a folder'],
      [{ queue: true, status: 'applied' }, '--status is valid only with --list. usage: orangu suggest --list --status <s>[,<s>]'],
    ]
    for (const [flags, message] of refusals) await expect(cmdSuggest([], flags, { read: deps }), JSON.stringify(flags)).rejects.toThrow(message)
    expect(deps.loads).toEqual([])
  })
})

/** The rows of 1 item: its head and each row under it, up to the next head or a blank line. */
function itemRows(lines: readonly string[], id: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(`  ${id}  [`))
  expect(start, id).toBeGreaterThanOrEqual(0)
  const rows = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^ {2}sg_[0-9a-f]{12} {2}\[/.test(line)) break
    rows.push(line)
  }
  return rows
}

const itemsOf = (queue: SuggestionQueue): QueueItem[] => QUEUE_GROUPS.flatMap((group) => queue.groups[group])
/** A row that may pass the measure: 1 whole command or 1 whole path, wider than its room. */
const WHOLE_ROW = /^( {4})(claude "\/orangu:[^"]+")$|^( {2}| {4})Workspace: (\S+)$/

describe('the queue text', () => {
  /** The fixture queue of every workspace, with a workspace path wider than every measure. */
  const longPathQueue = (): SuggestionQueue => {
    const queue = queueFixture('all')
    const path = `/w/${'a-folder-with-a-long-name-'.repeat(4)}repo`
    const groups = Object.fromEntries(QUEUE_GROUPS.map((group) => [group, queue.groups[group].map((item) => ({ ...item, workspace: path }))]))
    return { ...queue, groups: groups as SuggestionQueue['groups'] }
  }

  it.each([60, 80, 120])('fits every row to the layout at %i columns: a title wraps under itself whole, and only a whole command or path passes the measure', (columns) => {
    const width = layoutWidth({ columns })
    for (const queue of [queueFixture(), queueFixture('all'), longPathQueue(), emptyQueueFixture()]) {
      const lines = queueLines(queue, width)
      for (const line of lines) {
        if (displayWidth(line) <= width) continue
        const whole = WHOLE_ROW.exec(line)
        expect(whole, `${columns} columns: ${JSON.stringify(line)} passes ${width}`).not.toBeNull()
        const [indent, value] = whole![1] !== undefined ? [whole![1], whole![2]!] : [`${whole![3]}Workspace: `, whole![4]!]
        expect(displayWidth(value), line).toBeGreaterThan(width - displayWidth(indent))
      }
      for (const item of itemsOf(queue)) {
        const rows = itemRows(lines, item.id)
        const column = rows[0]!.indexOf(']  ') + 3
        const titleRows = [rows[0]!.slice(column), ...rows.slice(1).filter((row) => row.search(/\S/) === column).map((row) => row.slice(column))]
        expect(titleRows.join(' '), `${columns}: the title of ${item.id} is whole`).toBe(item.title)
      }
      expect(lines.at(-1), 'the last row').toBe(`  ${QUEUE_APP_ROW}`)
      expect(lines.join('\n'), 'the queue text names no store command').not.toContain('orangu suggest')
    }
  })

  it('prints a command row only for an item with a next step: a wait item and a deferred item have none, and the deferred item says why', () => {
    const queue = queueFixture()
    const lines = queueLines(queue, 80)
    const commands = lines.filter((line) => /^ {4}claude "/.test(line))
    expect(commands).toEqual(itemsOf(queue).flatMap((item) => (item.next === null ? [] : [`    ${item.next}`])))
    const waiting = queue.groups.wait
    expect(waiting.map((item) => [item.id, item.next, item.check])).toEqual([[sg(7), null, 'ran'], [sg(8), null, 'deferred']])
    for (const item of waiting) expect(itemRows(lines, item.id).some((row) => row.includes('claude "')), item.id).toBe(false)
    const deferred = itemRows(lines, sg(8)).slice(1).map((row) => row.trim()).join(' ')
    expect(deferred).toContain(DEFERRED_TEXT)
    expect(DEFERRED_TEXT).toBe('orangu did not check this change in this read, because the read reached its byte budget. Run orangu again to check it.')
    expect(itemRows(lines, sg(7)).slice(1).map((row) => row.trim())).toEqual([
      'Checked: within-noise at the first checkpoint.',
      'Sessions: 3 before the change, 4 of 10 after it.',
    ])
  })

  it('has its own empty state, and the app row stays last', () => {
    expect(queueLines(emptyQueueFixture(), 80)).toEqual([
      '',
      '  Improvements · 0 due · 0 open',
      '  Workspace: /w/repo',
      '',
      '  orangu found no open record in this workspace.',
      '',
      '  See this queue in the app: orangu serve',
    ])
  })

  it('--queue --json prints SuggestionQueue v1 with its exact keys past the output boundary, and the text has the same items', async () => {
    const secret = 'sk-ant-api03-abc123def456ghi789'
    seed([...queueFixtureRecords(), recordOf(sg(20), { ruleId: 'slow-tool', title: `Use the key ${secret} once`, statusAt: APPLIED_AT })])
    const json = await run({ queue: true, cwd: WORKSPACE, json: true }, readDeps(laterOf([1, 2, 3])))
    expect(json).not.toContain(secret)
    expect(readFileSync(storeFile(), 'utf8')).toContain(secret)
    const queue = JSON.parse(json) as SuggestionQueue
    expect(Object.keys(queue)).toEqual(['v', 'scope', 'now', 'counts', 'groups', 'globalOpen'])
    expect(Object.keys(queue.counts)).toEqual(['verdict', 'regressed', 'apply', 'review', 'running', 'wait', 'due', 'open'])
    expect(Object.keys(queue.groups)).toEqual([...QUEUE_GROUPS])
    expect(queue).toMatchObject({ v: 1, scope: WORKSPACE, now: NOW, globalOpen: 0 })
    const allowed = new Set(['group', 'id', 'ids', 'status', 'scope', 'ruleId', 'changeClass', 'title', 'workspace', 'lastMoveAt', 'appliedAt', 'candidates', 'check', 'checkpoint', 'verdict', 'final', 'leaning', 'cannotVerify', 'earlier', 'earlierCount', 'next'])
    for (const item of itemsOf(queue)) {
      expect(Object.keys(item).filter((key) => !allowed.has(key)), item.id).toEqual([])
      for (const key of ['group', 'id', 'ids', 'status', 'scope', 'ruleId', 'title', 'workspace', 'lastMoveAt', 'earlier', 'earlierCount', 'next']) expect(key in item, `${item.id} ${key}`).toBe(true)
    }
    const text = await run({ queue: true, cwd: WORKSPACE }, readDeps(laterOf([1, 2, 3])))
    for (const item of itemsOf(queue)) expect(text, item.id).toContain(`  ${item.id}  [${item.status}]`)
    expect(text).not.toContain(secret)
  })
})

describe('the history text', () => {
  it.each([60, 80, 120])('fits every row to the layout at %i columns, and only a whole path passes the measure', async (columns) => {
    seed([
      appliedOf(sg(1), { title: 'Run the type check before each commit, so the same tool error does not come back' }),
      appliedOf(sg(2), { status: 'rejected', statusAt: APPLIED_AT + 5_000, reasonCode: 'wrong-cause', title: 'Stop a retry after 2 failed calls' }),
      appliedOf(sg(3), { application: { v: 1, summary: 's', files: ['CLAUDE.md', `docs/${'a-long-folder-name/'.repeat(5)}NOTES.md`], checks: [{ name: 't', ok: true }], receiptPath: '/p/a.applied.json' } }),
    ])
    const rows = JSON.parse(await run({ history: true, cwd: WORKSPACE, json: true })) as ChangeRow[]
    expect(rows.map((row) => row.id)).toEqual([sg(1), sg(2), sg(3)])
    expect(rows.find((row) => row.id === sg(2))!.decidedAt).toBe(APPLIED_AT + 5_000)
    expect('decidedAt' in rows.find((row) => row.id === sg(1))!).toBe(false)
    const width = layoutWidth({ columns })
    const lines = historyLines(rows, width)
    for (const line of lines) {
      if (displayWidth(line) <= width) continue
      expect(line, `${columns} columns: ${JSON.stringify(line)} passes ${width}`).toMatch(/^ {4}(files: CLAUDE\.md, )?docs\/(a-long-folder-name\/){5}NOTES\.md$/)
    }
    // The facts break only between 2 facts: at 60 columns the row is 2 rows.
    if (width === 80) expect(lines).toContain('    applied 2026-10-01 00:00 · open · no verdict · rule reread-files')
    else expect(lines).toContain('    applied 2026-10-01 00:00 · open · no verdict')
    expect(lines.join('\n')).toContain('reason wrong-cause')
  })
})

describe('orangu suggest --show: the moves of a record', () => {
  it('adds transitions, 1 entry for each move in file order, and keeps every 0.11.0 key', async () => {
    const proposed = recordOf(sg(1), { status: 'proposed', statusAt: APPLIED_AT + 2, proposal: proposalOf() })
    seed([
      recordOf(sg(1), { statusAt: APPLIED_AT }),
      recordOf(sg(1), { status: 'kicked-off', statusAt: APPLIED_AT + 1 }),
      // the same status again is not a move
      recordOf(sg(1), { status: 'kicked-off', statusAt: APPLIED_AT + 1 }),
      proposed,
      { ...proposed, status: 'rejected', statusAt: APPLIED_AT + 3, reasonCode: 'too-much-effort' },
    ])
    const shown = JSON.parse(await run({ show: sg(1), json: true }))
    expect(Object.keys(shown)).toEqual(['record', 'sessions', 'catalog', 'missingSessionIds', 'transitions'])
    expect(shown.transitions).toEqual([
      { status: 'new', statusAt: APPLIED_AT },
      { status: 'kicked-off', statusAt: APPLIED_AT + 1 },
      { status: 'proposed', statusAt: APPLIED_AT + 2 },
      { status: 'rejected', statusAt: APPLIED_AT + 3, reasonCode: 'too-much-effort' },
    ])
    const text = await run({ show: sg(1) })
    expect(text).toContain('    moves:\n      2026-10-01 00:00  new\n      2026-10-01 00:00  kicked-off\n')
    expect(text).toContain('      2026-10-01 00:00  rejected (too-much-effort)\n')
  })
})

describe('orangu suggest --list --status', () => {
  it('keeps only those statuses, names the allowed list for an unknown one, and --list --json with no --status prints the same array as 0.11.0', async () => {
    seed([recordOf(sg(1), { statusAt: 3 }), recordOf(sg(2), { status: 'kicked-off', statusAt: 2 }), recordOf(sg(3), { status: 'rejected', statusAt: 1 })])
    const ids = async (flags: Record<string, string | boolean>): Promise<string[]> => JSON.parse(await run({ list: true, json: true, ...flags })).map((r: { id: string }) => r.id)
    expect(await ids({ status: 'new,rejected' })).toEqual([sg(1), sg(3)])
    expect(await ids({ status: 'kicked-off' })).toEqual([sg(2)])
    // The 0.11.0 array: every record, newest status first, each one as the store holds it.
    const stored = readFileSync(storeFile(), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as SuggestionRecord)
    expect(JSON.parse(await run({ list: true, json: true }))).toEqual([...stored].sort((a, b) => b.statusAt - a.statusAt))
    const allowed = 'new, kicked-off, proposed, applied, verified, rejected, failed, kept, regressed, unproven'
    for (const status of ['paused', 'new,Paused', '', true]) {
      await expect(cmdSuggest([], { list: true, status, json: true }), String(status)).rejects.toThrow(`--status takes 1 or more of ${allowed}`)
    }
    expect(await run({ list: true, status: 'applied' })).toBe('no suggestion has the status applied.\n')
  })
})

/** Every file under a folder, by its path inside the folder, with its bytes. */
function snapshot(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.set(relative(root, path), readFileSync(path))
    }
  }
  walk(root)
  return files
}

/** The deps that the CLI makes for 1 read: the trusted loaders behind the cohort facts cache of this orangu home. */
const trustedReadDeps = (): QueueReadDeps => createQueueReadDeps({ now: Date.parse('2030-01-01T00:00:00.000Z'), cache: new CohortFactsCache({ version: VERSION }) })

describe('the reads write nothing', () => {
  it('--queue, --todo, --lessons, --history, --show and --list --status keep the store bytes, add no file under proposals/, and add files only to the cohort facts cache', async () => {
    // A real workspace with 3 later sessions on disk, settled long before the clock of the read.
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-reads-ws-')))
    const project = join(process.env['CLAUDE_CONFIG_DIR']!, 'projects', projectSlug(workspace))
    mkdirSync(project, { recursive: true })
    for (let n = 0; n < 3; n++) {
      const sessionId = uuid(100 + n)
      const path = join(project, `${sessionId}.jsonl`)
      const session = new SessionBuilder({ sessionId, startAt: new Date(APPLIED_AT + (n + 1) * 60 * 60_000).toISOString(), cwd: workspace })
        .userPrompt('Work.')
        .assistant([{ type: 'text', text: 'Done.' }], { usage: { input_tokens: 1, output_tokens: 1 } })
      writeFileSync(path, session.toJsonl())
      const settled = new Date(APPLIED_AT + (n + 2) * 60 * 60_000)
      utimesSync(path, settled, settled)
    }
    // The trusted loaders check the stored identity of the workspace against the folder: path, inode and creation time.
    const proposal = { ...proposalOf(workspace), workspace: storedWorkspaceIdentity(await liveWorkspaceIdentity(workspace)) }
    seed([
      appliedOf(sg(1), { proposal }),
      recordOf(sg(2), { status: 'rejected', reasonCode: 'other', workspaceCwd: workspace }),
      recordOf(sg(3), { status: 'proposed', proposal }),
    ])
    mkdirSync(join(home, 'proposals'), { mode: 0o700 })
    const before = snapshot(home)
    const steps: Array<Record<string, string | boolean>> = [
      { queue: true, cwd: workspace },
      { queue: true, all: true, json: true },
      { todo: true, cwd: workspace, json: true },
      { todo: true, cwd: workspace },
      { lessons: true, cwd: workspace, json: true },
      { history: true, cwd: workspace },
      { show: sg(1), json: true },
      { list: true, status: 'applied,rejected', json: true },
    ]
    for (const flags of steps) await run(flags, trustedReadDeps())
    // The queue check ran: 3 later sessions after a frozen baseline of 3 make the applied record due.
    const queue = JSON.parse(await run({ queue: true, cwd: workspace, json: true }, trustedReadDeps())) as SuggestionQueue
    expect(queue.groups.verdict.map((item) => item.id)).toEqual([sg(1)])
    const after = snapshot(home)
    expect(after.get('suggestions.jsonl')).toEqual(before.get('suggestions.jsonl'))
    const moved = [...after.keys()].filter((path) => !before.get(path)?.equals(after.get(path)!))
    expect(moved.length, 'the queue check cached the facts of the 3 later sessions').toBe(3)
    for (const path of moved) expect(path, 'only the cohort facts cache gets files').toMatch(/^cache\/[^/]+\/cohort-facts-v1\/[0-9a-f]{40}\.json$/)
    expect([...before.keys()].filter((path) => !after.has(path))).toEqual([])
    expect(readdirSync(join(home, 'proposals'))).toEqual([])
  })
})
