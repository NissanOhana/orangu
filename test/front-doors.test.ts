/**
 * The front doors. A person starts orangu at 1 of 3 doors: `npx orangu` in a terminal, `orangu serve` for the local
 * app, or `/orangu:improve` in Claude Code. A person surface names a door, or 1 whole `claude "/orangu:…"` handoff.
 * It never names an `orangu suggest` command, because that is the store API that the skills and scripts call. Only
 * `orangu help all`, the Commands row of docs/USAGE.md, docs/DETERMINISM.md, docs/DATA-CONTRACTS.md and the output of
 * `orangu suggest` itself name it.
 *
 * site/llms.txt is not a person surface: it is the index for agents, and an agent can need the store API. So this
 * sweep does not read it. site/llms-full.txt joins README.md, docs/USAGE.md and docs/DETERMINISM.md for agents. The
 * sweep reads README.md itself.
 *
 * The sweep has no allowlist. A hit names its surface and its line: fix the copy, never this test.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, helpText } from '../scripts/ste-surfaces.js'
import { dashboardChoices, dashboardFrame, type DashboardData } from '../src/cli/commands/dashboard.js'
import { queueLines } from '../src/cli/commands/suggest-reads.js'
import { nextStepLines, type NextStep } from '../src/cli/summary.js'
import { MACHINE_CAPS, stripAnsi } from '../src/cli/tty.js'
import { kickoffCommands } from '../src/suggest/id.js'
import { QUEUE_GROUPS, buildQueue, type QueueCheck, type QueueItem } from '../src/suggest/queue.js'
import type { SuggestionRecord } from '../src/suggest/types.js'
import { queueFixture } from './fixtures/suggestion-queue.js'
import { APPLIED_AT, NOT_INCREASED, NOW, WORKSPACE, appliedOf, frozenOf, proposalOf, recordOf, sg, uuid } from './fixtures/suggestion-records.js'
import { currencyHits, moneyHits } from './money-vocabulary.js'

/** The store API in any form: `orangu suggest`, `npx orangu suggest`. */
const STORE_API = /\borangu suggest\b/

/** Each line of `text` that names the store API, as `<surface>:<line>: <text>`. */
function storeApiLines(surface: string, text: string): string[] {
  return text.split('\n').flatMap((line, index) => (STORE_API.test(line) ? [`${surface}:${index + 1}: ${line.trim()}`] : []))
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** The dashboard of a workspace with 2 due and 3 open items, of a store that cannot be read, and with nothing open. */
function dashboardFrames(): string[] {
  const live = { sessionId: uuid(1), path: '/c/a.jsonl', projectSlug: '-w-repo', project: 'repo', title: 'Fix the login test', sizeBytes: 100, mtimeMs: NOW - 10_000, running: true }
  const base: DashboardData = { repoName: 'repo', repoSessions: 2, globalSessions: 5, roots: 1, runningSessions: 1, live: [live], queue: { due: 0, open: 0 } }
  return (['store-error', { due: 2, open: 3 }, { due: 0, open: 0 }] as const).map((queue) => {
    const data = { ...base, queue }
    const choices = dashboardChoices(data)
    return dashboardFrame(MACHINE_CAPS, data, choices, { cursor: 0, start: 0, size: choices.length }, NOW).map(stripAnsi).join('\n')
  })
}

/** The footer of a session with a finding (both command forms) and of a clean session, each with a `due` row. */
function footers(): string[] {
  const record = { id: sg(1), ruleId: 'tool-errors', scope: 'session' as const, sessionIds: [uuid(1)], source: 'report' as const }
  const steps: NextStep[] = [
    { finding: 'The same tool error came back', improvement: 'Run the type check before each commit.', next: kickoffCommands(record, 'serve').claude, due: 2 },
    { finding: 'The same tool error came back', storeNote: 'the store is read-only', next: kickoffCommands(record, 'file').claude, due: 1 },
    { due: 3 },
  ]
  return steps.map((step) => nextStepLines(MACHINE_CAPS, step).map(stripAnsi).join('\n'))
}

/** 3 sessions before the change and 3 quiet ones after it, as discovery lists the file times. */
const SIX_TIMES = [APPLIED_AT - 3_000, APPLIED_AT - 2_000, APPLIED_AT - 1_000, APPLIED_AT + 1_000, APPLIED_AT + 2_000, APPLIED_AT + 3_000]
const ran = (over: Partial<Extract<QueueCheck, { check: 'ran' }>> = {}): QueueCheck => ({ check: 'ran', checkpoint: 'first', verdict: 'within-noise', final: false, ...over })

/** 1 record for each row of the table of `next` values, read alone: the item of each row. */
function nextTableItems(): Array<[string, QueueItem]> {
  const rows: Array<[string, SuggestionRecord, QueueCheck | undefined, number[]?]> = [
    ['applied, due', appliedOf(sg(1)), ran({ verdict: 'verified', final: true })],
    ['applied, few-baseline-sessions', appliedOf(sg(2), { frozenBaseline: frozenOf([1, 2]) }), undefined],
    ['regressed', appliedOf(sg(3), { status: 'regressed' }), undefined],
    ['proposed, repo', recordOf(sg(4), { status: 'proposed', proposal: proposalOf() }), undefined],
    ['proposed, session', recordOf(sg(5), { status: 'proposed', scope: 'session', proposal: proposalOf() }), undefined],
    ['new', recordOf(sg(6)), undefined],
    ['failed', recordOf(sg(7), { status: 'failed' }), undefined],
    ['proposed, global', recordOf(sg(8), { status: 'proposed', scope: 'global', proposal: proposalOf() }), undefined],
    ['applied, baseline-gone', appliedOf(sg(9), { frozenBaseline: undefined }), undefined, [APPLIED_AT - 1]],
    ['applied, legacy-record', appliedOf(sg(10), { proposal: undefined }), undefined],
    ['kicked-off', recordOf(sg(11), { status: 'kicked-off' }), undefined],
    ['applied, before a checkpoint', appliedOf(sg(12)), ran({ checkpoint: null, verdict: 'not-enough-sessions' })],
    ['applied, between the checkpoints', appliedOf(sg(13)), ran()],
    ['applied, deferred', appliedOf(sg(14)), { check: 'deferred' }],
    ['applied, no-directional-check before complete', appliedOf(sg(15), { proposal: proposalOf(WORKSPACE, [NOT_INCREASED]) }), ran({ verdict: 'no-directional-check' })],
  ]
  return rows.map(([label, record, check, times]) => {
    const queue = buildQueue({
      now: NOW,
      ...(record.scope === 'global' ? {} : { workspace: { cwd: WORKSPACE, sessionIds: [uuid(900)] } }),
      records: [record],
      lines: [record],
      checks: check ? { [record.id]: check } : {},
      discovered: { [record.id]: times ?? SIX_TIMES },
    })
    const items = QUEUE_GROUPS.flatMap((group) => queue.groups[group])
    expect(items, label).toHaveLength(1)
    return [label, items[0]!]
  })
}

/** Every module of the report client, tests left out: the serve-only home modules and the file report screens. */
function clientModules(): string[] {
  const dir = join(ROOT, 'src/report/client')
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .map((file) => file.split('\\').join('/'))
    .filter((file) => file.endsWith('.ts') && !/\.(?:test|spec|d)\.ts$/.test(file))
    .sort()
}

describe('the front doors: no person surface names the store API', () => {
  it('finds a store command on the line that names it', () => {
    expect(storeApiLines('x', 'one\nRun `npx orangu suggest --effect <id>` now.\nthree')).toEqual(['x:2: Run `npx orangu suggest --effect <id>` now.'])
    expect(storeApiLines('x', 'claude "/orangu:improve --verify sg_000000000001"')).toEqual([])
  })

  it('the short help names the 3 doors and no store command', () => {
    const help = helpText()
    for (const door of ['  orangu    ', '  orangu serve ', '  /orangu:improve ']) expect(help).toContain(door)
    expect(storeApiLines('orangu --help', help)).toEqual([])
  })

  it('README.md names no store command', () => {
    expect(storeApiLines('README.md', read('README.md'))).toEqual([])
  })

  it('the landing source names no store command', () => {
    expect(storeApiLines('site/index.src.html', read('site/index.src.html'))).toEqual([])
  })

  it('the dashboard frame names no store command, with open items, with a store error and with nothing open', () => {
    const frames = dashboardFrames()
    expect(frames[1]).toContain('IMPROVE Improvements')
    frames.forEach((frame, index) => expect(storeApiLines(`dashboard frame ${index + 1}`, frame)).toEqual([]))
  })

  it('the footer with a due row names no store command', () => {
    const lines = footers()
    for (const footer of lines) expect(footer).toContain('claude "/orangu:improve"')
    lines.forEach((footer, index) => expect(storeApiLines(`footer ${index + 1}`, footer)).toEqual([]))
  })

  it('each next of the queue is a handoff or null, and the printed queue names no store command', () => {
    const items = nextTableItems()
    for (const [label, item] of items) {
      if (item.next !== null) expect(item.next, label).toMatch(/^claude "\/orangu:(?:improve(?: --verify)?|apply) sg_[0-9a-f]{12}"$/)
    }
    expect(items.filter(([, item]) => item.next !== null)).toHaveLength(10)
    for (const scope of ['workspace', 'all'] as const) expect(storeApiLines(`queue text (${scope})`, queueLines(queueFixture(scope), 80).join('\n'))).toEqual([])
  })

  it('each module of the report client names no store command, the home modules included', () => {
    const modules = clientModules()
    for (const home of ['home-ui.ts', 'queue-ui.ts', 'history-ui.ts', 'lessons-ui.ts', 'dismiss-ui.ts', 'queue-card.ts']) expect(modules).toContain(home)
    expect(modules.flatMap((file) => storeApiLines(`src/report/client/${file}`, read(`src/report/client/${file}`)))).toEqual([])
  })
})

describe('the front doors quote no money and add no dependency', () => {
  it('package.json ships with no runtime dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  it('the door texts that the other money guards do not walk quote no money', () => {
    const texts: Array<[string, string]> = [
      ['site/llms.src.txt', read('site/llms.src.txt')],
      ['site/llms.txt', read('site/llms.txt')],
      ['site/llms-full.txt', read('site/llms-full.txt')],
      ['orangu --help', helpText()],
      ...dashboardFrames().map((frame, index): [string, string] => [`dashboard frame ${index + 1}`, frame]),
      ...footers().map((footer, index): [string, string] => [`footer ${index + 1}`, footer]),
    ]
    for (const [label, text] of texts) {
      expect(currencyHits(text), `${label}: currency amount`).toEqual([])
      expect(moneyHits(text), `${label}: money vocabulary`).toEqual([])
    }
  })
})
