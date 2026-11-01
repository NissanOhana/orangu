/**
 * The front doors. A person follows 1 chain: `npx orangu` in a terminal (the brief, then the local app), then
 * `/orangu:improve` in Claude Code. A person surface names a door, or 1 whole `claude "/orangu:…"` handoff.
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
import { ROOT, helpText, sessionTerminalViews } from '../scripts/ste-surfaces.js'
import { queueLines } from '../src/cli/commands/suggest-reads.js'
import { appBlock, nextStepLines, type NextStep } from '../src/cli/summary.js'
import { MACHINE_CAPS, stripAnsi } from '../src/cli/tty.js'
import type { Analysis } from '../src/model/analysis.js'
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

/** The 2 closing lines of bare `orangu` on a terminal: what the first run of the brain asks, then how to stop the app. */
const CLOSING_LINES = ['  The first run of /orangu:improve asks about your role and your work.', '  Press ctrl-c to stop the app.'] as const

/** The rows that bare `orangu` prints on a terminal after the brief: the app URL, the counts and the 2 closing lines. */
function appRows(): string {
  return appBlock(MACHINE_CAPS, { url: `http://127.0.0.1:53211/_orangu/${'q'.repeat(43)}`, sessions: 5, running: 1 }).map(stripAnsi).join('\n')
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

  it('the short help names the chain in order, then the full reference, and no store command or machine verb', () => {
    const help = helpText()
    const doors = ['\n  orangu  ', '\n  /orangu:improve  ', '\n  /orangu:interview  ', '\n  orangu help all  ']
    const at = doors.map((door) => help.indexOf(door))
    doors.forEach((door, index) => expect(at[index], door).toBeGreaterThan(-1))
    expect(at, 'in the order of the chain').toEqual([...at].sort((a, b) => a - b))
    const machine = ['orangu serve', 'orangu report', 'orangu repo', 'orangu global', 'orangu harness']
    const skills = ['/orangu:apply', '/orangu:analyze', '/orangu:harness', '/orangu:show-me', '/orangu:feedback']
    for (const name of [...machine, ...skills]) expect(help, name).not.toContain(name)
    expect(storeApiLines('orangu --help', help)).toEqual([])
  })

  it('README.md names no store command', () => {
    expect(storeApiLines('README.md', read('README.md'))).toEqual([])
  })

  it('the landing source names no store command', () => {
    expect(storeApiLines('site/index.src.html', read('site/index.src.html'))).toEqual([])
  })

  it('the app rows of bare orangu end with the first run of /orangu:improve and how to stop the app, and name no store command', () => {
    expect(appRows().split('\n').slice(-3)).toEqual(['', CLOSING_LINES[0], CLOSING_LINES[1]])
    expect(storeApiLines('app rows', appRows())).toEqual([])
  })

  it('the door view of the rendered#terminal row ends with the same 2 lines, so the STE gate scores them', async () => {
    const source = 'test/golden/canonical.analysis.json'
    const views = await sessionTerminalViews(source, JSON.parse(read(source)) as Analysis)
    const door = views.find((view) => view.file === `${source}#door`)
    expect(door?.lines?.slice(-3)).toEqual(['', ...CLOSING_LINES])
  })

  it('the footer with a due row names no store command', () => {
    const lines = footers()
    for (const footer of lines) expect(footer).toContain('claude "/orangu:improve"')
    lines.forEach((footer, index) => expect(storeApiLines(`footer ${index + 1}`, footer)).toEqual([]))
  })

  it('each next of the queue is a handoff or null, and the printed queue names no store command', () => {
    const items = nextTableItems()
    for (const [label, item] of items) {
      // C10 (2026-11-01): apply is hidden, so a proposed record hands its id to improve, which asks for the approval
      if (item.next !== null) expect(item.next, label).toMatch(/^claude "\/orangu:improve(?: --verify)? sg_[0-9a-f]{12}"$/)
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
      ['app rows', appRows()],
      ...footers().map((footer, index): [string, string] => [`footer ${index + 1}`, footer]),
    ]
    for (const [label, text] of texts) {
      expect(currencyHits(text), `${label}: currency amount`).toEqual([])
      expect(moneyHits(text), `${label}: money vocabulary`).toEqual([])
    }
  })
})
