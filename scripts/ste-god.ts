/**
 * The views of the rendered#god STE row (scripts/ste-surfaces.ts): what the god pane and the 2 god tools draw from
 * the synthetic fixtures of test/fixtures/god, through the real view builders under src/god/view, as the terminal
 * and the god Claude read them. Dev-only, like scripts/ste-surfaces.ts.
 */
import type { RenderedView } from './ste-surfaces.js'
import { NOW as GOD_NOW, boardSnapshot, byRepoSnapshot, degradedSnapshot, emptySnapshot, noRepoMatchSnapshot, readingSnapshot } from '../test/fixtures/god/snapshots.js'
import { INTENTS as GOD_INTENTS, OUTCOMES as GOD_OUTCOMES, RECAPS as GOD_RECAPS, SCREEN as GOD_SCREEN, detailSnapshot } from '../test/fixtures/god/detail.js'
import type { BoardSnapshot, DeliverIntent, DeliverOutcome, DeliverRefusal } from '../src/god/types.js'
import { barView } from '../src/god/view/bar.js'
import { statsAnswer } from '../src/god/control.js'
import { alertBody } from '../src/god/copy.js'
import { JUMP_NOTE } from '../src/god/view/keys.js'
import { confirmView, outcomeLines, PROMPT_MODE_TEXT, REFUSAL_TEXT } from '../src/god/view/confirm.js'
import { DETAIL_TABS, detailLines, detailView } from '../src/god/view/detail.js'
import { cannotDrawView, layoutOf, paneLines, paneView } from '../src/god/view/pane.js'
import { boardToolText, sessionToolText } from '../src/god/view/tool-text.js'
import type { Line } from '../src/god/view/types.js'

const GOD_FIXTURE = 'test/fixtures/god/snapshots.ts'

/**
 * The god pane of each fixture snapshot through the real view builders (src/god/view/pane.ts), as the terminal
 * shows it: the header, the board, the key row and each board state, at 60 columns (the board alone) and 110 (the
 * 44-column board beside the detail), with the waiting session selected and the prompt holding the keys. Then the
 * pane with the detail open in each tab at 60 columns (the detail in place of the board) and 110, the wide pane
 * with no session selected, the pane with each jump note, the pane with the sound off and a muted session, and each
 * line of a pane that cannot draw. Then each answer of /god stats, with and without the alert counts, and the body of
 * each alert. The fixture session texts are short and clean, so the row scores the pane.
 */
export function godViews(): RenderedView[] {
  const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
  const snapshots: ReadonlyArray<[string, BoardSnapshot, readonly string[]]> = [
    ['board', boardSnapshot(), []],
    ['board-stale-open', boardSnapshot(), ['stale']],
    ['by-repo', byRepoSnapshot(), []],
    ['reading', readingSnapshot(), []],
    ['no-sessions', emptySnapshot(), []],
    ['no-repo-match', noRepoMatchSnapshot(), []],
    ['sources-off-no-cmux', degradedSnapshot({ agents: { status: 'off' }, registry: { status: 'off' }, cmux: { status: 'missing' }, git: { status: 'off' } }, 12_000), []],
  ]
  const panes = snapshots.flatMap(([name, snapshot, openGroups]) =>
    [60, 110].map((bodyColumns) => {
      const view = paneView({ snapshot, bodyColumns, bodyRows: 40, now: GOD_NOW, selectedKey: 's-wait', openGroups, promptHoldsKeys: true })
      return { file: `${GOD_FIXTURE}#${name}.${bodyColumns}`, lines: paneLines(view).map(text) }
    }),
  )
  const opened = DETAIL_TABS.flatMap((tab) =>
    [60, 110].map((bodyColumns) => {
      const view = paneView({ snapshot: detailSnapshot(), bodyColumns, bodyRows: 40, now: GOD_NOW, selectedKey: 's-wait', openGroups: [], promptHoldsKeys: true, detail: { tab, scroll: 0, isOpen: true } })
      return { file: `${GOD_DETAIL_FIXTURE}#pane.${tab}.${bodyColumns}`, lines: paneLines(view).map(text) }
    }),
  )
  const noSelection = { file: `${GOD_FIXTURE}#no-selection.110`, lines: paneLines(paneView({ snapshot: boardSnapshot(), bodyColumns: 110, bodyRows: 40, now: GOD_NOW, openGroups: [], promptHoldsKeys: true })).map(text) }
  const cannotDraw = (['too-narrow', 'too-short', 'failed'] as const).map((reason) => ({ file: `${GOD_FIXTURE}#cannot-draw.${reason}`, lines: paneLines(cannotDrawView(reason, 60)).map(text) }))
  const noted = (Object.keys(JUMP_NOTE) as Array<keyof typeof JUMP_NOTE>).flatMap((reason) =>
    [60, 110].map((bodyColumns) => {
      const view = paneView({ snapshot: detailSnapshot(), bodyColumns, bodyRows: 40, now: GOD_NOW, selectedKey: 's-wait', openGroups: [], promptHoldsKeys: true, jumpNote: { sessionId: 's-wait', reason } })
      return { file: `${GOD_DETAIL_FIXTURE}#jump-note.${reason}.${bodyColumns}`, lines: paneLines(view).map(text) }
    }),
  )
  const quiet = detailSnapshot()
  const mutedSnapshot = { ...quiet, sessions: quiet.sessions.map((session) => (session.sessionId === 's-wait' ? { ...session, muted: true } : session)) }
  const soundOff = [60, 110].map((bodyColumns) => {
    const view = paneView({ snapshot: mutedSnapshot, bodyColumns, bodyRows: 40, now: GOD_NOW, selectedKey: 's-wait', openGroups: [], promptHoldsKeys: true, isSoundOff: true })
    return { file: `${GOD_DETAIL_FIXTURE}#sound-off-muted.${bodyColumns}`, lines: paneLines(view).map(text) }
  })
  const stats = { at: GOD_NOW, computeMs: 23, waitMs: 410, sessions: 15 }
  const statsViews = [undefined, [], [stats], [stats, { ...stats, sessions: 1 }]].map((recent, index) => ({ file: `${GOD_FIXTURE}#stats.${index}`, lines: [statsAnswer(recent)] }))
  const counted = [{ tones: 1, notifications: 1 }, { tones: 0, notifications: 3 }].map((counts, index) => ({ file: `${GOD_FIXTURE}#stats.alerts.${index}`, lines: [statsAnswer([stats], counts)] }))
  const alerts = (['needs-you', 'stuck'] as const).map((kind) => ({ file: `${GOD_FIXTURE}#alert.${kind}`, lines: [alertBody('api-7', kind)] }))
  return [...panes, ...opened, noSelection, ...noted, ...soundOff, ...cannotDraw, ...statsViews, ...counted, ...alerts, ...godDetailViews()]
}

const GOD_DETAIL_FIXTURE = 'test/fixtures/god/detail.ts'

/**
 * The detail of each fixture session in each tab at the detail width of a 60-column pane (the detail alone) and a
 * 110-column pane (beside the board), with the screen read and the answered Recap; the Recap while it runs and
 * when it failed; each tab with no cmux; the confirm bar of each intent and each outcome and refusal line; the
 * request of a tool that the pane does not answer; the mode line of a prompt; the bar of each draft with its text
 * field, and the bar after an old read; and the 2 tool texts at 110 columns. The fixture session texts are short and
 * clean, so the row scores what orangu writes.
 */
export function godDetailViews(): RenderedView[] {
  const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
  const snapshot = detailSnapshot()
  const detailWidth = (columns: number): number => {
    const layout = layoutOf(columns)
    return layout.kind === 'wide' ? layout.detailColumns : layout.boardColumns
  }
  const detail = (file: string, input: Omit<Parameters<typeof detailView>[0], 'rows' | 'now' | 'scroll'>, rows = 60): RenderedView => ({
    file: `${GOD_DETAIL_FIXTURE}#${file}`,
    lines: detailLines(detailView({ ...input, rows, now: GOD_NOW, scroll: 0 })).map(text),
  })
  const tabs = snapshot.sessions.flatMap((session) =>
    [60, 110].flatMap((columns) =>
      DETAIL_TABS.map((tab) => detail(`${session.sessionId}.${tab}.${columns}`, { session, width: detailWidth(columns), tab, isCmuxMissing: false, screen: GOD_SCREEN, recap: GOD_RECAPS.answered })),
    ),
  )
  const wait = snapshot.sessions.find((session) => session.sessionId === GOD_SCREEN.sessionId)!
  const states = [
    detail('recap.running', { session: wait, width: 79, tab: 'recap', isCmuxMissing: false, recap: GOD_RECAPS.running }),
    detail('recap.busy', { session: snapshot.sessions.find((session) => session.sessionId !== wait.sessionId)!, width: 79, tab: 'recap', isCmuxMissing: false, recap: GOD_RECAPS.running }),
    detail('recap.none', { session: wait, width: 79, tab: 'recap', isCmuxMissing: false }),
    detail('recap.failed', { session: wait, width: 79, tab: 'recap', isCmuxMissing: false, recap: GOD_RECAPS.failed }),
    detail('screen.refused', { session: wait, width: 79, tab: 'screen', isCmuxMissing: false, outcome: GOD_OUTCOMES.refused }),
    detail('screen.failed', { session: wait, width: 79, tab: 'screen', isCmuxMissing: false, screen: GOD_SCREEN, isScreenFailed: true }),
    ...snapshot.sessions.flatMap((session) => DETAIL_TABS.map((tab) => detail(`${session.sessionId}.${tab}.no-cmux`, { session, width: 79, tab, isCmuxMissing: true }))),
  ]
  const confirm = [60, 110].flatMap((columns) =>
    Object.values(GOD_INTENTS).map((intent) => ({ file: `${GOD_DETAIL_FIXTURE}#confirm.${intent.kind}.${columns}`, lines: confirmView({ intent, width: columns, rows: 12, scroll: 0 }).lines.map(text) })),
  )
  // a window of each kind: the Now tab and a prompt that do not fit their rows, so the row scores the count lines
  const windows = [
    detail('window.now', { session: wait, width: 79, tab: 'now', isCmuxMissing: false }, 11),
    { file: `${GOD_DETAIL_FIXTURE}#window.confirm`, lines: confirmView({ intent: GOD_INTENTS.prompt, width: 60, rows: 3, scroll: 1 }).lines.map(text) },
  ]
  const outcomes = [
    ...Object.values(GOD_OUTCOMES).map((outcome) => ({ file: `${GOD_DETAIL_FIXTURE}#outcome.${outcome.status}`, lines: outcomeLines(outcome, 110).map(text) })),
    ...(Object.keys(REFUSAL_TEXT) as DeliverRefusal[]).map((refusal) => ({ file: `${GOD_DETAIL_FIXTURE}#refusal.${refusal}`, lines: outcomeLines({ ...GOD_OUTCOMES.refused, refusal } as Parameters<typeof outcomeLines>[0], 110).map(text) })),
  ]
  const perm = snapshot.sessions.find((session) => session.sessionId === 's-perm')!
  const editRequest = { ...perm, transcript: { ...perm.transcript!, activity: { ...perm.transcript!.activity!, tool: 'Edit', text: 'Edit parse.ts', input: '{"file_path":"parse.ts"}' } } }
  const requests = [false, true].map((isCmuxMissing) => detail(`now.edit-request.${isCmuxMissing ? 'no-cmux' : 'cmux'}`, { session: editRequest, width: 79, tab: 'now', isCmuxMissing }))
  const modes = Object.keys(PROMPT_MODE_TEXT).map((mark) => ({
    file: `${GOD_DETAIL_FIXTURE}#confirm.mode.${mark}`,
    lines: confirmView({ intent: { ...GOD_INTENTS.prompt, text: `${mark}status` } as DeliverIntent, width: 110, rows: 12, scroll: 0 }).lines.map(text),
  }))
  const target = GOD_INTENTS.prompt.target
  const bar = (deliver: Parameters<typeof barView>[0]['deliver'], columns: number) => barView({ deliver, width: columns, rows: 12, selectedKey: target.sessionId, isScreenOpen: false })
  const drafts = (['prompt', 'peer'] as const).flatMap((kind) =>
    [0, 1, 2].map((count) => {
      const view = bar({ scroll: 0, draft: { kind, target, lines: Array.from({ length: count }, (_, index) => `Line ${index + 1}.`) } }, 110)!
      return { file: `${GOD_DETAIL_FIXTURE}#bar.draft.${kind}.${count}`, lines: [...view.lines.map(text), view.field!.placeholder] }
    }),
  )
  const stale = { ...GOD_OUTCOMES.refused, refusal: 'stale-screen' } as DeliverOutcome
  const bars = [
    ...drafts,
    { file: `${GOD_DETAIL_FIXTURE}#bar.stale`, lines: bar({ scroll: 0, intent: GOD_INTENTS.answer, outcome: stale }, 60)!.lines.map(text) },
    ...Object.values(GOD_OUTCOMES).map((outcome) => ({ file: `${GOD_DETAIL_FIXTURE}#bar.note.${outcome.status}`, lines: bar({ scroll: 0, outcome }, 60)!.lines.map(text) })),
  ]
  const tools = [
    { file: `${GOD_DETAIL_FIXTURE}#tool.board.110`, lines: boardToolText(snapshot, 110, GOD_NOW).split('\n') },
    ...snapshot.sessions.map((session) => ({ file: `${GOD_DETAIL_FIXTURE}#tool.session.${session.sessionId}`, lines: sessionToolText(snapshot, session.name, 110, GOD_NOW).split('\n') })),
  ]
  return [...tabs, ...states, ...confirm, ...windows, ...outcomes, ...requests, ...modes, ...bars, ...tools]
}
