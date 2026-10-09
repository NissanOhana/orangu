/**
 * The frame of the detail of 1 session: the title and facts lines, the tab row, the context bar and the flag lines,
 * and the window over the tab content (src/god/view/detail-tabs.test.ts holds the content of each tab). The detail
 * shows each text whole: it wraps at whole words, and only the row budget cuts the tab content, with a count line
 * that names its key. No line is wider than the detail, the detail takes no more rows than it has, and each color
 * holds the AA contrast on both sets.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { busy, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import { INTENTS, NOW, OUTCOMES, RECAPS, SCREEN, detailSession, detailSessions, detailSnapshot } from '../../../test/fixtures/god/detail.js'
import type { GodTokenName } from '../generated/tokens.js'
import type { DetailTab, GodSession } from '../types.js'
import { colorOf } from '../ui/theme.js'
import { cellWidth } from './cells.js'
import { confirmView, outcomeLines } from './confirm.js'
import { DETAIL_TABS, detailLines, detailView, nextTab, scrollBy, type DetailInput, type DetailView } from './detail.js'
import { layoutOf } from './pane.js'
import { CANNOT_DRAW } from './states.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const input = (session: GodSession, over: Partial<DetailInput> = {}): DetailInput => ({ session, width: 79, rows: 60, now: NOW, tab: 'now', scroll: 0, isCmuxMissing: false, ...over })
const detail = (sessionId: string, over: Partial<DetailInput> = {}): Extract<DetailView, { kind: 'detail' }> => {
  const view = detailView(input(detailSession(sessionId), over))
  if (view.kind !== 'detail') throw new Error(`${sessionId}: ${view.kind}`)
  return view
}
const withoutTab = (session: GodSession): GodSession => {
  const { tab: _tab, ...rest } = session
  return rest
}

describe('the head of the detail', () => {
  it('shows the name, then · and the cmux tab title, and the name in bold', () => {
    const view = detail('s-wait')
    expect(text(view.head[0]!)).toBe(' api-7 · Eval set › tab 2')
    expect(view.head[0]!.segments.find((segment) => segment.text.includes('api-7'))?.bold).toBe(true)
    expect(text(detail('s-work').head[0]!)).toBe(' api-9 · Parser')
  })

  it('shows the transcript title when the session has no cmux tab, else the name alone', () => {
    const view = detailView(input(withoutTab(detailSession('s-wait'))))
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(text(view.head[0]!)).toBe(' api-7 · Pick the eval set')
    expect(text(detail('s-stuck').head[0]!)).toBe(' api-3')
  })

  it('shows the repo, the branch and the permission mode on the facts line', () => {
    expect(text(detail('s-wait').head[1]!)).toBe(' api · main · default')
    expect(text(detail('s-stuck').head[1]!)).toBe(' api (worktree) · fix')
    expect(text(detail('s-new').head[1]!)).toBe(' No repo')
  })

  it('wraps a long title line at whole words and cuts nothing', () => {
    const long = { ...withoutTab(detailSession('s-wait')), name: 'name-'.repeat(12) }
    const view = detailView(input(long, { width: 30 }))
    if (view.kind !== 'detail') throw new Error(view.kind)
    const head = view.head.map(text)
    expect(head.every((line) => cellWidth(line) <= 30)).toBe(true)
    expect(head.join('').replace(/\s+/g, '')).toContain(`${'name-'.repeat(12)}·Pickthe`)
  })
})

describe('the tab row', () => {
  it('shows the 5 tabs in the order that t walks, the open tab in brackets, each tab keyed', () => {
    expect(DETAIL_TABS).toEqual(['now', 'history', 'agents', 'screen', 'recap'])
    const view = detail('s-wait', { tab: 'agents' })
    expect(view.tabRows.flat().map((cell) => cell.key)).toEqual(['tab:now', 'tab:history', 'tab:agents', 'tab:screen', 'tab:recap'])
    expect(detailLines(view).map(text)).toContain(' Now  History  [Agents]  Screen  Recap')
    const open = view.tabRows.flat().find((cell) => cell.tab === 'agents')!
    expect(open.segments).toEqual([{ text: '[Agents]', token: '--accent', bold: true }])
  })

  it('moves to the next tab with t, and from Recap back to Now', () => {
    const walked: DetailTab[] = []
    let tab: DetailTab = 'now'
    for (let step = 0; step < 5; step += 1) {
      tab = nextTab(tab)
      walked.push(tab)
    }
    expect(walked).toEqual(['history', 'agents', 'screen', 'recap', 'now'])
  })

  it('flows the tabs into more rows when the detail is narrow, and cuts no tab', () => {
    const view = detail('s-wait', { width: 30 })
    expect(view.tabRows.length).toBeGreaterThan(1)
    expect(view.tabRows.flat()).toHaveLength(5)
    for (const row of view.tabRows) expect(cellWidth(row.flatMap((cell) => cell.segments).map((segment) => segment.text).join('  ')) + 1).toBeLessThanOrEqual(30)
  })
})

describe('the context bar and the flag lines', () => {
  it('shows 10 cells, the percent, the running agents and the newest PR number', () => {
    const wait = detail('s-wait').foot.map(text)
    expect(wait[0]).toBe(' ctx ▰▰▰▰▰▰▱▱▱▱ 61% · PR #12')
    const work = detail('s-work').foot.map(text)
    expect(work[0]).toBe(' ctx ▰▰▱▱▱▱▱▱▱▱ ~15% · 2 agents')
  })

  it('shows no context bar when the session has no context, agent or PR', () => {
    expect(detail('s-new').foot.map(text)).toEqual([])
  })

  it('shows 1 line for each flag, in its color: same tree, same files with the file, same repo', () => {
    const foot = detail('s-work').foot
    expect(foot.slice(1).map(text)).toEqual([' SAME TREE: api-7', ' SAME FILES: web-2 (/work/web/notes.md)', ' SAME REPO: api-3'])
    expect(foot.slice(1).map((line) => line.segments.find((segment) => segment.text.startsWith('SAME')))).toEqual([
      { text: 'SAME TREE:', token: '--bad', bold: true },
      { text: 'SAME FILES:', token: '--cat-edit', bold: true },
      { text: 'SAME REPO:', dim: true, bold: true },
    ])
  })
})

describe('only the rows that fit, and no silent cut', () => {
  const long = (): GodSession => {
    const reply = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the reply.`).join('\n')
    return snapshotOf([busy('s-long', { name: 'long-1', transcript: transcript({ lastReply: reply }) })]).sessions[0]!
  }
  const COUNT = /^ \+(\d+) lines? \(([wz])\)$/

  it('shows a count line with the key that shows the rest, and the counts add up to the whole tab', () => {
    const session = long()
    const first = detailView(input(session, { rows: 20 }))
    if (first.kind !== 'detail') throw new Error(first.kind)
    const lines = detailLines(first)
    expect(lines.length).toBeLessThanOrEqual(20)
    const last = text(first.body.at(-1)!)
    expect(last).toMatch(COUNT)
    expect(COUNT.exec(last)![2]).toBe('z')
    expect(Number(COUNT.exec(last)![1]) + first.body.length - 1).toBe(first.window.total)
    const next = detailView(input(session, { rows: 20, scroll: scrollBy(first.window, 'down') }))
    if (next.kind !== 'detail') throw new Error(next.kind)
    expect(text(next.body[0]!)).toMatch(/^ \+\d+ lines \(w\)$/)
    const counts = next.body.map(text).filter((line) => COUNT.test(line)).map((line) => Number(COUNT.exec(line)![1]))
    expect(counts.reduce((sum, count) => sum + count, 0) + next.body.length - counts.length).toBe(next.window.total)
    expect(scrollBy(next.window, 'up')).toBe(0)
  })

  it('walks every page to the end, where no count line is below, and clamps a scroll past the end', () => {
    const session = long()
    let scroll = 0
    const seen: string[] = []
    for (let page = 0; page < 20; page += 1) {
      const view = detailView(input(session, { rows: 14, scroll }))
      if (view.kind !== 'detail') throw new Error(view.kind)
      seen.push(...view.body.map(text).filter((line) => !COUNT.test(line)))
      if (view.window.first + view.window.shown >= view.window.total) break
      scroll = scrollBy(view.window, 'down')
    }
    for (let index = 1; index <= 40; index += 1) expect(seen).toContain(`   Line ${index} of the reply.`)
    const end = detailView(input(session, { rows: 14, scroll: 999 }))
    if (end.kind !== 'detail') throw new Error(end.kind)
    expect(text(end.body.at(-1)!)).toBe('   Line 40 of the reply.')
    expect(text(end.body[0]!)).toMatch(/\(w\)$/)
  })

  it('lists only the options in view, so a digit never answers an option that the person cannot see', () => {
    const view = detail('s-wait', { rows: 11 })
    expect(view.body.map(text).at(-1)).toMatch(COUNT)
    const shown = view.body.flatMap((line) => (line.key === undefined ? [] : [line.key]))
    expect(view.options.map((option) => option.key)).toEqual(shown)
    expect(view.options.map((option) => option.digit)).toEqual([1, 2])
  })

  it('says the pane is too short when fewer than 3 rows are left for a tab that does not fit', () => {
    const view = detailView(input(long(), { rows: 5 }))
    expect(view).toEqual({ kind: 'too-short', lines: [{ segments: [{ text: ` ${CANNOT_DRAW['too-short']}` }] }] })
    expect(detailView(input(detailSession('s-new'), { rows: 4 })).kind).toBe('detail')
  })
})

describe('no line is wider than the detail', () => {
  const stress = (): readonly GodSession[] =>
    snapshotOf([
      waiting('s-cjk', {
        name: '日本語のセッション名',
        transcript: transcript({
          title: '日本語のタイトル',
          lastReply: '日本語の返事です。'.repeat(20),
          openQuestion: { toolUseId: 'tu', questions: [{ text: '日本語の質問はここにあります。'.repeat(6), header: '見出し', multiSelect: false, options: [{ label: '選択肢'.repeat(30), description: '説明'.repeat(40) }] }] },
        }),
      }),
      busy('s-emoji', { name: 'emoji-\u{1F600}', transcript: transcript({ activity: { toolUseId: 'tu', tool: 'Edit', text: 'Edit \u{1F468}‍\u{1F469}‍\u{1F467} é.md', isOpen: true }, lastReply: 'x'.repeat(300) }) }),
      busy('s-long', { name: 'y'.repeat(120), transcript: transcript({ activity: { toolUseId: 'tu', tool: 'Bash', text: 'Bash '.repeat(60), input: 'z'.repeat(400), isOpen: true } }) }),
    ]).sessions

  it.each([60, 89, 90, 110])('holds every line of every tab of every session to the detail width at %i columns', (columns) => {
    const layout = layoutOf(columns)
    const width = layout.kind === 'wide' ? layout.detailColumns : layout.boardColumns
    const sessions = [...detailSnapshot().sessions, ...stress()]
    expect(sessions.length).toBe(detailSessions().length + 3)
    for (const session of sessions) {
      for (const tab of DETAIL_TABS) {
        for (const isCmuxMissing of [false, true]) {
          for (const rows of [12, 60]) {
            const view = detailView({ session, width, rows, now: NOW, tab, scroll: 0, isCmuxMissing, screen: { ...SCREEN, sessionId: session.sessionId }, recap: { ...RECAPS.answered, sessionId: session.sessionId }, outcome: OUTCOMES.refused })
            const lines = view.kind === 'detail' ? detailLines(view) : view.lines
            for (const line of lines) expect(cellWidth(text(line)), `${session.name} ${tab} at ${width}: ${text(line)}`).toBeLessThanOrEqual(width)
            expect(lines.length, `${session.name} ${tab} rows ${rows}`).toBeLessThanOrEqual(view.kind === 'detail' ? rows : 1)
          }
        }
      }
    }
  })
})

describe('light-set contrast', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
  /** The --bg value of the first tokens.css rule whose selector is exactly `selector`. */
  const background = (selector: string): string => {
    const css = readFileSync(join(ROOT, 'src/report/client/tokens.css'), 'utf8')
    const start = css.indexOf(`${selector}{`)
    const value = /--bg:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(start, css.indexOf('}', start)))?.[1]
    if (value === undefined) throw new Error(`tokens.css has no --bg in ${selector}`)
    return value
  }
  /** The WCAG contrast ratio of 2 colors written as #rrggbb. */
  const contrast = (a: string, b: string): number => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high! + 0.05) / (low! + 0.05)
  }

  it('holds each token that the detail and the confirm bar draw at 4.5:1 or more against the ground of both sets', () => {
    const recaps = [undefined, RECAPS.answered, RECAPS.failed]
    const outcomes = Object.values(OUTCOMES)
    const segments = [
      ...detailSnapshot().sessions.flatMap((session) =>
        DETAIL_TABS.flatMap((tab) =>
          recaps.flatMap((recap, index) => {
            const view = detailView({ ...input(session, { tab, screen: SCREEN }), ...(recap === undefined ? {} : { recap }), outcome: outcomes[index % outcomes.length]! })
            return [...detailLines(view), ...(view.kind === 'detail' ? view.tabRows.flat() : [])].flatMap((line) => line.segments)
          }),
        ),
      ),
      ...Object.values(INTENTS).flatMap((intent) => confirmView({ intent, width: 110, rows: 20, scroll: 0 }).lines.flatMap((line) => line.segments)),
      ...outcomes.flatMap((outcome) => outcomeLines(outcome, 110).flatMap((line) => line.segments)),
    ]
    const tokens = [...new Set(segments.flatMap((segment): GodTokenName[] => (segment.token === undefined ? [] : [segment.token])))]
    expect(tokens).toEqual(expect.arrayContaining(['--accent', '--bad', '--warn', '--good', '--cat-edit']))
    for (const [theme, selector] of [['light', ':root'], ['dark', ':root[data-theme="dark"]']] as const) {
      const ground = background(selector)
      for (const token of tokens) expect(contrast(colorOf(token, theme), ground), `${token} on the ${theme} ground ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
