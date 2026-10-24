/**
 * Serve only: the Lessons section of the improvement home, the Remember step of the loop. For each workspace, which
 * kinds of change held there and which did not, and why a person dismissed one. Only the home frame (home-ui.ts)
 * imports this file, so the file bundles carry none of it.
 *
 * The client computes no verdict. Each cell counts the lessons of the lesson read by their stored status, their
 * stored verdict and their stored reason code: a plain count, or a dash for 0, with no total, no ratio and no color
 * scale. Every stored string goes through esc(). A lesson has no workspace key, so in a read of every workspace a
 * lesson takes the workspace of its stored record, as a History row does (history-ui.ts).
 */
import { CHANGE_CLASS_DEFINITIONS } from '../../suggest/change-classes.js'
import { REJECT_REASON_CODES, REJECT_REASON_LABELS } from '../../suggest/reason-codes.js'
import { esc, num } from './format.js'
import { headCard } from './components/card.js'
import { emptyHero, emptyNote } from './components/empty.js'
import { STORE_ERROR, folderOf, readError } from './queue-ui.js'
import { byWorkspace, type StoreContext } from './history-ui.js'
import type { Lesson, LessonRead } from './lesson-types.js'

export interface LessonsView {
  /** the read of this workspace, or of every workspace: undefined while the first read runs, null when it failed */
  main: LessonRead | null | undefined
  /** the read of every workspace, for the All workspaces disclosure: undefined until it lands, null when it failed */
  all?: LessonRead | null | undefined
  /** each of the 3 store reads of the home failed */
  storeError: boolean
  /** the Plain language audience */
  plain: boolean
}

/** 1 column of a table: its head, and the lessons that it counts. */
interface Column {
  head: string
  counts: (lesson: Lesson) => boolean
}

const status = (value: Lesson['status']) => (lesson: Lesson) => lesson.status === value
const unproven = (verdict: string) => (lesson: Lesson) => lesson.status === 'unproven' && lesson.verdict === verdict

const VERIFIED: Column = { head: 'Verified', counts: status('verified') }
const LAST: Column[] = [
  { head: 'Regressed', counts: status('regressed') },
  { head: 'Kept after a regression', counts: status('kept') },
  { head: 'Dismissed', counts: status('rejected') },
]

/** The outcome columns. In Detailed, "Not shown beyond chance" splits by the stored verdict. */
const PLAIN_OUTCOMES: Column[] = [VERIFIED, { head: 'Not shown beyond chance', counts: status('unproven') }, ...LAST]
const DETAILED_OUTCOMES: Column[] = [
  VERIFIED,
  { head: 'Within noise', counts: unproven('within-noise') },
  { head: 'Every guard held', counts: unproven('no-directional-check') },
  { head: 'Not enough sessions', counts: unproven('not-enough-sessions') },
  ...LAST,
]

/** The reason columns: 1 for each reason code, in the order of the codes. */
const REASONS: Column[] = REJECT_REASON_CODES.map((code) => ({ head: REJECT_REASON_LABELS[code], counts: (lesson: Lesson) => lesson.status === 'rejected' && lesson.reasonCode === code }))

/** The rows of both tables: 1 for each change class, then the lessons with no change class. */
const ROWS: ReadonlyArray<{ key: string; label: string }> = [
  ...CHANGE_CLASS_DEFINITIONS.map((definition) => ({ key: definition.id, label: definition.label })),
  { key: '', label: 'Dismissed before a proposal' },
]

/** A count in a cell. A 0 shows as a dash that a screen reader reads as 0. */
const cell = (n: number): string => `<td class="num">${n ? num(n) : '<span aria-hidden="true">–</span><span class="vh">0</span>'}</td>`

/**
 * 1 table: a row head for each row, a count for each column. In Detailed, the outcomes add the rule ids under each row
 * head and 1 more column, the other changes that landed in the same window.
 */
function table(lessons: readonly Lesson[], columns: readonly Column[], labelledBy: string, detailed: boolean): string {
  const head = `<tr><th scope="col">Change class</th>${columns.map((column) => `<th scope="col" class="num">${column.head}</th>`).join('')}${detailed ? '<th scope="col" class="num">Other changes in the window</th>' : ''}</tr>`
  const rows = ROWS.map(({ key, label }) => {
    const mine = lessons.filter((lesson) => (lesson.changeClass ?? '') === key)
    const rules = [...new Set(mine.map((lesson) => lesson.ruleId).filter((rule): rule is string => !!rule))]
    const pills = detailed && rules.length ? `<div class="pill-row">${rules.map((rule) => `<span class="pill">${esc(rule)}</span>`).join('')}</div>` : ''
    const others = detailed ? cell(new Set(mine.flatMap((lesson) => lesson.confoundedBy)).size) : ''
    return `<tr><th scope="row">${label}${pills}</th>${columns.map((column) => cell(mine.filter(column.counts).length)).join('')}${others}</tr>`
  })
  return `<div class="scroll-x"><table class="grid" aria-labelledby="${labelledBy}"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`
}

/**
 * 1 workspace card: the folder as its head, the whole path, the outcomes and the dismiss reasons. `n` keys the labels
 * of its 2 tables. Only a card of a workspace says that the next proposal reads its lessons.
 */
function lessonCard(head: string, path: string, lessons: readonly Lesson[], plain: boolean, n: number): string {
  const reasons = lessons.some((lesson) => lesson.status === 'rejected' && lesson.reasonCode)
  const body = [
    path ? `<div class="small muted">${esc(path)}</div>` : '',
    `<div class="eyebrow mt8" id="l-${n}-outcomes">Outcomes</div>${table(lessons, plain ? PLAIN_OUTCOMES : DETAILED_OUTCOMES, `l-${n}-outcomes`, !plain)}`,
    `<div class="eyebrow mt8" id="l-${n}-reasons">Dismiss reasons</div>${reasons ? table(lessons, REASONS, `l-${n}-reasons`, false) : '<p class="small">No dismissal with a reason yet.</p>'}`,
    path ? '<p class="small muted sg-foot">The next proposal for this workspace reads these lessons.</p>' : '',
  ]
  return headCard(esc(head), `<div class="pad">${body.join('')}</div>`, 'mb16')
}

/** The cards of a read of every workspace: 1 for each workspace, then the lessons with no workspace, then the global card. */
function workspaceCards(lessons: readonly Lesson[], view: LessonsView, context: StoreContext, order: { n: number }): string {
  const { blocks, global } = byWorkspace(lessons, context.records)
  const html = blocks.map(([workspace, items]) => lessonCard(workspace ? folderOf(workspace) : 'No workspace', workspace, items, view.plain, order.n++))
  if (global.length) html.push(lessonCard('Global proposals and lessons', '', global, view.plain, order.n++))
  return html.join('')
}

const LOADING = emptyNote('orangu reads the lessons.')
const ERROR = 'orangu could not read the lessons.'
const EMPTY_HINT = 'A lesson appears when a change gets a verdict, or when you dismiss one with a reason.'

/** The All workspaces disclosure: closed at first, read on its first open only, with the lessons that the section does not show. */
function allWorkspaces(main: LessonRead, view: LessonsView, context: StoreContext, order: { n: number }): string {
  const all = view.all
  const shown = new Set(main.lessons.map((lesson) => lesson.id))
  const body =
    all === undefined
      ? LOADING
      : all === null
        ? readError(ERROR)
        : workspaceCards(all.lessons.filter((lesson) => !shown.has(lesson.id)), view, context, order) || emptyNote('No other workspace has a lesson.')
  return `<details class="sg-note mt8" id="home-all-lessons"><summary><span class="chev" aria-hidden="true">▸</span>All workspaces</summary><div class="mt8"${all === undefined ? ' aria-busy="true"' : ''}>${body}</div></details>`
}

/** The section body once a read landed. A read of every workspace shows each workspace in turn, with no disclosure. */
function lessonsBody(read: LessonRead, view: LessonsView, context: StoreContext): string {
  const every = read.scope === 'all'
  const order = { n: 0 }
  const parts = [
    !read.lessons.length
      ? emptyHero({ title: every ? 'No lesson yet.' : 'No lesson yet for this workspace.', hint: EMPTY_HINT })
      : every
        ? workspaceCards(read.lessons, view, context, order)
        : lessonCard(folderOf(read.scope), read.scope, read.lessons, view.plain, order.n++),
  ]
  if (!every) parts.push(allWorkspaces(read, view, context, order))
  return parts.join('')
}

/** The Lessons section: closed at first, its summary the accessible name of the toggle, with the count of the read. */
export function lessonsSection(view: LessonsView, context: StoreContext): string {
  const read = view.main
  const every = read?.scope === 'all'
  const n = read?.lessons.length ?? 0
  const count = read ? (n ? ` · ${num(n)} ${every ? 'in all workspaces' : 'for this workspace'}` : every ? ' · none yet' : ' · none for this workspace yet') : ''
  const body = read === undefined ? LOADING : read === null ? readError(view.storeError ? STORE_ERROR : ERROR) : lessonsBody(read, view, context)
  return `<details class="card pad mb16 sg-note" id="home-lessons"><summary><span class="chev" aria-hidden="true">▸</span><b>Lessons</b>${count}</summary><div class="mt8"${read === undefined ? ' aria-busy="true"' : ''}>${body}</div></details>`
}
