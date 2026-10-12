/**
 * The detail of 1 session, as the pane draws it beside the board (90 columns or more) or in place of it, top to
 * bottom:
 * - the title line: the name of the row in bold (src/god/view/names.ts: the cmux tab title, else the transcript
 *   title, else the session name);
 * - the facts line: the session name when the title line shows another name, the repo, the branch and the
 *   permission mode, then `muted` while u keeps the session from its alerts;
 * - the tab row: Now, History, Agents, Screen, Recap. Each tab is 1 Button with the key tab:<tab>, and the open
 *   tab shows in brackets. `t` moves to the next tab;
 * - the content of the open tab (src/god/view/detail-tabs.ts);
 * - the context bar: 10 cells, `▰` used and `▱` free, the percent (`~` when the window is an estimate), the count
 *   of the running agents and the newest PR number;
 * - 1 line for each overlap flag: `SAME TREE: <name>`, `SAME FILES: <name> (<file>)`, `SAME REPO: <name>`.
 * Every text shows whole: it wraps at whole words, never cut. Only the row budget cuts, and only the tab content:
 * a window over it with a count line above (`w: +N lines`) and below (`z: +N lines`) that names the key that
 * shows the rest. When fewer than 3 rows are left for content that does not fit, the detail says that the pane is
 * too short. No line is wider than `width`. The clock comes in as `now`.
 */
import type { DeliverOutcome, DetailTab, GodSession, PrLink, RecapState, ScreenRead, ContextFacts } from '../types.js'
import { ACCENT, DIM, FLAG_PAINT } from '../ui/theme.js'
import { NO_REPO } from './board.js'
import { cellWidth } from './cells.js'
import { tabContent, type OptionKey } from './detail-tabs.js'
import { rowName } from './names.js'
import { CANNOT_DRAW, messageLines } from './states.js'
import type { Line, Segment } from './types.js'
import { MIN_WINDOW, windowOf, type ScrollWindow } from './window.js'
import { flat, wrapSegments } from './wrap.js'

export { SCROLL_KEYS, scrollBy } from './window.js'

/** The tabs in the order that `t` walks them. */
export const DETAIL_TABS: readonly DetailTab[] = ['now', 'history', 'agents', 'screen', 'recap']

/** The label of each tab. */
export const TAB_LABEL: Readonly<Record<DetailTab, string>> = { now: 'Now', history: 'History', agents: 'Agents', screen: 'Screen', recap: 'Recap' }

/** The label of each overlap flag line. */
export const FLAG_LABEL = { 'same-tree': 'SAME TREE', 'same-files': 'SAME FILES', 'same-repo': 'SAME REPO' } as const

/** 1 tab of the tab row: 1 Button. */
export type TabCell = { tab: DetailTab; key: string; segments: Segment[] }

/** The window over the tab content (src/god/view/window.ts). */
export type DetailWindow = ScrollWindow

/** What the detail reads. The engine shell passes the selection, the pane props, the clock and the last reads. */
export type DetailInput = {
  session: GodSession
  /** the detail width in cells */
  width: number
  /** the most lines that the detail may take */
  rows: number
  now: number
  tab: DetailTab
  /** the first line of the tab content to show: 0, or what scrollBy gave. The shell sets 0 on a new tab or session */
  scroll: number
  /** true when cmux is not on the machine: the digits draw dim, and the Screen tab says why it is empty */
  isCmuxMissing: boolean
  /** true while a draft of r or m is open: the digits draw dim with no hotkey */
  isDraftOpen?: boolean
  screen?: ScreenRead
  /** true when the newest screen read of this session failed */
  isScreenFailed?: boolean
  /** true when the last cmux read failed or did not end, so the tab map can be old */
  isTabMapOld?: boolean
  /** the last Recap: the Recap tab shows it when it is a Recap of this session, and no x key while any Recap runs */
  recap?: RecapState
  outcome?: DeliverOutcome
}

/**
 * The detail, or the reason it cannot draw:
 * - detail: head (title and facts), the tab row (rows of tab Buttons), the body (the window over the tab content),
 *   the foot (the context bar and the flags), the option keys in view, and the window;
 * - too-short: 1 message.
 */
export type DetailView =
  | { kind: 'detail'; head: Line[]; tabRows: TabCell[][]; body: Line[]; foot: Line[]; options: OptionKey[]; window: DetailWindow }
  | { kind: 'too-short'; lines: Line[] }

/** The tab after `tab`, and Now after Recap. */
export const nextTab = (tab: DetailTab): DetailTab => DETAIL_TABS[(DETAIL_TABS.indexOf(tab) + 1) % DETAIL_TABS.length]!

/** The context as a percent of the window, `~` first when the window is an estimate; undefined with no window. */
export function contextPercent(context: ContextFacts | undefined): string | undefined {
  if (context === undefined || context.window <= 0) return undefined
  return `${context.isEstimated ? '~' : ''}${Math.round((context.tokens / context.window) * 100)}%`
}

/** The newest PR link that names a number. */
export const newestPr = (links: readonly PrLink[]): number | undefined => [...links].reverse().find((link) => link.number !== undefined)?.number

/** The cmux tab title: the workspace title, then `›` and the surface title. The 2 tools show it. */
export function tabTitle(session: GodSession): string {
  const tab = session.tab
  return tab === undefined ? '' : [tab.workspaceTitle, tab.surfaceTitle ?? ''].map(flat).filter((title) => title !== '').join(' › ')
}

function headLines(session: GodSession, width: number): Line[] {
  const name = rowName(session)
  const title = wrapSegments([{ text: name, bold: true }], width)
  const repo = session.repo === undefined ? NO_REPO : `${flat(session.repo.name)}${session.repo.isWorktree ? ' (worktree)' : ''}`
  const sessionName = flat(session.name) === name ? '' : flat(session.name)
  const facts = [sessionName, repo, flat(session.transcript?.branch ?? ''), flat(session.transcript?.permissionMode ?? ''), session.muted ? 'muted' : ''].filter((fact) => fact !== '')
  return [...title, ...wrapSegments([{ text: facts.join(' · ') }], width)]
}

/** The tabs in rows of `width`: 1 space before the first tab of a row, 2 between tabs. No tab is cut. */
function tabRowsOf(open: DetailTab, width: number): TabCell[][] {
  const rows: TabCell[][] = []
  let used = 0
  for (const tab of DETAIL_TABS) {
    const cell: TabCell = { tab, key: `tab:${tab}`, segments: [tab === open ? { text: `[${TAB_LABEL[tab]}]`, ...ACCENT, bold: true } : { text: TAB_LABEL[tab] }] }
    const cellWidthNow = cellWidth(cell.segments[0]!.text)
    const row = rows.at(-1)
    if (row !== undefined && used + 2 + cellWidthNow <= width) {
      row.push(cell)
      used += 2 + cellWidthNow
    } else {
      rows.push([cell])
      used = 1 + cellWidthNow
    }
  }
  return rows
}

/** The space before the tab at `index` of a tab row: 1 before the first tab, 2 between tabs. */
export const tabGap = (index: number): string => (index === 0 ? ' ' : '  ')

/** 1 row of tab Buttons as 1 line. */
const tabLine = (row: readonly TabCell[]): Line => ({ segments: row.flatMap((cell, index) => [{ text: tabGap(index) }, ...cell.segments]) })

function footLines(session: GodSession, width: number): Line[] {
  const transcript = session.transcript
  const parts: Segment[][] = []
  const percent = contextPercent(transcript?.context)
  if (percent !== undefined && transcript?.context !== undefined) {
    const used = Math.min(10, Math.max(0, Math.round((transcript.context.tokens / transcript.context.window) * 10)))
    parts.push([{ text: 'ctx', ...DIM }, { text: ` ${'▰'.repeat(used)}` }, { text: '▱'.repeat(10 - used), ...DIM }, { text: ` ${percent}` }])
  }
  const running = (transcript?.agents ?? []).filter((task) => task.isRunning).length
  if (running > 0) parts.push([{ text: `${running} ${running === 1 ? 'agent' : 'agents'}` }])
  const pr = newestPr(transcript?.prLinks ?? [])
  if (pr !== undefined) parts.push([{ text: `PR #${pr}` }])
  const context = parts.length === 0 ? [] : wrapSegments(parts.flatMap((part, index) => (index === 0 ? part : [{ text: ' · ', ...DIM }, ...part])), width)
  const flags = session.flags.flatMap((flag) =>
    wrapSegments([{ text: `${FLAG_LABEL[flag.kind]}:`, ...FLAG_PAINT[flag.kind], bold: true }, { text: ` ${flat(flag.otherName)}${flag.file === undefined ? '' : ` (${flat(flag.file)})`}` }], width, 1, 3),
  )
  return [...context, ...flags]
}

/** The detail of 1 session. */
export function detailView(input: DetailInput): DetailView {
  const { session, width, rows } = input
  const head = headLines(session, width)
  const tabRows = tabRowsOf(input.tab, width)
  const foot = footLines(session, width)
  const content = tabContent(input.tab, input)
  const room = rows - head.length - tabRows.length - foot.length
  if (content.lines.length > room && room < MIN_WINDOW) return { kind: 'too-short', lines: messageLines(CANNOT_DRAW['too-short'], width) }
  const { lines: body, window } = windowOf(content.lines, room, input.scroll)
  const shown = new Set(body.flatMap((line) => (line.key === undefined ? [] : [line.key])))
  return { kind: 'detail', head, tabRows, body, foot, options: content.options.filter((option) => shown.has(option.key)), window }
}

/** Every line of a detail view, top to bottom. */
export function detailLines(view: DetailView): Line[] {
  if (view.kind === 'too-short') return [...view.lines]
  return [...view.head, ...view.tabRows.map(tabLine), ...view.body, ...view.foot]
}
