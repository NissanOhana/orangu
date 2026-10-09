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
import { REFUSAL_TEXT } from './confirm.js'
import { detailView, type DetailInput, type DetailView } from './detail.js'
import {
  MODEL_TEXT,
  MULTI_QUESTION,
  MULTI_QUESTION_NO_CMUX,
  MULTI_SELECT,
  NO_AGENTS,
  NO_HISTORY,
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
  it('shows the open question: the header chip and the wait, the question whole, then each option as <n> <label>', () => {
    expect(body('s-wait')).toEqual([
      ' ☐ Eval set · waits 6h',
      ` ${QUESTION}`,
      ' 1 Small  Only the fast tests.',
      ' 2 All',
      ' 3 None  Skip the eval.',
      ' Last reply',
      '   The eval tests pass. I need 1 choice from you.',
      '',
      '   The notes have the details.',
    ])
  })

  it('keys each option line by its digit, and draws the digit dim when cmux is not on the machine', () => {
    const view = detail('s-wait')
    expect(view.options).toEqual([1, 2, 3].map((digit) => ({ key: `option:${digit}`, digit, isOff: false })))
    expect(view.body.filter((line) => line.key !== undefined).map((line) => line.key)).toEqual(['option:1', 'option:2', 'option:3'])
    expect(view.body.find((line) => line.key === 'option:1')!.segments[1]).toEqual({ text: '1', bold: true })
    const off = detail('s-wait', { isCmuxMissing: true })
    expect(off.options.every((option) => option.isOff)).toBe(true)
    expect(off.body.find((line) => line.key === 'option:1')!.segments[1]).toEqual({ text: '1', dim: true })
  })

  it('shows every question of a dialog with 2 questions, with no digit key, and the line that says to answer it in its tab', () => {
    expect(MULTI_QUESTION).toBe('This dialog has more than 1 question. Press j to answer it in its tab.')
    const view = detail('s-multi')
    expect(view.options).toEqual([])
    expect(view.body.map(text)).toEqual([' ☐ Port · waits 4m', ' Which port do you want?', ' • 3000', ' • 8080', ' ☐ Host', ' Which host do you want?', ' • Local', ' • Shared', ` ${MULTI_QUESTION}`, ' Last reply', '   No reply yet.'])
    expect(body('s-multi', { isCmuxMissing: true })).toContain(` ${MULTI_QUESTION_NO_CMUX}`)
  })

  it('shows a dialog with more than 1 choice with no digit key, and its own line', () => {
    const view = detail('s-pick')
    expect(view.options).toEqual([])
    expect(view.body.map(text).slice(0, 6)).toEqual([' ☐ Checks · waits 2m', ' Which checks do you want?', ' • Lint', ' • Types', ' • Tests', ` ${MULTI_SELECT}`])
  })

  it('shows the permission request and its whole input', () => {
    expect(body('s-perm')).toEqual([' ☐ Permission · waits 3m', ' Bash npm test', ' Input', '   {"command":"npm test","description":"Run the tests"}', ' Last reply', '   No reply yet.'])
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
