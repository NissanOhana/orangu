/**
 * The content of each tab of the detail: Now (the open question with its options, the permission request, the tool
 * call, the API error, the last reply), History (the newest turn first), Agents (running first), Screen (the read
 * of the cmux tab with its spaces, under a refusal line) and Recap (the model text label and the token count).
 * Each text shows whole.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, busy, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import { NOW, OUTCOMES, QUESTION, RECAPS, SCREEN, detailSession } from '../../../test/fixtures/god/detail.js'
import type { GodSession } from '../types.js'
import { MULTI_DIALOG, MULTI_DIALOG_NO_CMUX, REFUSAL_TEXT } from './confirm.js'
import { detailView, type DetailInput, type DetailView } from './detail.js'
import {
  MODEL_TEXT,
  NO_AGENTS,
  NO_HISTORY,
  PERMISSION_JUMP,
  PERMISSION_JUMP_NO_CMUX,
  RECAP_FAILURE,
  RECAP_HINT,
  RECAP_RUNNING,
  SCREEN_NO_CMUX,
  SCREEN_NO_TAB,
  SCREEN_READING,
} from './detail-tabs.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const input = (session: GodSession, over: Partial<DetailInput> = {}): DetailInput => ({ session, width: 79, rows: 60, now: NOW, tab: 'now', scroll: 0, isCmuxMissing: false, ...over })
const detail = (sessionId: string, over: Partial<DetailInput> = {}): Extract<DetailView, { kind: 'detail' }> => {
  const view = detailView(input(detailSession(sessionId), over))
  if (view.kind !== 'detail') throw new Error(`${sessionId}: ${view.kind}`)
  return view
}
const body = (sessionId: string, over: Partial<DetailInput> = {}): string[] => detail(sessionId, over).body.map(text)

describe('the Now tab', () => {
  it('shows the open question: the header chip and the wait, the question whole, then each option as <n>: <label>', () => {
    expect(body('s-wait')).toEqual([
      ' ☐ Eval set · waits 6h',
      ` ${QUESTION}`,
      ' 1: Small  Only the fast tests.',
      ' 2: All',
      ' 3: None  Skip the eval.',
      ' Last reply',
      '   The eval tests pass. I need 1 choice from you.',
      '',
      '   The notes have the details.',
    ])
  })

  it('keys each option line by its digit, with the digit as its hotkey, and draws the digit dim with no hotkey when cmux is not on the machine', () => {
    const view = detail('s-wait')
    expect(view.options).toEqual([1, 2, 3].map((digit) => ({ key: `option:${digit}`, digit, isOff: false })))
    expect(view.body.filter((line) => line.key !== undefined).map((line) => [line.key, line.hotkey])).toEqual([
      ['option:1', '1'],
      ['option:2', '2'],
      ['option:3', '3'],
    ])
    // the engine paints the hotkey, a colon and a space at the start of the Button, so the view counts those cells
    expect(view.body.find((line) => line.key === 'option:1')!.segments.slice(0, 3)).toEqual([{ text: ' ' }, { text: '1: ', isPainted: true }, { text: 'Small' }])
    const off = detail('s-wait', { isCmuxMissing: true })
    expect(off.options.every((option) => option.isOff)).toBe(true)
    expect(off.body.find((line) => line.key === 'option:1')!.hotkey).toBeUndefined()
    expect(off.body.find((line) => line.key === 'option:1')!.segments[1]).toEqual({ text: '1', dim: true })
    expect(off.body.map(text).slice(2, 5)).toEqual([' 1 Small  Only the fast tests.', ' 2 All', ' 3 None  Skip the eval.'])
  })

  it('wraps a long option label under its painted hotkey, with the rest of the label after the hang', () => {
    const wait = detailSession('s-wait')
    const open = wait.transcript!.openQuestion!
    const long = { ...wait, transcript: { ...wait.transcript!, openQuestion: { ...open, questions: [{ ...open.questions[0]!, options: [{ label: 'A very long label that goes past the edge of the pane' }] }] } } }
    const view = detailView(input(long, { width: 30 }))
    if (view.kind !== 'detail') throw new Error(view.kind)
    const at = view.body.findIndex((line) => line.key === 'option:1')
    expect(view.body.slice(at, at + 3).map(text)).toEqual([' 1: A very long label that', '   goes past the edge of the', '   pane'])
  })

  /** the lines of the dialog line under the options, joined: it wraps at 79 columns */
  const dialogLine = (lines: readonly string[], from: number): string => lines.slice(from, lines.indexOf(' Last reply')).join(' ').replace(/\s+/g, ' ').trim()

  it('shows every question of a dialog with 2 questions, with no digit key, and the line that says to answer it in its tab', () => {
    expect(MULTI_DIALOG).toBe('This dialog has more than 1 question or more than 1 choice. Press j to answer it in its tab.')
    const view = detail('s-multi')
    expect(view.options).toEqual([])
    const lines = view.body.map(text)
    expect(lines.slice(0, 8)).toEqual([' ☐ Port · waits 4m', ' Which port do you want?', ' • 3000', ' • 8080', ' ☐ Host', ' Which host do you want?', ' • Local', ' • Shared'])
    expect(dialogLine(lines, 8)).toBe(MULTI_DIALOG)
    expect(lines.slice(-2)).toEqual([' Last reply', '   No reply yet.'])
    expect(dialogLine(body('s-multi', { isCmuxMissing: true }), 8)).toBe(MULTI_DIALOG_NO_CMUX)
  })

  it('shows a dialog with more than 1 choice with no digit key, and the same line', () => {
    const view = detail('s-pick')
    expect(view.options).toEqual([])
    const lines = view.body.map(text)
    expect(lines.slice(0, 5)).toEqual([' ☐ Checks · waits 2m', ' Which checks do you want?', ' • Lint', ' • Types', ' • Tests'])
    expect(dialogLine(lines, 5)).toBe(MULTI_DIALOG)
  })

  it('shows the permission request, its whole input, then Yes and No of a Bash request as digit Buttons', () => {
    expect(body('s-perm')).toEqual([' ☐ Permission · waits 3m', ' Bash npm test', ' Input', '   {"command":"npm test","description":"Run the tests"}', ' 1: Yes', ' 2: No', ' Last reply', '   No reply yet.'])
    const view = detail('s-perm')
    expect(view.options).toEqual([
      { key: 'permission:yes', digit: 1, isOff: false, choice: 'yes' },
      { key: 'permission:no', digit: 2, isOff: false, choice: 'no' },
    ])
    expect(view.body.filter((line) => line.key !== undefined).map((line) => [line.key, line.hotkey])).toEqual([
      ['permission:yes', '1'],
      ['permission:no', '2'],
    ])
    const off = detail('s-perm', { isCmuxMissing: true })
    expect(off.body.map(text)).toContain(' 1 Yes')
    expect(off.body.every((line) => line.hotkey === undefined)).toBe(true)
  })

  it('gives a request of any other tool no Yes and No, and the line that says to answer it in its tab', () => {
    const perm = detailSession('s-perm')
    const edit = { ...perm, transcript: { ...perm.transcript!, activity: { ...perm.transcript!.activity!, tool: 'Edit', text: 'Edit parse.ts', input: '{"file_path":"parse.ts"}' } } }
    const view = detailView(input(edit))
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(view.options).toEqual([])
    expect(view.body.some((line) => line.key !== undefined)).toBe(false)
    const lines = view.body.map(text)
    expect(dialogLine(lines, 4)).toBe(PERMISSION_JUMP)
    expect(PERMISSION_JUMP).toBe('The pane answers only a Bash request with Yes or No. Press j to answer this request in its tab.')
    const off = detailView(input(edit, { isCmuxMissing: true }))
    if (off.kind !== 'detail') throw new Error(off.kind)
    expect(dialogLine(off.body.map(text), 4)).toBe(PERMISSION_JUMP_NO_CMUX)
  })

  it('keeps the runs of spaces of the tool input as written', () => {
    const spacedInput = '{"command":"echo  a   b"}'
    const perm = detailSession('s-perm')
    const spaced = { ...perm, transcript: { ...perm.transcript!, activity: { ...perm.transcript!.activity!, input: spacedInput } } }
    const view = detailView(input(spaced))
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(view.body.map(text)).toContain(`   ${spacedInput}`)
  })

  it('shows the current tool call, or the API error of a stuck session, then the last reply', () => {
    expect(body('s-work')).toEqual([' Runs  Edit parse.ts  1m ago', ' Last reply', '   I edit the parser now.'])
    const stuck = detail('s-stuck')
    expect(stuck.body.map(text)).toEqual([' API error  The API refused the request.', ' Last reply', '   No reply yet.'])
    expect(stuck.body[0]!.segments.find((segment) => segment.text === 'API error')).toEqual({ text: 'API error', token: '--warn', bold: true })
  })

  it('shows the reason of the wait when a waiting session has no question and no open call', () => {
    const plain = snapshotOf([waiting('s-x', { name: 'x-1', transcript: transcript() })])
    const view = detailView(input(plain.sessions[0]!))
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(view.body.map(text)).toEqual([' Waits for  input needed', ' Last reply', '   No reply yet.'])
  })

  it('says that a session with no transcript has none', () => {
    expect(body('s-new')).toEqual([' No transcript yet.'])
  })
})

describe('the History tab', () => {
  it('shows the last turns, the newest first, each as your prompt and then the reply', () => {
    expect(body('s-wait', { tab: 'history' })).toEqual([
      ' You  6h ago',
      '   Run the eval tests.',
      ' Reply  6h ago',
      '   The eval tests pass. I need 1 choice from you.',
      ' You  7h ago',
      '   Read the parser.',
      ' Reply  6h ago',
      '   I read the parser. It has 3 parts.',
    ])
  })

  it('shows a turn with no prompt as its reply alone, and a turn with no reply yet', () => {
    const turns = snapshotOf([busy('s-x', { name: 'x-1', transcript: transcript({ history: [{ reply: 'Done.', replyAt: NOW - HOUR }, { prompt: 'Go on.', promptAt: NOW - MINUTE }] }) })])
    const view = detailView(input(turns.sessions[0]!, { tab: 'history' }))
    if (view.kind !== 'detail') throw new Error(view.kind)
    expect(view.body.map(text)).toEqual([' You  1m ago', '   Go on.', ' Reply', '   No reply yet.', ' Reply  1h ago', '   Done.'])
  })

  it('says when the part of the transcript that the pane read holds no turn', () => {
    expect(body('s-work', { tab: 'history' })).toEqual([` ${NO_HISTORY}`])
  })
})

describe('the Agents tab', () => {
  it('shows the running tasks first, then the ended ones, then the subagent files of older turns', () => {
    expect(body('s-work', { tab: 'agents' })).toEqual([
      ' runs   Read the notes  Explore  2m ago',
      ' runs   Find the parser tests  Explore  3m ago',
      ' ended  Bash npm run build  25m ago',
      ' older  Plan the parser work.  Plan  3h ago',
    ])
    expect(detail('s-work', { tab: 'agents' }).body[2]!.segments[1]).toEqual({ text: 'ended', dim: true })
  })

  it('says when the session has no subagent and no background task', () => {
    expect(body('s-wait', { tab: 'agents' })).toEqual([` ${NO_AGENTS}`])
  })
})

describe('the Screen tab', () => {
  it('shows the screen whole, with its spaces, and drops the blank lines at its end', () => {
    expect(body('s-wait', { tab: 'screen', screen: SCREEN })).toEqual([
      ' ☐ Eval set',
      '',
      ` ${QUESTION}`,
      '',
      ' ❯ 1. Small',
      '      Only the fast tests.',
      '   2. All',
      '   3. None',
      '      Skip the eval.',
    ])
  })

  it('breaks a screen line that is wider than the detail into lines of the width, and cuts nothing', () => {
    const wide = { ...SCREEN, text: 'x'.repeat(70) }
    expect(body('s-wait', { tab: 'screen', screen: wide, width: 30 })).toEqual([` ${'x'.repeat(29)}`, ` ${'x'.repeat(29)}`, ` ${'x'.repeat(12)}`])
  })

  it('shows the refusal line in the bad color above the fresh screen of a refusal', () => {
    const view = detail('s-wait', { tab: 'screen', outcome: OUTCOMES.refused })
    expect(text(view.body[0]!)).toBe(` ${REFUSAL_TEXT['screen-changed']}`)
    expect(view.body[0]!.segments[1]).toEqual({ text: REFUSAL_TEXT['screen-changed'], token: '--bad' })
    expect(text(view.body[1]!)).toBe(' ☐ Eval set')
  })

  it('says why it shows no screen: no cmux, no tab, or no read yet', () => {
    expect(body('s-wait', { tab: 'screen', isCmuxMissing: true })).toEqual([` ${SCREEN_NO_CMUX}`])
    expect(body('s-stuck', { tab: 'screen' })).toEqual([` ${SCREEN_NO_TAB}`])
    expect(body('s-wait', { tab: 'screen' })).toEqual([` ${SCREEN_READING}`])
    expect(body('s-work', { tab: 'screen', screen: SCREEN })).toEqual([` ${SCREEN_READING}`])
  })

  it('shows the refusal line of the session above the reason that it shows no screen', () => {
    const stuck = { sessionId: 's-stuck', name: 'api-3' }
    const noTab = { status: 'refused' as const, intent: { kind: 'prompt' as const, target: stuck, text: 'Run the tests.' }, at: NOW, refusal: 'no-tab' as const }
    expect(body('s-stuck', { tab: 'screen', outcome: noTab })).toEqual([` ${REFUSAL_TEXT['no-tab']}`, ` ${SCREEN_NO_TAB}`])
    const noCmux = { ...noTab, intent: { ...noTab.intent, target: { sessionId: 's-wait', name: 'api-7' } }, refusal: 'no-cmux' as const }
    expect(body('s-wait', { tab: 'screen', isCmuxMissing: true, outcome: noCmux })).toEqual([` ${REFUSAL_TEXT['no-cmux']}`, ` ${SCREEN_NO_CMUX}`])
  })
})

describe('the Recap tab', () => {
  it('says which key makes a Recap, and that the model text uses tokens', () => {
    expect(RECAP_HINT).toMatch(/Press x/)
    expect(RECAP_HINT).toMatch(/tokens/)
    expect(body('s-wait', { tab: 'recap' })).toEqual([` ${RECAP_HINT}`])
    expect(body('s-work', { tab: 'recap', recap: RECAPS.answered })).toEqual([` ${RECAP_HINT}`])
    expect(body('s-wait', { tab: 'recap', recap: RECAPS.running })).toEqual([` ${RECAP_RUNNING}`])
  })

  it('shows the model text label above the text and the token count under it', () => {
    const view = detail('s-wait', { tab: 'recap', recap: RECAPS.answered })
    expect(view.body.map(text)).toEqual([` ${MODEL_TEXT}`, '   The session waits for your choice of the eval set. The eval tests pass.', ' 1,834 tokens'])
    expect(view.body[0]!.segments[1]).toEqual({ text: MODEL_TEXT, dim: true })
  })

  it('shows the reason of a failed Recap and its token count', () => {
    expect(body('s-wait', { tab: 'recap', recap: RECAPS.failed })).toEqual([` ${RECAP_FAILURE['api-error']}`, ' 0 tokens'])
    expect(Object.keys(RECAP_FAILURE).sort()).toEqual(['aborted', 'api-error', 'empty-reply', 'refused'])
  })
})
