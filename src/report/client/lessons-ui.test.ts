import { beforeAll, describe, expect, it } from 'vitest'
import type { SuggestionViewRecord } from '../../model/app-data.js'
import { CHANGE_CLASS_DEFINITIONS } from '../../suggest/change-classes.js'
import { REJECT_REASON_LABELS } from '../../suggest/reason-codes.js'
import { historyFixture } from '../../../test/fixtures/suggestion-history.js'
import type { Lesson, LessonRead } from './lesson-types.js'
import { lessonsSection, type LessonsView } from './lessons-ui.js'

// The fixture: 6 lessons of 1 workspace, all of the class `instruction`, built by the server's own builder. The client
// reads the server shape through its own type, so the server result must stay assignable to it.
let read: LessonRead
let records: Map<string, SuggestionViewRecord>
beforeAll(async () => {
  const fixture = await historyFixture()
  read = fixture.lessons
  records = new Map(fixture.records.map((record) => [record.id, record]))
})

const view = (main: LessonsView['main'], over: Partial<LessonsView> = {}): LessonsView => ({ main, storeError: false, plain: false, ...over })
const draw = (main: LessonsView['main'], over: Partial<LessonsView> = {}, withRecords = records): string => lessonsSection(view(main, over), { records: withRecords })
const DASH = '<td class="num"><span aria-hidden="true">–</span><span class="vh">0</span></td>'
const n = (count: number): string => `<td class="num">${count}</td>`

/** The cells of the row whose head starts with `label`, in the first table of `html` after `from`. */
function cells(html: string, label: string, from = 'id="l-0-outcomes"'): string {
  const at = html.indexOf(`<th scope="row">${label}`, html.indexOf(from))
  expect(at, label).toBeGreaterThanOrEqual(0)
  return html.slice(html.indexOf('</th>', at) + 5, html.indexOf('</tr>', at))
}

/** A lesson of the fixture read with `over`. */
const lesson = (over: Partial<Lesson>): Lesson => ({ ...read.lessons[0]!, ...over })

describe('the Lessons section: the states', () => {
  it('shows the loading line while the first read runs, with no count and a busy body', () => {
    const html = draw(undefined)
    expect(html).toContain('<details class="card pad mb16 sg-note" id="home-lessons"><summary><span class="chev" aria-hidden="true">▸</span><b>Lessons</b></summary><div class="mt8" aria-busy="true">')
    expect(html).toContain('<div class="chart-empty">orangu reads the lessons.</div>')
  })

  it('shows the error state when the read failed, and names the store when each of the 3 store reads failed', () => {
    const html = draw(null)
    expect(html).toContain('<div class="t">orangu could not read the lessons.</div>')
    expect(html).toContain('<div class="s">Run orangu in a terminal and choose Improvements to see the reason.</div>')
    expect(html).toContain('data-copy="npx orangu"')
    expect(draw(null, { storeError: true })).toContain('<div class="t">orangu could not read the suggestion store.</div>')
  })

  it('shows the empty state of this workspace, and of every workspace', () => {
    const empty = draw({ ...read, lessons: [] })
    expect(empty).toContain('<b>Lessons</b> · none for this workspace yet</summary>')
    expect(empty).toContain('<div class="t">No lesson yet for this workspace.</div>')
    expect(empty).toContain('<div class="s">A lesson appears when a change gets a verdict, or when you dismiss one with a reason.</div>')
    const every = draw({ ...read, scope: 'all', lessons: [] })
    expect(every).toContain('<b>Lessons</b> · none yet</summary>')
    expect(every).toContain('<div class="t">No lesson yet.</div>')
  })

  it('counts the lessons in the summary, starts closed, and draws 1 card for this workspace with its folder and its path', () => {
    const html = draw(read)
    expect(html).toContain('id="home-lessons"><summary>')
    expect(html).toContain('<b>Lessons</b> · 6 for this workspace</summary>')
    expect(html).toContain('<div class="card mb16" style="overflow:hidden"><div class="card-head">repo</div><div class="pad"><div class="small muted">/w/repo</div>')
    expect(html).toContain('<p class="small muted sg-foot">The next proposal for this workspace reads these lessons.</p>')
    expect(draw({ ...read, scope: 'all' })).toContain('<b>Lessons</b> · 6 in all workspaces</summary>')
  })
})

describe('the Lessons section: the outcomes table', () => {
  it('has 1 row head for each change class, then the lessons with no class, each a row header', () => {
    const html = draw(read)
    const table = html.slice(html.indexOf('id="l-0-outcomes"'), html.indexOf('id="l-0-reasons"'))
    const heads = [...table.matchAll(/<th scope="row">([^<]*)/g)].map((m) => m[1])
    expect(heads).toEqual([...CHANGE_CLASS_DEFINITIONS.map((definition) => definition.label), 'Dismissed before a proposal'])
    expect(table).toContain('<table class="grid" aria-labelledby="l-0-outcomes">')
  })

  it('puts each table in its own scroll box, so a wide table scrolls there and not the page', () => {
    const html = draw(read)
    expect(html).toContain('<div class="scroll-x"><table class="grid" aria-labelledby="l-0-outcomes">')
    expect(html).toContain('<div class="scroll-x"><table class="grid" aria-labelledby="l-0-reasons">')
    expect(html.match(/<table /g)).toHaveLength(html.match(/<div class="scroll-x"><table /g)!.length)
  })

  it('counts by the stored status in Plain language, in 5 columns', () => {
    const html = draw(read, { plain: true })
    expect(html).toContain('<tr><th scope="col">Change class</th><th scope="col" class="num">Verified</th><th scope="col" class="num">Not shown beyond chance</th><th scope="col" class="num">Regressed</th><th scope="col" class="num">Kept after a regression</th><th scope="col" class="num">Dismissed</th></tr>')
    expect(cells(html, 'Instruction files')).toBe(n(2) + n(1) + n(1) + n(1) + n(1))
    expect(cells(html, 'Hooks')).toBe(DASH.repeat(5))
  })

  it('splits "Not shown beyond chance" by the stored verdict in Detailed, and adds the other changes of the window', () => {
    const html = draw(read)
    expect(html).toContain('<th scope="col" class="num">Verified</th><th scope="col" class="num">Within noise</th><th scope="col" class="num">Every guard held</th><th scope="col" class="num">Not enough sessions</th><th scope="col" class="num">Regressed</th><th scope="col" class="num">Kept after a regression</th><th scope="col" class="num">Dismissed</th><th scope="col" class="num">Other changes in the window</th>')
    expect(cells(html, 'Instruction files')).toBe(n(2) + n(1) + DASH + DASH + n(1) + n(1) + n(1) + DASH)
    const more = { ...read, lessons: [lesson({ id: 'sg_0000000000f1', status: 'unproven', verdict: 'no-directional-check', confoundedBy: ['sg_0000000000a1', 'sg_0000000000a2'] }), lesson({ id: 'sg_0000000000f2', status: 'unproven', verdict: 'not-enough-sessions', confoundedBy: ['sg_0000000000a1'] })] }
    expect(cells(draw(more), 'Instruction files')).toBe(DASH + DASH + n(1) + n(1) + DASH + DASH + DASH + n(2))
  })

  it('shows the rule ids under the row head in Detailed only', () => {
    const pills = '<div class="pill-row"><span class="pill">repeated-commands</span><span class="pill">unverified-edits</span><span class="pill">tool-errors</span></div>'
    expect(draw(read)).toContain(`<th scope="row">Instruction files${pills}</th>`)
    expect(draw(read, { plain: true })).not.toContain('pill-row')
  })

  it('counts a lesson with no change class in the row "Dismissed before a proposal"', () => {
    const { changeClass: _, ...noClass } = lesson({ id: 'sg_0000000000f3', status: 'rejected', reasonCode: 'not-wanted', verdict: null })
    const html = draw({ ...read, lessons: [noClass] }, { plain: true })
    expect(cells(html, 'Dismissed before a proposal')).toBe(DASH.repeat(4) + n(1))
    expect(cells(html, 'Instruction files')).toBe(DASH.repeat(5))
  })

  it('draws a 0 as a dash that reads as 0, with no total, no ratio and no percent', () => {
    const html = draw(read)
    expect(html).toContain(DASH)
    expect(html).not.toContain('%')
    expect(html).not.toMatch(/\b(?:total|ratio)\b/i)
  })

  it('never shows the leaning hint of the queue', () => {
    for (const plain of [false, true]) expect(draw(read, { plain })).not.toMatch(/leaning/i)
  })
})

describe('the Lessons section: the dismiss reasons', () => {
  it('counts each reason code of a dismissal in its own column, in the order of the codes', () => {
    const html = draw(read)
    const heads = Object.values(REJECT_REASON_LABELS).map((label) => `<th scope="col" class="num">${label}</th>`).join('')
    expect(html).toContain(`<table class="grid" aria-labelledby="l-0-reasons"><thead><tr><th scope="col">Change class</th>${heads}</tr></thead>`)
    expect(cells(html, 'Instruction files', 'id="l-0-reasons"')).toBe(DASH + DASH + n(1) + DASH + DASH)
  })

  it('says so in place of the table when no dismissal has a reason', () => {
    const html = draw({ ...read, lessons: read.lessons.filter((l) => l.status !== 'rejected') })
    expect(html).toContain('<div class="eyebrow mt8" id="l-0-reasons">Dismiss reasons</div><p class="small">No dismissal with a reason yet.</p>')
    expect(html).not.toContain('aria-labelledby="l-0-reasons"')
  })
})

describe('the Lessons section: every workspace', () => {
  const recordIn = (id: string, cwd: string | undefined): SuggestionViewRecord =>
    ({ ...records.get(read.lessons[0]!.id)!, id, proposal: { ...records.get(read.lessons[0]!.id)!.proposal!, workspace: cwd === undefined ? undefined : { cwd, device: '1', inode: '2' } } }) as SuggestionViewRecord
  const extras = () => [
    [lesson({ id: 'sg_0000000000e1' }), recordIn('sg_0000000000e1', '~/code/billing')],
    [lesson({ id: 'sg_0000000000e2' }), recordIn('sg_0000000000e2', undefined)],
    [lesson({ id: 'sg_0000000000e3', scope: 'global' }), recordIn('sg_0000000000e3', undefined)],
  ] as const
  const withExtra = () => new Map([...records, ...extras().map(([l, record]) => [l.id, record] as const)])
  const allRead = (): LessonRead => ({ ...read, scope: 'all', lessons: [...read.lessons, ...extras().map(([l]) => l)] })

  it('closes the disclosure at first and reads it on its first open only', () => {
    expect(draw(read)).toContain('<details class="sg-note mt8" id="home-all-lessons"><summary><span class="chev" aria-hidden="true">▸</span>All workspaces</summary><div class="mt8" aria-busy="true"><div class="chart-empty">orangu reads the lessons.</div>')
  })

  it('shows 1 card for each other workspace, then the lessons with no workspace, then the global card last, and none of this workspace', () => {
    const html = draw(read, { all: allRead() }, withExtra())
    const disclosure = html.slice(html.indexOf('id="home-all-lessons"'))
    const heads = [...disclosure.matchAll(/<div class="card-head">([^<]*)<\/div>/g)].map((m) => m[1])
    expect(heads).toEqual(['billing', 'No workspace', 'Global proposals and lessons'])
    expect(disclosure).toContain('<div class="card-head">billing</div><div class="pad"><div class="small muted">~/code/billing</div><div class="eyebrow mt8" id="l-1-outcomes">')
    // only a card of a workspace says that the next proposal reads its lessons
    expect(disclosure.match(/The next proposal for this workspace reads these lessons\./g)).toHaveLength(1)
  })

  it('says when no other workspace has a lesson, and shows the error state when the read failed', () => {
    expect(draw(read, { all: read })).toContain('<div class="chart-empty">No other workspace has a lesson.</div>')
    const failed = draw(read, { all: null })
    expect(failed.slice(failed.indexOf('id="home-all-lessons"'))).toContain('<div class="t">orangu could not read the lessons.</div>')
  })

  it('shows each workspace in turn with no disclosure when the read is of every workspace', () => {
    const html = draw(allRead(), {}, withExtra())
    expect(html).not.toContain('home-all-lessons')
    const heads = [...html.matchAll(/<div class="card-head">([^<]*)<\/div>/g)].map((m) => m[1])
    expect(heads).toEqual(['repo', 'billing', 'No workspace', 'Global proposals and lessons'])
  })
})

// A stored string can hold markup. Each place draws it as text: 1 marker for each place.
describe('the Lessons section: each stored string is text', () => {
  it('draws the folder and the path of this workspace as text', () => {
    const html = draw({ ...read, scope: '/w/<x-path>/<x-folder>' })
    expect(html).toContain('<div class="card-head">&lt;x-folder&gt;</div>')
    expect(html).toContain('<div class="small muted">/w/&lt;x-path&gt;/&lt;x-folder&gt;</div>')
    expect(html).not.toMatch(/<x-/)
  })

  it('draws a rule id as text', () => {
    const html = draw({ ...read, lessons: [lesson({ ruleId: '<x-rule>' })] })
    expect(html).toContain('<span class="pill">&lt;x-rule&gt;</span>')
    expect(html).not.toMatch(/<x-/)
  })
})
